/**
 * Idle auto-release for scheduler-launched client servers.
 *
 * Opt-in per allocation: when the compute-node client server is started with
 * NEBULA_IDLE_EXIT_MINUTES=<n>, it watches its own kernel and terminal
 * activity and exits its process after n idle minutes. The batch job then
 * completes and the allocation ends naturally — no scancel plumbing, no
 * scheduler-side state.
 *
 * "Idle" means all of:
 *   - no kernel session is busy (or still starting up), AND
 *   - the most recent kernel activity (execution start/finish, restart) is
 *     older than the timeout, AND
 *   - the most recent terminal (pty) activity is older than the timeout.
 *
 * The monitor's own start time is the initial activity baseline, so a fresh
 * allocation gets the full timeout before anything has run on it.
 */

/** How far before the exit we log the "run anything to keep it" warning. */
const WARN_LEAD_MINUTES = 5;

/**
 * Pure idleness decision — should the client server exit now?
 *
 * @param nowMs current time (ms since epoch)
 * @param lastKernelActivityMs most recent kernel activity (ms), or null if no signal
 * @param anyKernelBusy true when any kernel session is 'busy' or 'starting'
 * @param lastPtyActivityMs most recent terminal activity (ms), or null if no signal
 * @param timeoutMinutes idle timeout; <= 0 disables (never exit)
 */
export function shouldIdleExit(
  nowMs: number,
  lastKernelActivityMs: number | null,
  anyKernelBusy: boolean,
  lastPtyActivityMs: number | null,
  timeoutMinutes: number,
): boolean {
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) return false;
  if (anyKernelBusy) return false;
  const last = Math.max(lastKernelActivityMs ?? 0, lastPtyActivityMs ?? 0);
  if (last <= 0) return false; // no baseline at all — never guess
  return nowMs - last >= timeoutMinutes * 60_000;
}

export interface IdleExitMonitorOptions {
  /** Idle minutes before self-exit (from NEBULA_IDLE_EXIT_MINUTES). */
  timeoutMinutes: number;
  /** Kernel-side activity snapshot (kernelService.getIdleSnapshot). */
  getKernelSnapshot: () => { anyBusy: boolean; lastActivityMs: number | null };
  /** Most recent terminal activity across pty sessions (null = none). */
  getLastPtyActivityMs: () => number | null;
  /** Called once when ~WARN_LEAD_MINUTES remain (re-armed if activity resumes). */
  onWarn: (minutesLeft: number) => void;
  /** Called once when the idle timeout is reached. */
  onIdleExit: () => void | Promise<void>;
  /** Check interval; default 60s. Exposed for tests. */
  intervalMs?: number;
  /** Activity baseline; default Date.now() (start of monitoring). */
  startedAtMs?: number;
}

/**
 * Start the periodic idleness check. Returns a stop function.
 * The interval is unref()ed so it never keeps an exiting process alive.
 */
export function startIdleExitMonitor(opts: IdleExitMonitorOptions): () => void {
  const intervalMs = opts.intervalMs ?? 60_000;
  const startedAt = opts.startedAtMs ?? Date.now();
  let warned = false;
  let exiting = false;

  const tick = () => {
    if (exiting) return;
    const now = Date.now();
    const kernel = opts.getKernelSnapshot();
    // The monitor start counts as activity so a fresh, never-used allocation
    // still gets the full timeout before releasing itself.
    const lastKernel = Math.max(kernel.lastActivityMs ?? 0, startedAt);
    const lastPty = opts.getLastPtyActivityMs();

    if (shouldIdleExit(now, lastKernel, kernel.anyBusy, lastPty, opts.timeoutMinutes)) {
      exiting = true;
      clearInterval(timer);
      void opts.onIdleExit();
      return;
    }

    // Warn once when within WARN_LEAD_MINUTES of the cutoff; re-arm on activity.
    const last = Math.max(lastKernel, lastPty ?? 0);
    const idleMinutes = (now - last) / 60_000;
    const warnAt = opts.timeoutMinutes - WARN_LEAD_MINUTES;
    if (kernel.anyBusy || idleMinutes < warnAt) {
      warned = false;
    } else if (!warned && warnAt > 0) {
      warned = true;
      opts.onWarn(Math.max(1, Math.round(opts.timeoutMinutes - idleMinutes)));
    }
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
