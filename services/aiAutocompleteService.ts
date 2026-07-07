/**
 * AI Autocomplete Service — client bridge to the nebula-autocomplete engine
 * running in the node server (POST /api/autocomplete, SSE).
 *
 * The feature is a per-user, client-side setting (`aiAutocomplete` in
 * nebula-settings), mirroring how remoteAgentEnabled is gated. Components that
 * need to react to toggle changes listen for SETTINGS_CHANGED_EVENT, which
 * SettingsModal / the welcome card dispatch after saving.
 */
import { createCompletionFetcher } from 'nebula-autocomplete/client';
import type { GhostTextFetcher } from 'nebula-autocomplete/codemirror';
import { authService } from './authService';
import { getSettings, saveSettings } from './settingsService';
import { serverIsRemote, fetchEnvironment } from './environmentService';

export const SETTINGS_CHANGED_EVENT = 'nebula-settings-changed';

/**
 * Notebook-level hints for autocomplete (kernel, filename). Set by the Notebook
 * when the kernel/file changes; read by the ghost-text fetcher. Global (like
 * settings) so we don't thread props through every cell editor. We pass these as
 * HINTS and let the model infer the language rather than hardcoding it.
 */
let autocompleteContext: { kernelName?: string; filename?: string } = {};
export function setAutocompleteContext(ctx: { kernelName?: string; filename?: string }): void {
  autocompleteContext = { ...autocompleteContext, ...ctx };
}

export function notifySettingsChanged(): void {
  window.dispatchEvent(new Event(SETTINGS_CHANGED_EVENT));
}

export function isAiAutocompleteEnabled(): boolean {
  return getSettings().aiAutocomplete === true;
}

/** undefined = the user has not decided yet (drives the first-run prompt). */
export function isAiAutocompleteDecided(): boolean {
  return getSettings().aiAutocomplete !== undefined;
}

export function setAiAutocomplete(enabled: boolean, backend?: 'claude' | 'codex'): void {
  saveSettings({
    aiAutocomplete: enabled,
    ...(backend ? { aiAutocompleteBackend: backend } : {}),
  });
  notifySettingsChanged();
}

const fetchCompletion = createCompletionFetcher('/api/autocomplete', {
  headers: () => ({ ...(authService.getAuthHeaders() as Record<string, string>) }),
});

/**
 * True when the user wants CLIs to run on their own machine. Follows the
 * explicit `agentRunsOn` choice, but also treats an enabled remote-agent (the
 * agent terminal's "my machine" mode) as implying it — so autocomplete follows
 * the agent onto the tunnel even if the where-selector was never touched.
 */
function wantsRemoteMachine(): boolean {
  // On a LOCAL server there is no "my machine" vs "server" — the server IS your
  // machine. Never treat it as remote, even if a stale remoteAgent flag lingers.
  if (!serverIsRemote()) return false;
  const s = getSettings();
  if (s.agentRunsOn === 'mine') return true;
  if (s.agentRunsOn === 'server') return false;
  return s.remoteAgentEnabled === true; // undecided → follow the agent's mode
}

/** "Run on my machine" transport for the selected backend, or undefined to run
 *  on the server. Needs the reverse-tunnel params + a probed remote binary. */
function buildAutocompleteTransport(
  backend: 'claude' | 'codex',
): { port: number; user: string; bin: string } | undefined {
  if (!wantsRemoteMachine()) return undefined;
  const s = getSettings();
  const port = s.remoteAgentPort;
  const user = s.remoteAgentUser?.trim();
  const bin = (backend === 'codex' ? s.remoteCodexBin : s.remoteClaudeBin)?.trim();
  if (!port || !user || !bin) return undefined;
  return { port, user, bin };
}

/**
 * Ask the server to resolve the user's own claude/codex paths over the reverse
 * tunnel and cache them in settings. Call when the user opts into "run on my
 * machine". Returns which providers were found.
 */
type ProbeResult = { claude: string | null; codex: string | null; reachable: boolean };
let probeInflight: Promise<ProbeResult | null> | null = null;

export async function probeRemoteBins(): Promise<ProbeResult | null> {
  if (probeInflight) return probeInflight; // dedupe concurrent callers (e.g. burst of completions)
  const s = getSettings();
  if (!s.remoteAgentPort || !s.remoteAgentUser?.trim()) return null;
  probeInflight = (async () => {
    try {
      const resp = await fetch('/api/autocomplete/probe-remote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(authService.getAuthHeaders() as Record<string, string>) },
        body: JSON.stringify({ port: s.remoteAgentPort, user: s.remoteAgentUser!.trim() }),
      });
      if (!resp.ok) return null;
      const data = await resp.json();
      saveSettings({ remoteClaudeBin: data.claude ?? '', remoteCodexBin: data.codex ?? '' });
      notifySettingsChanged();
      return { claude: data.claude ?? null, codex: data.codex ?? null, reachable: !!data.reachable };
    } catch {
      return null;
    } finally {
      probeInflight = null;
    }
  })();
  return probeInflight;
}

export interface CliStatus { installed: boolean; usable: boolean; detail: string }
export interface Diagnostics {
  environment: { kind: string; hostname: string; platform: string; scheduler: string | null };
  server: { claude: CliStatus; codex: CliStatus };
  tunnel: null | { configured: boolean; reachable: boolean; claude: string | null; codex: string | null };
}

