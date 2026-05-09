import { describe, it, expect, vi } from 'vitest';
import { NebulaClient } from '../notebook/client.js';

describe('NebulaClient session pinning', () => {
  it('reuses an existing notebook kernel session for executeCellOp', async () => {
    const client = new NebulaClient({ baseUrl: 'http://example.test' });

    vi.spyOn(client, 'listSessions').mockResolvedValue({
      success: true,
      data: [
        {
          id: 'session-pinned',
          kernel_name: 'python3',
          status: 'idle',
          file_path: '/tmp/test.ipynb',
        },
      ],
    });
    const getOrCreateSpy = vi.spyOn(client, 'getOrCreateKernelForFile').mockResolvedValue({
      success: true,
      data: {
        sessionId: 'session-created',
        kernelName: 'python3',
        status: 'idle',
        filePath: '/tmp/test.ipynb',
      },
    });
    const applyOperationSpy = vi.spyOn(client, 'applyOperation').mockResolvedValue({
      success: true,
      data: {
        success: true,
        cellId: 'cell-1',
        cellIndex: 0,
        executionStatus: 'idle',
        outputs: [],
        sessionId: 'session-pinned',
      },
    } as any);

    const result = await client.executeCellOp('/tmp/test.ipynb', { cellId: 'cell-1' });

    expect(result.success).toBe(true);
    expect(applyOperationSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'executeCell',
      notebookPath: '/tmp/test.ipynb',
      sessionId: 'session-pinned',
    }));
    expect(getOrCreateSpy).not.toHaveBeenCalled();
    expect(client.getPinnedKernelSessionId('/tmp/test.ipynb')).toBe('session-pinned');
  });

  it('creates and pins a kernel session when executeCellOp has no existing session', async () => {
    const client = new NebulaClient({ baseUrl: 'http://example.test' });

    vi.spyOn(client, 'listSessions').mockResolvedValue({
      success: true,
      data: [],
    });
    const getOrCreateSpy = vi.spyOn(client, 'getOrCreateKernelForFile').mockResolvedValue({
      success: true,
      data: {
        sessionId: 'session-created',
        kernelName: 'python3',
        status: 'idle',
        filePath: '/tmp/test.ipynb',
      },
    });
    const applyOperationSpy = vi.spyOn(client, 'applyOperation').mockResolvedValue({
      success: true,
      data: {
        success: true,
        cellId: 'cell-1',
        cellIndex: 0,
        executionStatus: 'idle',
        outputs: [],
        sessionId: 'session-created',
      },
    } as any);

    const result = await client.executeCellOp('/tmp/test.ipynb', { cellId: 'cell-1' });

    expect(result.success).toBe(true);
    expect(getOrCreateSpy).toHaveBeenCalledWith('/tmp/test.ipynb', undefined);
    expect(applyOperationSpy).toHaveBeenCalledWith(expect.objectContaining({
      type: 'executeCell',
      notebookPath: '/tmp/test.ipynb',
      sessionId: 'session-created',
    }));
    expect(client.getPinnedKernelSessionId('/tmp/test.ipynb')).toBe('session-created');
  });

  it('pins an existing session on startAgentSession and clears it on endAgentSession', async () => {
    const client = new NebulaClient({ baseUrl: 'http://example.test' });

    vi.spyOn(client, 'listSessions').mockResolvedValue({
      success: true,
      data: [
        {
          id: 'session-existing',
          kernel_name: 'python3',
          status: 'idle',
          file_path: '/tmp/test.ipynb',
        },
      ],
    });
    const applyOperationSpy = vi.spyOn(client, 'applyOperation')
      .mockResolvedValueOnce({ success: true, data: { success: true } } as any)
      .mockResolvedValueOnce({ success: true, data: { success: true } } as any);

    const started = await client.startAgentSession('/tmp/test.ipynb', 'agent-1');
    expect(started.success).toBe(true);
    expect(client.getPinnedKernelSessionId('/tmp/test.ipynb')).toBe('session-existing');

    const ended = await client.endAgentSession('/tmp/test.ipynb');
    expect(ended.success).toBe(true);
    expect(client.getPinnedKernelSessionId('/tmp/test.ipynb')).toBeNull();
    expect(applyOperationSpy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      type: 'startAgentSession',
      notebookPath: '/tmp/test.ipynb',
    }));
    expect(applyOperationSpy).toHaveBeenNthCalledWith(2, expect.objectContaining({
      type: 'endAgentSession',
      notebookPath: '/tmp/test.ipynb',
    }));
  });
});
