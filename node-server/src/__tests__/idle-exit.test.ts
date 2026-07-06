/**
 * Idle auto-release — the pure idleness decision and the monitor wiring, plus
 * the job-template threading of NEBULA_IDLE_EXIT_MINUTES into the sbatch script.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { shouldIdleExit, startIdleExitMonitor } from '../idle-exit';
import { renderJobScript, type LaunchContext } from '../scheduler/job-template';
import type { JobSpec } from '../scheduler/types';

const MIN = 60_000;

describe('shouldIdleExit', () => {
  const now = 1_000_000 * MIN;

  it('exits when the last activity is older than the timeout', () => {
    expect(shouldIdleExit(now, now - 61 * MIN, false, null, 60)).toBe(true);
    expect(shouldIdleExit(now, now - 60 * MIN, false, null, 60)).toBe(true); // exact boundary
  });

  it('does not exit while activity is fresher than the timeout', () => {
    expect(shouldIdleExit(now, now - 59 * MIN, false, null, 60)).toBe(false);
    expect(shouldIdleExit(now, now - 1 * MIN, false, null, 60)).toBe(false);
  });

  it('never exits while any kernel is busy, however stale the timestamps', () => {
    expect(shouldIdleExit(now, now - 500 * MIN, true, now - 500 * MIN, 60)).toBe(false);
  });

  it('recent terminal activity keeps the allocation alive even with stale kernels', () => {
    expect(shouldIdleExit(now, now - 200 * MIN, false, now - 5 * MIN, 60)).toBe(false);
    expect(shouldIdleExit(now, now - 200 * MIN, false, now - 61 * MIN, 60)).toBe(true);
  });

  it('recent kernel activity keeps it alive even with stale terminals', () => {
    expect(shouldIdleExit(now, now - 5 * MIN, false, now - 200 * MIN, 60)).toBe(false);
  });

  it('takes the most recent of the two signals', () => {
    // pty newer than kernel and inside the window
    expect(shouldIdleExit(now, now - 90 * MIN, false, now - 30 * MIN, 60)).toBe(false);
    // both outside the window
    expect(shouldIdleExit(now, now - 90 * MIN, false, now - 70 * MIN, 60)).toBe(true);
  });

  it('is disabled for zero/negative/NaN timeouts', () => {
    expect(shouldIdleExit(now, now - 500 * MIN, false, null, 0)).toBe(false);
    expect(shouldIdleExit(now, now - 500 * MIN, false, null, -5)).toBe(false);
    expect(shouldIdleExit(now, now - 500 * MIN, false, null, NaN)).toBe(false);
  });

  it('never exits with no activity signal at all (no baseline to measure from)', () => {
    expect(shouldIdleExit(now, null, false, null, 60)).toBe(false);
  });
});

describe('startIdleExitMonitor', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function run(opts: {
    timeoutMinutes: number;
    kernel: () => { anyBusy: boolean; lastActivityMs: number | null };
    pty?: () => number | null;
  }) {
    const warns: number[] = [];
    let exited = false;
    const stop = startIdleExitMonitor({
      timeoutMinutes: opts.timeoutMinutes,
      getKernelSnapshot: opts.kernel,
      getLastPtyActivityMs: opts.pty ?? (() => null),
      onWarn: (m) => warns.push(m),
      onIdleExit: () => { exited = true; },
      intervalMs: MIN,
      startedAtMs: Date.now(),
    });
    return { warns, isExited: () => exited, stop };
  }

  it('warns ~5 minutes before the cutoff, then exits at the timeout', () => {
    vi.useFakeTimers();
    const m = run({ timeoutMinutes: 30, kernel: () => ({ anyBusy: false, lastActivityMs: null }) });

    vi.advanceTimersByTime(24 * MIN); // before the warn window
    expect(m.warns).toEqual([]);
    expect(m.isExited()).toBe(false);

    vi.advanceTimersByTime(2 * MIN); // 26m idle — inside warn window, warn once
    expect(m.warns.length).toBe(1);
    expect(m.warns[0]).toBeLessThanOrEqual(5);
    expect(m.isExited()).toBe(false);

    vi.advanceTimersByTime(3 * MIN); // still only one warning
    expect(m.warns.length).toBe(1);

    vi.advanceTimersByTime(2 * MIN); // past 30m — exit
    expect(m.isExited()).toBe(true);
    m.stop();
  });

  it('fresh activity resets the clock (a never-idle allocation never exits)', () => {
    vi.useFakeTimers();
    const m = run({
      timeoutMinutes: 15,
      kernel: () => ({ anyBusy: false, lastActivityMs: Date.now() - 2 * MIN }),
    });
    vi.advanceTimersByTime(120 * MIN);
    expect(m.warns).toEqual([]);
    expect(m.isExited()).toBe(false);
    m.stop();
  });

  it('a busy kernel blocks the exit even past the timeout', () => {
    vi.useFakeTimers();
    let busy = true;
    const start = Date.now();
    const m = run({
      timeoutMinutes: 10,
      kernel: () => ({ anyBusy: busy, lastActivityMs: start }),
    });
    vi.advanceTimersByTime(60 * MIN);
    expect(m.isExited()).toBe(false);
    // Execution finishes and bumps lastActivity; the full timeout starts over.
    busy = false;
    const finishedAt = Date.now();
    const m2kernel = () => ({ anyBusy: false, lastActivityMs: finishedAt });
    m.stop();
    const m2 = run({ timeoutMinutes: 10, kernel: m2kernel });
    vi.advanceTimersByTime(9 * MIN);
    expect(m2.isExited()).toBe(false);
    vi.advanceTimersByTime(2 * MIN);
    expect(m2.isExited()).toBe(true);
    m2.stop();
  });
});

describe('renderJobScript idle-exit threading', () => {
  const ctx: LaunchContext = {
    mainUrl: 'http://login:3000',
    nodeBin: '/usr/bin/node',
    execArgv: [],
    scriptPath: '/nebula/node-server/src/index.ts',
    cwd: '/nebula',
    stateDir: '/home/u/.nebula/allocations',
  };
  const base: JobSpec = {
    partition: 'gpu', cpus: 4, memGb: 16, walltimeMinutes: 120, jobName: 'nebula-gpu',
  };

  it('exports NEBULA_IDLE_EXIT_MINUTES when the spec opts in', () => {
    const script = renderJobScript({ ...base, idleTimeoutMinutes: 45 }, ctx, 'abc123', 'tok');
    expect(script).toContain('export NEBULA_IDLE_EXIT_MINUTES=45');
  });

  it('omits the env var when the spec does not opt in', () => {
    const script = renderJobScript(base, ctx, 'abc123', 'tok');
    expect(script).not.toContain('NEBULA_IDLE_EXIT_MINUTES');
  });
});
