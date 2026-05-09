/**
 * Unit tests for NebulaClient request wiring (operation router).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NebulaClient, createNebulaClient } from '../../src/notebook/client.js';

const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('NebulaClient (unit)', () => {
  let client: NebulaClient;

  beforeEach(() => {
    client = createNebulaClient({ baseUrl: 'http://localhost:8000', retries: 1 });
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('listKernels maps kernel metadata', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        kernels: [
          { name: 'python3', display_name: 'Python 3.11', language: 'python' },
          { name: 'ir', display_name: 'R 4.2', language: 'r' },
        ],
      }),
    });

    const result = await client.listKernels();

    expect(result.success).toBe(true);
    expect(result.data).toEqual([
      { name: 'python3', displayName: 'Python 3.11', language: 'python' },
      { name: 'ir', displayName: 'R 4.2', language: 'r' },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/kernels',
      expect.objectContaining({ headers: { 'Content-Type': 'application/json' } })
    );
  });

  it('startKernel posts to /api/kernels/start', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ session_id: 'session-123', kernel_name: 'python3' }),
    });

    const result = await client.startKernel('python3');

    expect(result.success).toBe(true);
    expect(result.data?.sessionId).toBe('session-123');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/kernels/start',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ kernel_name: 'python3', file_path: undefined }),
      })
    );
  });

  it('getOrCreateKernelForFile posts to /api/kernels/for-file', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ session_id: 'session-456', kernel_name: 'python3', file_path: '/tmp/test.ipynb' }),
    });

    const result = await client.getOrCreateKernelForFile('/tmp/test.ipynb');

    expect(result.success).toBe(true);
    expect(result.data?.filePath).toBe('/tmp/test.ipynb');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/kernels/for-file',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ file_path: '/tmp/test.ipynb', kernel_name: undefined }),
      })
    );
  });

  it('readNotebookViaRouter returns router data', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          path: '/tmp/test.ipynb',
          cells: [{ id: 'cell-1', type: 'code', content: 'x = 1' }],
        },
      }),
    });

    const result = await client.readNotebookViaRouter('/tmp/test.ipynb');

    expect(result.success).toBe(true);
    expect(result.data?.cells.length).toBe(1);
  });

  it('readNotebookViaRouter propagates router error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: false, error: 'Not found' }),
    });

    const result = await client.readNotebookViaRouter('/tmp/missing.ipynb');

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not found');
  });

  it('insertCellOp posts operation payload', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        cellIndex: 0,
        cellId: 'cell-1',
      }),
    });

    const result = await client.insertCellOp('/tmp/test.ipynb', -1, {
      id: 'cell-1',
      type: 'code',
      content: 'print("hi")',
    });

    expect(result.success).toBe(true);
    expect(result.data?.cellId).toBe('cell-1');
    expect(mockFetch).toHaveBeenCalledWith(
      'http://localhost:8000/api/notebook/operation',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          operation: {
            type: 'insertCell',
            notebookPath: '/tmp/test.ipynb',
            index: -1,
            cell: { id: 'cell-1', type: 'code', content: 'print("hi")' },
          },
        }),
      })
    );
  });

  it('readCellOp posts readCell operation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        cellIndex: 0,
        cell: { id: 'cell-1', type: 'code', content: 'x = 1' },
      }),
    });

    const result = await client.readCellOp('/tmp/test.ipynb', { cellId: 'cell-1' });

    expect(result.success).toBe(true);
    expect(result.data?.cell.id).toBe('cell-1');
  });

  it('clearNotebookOp posts clearNotebook operation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        deletedCount: 3,
        metadata: { totalCells: 0 },
      }),
    });

    const result = await client.clearNotebookOp('/tmp/test.ipynb');

    expect(result.success).toBe(true);
    expect(result.data?.deletedCount).toBe(3);
  });
});
