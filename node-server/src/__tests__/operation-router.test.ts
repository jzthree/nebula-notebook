// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { OperationRouter } from '../notebook/operation-router';

describe('OperationRouter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-20T12:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('treats stale UI connections as unavailable for routing', async () => {
    const router = new OperationRouter();
    const applyOperation = vi.fn(async () => ({ success: true, backend: 'headless', routed: 'applyOperation' }));
    router.setHeadlessHandler({
      applyOperation,
      readNotebook: vi.fn(async () => ({ success: true, backend: 'headless', data: { cells: [] } })),
    } as any);

    const ws = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;

    await router.registerUI(ws, '/tmp/stale.ipynb');
    expect(router.hasUI('/tmp/stale.ipynb')).toBe(true);

    vi.advanceTimersByTime(46000);

    expect(router.hasUI('/tmp/stale.ipynb')).toBe(false);

    const result = await router.applyOperation({
      type: 'readCell',
      notebookPath: '/tmp/stale.ipynb',
    });

    expect(result).toMatchObject({ success: true, backend: 'headless', routed: 'applyOperation' });
    expect(applyOperation).toHaveBeenCalledTimes(1);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it('refreshes UI liveness when the connection shows activity', async () => {
    const router = new OperationRouter();
    const ws = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;

    await router.registerUI(ws, '/tmp/live.ipynb');
    vi.advanceTimersByTime(30000);
    router.markUIActivity(ws, '/tmp/live.ipynb');
    vi.advanceTimersByTime(30000);

    expect(router.hasUI('/tmp/live.ipynb')).toBe(true);
  });
});
