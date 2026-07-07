import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CompletionBackend } from "../types.js";
import { planSpawn, type Transport } from "../transport.js";

export interface CodexBackendOptions {
  /**
   * Model. Default "gpt-5.4-mini" — the fast model available with
   * ChatGPT-subscription auth (the *-codex-mini variants are API-only).
   */
  model?: string;
  /** Reasoning effort. Default "low" ("minimal" is rejected by codex's built-in tools). */
  reasoningEffort?: string;
  /**
   * CODEX_HOME containing only auth.json. Strongly recommended: skips the
   * global config's MCP servers/plugins/hooks (measured ~2s/request saved).
   * Prepare with: mkdir -p <dir> && cp ~/.codex/auth.json <dir>/
   */
  codexHome?: string;
  /** Per-request timeout. Default 60_000 ms. */
  timeoutMs?: number;
  /** Path to the codex binary. Default "codex". */
  binary?: string;
  /** Working directory. Default a temp dir. */
  workspaceDir?: string;
  /** Where codex runs: locally (default) or over ssh on the user's machine.
   *  Over ssh, codexHome is ignored (the user's own ~/.codex/auth.json is used;
   *  --ephemeral already keeps completions trace-free). */
  transport?: Transport;
}

/**
 * One-shot `codex exec --json` per completion (subscription auth). Codex has
 * no incremental token stream in exec mode, so results arrive buffered.
 */
export class CodexBackend implements CompletionBackend {
  readonly name = "codex";
  private opts: Required<Omit<CodexBackendOptions, "codexHome">> & {
    codexHome?: string;
  };

  constructor(options: CodexBackendOptions = {}) {
    this.opts = {
      model: options.model ?? "gpt-5.4-mini",
      reasoningEffort: options.reasoningEffort ?? "low",
      codexHome: options.codexHome,
      timeoutMs: options.timeoutMs ?? 60_000,
      binary: options.binary ?? "codex",
      workspaceDir: options.workspaceDir ?? join(tmpdir(), "nebula-autocomplete-ws"),
      transport: options.transport ?? { kind: "local" },
    };
    if (this.opts.transport.kind === "local") mkdirSync(this.opts.workspaceDir, { recursive: true });
  }

  complete(
    prompt: string,
    { signal, onChunk }: { signal?: AbortSignal; onChunk?: (t: string) => void } = {},
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
      const argv = [
        "exec", "--json",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--color", "never",
        // Completions are throwaway: don't persist rollout/session files or
        // prompt history — at autocomplete frequency they pollute CODEX_HOME.
        "--ephemeral",
        "-c", 'history.persistence="none"',
        // Also skip the curated-plugins sync, which otherwise clones tens of
        // MB into CODEX_HOME/.tmp on every exec.
        "-c", "features.plugins=false",
        "-m", this.opts.model,
        "-c", `model_reasoning_effort="${this.opts.reasoningEffort}"`,
        prompt,
      ];
      // Local: honor codexHome (skips global config's MCP/plugins). Over ssh,
      // use the user's own ~/.codex on their machine (auth lives there).
      const envOverrides: Record<string, string> =
        this.opts.transport.kind === "local" && this.opts.codexHome
          ? { CODEX_HOME: this.opts.codexHome }
          : {};
      const cwd =
        this.opts.transport.kind === "ssh" ? "/tmp/nebula-autocomplete-ws" : this.opts.workspaceDir;
      const plan = planSpawn(this.opts.transport, this.opts.binary, argv, envOverrides, cwd);
      const proc = spawn(plan.command, plan.args, { ...plan.options, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (err += d.toString()));
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error("codex timed out"));
      }, this.opts.timeoutMs);
      const onAbort = () => {
        proc.kill();
        reject(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return;
        if (code !== 0) {
          return reject(new Error(`codex rc=${code}: ${err.slice(-300)}`));
        }
        const text = extractAgentMessage(out);
        if (text) onChunk?.(text);
        resolve(text);
      });
    });
  }

  dispose(): void {
    /* one-shot processes; nothing persistent to release */
  }
}

/** Find the agent message in codex --json JSONL output (shape varies by version). */
export function extractAgentMessage(jsonl: string): string {
  let text = "";
  for (const line of jsonl.split("\n")) {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const item = ev.item ?? ev.msg ?? ev;
    const kind = String(item.item_type ?? item.type ?? "");
    if (kind.includes("agent_message") && typeof item.text === "string") {
      text = item.text;
    }
  }
  return text;
}
