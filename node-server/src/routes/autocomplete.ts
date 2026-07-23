/**
 * AI autocomplete API — inline code completions for notebook cells.
 *
 * Routes live under /api and are auth-protected like the rest of the API.
 * Backed by the nebula-autocomplete engine, which drives a Claude Code / Codex
 * CLI using the user's own subscription. The CLI can run in one of two places:
 *
 *   - on THIS server (default) — when the Nebula host itself has claude/codex
 *     (a local install, or a login node where the CLIs are available);
 *   - on the USER'S machine over the reverse SSH tunnel ("run on my machine") —
 *     for remote Nebula where the user would rather use their own laptop's CLI +
 *     subscription. See the `transport` field on the completion request.
 *
 * Engines are created lazily and cached per (backend, transport) so a warm pool
 * is reused across turns; disposed on server shutdown.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { spawn } from 'child_process';
import { getEnvironment } from '../environment';
import {
  AutocompleteEngine,
  ClaudeBackend,
  CodexBackend,
  type CompletionRequest,
  type SshTransport,
} from 'nebula-autocomplete';
import { registerAutocompleteRoute } from 'nebula-autocomplete/server';

type BackendName = 'claude' | 'codex';

/** Per-request "run on my machine" transport, sent by the client when it wants
 *  the CLI to run on the user's laptop over the reverse tunnel. */
interface RemoteTransport {
  port: number;   // reverse-tunnel port on this host → user's sshd
  user: string;   // username on the user's machine
  bin: string;    // absolute path to the provider CLI on the user's machine
  host?: string;  // default 'localhost'
}

const engines = new Map<string, AutocompleteEngine>();

/**
 * Async command runner. NEVER use spawnSync here: these probes run ssh calls
 * that can take 10+ seconds, and spawnSync freezes Node's event loop — which
 * stalls EVERYTHING the server does (terminal WS input, API responses), felt
 * as "the whole app is unresponsive for ~10s after a refresh".
 */
function runCmd(cmd: string, args: string[], timeoutMs: number): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (status: number | null) => { if (!done) { done = true; resolve({ status, stdout: out }); } };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } finish(null); }, timeoutMs);
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.on('error', () => { clearTimeout(timer); finish(null); });
    proc.on('exit', (code) => { clearTimeout(timer); finish(code); });
  });
}

async function binaryAvailable(name: string): Promise<boolean> {
  return (await runCmd('which', [name], 3000)).status === 0;
}

/** Parse + validate a client-supplied transport (untrusted input). */
function parseTransport(raw: unknown): RemoteTransport | null {
  if (!raw || typeof raw !== 'object') return null;
  const t = raw as Record<string, unknown>;
  const port = Number(t.port);
  const user = typeof t.user === 'string' ? t.user.trim() : '';
  const bin = typeof t.bin === 'string' ? t.bin.trim() : '';
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (!user || !/^[A-Za-z0-9._-]+$/.test(user)) return null;
  if (!bin.startsWith('/')) return null; // must be an absolute path
  const host = typeof t.host === 'string' && t.host.trim() ? t.host.trim() : 'localhost';
  return { port, user, bin, host };
}

function toSsh(t: RemoteTransport): SshTransport {
  return { kind: 'ssh', host: t.host ?? 'localhost', port: t.port, user: t.user, remoteBin: t.bin };
}

/** Tuning accepted from the client (Advanced settings), sanitized here. */
interface EngineTuning {
  model: string;          // whitelisted per backend
  thinkingTokens: number; // 0 = off
}

function sanitizeTuning(name: BackendName, raw: Record<string, unknown>): EngineTuning {
  // Experimental tuning surface: any shell-safe model id is allowed (it's the
  // user's own CLI/subscription; a bad id just fails the worker's warmup
  // visibly). Pattern-gated so nothing hostile reaches the spawn argv.
  let model = typeof raw.model === 'string' ? raw.model.trim().toLowerCase() : '';
  if (name === 'claude') {
    // Default sonnet (was haiku): BENCHMARKED (eval/bench.mjs, 54 samples/config,
    // interleaved) — sonnet ttfb p50 1086ms vs haiku 987ms (+10%, fixed API
    // overhead dominates short completions) while fixing haiku's context
    // failures (100% vs 94% ctx-accuracy). Thinking: on haiku it engages
    // every turn (probed: ~1-1.5k chars) = 3-8s of non-streaming dead air; on
    // sonnet MAX_THINKING_TOKENS never engages at all for completion-sized
    // prompts (probed: 0 thinking chars, 4/4), so it can't help there either.
    model = /^[a-z0-9][a-z0-9._:-]{0,63}$/.test(model) ? model : 'sonnet';
  } else model = ''; // codex: fixed model
  const rawTokens = Number((raw as { thinkingTokens?: unknown }).thinkingTokens);
  const thinkingTokens = Number.isFinite(rawTokens)
    ? Math.min(16_000, Math.max(0, Math.round(rawTokens)))
    : raw.thinking === true ? 4096 : 0;
  return { model, thinkingTokens };
}