/** Full diagnostics for the AI settings tab: environment, server CLI login
 *  status, and (if the tunnel is configured) reachability + resolved paths. */
export async function runDiagnostics(): Promise<Diagnostics | null> {
  const s = getSettings();
  const body: { port?: number; user?: string } = {};
  if (s.remoteAgentPort && s.remoteAgentUser?.trim()) {
    body.port = s.remoteAgentPort;
    body.user = s.remoteAgentUser.trim();
  }
  try {
    const resp = await fetch('/api/autocomplete/diagnose', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(authService.getAuthHeaders() as Record<string, string>) },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Diagnostics;
  } catch {
    return null;
  }
}

/** Run one real sample completion and report where it ran + latency, for the
 *  "Test" button. Mirrors the live ghost-text path (probe + transport). Uses a
 *  unique prefix so it never hits the engine cache (a real, timed round-trip). */
export async function testCompletion(): Promise<{
  ok: boolean; text: string; ranOn: 'this server' | 'local machine'; ms?: number; fromCache?: boolean; error?: string;
}> {
  const backend = getSettings().aiAutocompleteBackend ?? 'claude';
  let transport = buildAutocompleteTransport(backend);
  if (!transport && wantsRemoteMachine()) {
    await probeRemoteBins();
    transport = buildAutocompleteTransport(backend);
  }
  const ranOn = transport ? 'local machine' : 'this server';
  // Cache-bust: a unique marker in the prefix + sessionKey guarantees a fresh
  // completion, so the reported time is a real round-trip, not a cache hit.
  const marker = Math.random().toString(36).slice(2, 8);
  const t0 = performance.now();
  try {
    const result = await fetchCompletion(
      { prefix: `# selftest ${marker}\ndef add(a, b):\n    `, suffix: '', language: 'python', sessionKey: `diag-${marker}`, backend, ...(transport ? { transport } : {}) } as Parameters<typeof fetchCompletion>[0],
      {},
    );
    return { ok: true, text: result.text, ranOn, ms: Math.round(performance.now() - t0), fromCache: !!result.fromCache };
  } catch (e) {
    return { ok: false, text: '', ranOn, ms: Math.round(performance.now() - t0), error: e instanceof Error ? e.message : String(e) };
  }
}

/** Which CLI backends are usable on the Nebula server itself. */
export async function fetchServerBackends(): Promise<{ claude: boolean; codex: boolean } | null> {
  try {
    const resp = await fetch('/api/autocomplete/status', {
      headers: { ...(authService.getAuthHeaders() as Record<string, string>) },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return { claude: !!data?.backends?.claude, codex: !!data?.backends?.codex };
  } catch {
    return null;
  }
}

/**
 * Ghost-text fetcher for CodeEditor: sends the cursor context plus all cell
 * contents (for cross-cell awareness) to the server engine.
 */
export function createAiGhostTextFetcher(
  cellsRef: React.RefObject<Array<{ type: string; content: string }>>,
  cellId?: string,
): GhostTextFetcher {
  return async ({ prefix, suffix }, { signal, onChunk }) => {
    const raw = cellsRef.current ?? [];
    const cells = raw.map((c) => ({
      type: c.type === 'markdown' ? ('markdown' as const) : ('code' as const),
      content: c.content,
    }));
    const activeCellIndex = raw.findIndex((c) => c.content === prefix + suffix);
    // Make sure we know whether the server is remote before the mine-mode logic
    // below (cached after first call). On a local server this keeps us running on
    // the server (= your machine) instead of hunting for a nonexistent tunnel.
    await fetchEnvironment();
    const backend = getSettings().aiAutocompleteBackend ?? 'claude';
    let transport = buildAutocompleteTransport(backend);
    // Self-heal: the user wants their own machine and the tunnel is configured,
    // but we haven't resolved their CLI path yet — probe once, then retry. Avoids
    // silently falling back to the server (whose CLI may not be logged in).
    if (!transport && wantsRemoteMachine()) {
      const s = getSettings();
      if (s.remoteAgentPort && s.remoteAgentUser?.trim()) {
        await probeRemoteBins();
        transport = buildAutocompleteTransport(backend);
      }
    }
    // User wants their own machine but we can't reach its CLI — skip rather than
    // fall back to the server (whose CLI may not be logged in and would surface a
    // misleading error).
    if (!transport && wantsRemoteMachine()) return '';
    const result = await fetchCompletion(
      {
        prefix,
        suffix,
        // Hints only — no hardcoded language. The model infers it from the code
        // plus the current kernel/filename.
        ...(autocompleteContext.kernelName ? { kernelName: autocompleteContext.kernelName } : {}),
        ...(autocompleteContext.filename ? { filename: autocompleteContext.filename } : {}),
        cells,
        ...(activeCellIndex >= 0 ? { activeCellIndex } : {}),
        sessionKey: cellId ?? 'default-cell',
        backend,
        ...(transport ? { transport } : {}),
      } as Parameters<typeof fetchCompletion>[0],
      { signal, onChunk },
    );
    return result.text;
  };
}
