import { LruCache } from "./lru.js";
import { buildPrompt, cacheKey } from "./prompt.js";
import {
  createTagStreamFilter,
  extractCompletionTag,
  stripFences,
  trimPrefixOverlap,
  trimSuffixOverlap,
} from "./text.js";
import type {
  CompleteOptions,
  CompletionRequest,
  CompletionResult,
  EngineOptions,
} from "../types.js";

/**
 * Backend-agnostic autocomplete engine: prompt assembly, LRU result cache,
 * and per-session supersession (a new request aborts the previous one with
 * the same sessionKey).
 */
export class AutocompleteEngine {
  private cache: LruCache<string>;
  private inflight = new Map<string, AbortController>();
  // Per-session dispatch chain (single-flight): a backend turn cannot be
  // cancelled once dispatched — an aborted request's worker still runs its
  // turn to completion. Without this, a typing burst fanned superseded
  // requests out across workers: the pool exhausted, each keystroke cold-
  // spawned another process, and contending spawns snowballed into ~30s
  // waits. Chaining per session keeps at most ONE turn per cell in flight;
  // superseded requests abort while queued and never touch the backend.
  private turnChain = new Map<string, Promise<void>>();
  private contextBudget: number;
  private maxLines: number;

  constructor(private opts: EngineOptions) {
    this.cache = new LruCache<string>(opts.cacheSize ?? 128);
    this.contextBudget = opts.contextBudget ?? 6000;
    this.maxLines = opts.maxLines ?? 5;
  }

  async complete(
    req: CompletionRequest,
    { signal, onChunk }: CompleteOptions = {},
  ): Promise<CompletionResult> {
    const t0 = performance.now();
    const key = cacheKey(req);

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      onChunk?.(cached);
      return {
        text: cached,
        backend: this.opts.backend.name,
        fromCache: true,
        ttfbMs: 0,
        totalMs: Math.round(performance.now() - t0),
      };
    }

    // Supersede any in-flight request for the same session (cell).
    const session = req.sessionKey;
    let controller: AbortController | undefined;
    if (session !== undefined) {
      this.inflight.get(session)?.abort(new Error("superseded"));
      controller = new AbortController();
      this.inflight.set(session, controller);
      if (signal) {
        const upstream = signal;
        upstream.addEventListener("abort", () => controller!.abort(upstream.reason), {
          once: true,
        });
      }
    }
    const effectiveSignal = controller?.signal ?? signal;

    let ttfb: number | null = null;
    const rawChunkGuard = (t: string) => {
      if (ttfb === null) ttfb = performance.now() - t0;
      onChunk?.(t);
    };
    // The model wraps its completion in <completion> tags (leading whitespace
    // survives generation only inside them) — keep the tags out of streamed
    // ghost text while the inner text streams through.
    const chunkGuard = createTagStreamFilter(rawChunkGuard);

    try {
      const prompt = buildPrompt(req, {
        contextBudget: this.contextBudget,
        maxLines: this.maxLines,
      });
      const diag: import("../types.js").CompletionDiag = { promptChars: prompt.length };

      // Single-flight per session: wait for the previous turn on this cell to
      // settle before dispatching. If we're superseded while queued (the user
      // kept typing), bail here — no backend turn is ever wasted on us.
      const prev = session !== undefined ? this.turnChain.get(session) : undefined;
      const run = (async (): Promise<string> => {
        if (prev) {
          const tQueue = performance.now();
          await prev; // never rejects (stored pre-caught)
          diag.queueWaitMs = Math.round(performance.now() - tQueue);
          if (effectiveSignal?.aborted) throw new Error("superseded");
        }
        return this.opts.backend.complete(prompt, {
          signal: effectiveSignal,
          onChunk: chunkGuard,
          diag,
        });
      })();
      if (session !== undefined) {
        const link = run.then(() => undefined, () => undefined);
        this.turnChain.set(session, link);
        void link.then(() => {
          if (this.turnChain.get(session) === link) this.turnChain.delete(session);
        });
      }
      const raw = await run;
      // Tag-wrapped replies carry whitespace verbatim; untagged replies fall
      // back to the fence-stripping pipeline.
      const tagged = extractCompletionTag(raw);
      const text = trimSuffixOverlap(
        req.suffix ?? "",
        trimPrefixOverlap(req.prefix, tagged !== null ? tagged : stripFences(raw)),
      );
      this.cache.set(key, text);
      return {
        text,
        backend: this.opts.backend.name,
        fromCache: false,
        ttfbMs: Math.round(ttfb ?? performance.now() - t0),
        totalMs: Math.round(performance.now() - t0),
        diag,
      };
    } finally {
      if (session !== undefined && this.inflight.get(session) === controller) {
        this.inflight.delete(session);
      }
    }
  }

  dispose(): void {
    for (const c of this.inflight.values()) c.abort(new Error("engine disposed"));
    this.inflight.clear();
    this.opts.backend.dispose();
  }
}