function engineKey(name: BackendName, t: RemoteTransport | null, tune: EngineTuning): string {
  const base = t ? `${name}:ssh:${t.user}@${t.host ?? 'localhost'}:${t.port}:${t.bin}` : name;
  return `${base}:${tune.model}:${tune.thinkingTokens}`;
}

function getEngine(name: BackendName, t: RemoteTransport | null, tune: EngineTuning): AutocompleteEngine {
  const key = engineKey(name, t, tune);
  let engine = engines.get(key);
  if (!engine) {
    const backend =
      name === 'codex'
        ? new CodexBackend({
            codexHome: t ? undefined : process.env.NEBULA_AUTOCOMPLETE_CODEX_HOME,
            transport: t ? toSsh(t) : { kind: 'local' },
          })
        : new ClaudeBackend({
            transport: t ? toSsh(t) : { kind: 'local' },
            ...(tune.model ? { model: tune.model } : {}),
            maxThinkingTokens: tune.thinkingTokens,
          });
    // contextBudget 20000: field testing showed 20k chars of context leaves
    // latency essentially unchanged (worker history is prefix-cached; only the
    // new message is uncached) — an earlier small A/B suggesting otherwise was
    // cache/variance artifact. 20k covers the whole notebook in most cases;
    // per-request overrides (Advanced settings) are clamped inside the engine.
    engine = new AutocompleteEngine({ backend, contextBudget: 20_000 });
    engines.set(key, engine);
  }
  return engine;
}

export function disposeAutocompleteEngines(): void {
  for (const engine of engines.values()) engine.dispose();
  engines.clear();
}

/**
 * Discover the absolute path of a provider CLI on the user's machine over the
 * reverse tunnel (PATH isn't set for a non-interactive ssh, so running the CLI
 * needs an absolute path). Uses a login shell + a sentinel so rc-file noise
 * doesn't corrupt the result. Best-effort; returns null on any failure.
 */
async function discoverRemoteBin(port: number, user: string, provider: BackendName, host = 'localhost'): Promise<string | null> {
  if (!Number.isInteger(port) || !/^[A-Za-z0-9._-]+$/.test(user)) return null;
  // `whence -p` FIRST: on the user's machine `claude`/`codex` is typically a zsh
  // FUNCTION, so `command -v` returns the function name (not a path) and would
  // short-circuit. `whence -p` (zsh) resolves the actual binary; `command -v` is
  // the fallback for non-zsh login shells (where `whence` doesn't exist).
  const remote = `$SHELL -lic 'printf "NB_BIN=%s\\n" "$(whence -p ${provider} 2>/dev/null || command -v ${provider} 2>/dev/null)"' 2>/dev/null`;
  const res = await runCmd(
    'ssh',
    ['-p', String(port), '-o', 'ProxyCommand=none', '-o', 'StrictHostKeyChecking=accept-new',
     '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@${host}`, remote],
    12000,
  );
  if (res.status !== 0 || !res.stdout) return null;
  const line = res.stdout.split('\n').find((l) => l.startsWith('NB_BIN='));
  const bin = line ? line.slice('NB_BIN='.length).trim() : '';
  return bin.startsWith('/') ? bin : null;
}

/**
 * Actually RUN a provider CLI on THIS server with a trivial prompt to tell
 * "installed" from "usable" (logged in). Bounded + best-effort. Returns a status
 * the diagnostics UI can render.
 */
async function checkCliUsable(name: BackendName): Promise<{ installed: boolean; usable: boolean; detail: string }> {
  if (!(await binaryAvailable(name))) return { installed: false, usable: false, detail: 'not installed on this server' };
  return new Promise((resolve) => {
    const cfg = `/tmp/nebula-diag-${name}-${process.pid}-${Math.round(process.hrtime()[1])}`;
    const args =
      name === 'claude'
        ? ['-p', 'reply with just: ok', '--model', 'haiku']
        : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--ephemeral', '-m', 'gpt-5.6-luna', 'reply ok'];
    const env = { ...process.env, CLAUDE_CODE_MAX_OUTPUT_TOKENS: '64', CLAUDE_CONFIG_DIR: cfg } as NodeJS.ProcessEnv;
    let out = '', err = '', done = false;
    const finish = (r: { installed: boolean; usable: boolean; detail: string }) => { if (!done) { done = true; resolve(r); } };
    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(name, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      return finish({ installed: true, usable: false, detail: 'failed to launch' });
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* */ } finish({ installed: true, usable: false, detail: 'timed out (no response in 25s)' }); }, 25000);
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', () => { clearTimeout(timer); finish({ installed: true, usable: false, detail: 'failed to launch' }); });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const blob = (out + '\n' + err).toLowerCase();
      const authIssue = /log ?in|logged in|authenticat|unauthor|oauth|api key|credit balance|subscription|setup-token|not authenticated/.test(blob);
      if (authIssue) return finish({ installed: true, usable: false, detail: 'not logged in on this server' });
      if (code === 0 && out.trim()) return finish({ installed: true, usable: true, detail: 'logged in' });
      return finish({ installed: true, usable: false, detail: err.trim().slice(-160) || `exited ${code}` });
    });
  });
}

