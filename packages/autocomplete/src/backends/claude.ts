import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { transcriptDirMatchesToken } from "../core/text.js";
import type { CompletionBackend } from "../types.js";
import { planSpawn, planRemoteCleanup, type Transport } from "../transport.js";

export interface ClaudeBackendOptions {
  /** Model passed to --model. Default "haiku" (fastest tier). */
  model?: string;
  /** Warm worker processes. Default 2. */
  poolSize?: number;
  /** Turns before a worker is recycled (stream-json turns share history). Default 8. */
  maxTurnsPerWorker?: number;
  /** Accumulated prompt chars before a worker is recycled. History size — not
   *  turn count — is what drags TTFB, so this is the primary recycle driver.
   *  Default 18_000 (~3 big-notebook prompts). */
  maxHistoryCharsPerWorker?: number;
  /** Per-turn timeout. Default 45_000 ms. */
  turnTimeoutMs?: number;
  /** Working directory for workers — keep it empty so no CLAUDE.md loads. */
  workspaceDir?: string;
  /** Path to the claude binary. Default "claude". */
  binary?: string;
  /** Where the claude process runs: locally (default) or over ssh on the user's
   *  machine (remote Nebula + local agent). Default { kind: "local" }. */
  transport?: Transport;
  /** Thinking-token budget. Default 0: thinking never streams as ghost text
   *  (observed burning a whole turn invisibly), but a budget can improve
   *  tricky completions — surfaced as an Advanced setting. */
  maxThinkingTokens?: number;
}

function isWorkerDeath(err: unknown): boolean {
  return err instanceof Error && err.message === "claude worker exited";
}

interface PendingTurn {
  onChunk?: (text: string) => void;
  resolve: (full: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Accumulated streamed deltas — salvages output-token-limit "errors". */
  streamed?: string;
}

class ClaudeWorker {
  busy = false;
  dead = false;
  turns = 0;
  /** Total prompt chars sent — the real recycle driver: stream-json history
   *  grows with every prompt, and TTFB grows with HISTORY SIZE, not turn
   *  count (measured: 6.4KB prompts drag +~0.2s/turn; 1.5KB prompts don't). */
  sentChars = 0;
  readonly bornAt = Date.now();
  /** Invoked once when the process exits/errors — lets the pool respawn in the background. */
  onDeath?: () => void;
  readonly warmed: Promise<void>;
  // Each worker runs in its OWN cwd subdir so Claude's per-cwd transcript
  // directory is unique per worker. Pruning a recycled worker's transcripts
  // then can't touch a concurrently-active worker's dir. cwdToken is the
  // subdir name — it appears in the munged transcript-dir name.
  readonly cwd: string;
  readonly cwdToken = randomUUID();
  private pending: PendingTurn | null = null;
  private buf = "";
  private proc: ChildProcessWithoutNullStreams;

  // For the ssh transport: an ephemeral config dir on the REMOTE side so claude's
  // transcripts don't accumulate on the user's machine — wiped on kill().
  private readonly remoteConfigDir: string;

