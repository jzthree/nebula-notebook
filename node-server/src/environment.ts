/**
 * Environment awareness — where is this Nebula server running relative to the user?
 *
 * The "run the agent / autocomplete on this server vs. my machine" choice only
 * makes sense when the server ISN'T the user's own machine. This detects the
 * server's context so the UI can collapse that choice when it's meaningless
 * (a local install) and surface it when it matters (a cluster/remote server).
 *
 *   kind = 'cluster'  → a scheduler (SLURM) is present: shared HPC login/compute node
 *   kind = 'local'    → a personal machine (desktop OS, no scheduler)
 *   kind = 'server'   → some other remote host (no scheduler, not a desktop)
 *
 * Override with NEBULA_ENV=local|cluster|server when the heuristic is wrong
 * (e.g. a headless Linux workstation you use locally, or a cloud VM you tunnel to).
 */
import * as os from 'os';
import { allocationService } from './scheduler/allocation-service';

export type EnvironmentKind = 'local' | 'cluster' | 'server';

export interface EnvironmentInfo {
  kind: EnvironmentKind;
  hostname: string;
  platform: NodeJS.Platform;
  scheduler: string | null;
}

let cached: EnvironmentInfo | null = null;

function detectKind(scheduler: string | null, platform: NodeJS.Platform): EnvironmentKind {
  const override = (process.env.NEBULA_ENV || '').toLowerCase();
  if (override === 'local' || override === 'cluster' || override === 'server') return override;
  if (scheduler) return 'cluster';
  if (platform === 'darwin') return 'local';
  // A Linux host with no scheduler is ambiguous (personal workstation vs remote
  // box). Default to 'local' so a single-user install doesn't nag about tunnels;
  // remote-server users set NEBULA_ENV=server (or override in the UI).
  return 'local';
}

export function getEnvironment(): EnvironmentInfo {
  if (cached) return cached;
  const scheduler = allocationService.isEnabled()
    ? (allocationService.getScheduler()?.name ?? null)
    : null;
  const platform = os.platform();
  cached = { kind: detectKind(scheduler, platform), hostname: os.hostname(), platform, scheduler };
  return cached;
}