export default async function autocompleteRoutes(fastify: FastifyInstance) {
  /**
   * Which CLI backends are usable on THIS server (for the settings UI and the
   * editor's ghost-text gate). "Usable" means an actual trivial turn succeeds
   * (logged in), not merely that the binary exists — a binary without
   * credentials previously reported true here, so the UI enabled ghost text
   * that could only ever produce "Not logged in" errors. The real probe costs
   * a CLI round trip, so results are cached with a TTL.
   */
  let statusCache: { at: number; backends: { claude: boolean; codex: boolean } } | null = null;
  let statusProbe: Promise<{ claude: boolean; codex: boolean }> | null = null;
  const STATUS_TTL_MS = 5 * 60_000;

  fastify.get('/autocomplete/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    if (!statusCache || Date.now() - statusCache.at > STATUS_TTL_MS) {
      if (!statusProbe) {
        statusProbe = Promise.all([checkCliUsable('claude'), checkCliUsable('codex')])
          .then(([claude, codex]) => {
            const backends = { claude: claude.usable, codex: codex.usable };
            statusCache = { at: Date.now(), backends };
            return backends;
          })
          .finally(() => { statusProbe = null; });
      }
      await statusProbe;
    }
    return reply.send({
      enabled: true,
      backends: statusCache!.backends,
    });
  });

  /**
   * Resolve the user's local CLI paths over the reverse tunnel, so the client
   * can enable "run on my machine". Body: { port, user, host? }.
   * Returns { ok, reachable, claude, codex }.
   */
  fastify.post('/autocomplete/probe-remote', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const port = Number(body.port);
    const user = typeof body.user === 'string' ? body.user.trim() : '';
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : 'localhost';
    if (!Number.isInteger(port) || port <= 0 || !user) {
      return reply.code(400).send({ ok: false, error: 'port and user required' });
    }
    const [claude, codex] = await Promise.all([
      discoverRemoteBin(port, user, 'claude', host),
      discoverRemoteBin(port, user, 'codex', host),
    ]);
    return reply.send({ ok: true, reachable: claude !== null || codex !== null, claude, codex });
  });

  /**
   * Comprehensive diagnostics for the settings "AI" tab. Body: { port?, user? }.
   * Reports the environment, whether this server's CLIs are usable (logged in),
   * and — if tunnel params are given — whether the user's machine is reachable
   * and which CLIs resolve there.
   */
  fastify.post('/autocomplete/diagnose', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const port = Number(body.port);
    const user = typeof body.user === 'string' ? body.user.trim() : '';
    const host = typeof body.host === 'string' && body.host.trim() ? body.host.trim() : 'localhost';
    const hasTunnel = Number.isInteger(port) && port > 0 && !!user;

    const [claude, codex] = await Promise.all([checkCliUsable('claude'), checkCliUsable('codex')]);
    let tunnel: null | { configured: boolean; reachable: boolean; claude: string | null; codex: string | null } = null;
    if (hasTunnel) {
      const [rc, rx] = await Promise.all([
        discoverRemoteBin(port, user, 'claude', host),
        discoverRemoteBin(port, user, 'codex', host),
      ]);
      tunnel = { configured: true, reachable: rc !== null || rx !== null, claude: rc, codex: rx };
    }
    return reply.send({ environment: getEnvironment(), server: { claude, codex }, tunnel });
  });

  /** POST /autocomplete — SSE stream. Body may include `transport` to run the
   *  CLI on the user's machine instead of this server. */
  registerAutocompleteRoute(fastify, (req: CompletionRequest) => {
    const raw = req as unknown as Record<string, unknown>;
    const name: BackendName = req.backend === 'codex' ? 'codex' : 'claude';
    const t = parseTransport(raw.transport);
    return getEngine(name, t, sanitizeTuning(name, raw));
  });

  // Pre-warm the default local engine at server start: the first completion
  // after a server (re)start otherwise pays engine creation + pool spawn +
  // warmup turns on the user's keystroke (measured ~19s cold). Booting it
  // here moves that entirely off the request path. Best-effort; claude only
  // (the default backend — codex spawns per-request by design).
  void binaryAvailable('claude').then((ok) => {
    if (ok) getEngine('claude', null, { model: 'sonnet', thinkingTokens: 0 });
  }).catch(() => { /* pre-warm is opportunistic */ });

  fastify.addHook('onClose', async () => {
    disposeAutocompleteEngines();
  });
}