  constructor(private opts: Required<ClaudeBackendOptions>) {
    const argv = [
      "-p",
      "--model", opts.model,
      // Strip tools and MCP servers from the harness prompt — the largest
      // per-turn latency saver (measured ~2.3s -> ~1.4s TTFB).
      "--tools", "",
      "--mcp-config", '{"mcpServers":{}}',
      "--strict-mcp-config",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];
    const env: Record<string, string> = {
      // Generous cap: hitting it surfaces as an ERROR that discards the turn,
      // so a tight cap converts long completions into nothing (observed).
      // Runaways are bounded by the turn timeout and by supersession
      // interrupts instead; long ghost text streams visibly and the user can
      // ignore or Escape it.
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "4096",
      // Default 0: thinking tokens never stream as ghost text — observed as
      // a 17s turn burning the whole budget with NOTHING shown. Users can
      // opt into a budget (Advanced) for higher-quality completions.
      MAX_THINKING_TOKENS: String(opts.maxThinkingTokens ?? 0),
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    };
    if (opts.transport.kind === "ssh") {
      // Remote: run in a fresh remote tmp dir; keep transcripts in an ephemeral
      // remote config dir (auth still comes from the user's real login via their
      // ~/.zshenv token). No local workspace dir.
      this.cwd = `/tmp/nebula-autocomplete-ws-${this.cwdToken}`;
      this.remoteConfigDir = `/tmp/nebula-autocomplete-cfg-${this.cwdToken}`;
      env.CLAUDE_CONFIG_DIR = this.remoteConfigDir;
    } else {
      this.cwd = join(opts.workspaceDir, this.cwdToken);
      this.remoteConfigDir = "";
      mkdirSync(this.cwd, { recursive: true });
    }
    const plan = planSpawn(opts.transport, opts.binary, argv, env, this.cwd);
    this.proc = spawn(plan.command, plan.args, {
      ...plan.options,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.on("data", (d: Buffer) => this.onData(d));
    this.proc.on("exit", () => {
      this.dead = true;
      this.pending?.reject(new Error("claude worker exited"));
      this.pending = null;
      const cb = this.onDeath;
      this.onDeath = undefined; // fire once
      cb?.();
    });
    this.proc.on("error", (err) => {
      this.dead = true;
      this.pending?.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending = null;
      const cb = this.onDeath;
      this.onDeath = undefined;
      cb?.();
    });
    this.warmed = this.runTurn("Reply with exactly: ok").then(
      () => undefined,
      () => undefined,
    );
  }

  private onData(data: Buffer): void {
    this.buf += data.toString();
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim() || !this.pending) continue;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === "stream_event") {
        const event = ev.event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
          this.pending.streamed = (this.pending.streamed ?? "") + event.delta.text;
          this.pending.onChunk?.(event.delta.text);
        }
      } else if (ev.type === "result") {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p!.timer);
        // CLI failures (not logged in, out of credits, …) arrive as a result
        // event with is_error / non-success subtype. Reject those turns —
        // resolving would cache and render the error text as a suggestion.
        if (ev.is_error === true || (typeof ev.subtype === "string" && ev.subtype !== "success")) {
          const msg = typeof ev.result === "string" && ev.result.trim()
            ? ev.result.trim()
            : `claude turn failed (${ev.subtype ?? "error"})`;
          // Hitting the output-token cap arrives as an ERROR, discarding a
          // completion we already streamed in full (observed: 35s turn, 512
          // tokens, then thrown away). The streamed text IS the completion —
          // truncated, but the tag/trim pipeline handles a missing close tag.
          if (/output token maximum/i.test(msg) && p!.streamed) {
            p!.resolve(p!.streamed);
          } else {
            const note = /output token maximum/i.test(msg)
              ? ` (streamed ${p!.streamed?.length ?? 0}ch before the cap)`
              : "";
            p!.reject(new Error(msg + note));
          }
        } else {
          p!.resolve(typeof ev.result === "string" ? ev.result : "");
        }
      }
    }
  }

  runTurn(text: string, onChunk?: (t: string) => void, signal?: AbortSignal): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.dead) return reject(new Error("claude worker is dead"));
      const timer = setTimeout(() => {
        this.pending = null;
        this.kill();
        reject(new Error("claude turn timed out"));
      }, this.opts.turnTimeoutMs);
      const pending: PendingTurn = { onChunk, resolve, reject, timer };
      // Supersession: a dispatched turn CAN be cancelled — the stream-json
      // protocol accepts {type:"control_request",request:{subtype:"interrupt"}}
      // and ends the running turn in ~10ms (measured), leaving the worker
      // reusable. Without this, a superseded completion held its worker for
      // the full turn and the successor's "queued" time was a whole turn.
      // Guard on `this.pending === pending` so a late abort can never kill a
      // successor's turn that reused this worker.
      const onAbort = () => {
        if (this.pending === pending && !this.dead) {
          try {
            this.proc.stdin.write(JSON.stringify({
              type: "control_request",
              request_id: `int-${Date.now()}`,
              request: { subtype: "interrupt" },
            }) + "\n");
          } catch { /* worker dying anyway */ }
        }
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      pending.resolve = (v) => { cleanup(); resolve(v); };
      pending.reject = (e) => { cleanup(); reject(e); };
      this.pending = pending;
      if (signal?.aborted) onAbort();
      const msg = {
        type: "user",
        message: { role: "user", content: [{ type: "text", text }] },
      };
      this.proc.stdin.write(JSON.stringify(msg) + "\n");
    });
  }

  kill(): void {
    this.dead = true;
    try {
      this.proc.kill();
    } catch {
      /* already gone */
    }
    // Remote no-trace: wipe this worker's ephemeral config + workspace dirs on
    // the user's machine. Fire-and-forget over the (still-warm) control channel.
    if (this.opts.transport.kind === "ssh") {
      for (const dir of [this.remoteConfigDir, this.cwd]) {
        if (!dir) continue;
        try {
          const c = planRemoteCleanup(this.opts.transport, dir);
          spawn(c.command, c.args, { stdio: "ignore" }).unref();
        } catch {
          /* best-effort */
        }
      }
    }
  }
}

/**
 * Persistent warm pool of `claude` CLI processes (subscription auth) in
 * stream-json mode. Workers are recycled after maxTurnsPerWorker completions
 * so conversation history never bloats the context.
 */
