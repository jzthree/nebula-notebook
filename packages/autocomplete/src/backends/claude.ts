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
  /** Per-turn timeout. Default 45_000 ms. */
  turnTimeoutMs?: number;
  /** Working directory for workers — keep it empty so no CLAUDE.md loads. */
  workspaceDir?: string;
  /** Path to the claude binary. Default "claude". */
  binary?: string;
  /** Where the claude process runs: locally (default) or over ssh on the user's
   *  machine (remote Nebula + local agent). Default { kind: "local" }. */
  transport?: Transport;
}

function isWorkerDeath(err: unknown): boolean {
  return err instanceof Error && err.message === "claude worker exited";
}

interface PendingTurn {
  onChunk?: (text: string) => void;
  resolve: (full: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class ClaudeWorker {
  busy = false;
  dead = false;
  turns = 0;
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
      CLAUDE_CODE_MAX_OUTPUT_TOKENS: "512",
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
    });
    this.proc.on("error", (err) => {
      this.dead = true;
      this.pending?.reject(err instanceof Error ? err : new Error(String(err)));
      this.pending = null;
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
          this.pending.onChunk?.(event.delta.text);
        }
      } else if (ev.type === "result") {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p!.timer);
        p!.resolve(typeof ev.result === "string" ? ev.result : "");
      }
    }
  }

  runTurn(text: string, onChunk?: (t: string) => void): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      if (this.dead) return reject(new Error("claude worker is dead"));
      const timer = setTimeout(() => {
        this.pending = null;
        this.kill();
        reject(new Error("claude turn timed out"));
      }, this.opts.turnTimeoutMs);
      this.pending = { onChunk, resolve, reject, timer };
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
      maxTurnsPerWorker: options.maxTurnsPerWorker ?? 8,
      turnTimeoutMs: options.turnTimeoutMs ?? 45_000,
      // Default to a per-instance dir so the transcript-dir name is unique to
      // this backend. A caller-supplied dir is used verbatim (its transcripts
      // are then only pruned if its basename happens to contain wsToken — so
      // prefer letting the default apply for full hygiene).
      workspaceDir:
        options.workspaceDir ?? join(tmpdir(), `nebula-autocomplete-ws-${this.wsToken}`),
      binary: options.binary ?? "claude",
      transport,
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
      this.pool.push(new ClaudeWorker(this.opts));
    }
  }

  async complete(
    prompt: string,
    { signal, onChunk }: { signal?: AbortSignal; onChunk?: (t: string) => void } = {},
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
      return await this.attempt(prompt, signal, guard, false);
    } catch (err) {
      if (this.disposed || signal?.aborted || emitted || !isWorkerDeath(err)) throw err;
      return await this.attempt(prompt, signal, guard, true);
    }
  }

  private async attempt(
    prompt: string,
    signal: AbortSignal | undefined,
    guard: (t: string) => void,
    forceFresh: boolean,
  ): Promise<string> {
    this.ensurePool();
    let worker = forceFresh ? undefined : this.pool.find((w) => !w.busy && !w.dead);
    if (!worker) {
      worker = new ClaudeWorker(this.opts);
      this.pool.push(worker);
    }
    worker.busy = true;
    // Always wait for the warmup turn: dispatching while it is in flight
    // would steal its pending handler and resolve with the warmup's output.
    await worker.warmed;
    try {
      const full = await worker.runTurn(prompt, guard);
      signal?.throwIfAborted();
      return full;
    } finally {
      worker.turns += 1;
      worker.busy = false;
      if (worker.turns >= this.opts.maxTurnsPerWorker || worker.dead) {
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
