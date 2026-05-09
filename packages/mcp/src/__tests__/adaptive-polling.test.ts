import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createAdaptivePoller } from '../utils/polling.js';

describe('AdaptivePoller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should start with initial interval (50ms)', () => {
    const poller = createAdaptivePoller();

    expect(poller.getCurrentInterval()).toBe(50);
  });

  it('should exponentially increase interval (2x backoff)', () => {
    const poller = createAdaptivePoller();

    // Initial: 50ms
    expect(poller.getCurrentInterval()).toBe(50);

    // First increment: 50 * 2 = 100ms
    poller.incrementInterval();
    expect(poller.getCurrentInterval()).toBe(100);

    // Second increment: 100 * 2 = 200ms
    poller.incrementInterval();
    expect(poller.getCurrentInterval()).toBe(200);

    // Third increment: 200 * 2 = 400ms
    poller.incrementInterval();
    expect(poller.getCurrentInterval()).toBe(400);

    // Fourth increment: 400 * 2 = 800ms
    poller.incrementInterval();
    expect(poller.getCurrentInterval()).toBe(800);
  });

  it('should cap at max interval (1000ms)', () => {
    const poller = createAdaptivePoller({ maxInterval: 1000 });

    // Increment many times to exceed max
    for (let i = 0; i < 10; i++) {
      poller.incrementInterval();
    }

    // Should be capped at 1000ms, not exceed it
    expect(poller.getCurrentInterval()).toBe(1000);
  });

  it('should reset to initial interval', () => {
    const poller = createAdaptivePoller();

    // Increment a few times
    poller.incrementInterval();
    poller.incrementInterval();
    expect(poller.getCurrentInterval()).toBe(200);

    // Reset should go back to initial
    poller.reset();
    expect(poller.getCurrentInterval()).toBe(50);
  });

  it('should support custom config', () => {
    const poller = createAdaptivePoller({
      initialInterval: 100,
      maxInterval: 500,
      backoffFactor: 1.5
    });

    // Should start with custom initial
    expect(poller.getCurrentInterval()).toBe(100);

    // First increment: 100 * 1.5 = 150ms
    poller.incrementInterval();
    expect(poller.getCurrentInterval()).toBe(150);

    // Second increment: 150 * 1.5 = 225ms
    poller.incrementInterval();
    expect(poller.getCurrentInterval()).toBe(225);

    // Keep incrementing until we hit max
    for (let i = 0; i < 10; i++) {
      poller.incrementInterval();
    }

    // Should be capped at custom max (500ms)
    expect(poller.getCurrentInterval()).toBe(500);
  });

  it('should wait for current interval duration', async () => {
    const poller = createAdaptivePoller({ initialInterval: 100 });

    // Track if wait completed
    let resolved = false;
    const waitPromise = poller.wait().then(() => { resolved = true; });

    // Should not be resolved immediately
    expect(resolved).toBe(false);

    // Fast-forward all timers
    await vi.runAllTimersAsync();

    // Should now be resolved after timer completes
    expect(resolved).toBe(true);

    // Clean up
    await waitPromise;
  });
});