export class ClaudeBackend implements CompletionBackend {
  readonly name = "claude";
  private pool: ClaudeWorker[] = [];
  private opts: Required<ClaudeBackendOptions>;
  private disposed = false;
  // Unique token embedded in the workspace path. Claude Code keys its session
  // transcript directory (~/.claude/projects/<munged-cwd>) off the process cwd,
  // so this token survives path munging and lets us find and delete only our
  // own transcript dirs — never a real session. See pruneTranscripts().
  private readonly wsToken = randomUUID();

  constructor(options: ClaudeBackendOptions = {}) {
    // For ssh transport, give all workers a shared ControlMaster socket so the
    // handshake is paid once and reconnects are ~free.
    let transport: Transport = options.transport ?? { kind: "local" };
    if (transport.kind === "ssh" && !transport.controlPath) {
      // Keep the ControlMaster socket path SHORT: unix-socket paths max ~104
      // chars, and macOS tmpdir() is a long /var/folders/... path that overflows
      // it (→ ssh aborts). /tmp + a short token stays well under the limit.
      transport = { ...transport, controlPath: `/tmp/nac-${this.wsToken.slice(0, 8)}` };
    }
    this.opts = {
      model: options.model ?? "haiku",
      poolSize: options.poolSize ?? 2,
      // MEASURED (10 sequential real turns, one worker): per-turn latency does
      // NOT grow with turn count — turns 7-9 averaged FASTER than 0-2, so the
      // CLI/API handles its own history efficiently (prompt caching). Keep 8:
      // recycling more often would just burn a warmup API call per recycle
      // for zero latency benefit.
      maxTurnsPerWorker: options.maxTurnsPerWorker ?? 8,
      // MEASURED: TTFB grows with accumulated HISTORY, not turns — 6.4KB
      // real-notebook prompts dragged ttfb 3.2s@turn5 -> 4.0s@turn7, while a
      // 10-turn run of 1.5KB prompts showed no drag at all. Cap history size;
      // the turn cap above is just a backstop. Recycling is background-warmed
      // (spawnWorker/ensurePool), so tighter recycling costs the user nothing.
      maxHistoryCharsPerWorker: options.maxHistoryCharsPerWorker ?? 18_000,
      turnTimeoutMs: options.turnTimeoutMs ?? 45_000,
      // Default to a per-instance dir so the transcript-dir name is unique to
      // this backend. A caller-supplied dir is used verbatim (its transcripts
      // are then only pruned if its basename happens to contain wsToken — so
      // prefer letting the default apply for full hygiene).
      workspaceDir:
        options.workspaceDir ?? join(tmpdir(), `nebula-autocomplete-ws-${this.wsToken}`),
      binary: options.binary ?? "claude",
      transport,
      maxThinkingTokens: options.maxThinkingTokens ?? 0,
    };
    // Local transport keeps its worker workspaces under workspaceDir; ssh workers
    // use remote dirs, so no local dir is needed.
    if (transport.kind === "local") mkdirSync(this.opts.workspaceDir, { recursive: true });
    this.ensurePool();
  }

  /**
   * Delete any Claude Code session-transcript directories that belong to this
   * backend. Claude writes `~/.claude/projects/<munged-cwd>/*.jsonl` on some
   * versions/platforms; the munged name preserves alphanumerics, so our
   * wsToken (a UUID) always survives. We match by comparing alphanumeric-only
   * forms, which is munge-algorithm-independent and cannot collide with a real
   * project path. Best-effort: never throws into the caller.
   */
  private pruneTranscripts(token: string = this.wsToken): void {
    // ssh transport: transcripts live on the remote machine in a per-worker
    // ephemeral CLAUDE_CONFIG_DIR, wiped by ClaudeWorker.kill(). Nothing local.
    if (this.opts.transport.kind === "ssh") return;
    try {
      const projectsDir = join(
        process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
        "projects",
      );
      for (const entry of readdirSync(projectsDir)) {
        if (transcriptDirMatchesToken(entry, token)) {
          rmSync(join(projectsDir, entry), { recursive: true, force: true });
        }
      }
    } catch {
      /* projects dir absent (nothing written) or unreadable — nothing to prune */
    }
  }

  private ensurePool(): void {
    if (this.disposed) return;
    this.pool = this.pool.filter((w) => !w.dead);
    while (this.pool.length < this.opts.poolSize) {
      this.pool.push(this.spawnWorker());
    }
  }

