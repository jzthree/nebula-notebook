/**
 * Environment awareness — where is this Nebula server running relative to the user?
 *
 * The "run the agent / autocomplete on this server vs. my machine" choice only
 * makes sense when the server ISN'T the user's own machine. This detects the
 * server's context so the UI can collapse that choice when it's meaningless
 * (a local install) and surface it when it matters (a cluster/remote server).
 *
 *   kind = 'cluster'  → a scheduler (SLURM) is present: shared HPC login/compute node
 *   kind = 'local'    → a personal machine (desktop OS / desktop session)
 *   kind = 'server'   → some other remote host (headless, reached over ssh)
 *
 * Signals, most→least decisive:
 *   NEBULA_ENV override → whatever it says (confidence: high)
 *   scheduler present   → cluster                (high)
 *   darwin              → local                  (high)
 *   started inside ssh  → server                 (high — the user reaches this box remotely)
 *   desktop session     → local                  (high — DISPLAY/Wayland ⇒ someone sits here)
 *   headless linux, none of the above → local (safe default) but confidence:
 *   'ambiguous' — the UI asks the user ONCE and stores their answer.
 *
 * Override with NEBULA_ENV=local|cluster|server, or per-user in the client
 * settings (environmentOverride) — the client override always wins in the UI.
 */
import * as os from 'os';
import { allocationService } from './scheduler/allocation-service';

export type EnvironmentKind = 'local' | 'cluster' | 'server';

export interface EnvironmentInfo {
  kind: EnvironmentKind;
  /** 'high' = trust it; 'ambiguous' = the UI should ask the user once. */
  confidence: 'high' | 'ambiguous';
  /** Human-readable one-liner for the settings UI ("SLURM detected", …). */
  reason: string;
  hostname: string;
  platform: NodeJS.Platform;
  scheduler: string | null;
}

function detect(scheduler: string | null, platform: NodeJS.Platform): Pick<EnvironmentInfo, 'kind' | 'confidence' | 'reason'> {
  const override = (process.env.NEBULA_ENV || '').toLowerCase();
  if (override === 'local' || override === 'cluster' || override === 'server') {
    return { kind: override, confidence: 'high', reason: `NEBULA_ENV=${override}` };
  }
  if (scheduler) {
    return { kind: 'cluster', confidence: 'high', reason: `${scheduler} scheduler detected` };
  }
  if (platform === 'darwin') {
    return { kind: 'local', confidence: 'high', reason: 'macOS — a personal machine' };
  }
  // Started from inside an ssh session → the user reaches this box remotely.
  if (process.env.SSH_CONNECTION || process.env.SSH_TTY || process.env.SSH_CLIENT) {
    return { kind: 'server', confidence: 'high', reason: 'server was started over SSH' };
  }
  // A desktop session on Linux → someone sits at this machine.
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === 'x11' || process.env.XDG_SESSION_TYPE === 'wayland') {
    return { kind: 'local', confidence: 'high', reason: 'Linux desktop session detected' };
  }
  // Headless Linux, no scheduler, not launched over ssh (e.g. systemd unit,
  // container, tmux that outlived its ssh). Could be a workstation or a remote
  // box — default local (never nag a single-user install) but flag it so the
  // UI can ask the user once instead of silently guessing.
  return {
    kind: 'local',
    confidence: 'ambiguous',
    reason: 'headless Linux with no scheduler — could be your workstation or a remote box',
  };
}

export function getEnvironment(): EnvironmentInfo {
  // NO caching: scheduler detection completes asynchronously after boot, and
  // the first /api/health frequently arrives before it (startup health polls,
  // the browser tab reconnecting) — caching that first answer froze
  // kind='local' onto SLURM login nodes for the server's whole lifetime.
  // Recomputing is two method calls + os lookups; the answer self-corrects
  // the moment scheduler detection lands.
  const scheduler = allocationService.isEnabled()
    ? (allocationService.getScheduler()?.name ?? null)
    : null;
  const platform = os.platform();
  return { ...detect(scheduler, platform), hostname: os.hostname(), platform, scheduler };
}
