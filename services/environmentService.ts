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
  hostname: string;
  platform: string;
  scheduler: string | null;
}

let cached: EnvironmentInfo | null = null;
let inflight: Promise<EnvironmentInfo | null> | null = null;

/** Fetch (once) the server's self-reported environment. Null if unreachable. */
export async function fetchEnvironment(): Promise<EnvironmentInfo | null> {
  if (cached) return cached;
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
          hostname: typeof env.hostname === 'string' ? env.hostname : '',
          platform: typeof env.platform === 'string' ? env.platform : '',
          scheduler: typeof env.scheduler === 'string' ? env.scheduler : null,
        };
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
