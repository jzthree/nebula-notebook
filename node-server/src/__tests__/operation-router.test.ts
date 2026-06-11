// @vitest-environment node

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { OperationRouter } from '../notebook/operation-router';
import { hashCellContent } from '../notebook/cell-hash';
import * as fsMod from 'fs';
import * as osMod from 'os';
import * as pathMod from 'path';

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

  it('notifies a responsive UI when the kernel changes externally', async () => {
    const router = new OperationRouter();
    const ws = {
      readyState: WebSocket.OPEN,
      close: vi.fn(),
      send: vi.fn(),
    } as unknown as WebSocket;

    await router.registerUI(ws, '/tmp/kernel.ipynb');
    router.notifyKernelChanged('/tmp/kernel.ipynb', {
      kernelName: 'python3',
      serverId: 'local',
    });

    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({
      type: 'kernelChanged',
      kernelName: 'python3',
      serverId: 'local',
    }));
  });
});

describe('OperationRouter collaborative OCC', () => {
  let tmpDir: string;
  let nbPath: string;

  beforeEach(() => {
    tmpDir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'occ-test-'));
    nbPath = pathMod.join(tmpDir, 'nb.ipynb');
    fsMod.writeFileSync(nbPath, JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  });

  afterEach(() => {
    fsMod.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeRouter() {
    const router = new OperationRouter();
    const seen: Record<string, unknown>[] = [];
    const applyOperation = vi.fn(async (op: Record<string, unknown>) => {
      seen.push(op);
      if (op.type === 'readCell') {
        return { success: true, cell: { id: 'cell-1', content: 'original content' } };
      }
      return { success: true, cellId: op.cellId };
    });
    router.setHeadlessHandler({
      applyOperation,
      readNotebook: vi.fn(async () => ({
        success: true,
        data: { cells: [{ id: 'cell-1', content: 'original content' }, { id: 'cell-2', content: 'other' }] },
      })),
      getUpdatesSince: vi.fn(() => []),
    } as any);
    return { router, seen, applyOperation };
  }

  const start = (router: OperationRouter, exclusive = false) =>
    router.applyOperation({ type: 'startAgentSession', notebookPath: nbPath, agentId: 'a1', exclusive });

  it('rejects collaborative writes to cells the agent has not read', async () => {
    const { router } = makeRouter();
    await start(router);

    const result = await router.applyOperation({
      type: 'updateContent', notebookPath: nbPath, agentId: 'a1', cellId: 'cell-1', content: 'new',
    });
    expect(result.success).toBe(false);
    expect(result.conflict).toBe(true);
    expect(result.error).toContain("haven't read");
  });

  it('stamps expectedHash from a prior read and from own writes', async () => {
    const { router, seen } = makeRouter();
    await start(router);

    await router.applyOperation({ type: 'readCell', notebookPath: nbPath, agentId: 'a1', cellId: 'cell-1' });
    await router.applyOperation({
      type: 'updateContent', notebookPath: nbPath, agentId: 'a1', cellId: 'cell-1', content: 'v2',
    });
    const firstWrite = seen.find(op => op.type === 'updateContent');
    expect(firstWrite?.expectedHash).toBe(hashCellContent('original content'));

    // The agent's own successful write becomes the new baseline
    await router.applyOperation({
      type: 'updateContent', notebookPath: nbPath, agentId: 'a1', cellId: 'cell-1', content: 'v3',
    });
    const secondWrite = seen.filter(op => op.type === 'updateContent')[1];
    expect(secondWrite?.expectedHash).toBe(hashCellContent('v2'));
  });

  it('records hashes from full-notebook reads (router.readNotebook)', async () => {
    const { router, seen } = makeRouter();
    await start(router);

    await router.readNotebook(nbPath);
    const result = await router.applyOperation({
      type: 'updateContent', notebookPath: nbPath, agentId: 'a1', cellId: 'cell-2', content: 'edited',
    });
    expect(result.success).toBe(true);
    const write = seen.find(op => op.type === 'updateContent');
    expect(write?.expectedHash).toBe(hashCellContent('other'));
  });

  it('rejects index-addressed destructive writes in collaborative sessions', async () => {
    const { router } = makeRouter();
    await start(router);

    const result = await router.applyOperation({
      type: 'deleteCell', notebookPath: nbPath, agentId: 'a1', cellIndex: 0,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('cell_id');
  });

  it('exclusive sessions bypass OCC entirely', async () => {
    const { router, seen } = makeRouter();
    await start(router, true);

    const result = await router.applyOperation({
      type: 'updateContent', notebookPath: nbPath, agentId: 'a1', cellId: 'cell-1', content: 'no read needed',
    });
    expect(result.success).toBe(true);
    const write = seen.find(op => op.type === 'updateContent');
    expect(write?.expectedHash).toBeUndefined();
  });

  it('clearNotebook requires an exclusive session', async () => {
    const { router } = makeRouter();
    await start(router);
    const collab = await router.applyOperation({ type: 'clearNotebook', notebookPath: nbPath, agentId: 'a1' });
    expect(collab.success).toBe(false);
    expect(collab.error).toContain('exclusive');

    await start(router, true); // same agent upgrades to exclusive
    const excl = await router.applyOperation({ type: 'clearNotebook', notebookPath: nbPath, agentId: 'a1' });
    expect(excl.success).toBe(true);
  });
});
