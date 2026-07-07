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
import { spawnSync, spawn } from 'child_process';
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

function binaryAvailable(name: string): boolean {
  try {
    return spawnSync('which', [name], { timeout: 3000 }).status === 0;
  } catch {
    return false;
  }
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

function engineKey(name: BackendName, t: RemoteTransport | null): string {
  return t ? `${name}:ssh:${t.user}@${t.host ?? 'localhost'}:${t.port}:${t.bin}` : name;
}

function getEngine(name: BackendName, t: RemoteTransport | null): AutocompleteEngine {
  const key = engineKey(name, t);
  let engine = engines.get(key);
  if (!engine) {
    const backend =
      name === 'codex'
        ? new CodexBackend({
            codexHome: t ? undefined : process.env.NEBULA_AUTOCOMPLETE_CODEX_HOME,
            transport: t ? toSsh(t) : { kind: 'local' },
          })
        : new ClaudeBackend({ transport: t ? toSsh(t) : { kind: 'local' } });
    engine = new AutocompleteEngine({ backend });
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
function discoverRemoteBin(port: number, user: string, provider: BackendName, host = 'localhost'): string | null {
  if (!Number.isInteger(port) || !/^[A-Za-z0-9._-]+$/.test(user)) return null;
  // `whence -p` FIRST: on the user's machine `claude`/`codex` is typically a zsh
  // FUNCTION, so `command -v` returns the function name (not a path) and would
  // short-circuit. `whence -p` (zsh) resolves the actual binary; `command -v` is
  // the fallback for non-zsh login shells (where `whence` doesn't exist).
  const remote = `$SHELL -lic 'printf "NB_BIN=%s\\n" "$(whence -p ${provider} 2>/dev/null || command -v ${provider} 2>/dev/null)"' 2>/dev/null`;
  const res = spawnSync(
    'ssh',
    ['-p', String(port), '-o', 'ProxyCommand=none', '-o', 'StrictHostKeyChecking=accept-new',
     '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', `${user}@${host}`, remote],
    { timeout: 12000, encoding: 'utf-8' },
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
function checkCliUsable(name: BackendName): Promise<{ installed: boolean; usable: boolean; detail: string }> {
  return new Promise((resolve) => {
    if (!binaryAvailable(name)) return resolve({ installed: false, usable: false, detail: 'not installed on this server' });
    const cfg = `/tmp/nebula-diag-${name}-${process.pid}-${Math.round(process.hrtime()[1])}`;
    const args =
      name === 'claude'
        ? ['-p', 'reply with just: ok', '--model', 'haiku']
        : ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never', '--ephemeral', '-m', 'gpt-5.4-mini', 'reply ok'];
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
  /** Which CLI backends are usable on THIS server (for the settings UI). */
  fastify.get('/autocomplete/status', async (_req: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      enabled: true,
      backends: {
        claude: binaryAvailable('claude'),
        codex: binaryAvailable('codex'),
      },
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
    const claude = discoverRemoteBin(port, user, 'claude', host);
    const codex = discoverRemoteBin(port, user, 'codex', host);
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
      const rc = discoverRemoteBin(port, user, 'claude', host);
      const rx = discoverRemoteBin(port, user, 'codex', host);
      tunnel = { configured: true, reachable: rc !== null || rx !== null, claude: rc, codex: rx };
    }
    return reply.send({ environment: getEnvironment(), server: { claude, codex }, tunnel });
  });

  /** POST /autocomplete — SSE stream. Body may include `transport` to run the
   *  CLI on the user's machine instead of this server. */
  registerAutocompleteRoute(fastify, (req: CompletionRequest) => {
    const t = parseTransport((req as unknown as { transport?: unknown }).transport);
    return getEngine(req.backend === 'codex' ? 'codex' : 'claude', t);
  });

  fastify.addHook('onClose', async () => {
    disposeAutocompleteEngines();
  });
}
