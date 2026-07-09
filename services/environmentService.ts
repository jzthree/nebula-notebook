/**
 * Environment awareness (client).
 *
 * One source of truth for "is the Nebula server the user's own machine, or a
 * remote host?" — which decides whether the "run the agent / autocomplete on
 * this server vs. my machine" choice is even shown. When the server is local,
 * that choice is meaningless (the server IS your machine) and the UI collapses
 * it away; when remote, it's surfaced.
 *
 * Source: /api/health `environment` (server-detected), with a user override in
 * settings for the cases the heuristic can't know (a headless local Linux box,
 * or a cloud VM you tunnel to).
 */
import { getSettings } from './settingsService';

export type EnvironmentKind = 'local' | 'cluster' | 'server';

export interface EnvironmentInfo {
  kind: EnvironmentKind;
  /** 'high' = trust the detection; 'ambiguous' = ask the user once. */
  confidence: 'high' | 'ambiguous';
  /** Human-readable detection reason ("SLURM scheduler detected", ...). */
  reason: string;
  hostname: string;
  platform: string;
  scheduler: string | null;
}

let cached: EnvironmentInfo | null = null;
let cachedAt = 0;
let inflight: Promise<EnvironmentInfo | null> | null = null;

// TTL, not cache-forever: right after a server (re)start the server can answer
// health before its scheduler detection finishes, briefly self-reporting
// 'local' on a cluster login node. A short TTL lets the client converge on the
// settled answer instead of freezing the boot-race result for the tab's life.
const ENV_CACHE_TTL_MS = 30_000;

/** Fetch the server's self-reported environment (30s cache). Null if unreachable. */
export async function fetchEnvironment(): Promise<EnvironmentInfo | null> {
  if (cached && Date.now() - cachedAt < ENV_CACHE_TTL_MS) return cached;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const res = await fetch('/api/health');
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const env = data?.environment;
      if (env && typeof env.kind === 'string') {
        cached = {
          kind: env.kind,
          confidence: env.confidence === 'ambiguous' ? 'ambiguous' : 'high',
          reason: typeof env.reason === 'string' ? env.reason : '',
          hostname: typeof env.hostname === 'string' ? env.hostname : '',
          platform: typeof env.platform === 'string' ? env.platform : '',
          scheduler: typeof env.scheduler === 'string' ? env.scheduler : null,
        };
        cachedAt = Date.now();
        return cached;
      }
      return null;
    } catch {
      return null;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Synchronously read the last-fetched environment (null before first fetch). */
export function getCachedEnvironment(): EnvironmentInfo | null {
  return cached;
}

/**
 * Is the Nebula server remote from the user (so "run on server vs my machine"
 * is a real choice)? User override wins; otherwise anything that isn't a local
 * install counts as remote. Defaults to false (local) until the environment is
 * known, so a fresh local install never flashes remote-only UI.
 */
export function serverIsRemote(env: EnvironmentInfo | null = cached): boolean {
  const override = getSettings().environmentOverride;
  if (override === 'remote') return true;
  if (override === 'local') return false;
  return !!env && env.kind !== 'local';
}

/** A short human label for where the server runs, for status chips. */
export function environmentLabel(env: EnvironmentInfo | null = cached): string {
  if (!env) return '';
  if (env.kind === 'cluster') return env.hostname ? `${env.hostname} (cluster)` : 'cluster';
  if (env.kind === 'server') return env.hostname || 'remote server';
  return 'this machine';
}

/**
 * Should the UI ask the user where this server runs? True only when the
 * server itself says its detection is ambiguous (headless Linux, no
 * scheduler, not launched over ssh) AND the user hasn't answered yet
 * (environmentOverride unset). Everything else resolves silently.
 */
export function environmentNeedsUserChoice(env: EnvironmentInfo | null = cached): boolean {
  if (!env || env.confidence !== 'ambiguous') return false;
  const override = getSettings().environmentOverride;
  return override !== 'local' && override !== 'remote';
}