  /**
   * Spawn a worker wired for background self-healing: the claude CLI exits on
   * its own after long idle, and replacing it lazily (at the next request)
   * put the whole cold start — process boot + ssh reconnect + warmup turn —
   * on the user's first post-idle completion (multi-second "autocomplete is
   * dead after I come back" lag). Respawning the moment a worker dies keeps
   * the pool warm through idle, so the first keystroke after a break pays the
   * same ~1.5s as any other. Crash-loop guard: only self-respawn for workers
   * that were healthy (survived 60s or completed a turn) — a broken binary
   * dies instantly and would otherwise spawn-loop forever.
   */
  private spawnWorker(): ClaudeWorker {
    const w = new ClaudeWorker(this.opts);
    w.onDeath = () => {
      if (this.disposed) return;
      const wasHealthy = w.turns > 0 || Date.now() - w.bornAt > 60_000;
      if (!wasHealthy) return;
      setTimeout(() => this.ensurePool(), 250);
    };
    return w;
  }

  async complete(
    prompt: string,
    { signal, onChunk, diag }: { signal?: AbortSignal; onChunk?: (t: string) => void; diag?: import("../types.js").CompletionDiag } = {},
  ): Promise<string> {
    if (this.disposed) throw new Error("backend disposed");
    signal?.throwIfAborted();
    // A pooled worker can die between turns (the CLI process exits on its own
    // in some versions). Retry once on a guaranteed-fresh worker before giving
    // up — but never after the caller aborted or emitted partial ghost text.
    let emitted = false;
    const guard = (t: string) => {
      if (!signal?.aborted) {
        emitted = true;
        onChunk?.(t);
      }
    };
    try {
      return await this.attempt(prompt, signal, guard, false, diag);
    } catch (err) {
      if (this.disposed || signal?.aborted || emitted || !isWorkerDeath(err)) throw err;
      if (diag) diag.retried = true;
      return await this.attempt(prompt, signal, guard, true, diag);
    }
  }

  private async attempt(
    prompt: string,
    signal: AbortSignal | undefined,
    guard: (t: string) => void,
    forceFresh: boolean,
    diag?: import("../types.js").CompletionDiag,
  ): Promise<string> {
    const tAcquire = performance.now();
    this.ensurePool();
    if (diag) {
      diag.transport = this.opts.transport.kind;
      diag.poolSize = this.pool.length;
      diag.poolBusy = this.pool.filter((w) => w.busy && !w.dead).length;
    }
    let worker = forceFresh ? undefined : this.pool.find((w) => !w.busy && !w.dead);
    if (!worker) {
      worker = this.spawnWorker();
      this.pool.push(worker);
      if (diag) diag.coldSpawn = true;
      console.log(`[autocomplete] cold worker spawn (${this.opts.transport.kind}): pool ${this.pool.length - 1} all busy/dead`);
    }
    worker.busy = true;
    if (diag) {
      diag.workerTurn = worker.turns;
      diag.workerHistoryChars = worker.sentChars;
    }
    // Always wait for the warmup turn: dispatching while it is in flight
    // would steal its pending handler and resolve with the warmup's output.
    await worker.warmed;
    if (diag) diag.workerWaitMs = Math.round(performance.now() - tAcquire);
    try {
      const full = await worker.runTurn(prompt, guard, signal);
      signal?.throwIfAborted();
      return full;
    } finally {
      worker.turns += 1;
      worker.sentChars += prompt.length;
      worker.busy = false;
      if (
        worker.turns >= this.opts.maxTurnsPerWorker ||
        worker.sentChars >= this.opts.maxHistoryCharsPerWorker ||
        worker.dead
      ) {
        const recycled = worker;
        recycled.kill();
        // Prune only THIS worker's transcript dir (matched by its own cwd
        // token) so a concurrently-active worker's dir is never disturbed.
        // Bounds growth over a long-lived server, not just at shutdown.
        this.pruneTranscripts(recycled.cwdToken);
        if (this.opts.transport.kind === "local") {
          try {
            rmSync(recycled.cwd, { recursive: true, force: true });
          } catch {
            /* best-effort */
          }
        } // ssh worker dirs are remote — cleaned by recycled.kill()
        this.ensurePool(); // warm replacement spawns in the background
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const w of this.pool) w.kill();
    this.pool = [];
    this.pruneTranscripts();
    if (this.opts.transport.kind === "ssh") {
      // Tear down the shared ControlMaster connection.
      if (this.opts.transport.controlPath) {
        try {
          spawn("ssh", ["-O", "exit", "-o", `ControlPath=${this.opts.transport.controlPath}`,
            `${this.opts.transport.user}@${this.opts.transport.host}`], { stdio: "ignore" }).unref();
        } catch { /* best-effort */ }
      }
      return;
    }
    try {
      rmSync(this.opts.workspaceDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}
