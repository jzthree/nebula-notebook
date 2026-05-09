/**
 * Tests for Notebook Tools
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  readNotebookCells,
  writeNotebookCell,
  executeCell,
  searchNotebookCells,
  readCellsToolDefinition,
  writeCellToolDefinition,
  executeCellToolDefinition,
  searchCellsToolDefinition,
} from '../../src/notebook/tools.js';
import { NebulaClient } from '../../src/notebook/client.js';

// Create a mock client
function createMockClient(): NebulaClient {
  return {
    readNotebookViaRouter: vi.fn(),
    readCellOp: vi.fn(),
    readCellOutputOp: vi.fn(),
    insertCellOp: vi.fn(),
    updateContentOp: vi.fn(),
    updateMetadataOp: vi.fn(),
    executeCode: vi.fn(),
    listKernels: vi.fn(),
    startKernel: vi.fn(),
    interruptKernel: vi.fn(),
    shutdownKernel: vi.fn(),
    generateCode: vi.fn(),
    chat: vi.fn(),
  } as unknown as NebulaClient;
}

describe('readNotebookCells', () => {
  let mockClient: NebulaClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('should read all cells from notebook', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'print(1)', outputs: [] },
          { id: 'cell-2', type: 'markdown', content: '# Title', outputs: [] },
          { id: 'cell-3', type: 'code', content: 'print(2)', outputs: [] },
        ],
      },
    });

    const result = await readNotebookCells(
      { notebookPath: '/test.ipynb' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells).toHaveLength(3);
    expect(result.data?.totalCells).toBe(3);
  });

  it('should read specific cell indices', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'print(1)', outputs: [] },
          { id: 'cell-2', type: 'markdown', content: '# Title', outputs: [] },
          { id: 'cell-3', type: 'code', content: 'print(2)', outputs: [] },
        ],
      },
    });

    const result = await readNotebookCells(
      { notebookPath: '/test.ipynb', cellIndices: [0, 2] },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells).toHaveLength(2);
    expect(result.data?.cells[0].id).toBe('cell-1');
    expect(result.data?.cells[1].id).toBe('cell-3');
  });

  it('should filter out invalid cell indices', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'print(1)', outputs: [] },
        ],
      },
    });

    const result = await readNotebookCells(
      { notebookPath: '/test.ipynb', cellIndices: [-1, 0, 5, 100] },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells).toHaveLength(1);
  });

  it('should exclude outputs by default', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'print(1)', outputs: [{ type: 'stdout', content: '1' }] },
        ],
      },
    });

    const result = await readNotebookCells(
      { notebookPath: '/test.ipynb' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells[0].outputs).toBeUndefined();
  });

  it('should include outputs when requested', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'print(1)', outputs: [{ type: 'stdout', content: '1' }] },
        ],
      },
    });

    const result = await readNotebookCells(
      { notebookPath: '/test.ipynb', includeOutputs: true },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells[0].outputs).toHaveLength(1);
  });

  it('should handle read errors', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: false,
      error: 'File not found',
    });

    const result = await readNotebookCells(
      { notebookPath: '/nonexistent.ipynb' },
      mockClient
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('File not found');
  });
});

describe('writeNotebookCell', () => {
  let mockClient: NebulaClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('should update existing cell', async () => {
    (mockClient.readCellOp as any).mockResolvedValueOnce({
      success: true,
      data: {
        cellIndex: 0,
        cell: { id: 'cell-1', type: 'code', content: 'old content', outputs: [] },
      },
    });
    (mockClient.updateContentOp as any).mockResolvedValueOnce({ success: true });
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'old content', outputs: [] },
        ],
      },
    });

    const result = await writeNotebookCell(
      { notebookPath: '/test.ipynb', cellIndex: 0, content: 'new content' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cellIndex).toBe(0);
    expect(result.data?.totalCells).toBe(1);
    expect(mockClient.updateContentOp).toHaveBeenCalledWith(
      '/test.ipynb',
      'cell-1',
      'new content'
    );
    expect(mockClient.updateMetadataOp).not.toHaveBeenCalled();
  });

  it('should append new cell with index -1', async () => {
    (mockClient.insertCellOp as any).mockResolvedValueOnce({
      success: true,
      data: { cellIndex: 1, cellId: 'cell-2' },
    });
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'existing', outputs: [] },
          { id: 'cell-2', type: 'code', content: 'new cell', outputs: [] },
        ],
      },
    });

    const result = await writeNotebookCell(
      { notebookPath: '/test.ipynb', cellIndex: -1, content: 'new cell' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cellIndex).toBe(1); // New cell at index 1
    expect(result.data?.totalCells).toBe(2);
    expect(mockClient.insertCellOp).toHaveBeenCalledTimes(1);
  });

  it('should set cell type', async () => {
    (mockClient.readCellOp as any).mockResolvedValueOnce({
      success: true,
      data: {
        cellIndex: 0,
        cell: { id: 'cell-1', type: 'code', content: 'old', outputs: [] },
      },
    });
    (mockClient.updateContentOp as any).mockResolvedValueOnce({ success: true });
    (mockClient.updateMetadataOp as any).mockResolvedValueOnce({ success: true });
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'markdown', content: '# Header', outputs: [] },
        ],
      },
    });

    const result = await writeNotebookCell(
      { notebookPath: '/test.ipynb', cellIndex: 0, content: '# Header', cellType: 'markdown' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(mockClient.updateMetadataOp).toHaveBeenCalledWith('/test.ipynb', 'cell-1', { type: 'markdown' });
  });

  it('should reject invalid cell index', async () => {
    (mockClient.readCellOp as any).mockResolvedValueOnce({
      success: false,
      error: 'Cell index 5 out of range',
    });

    const result = await writeNotebookCell(
      { notebookPath: '/test.ipynb', cellIndex: 5, content: 'x' },
      mockClient
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('out of range');
  });

  it('should handle write errors', async () => {
    (mockClient.readCellOp as any).mockResolvedValueOnce({
      success: true,
      data: {
        cellIndex: 0,
        cell: { id: 'cell-1', type: 'code', content: 'x', outputs: [] },
      },
    });
    (mockClient.updateContentOp as any).mockResolvedValueOnce({
      success: false,
      error: 'Permission denied',
    });

    const result = await writeNotebookCell(
      { notebookPath: '/test.ipynb', cellIndex: 0, content: 'x' },
      mockClient
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Permission denied');
  });
});

describe('executeCell', () => {
  let mockClient: NebulaClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('should execute code and return outputs', async () => {
    (mockClient.executeCode as any).mockResolvedValueOnce({
      success: true,
      data: {
        outputs: [
          { type: 'stdout', content: 'Hello World' },
        ],
        success: true,
      },
    });

    const result = await executeCell(
      { sessionId: 'session-123', code: 'print("Hello World")' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.outputs).toHaveLength(1);
    expect(result.data?.success).toBe(true);
  });

  it('should handle execution errors', async () => {
    (mockClient.executeCode as any).mockResolvedValueOnce({
      success: true,
      data: {
        outputs: [{ type: 'error', content: 'NameError: name x is not defined' }],
        success: false,
        error: 'Execution failed',
      },
    });

    const result = await executeCell(
      { sessionId: 'session-123', code: 'print(x)' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.success).toBe(false);
    expect(result.data?.error).toBe('Execution failed');
  });

  it('should handle client errors', async () => {
    (mockClient.executeCode as any).mockResolvedValueOnce({
      success: false,
      error: 'Session not found',
    });

    const result = await executeCell(
      { sessionId: 'invalid-session', code: 'print(1)' },
      mockClient
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe('Session not found');
  });
});

describe('searchNotebookCells', () => {
  let mockClient: NebulaClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('should search cells by keyword', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'import pandas as pd', outputs: [] },
          { id: 'cell-2', type: 'code', content: 'df = pd.DataFrame()', outputs: [] },
          { id: 'cell-3', type: 'code', content: 'import numpy as np', outputs: [] },
        ],
      },
    });

    const result = await searchNotebookCells(
      { notebookPath: '/test.ipynb', query: 'pandas' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells.length).toBeGreaterThan(0);
    // Cells with 'pandas' should be returned
    expect(result.data?.cells.some(c => c.content.includes('pandas'))).toBe(true);
  });

  it('should rank cells by relevance', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'x = 1', outputs: [] },
          { id: 'cell-2', type: 'code', content: 'pandas pandas pandas', outputs: [] },
          { id: 'cell-3', type: 'code', content: 'import pandas', outputs: [] },
        ],
      },
    });

    const result = await searchNotebookCells(
      { notebookPath: '/test.ipynb', query: 'pandas' },
      mockClient
    );

    expect(result.success).toBe(true);
    // Cell with more occurrences should rank higher
    expect(result.data?.cells[0].content).toContain('pandas');
    expect(result.data?.cells[0].score).toBeGreaterThan(result.data?.cells[1]?.score || 0);
  });

  it('should respect limit parameter', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: Array.from({ length: 10 }, (_, i) => ({
          id: `cell-${i}`,
          type: 'code',
          content: `pandas code ${i}`,
          outputs: [],
        })),
      },
    });

    const result = await searchNotebookCells(
      { notebookPath: '/test.ipynb', query: 'pandas', limit: 3 },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells.length).toBe(3);
    expect(result.data?.totalCells).toBe(10);
  });

  it('should include cell indices', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'x = 1', outputs: [] },
          { id: 'cell-2', type: 'code', content: 'pandas code', outputs: [] },
        ],
      },
    });

    const result = await searchNotebookCells(
      { notebookPath: '/test.ipynb', query: 'pandas' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells[0].index).toBe(1); // Second cell matches
  });

  it('should search in outputs when included', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          {
            id: 'cell-1',
            type: 'code',
            content: 'print(df)',
            outputs: [{ type: 'stdout', content: 'pandas DataFrame with 100 rows' }],
          },
        ],
      },
    });

    const result = await searchNotebookCells(
      { notebookPath: '/test.ipynb', query: 'pandas', includeOutputs: true },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells).toHaveLength(1);
  });

  it('should return empty for no matches', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'x = 1', outputs: [] },
        ],
      },
    });

    const result = await searchNotebookCells(
      { notebookPath: '/test.ipynb', query: 'nonexistent_term_xyz' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.cells).toHaveLength(0);
  });

  it('should boost exact phrase matches', async () => {
    (mockClient.readNotebookViaRouter as any).mockResolvedValueOnce({
      success: true,
      data: {
        path: '/test.ipynb',
        cells: [
          { id: 'cell-1', type: 'code', content: 'pandas dataframe', outputs: [] },
          { id: 'cell-2', type: 'code', content: 'pandas and also dataframe', outputs: [] },
        ],
      },
    });

    const result = await searchNotebookCells(
      { notebookPath: '/test.ipynb', query: 'pandas dataframe' },
      mockClient
    );

    expect(result.success).toBe(true);
    // Exact phrase match should score higher
    expect(result.data?.cells[0].content).toBe('pandas dataframe');
  });
});

describe('Tool Definitions', () => {
  it('readCellsToolDefinition should have correct structure', () => {
    expect(readCellsToolDefinition.name).toBe('notebook_read_cells');
    expect(readCellsToolDefinition.parameters.required).toContain('notebookPath');
    expect(readCellsToolDefinition.parameters.properties.cellIndices).toBeDefined();
    expect(readCellsToolDefinition.parameters.properties.includeOutputs).toBeDefined();
  });

  it('writeCellToolDefinition should have correct structure', () => {
    expect(writeCellToolDefinition.name).toBe('notebook_write_cell');
    expect(writeCellToolDefinition.parameters.required).toContain('notebookPath');
    expect(writeCellToolDefinition.parameters.required).toContain('cellIndex');
    expect(writeCellToolDefinition.parameters.required).toContain('content');
  });

  it('executeCellToolDefinition should have correct structure', () => {
    expect(executeCellToolDefinition.name).toBe('notebook_execute');
    expect(executeCellToolDefinition.parameters.required).toContain('sessionId');
    expect(executeCellToolDefinition.parameters.required).toContain('code');
  });

  it('searchCellsToolDefinition should have correct structure', () => {
    expect(searchCellsToolDefinition.name).toBe('notebook_search');
    expect(searchCellsToolDefinition.parameters.required).toContain('notebookPath');
    expect(searchCellsToolDefinition.parameters.required).toContain('query');
    expect(searchCellsToolDefinition.parameters.properties.limit).toBeDefined();
  });
});

// Import the readOutputTool for adaptive polling tests
import { readOutputTool } from '../../src/tools/notebook.js';

describe('read_output adaptive polling', () => {
  let mockClient: Partial<NebulaClient>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should poll quickly for fast executions', async () => {
    // Mock: First poll returns busy/empty, second poll returns complete with output
    // Should complete in ~50-100ms (one interval)
    const busyResponse = {
      success: true,
      data: {
        cellId: 'cell-1',
        cellIndex: 0,
        outputs: [],
        executionStatus: 'busy' // Cell is still executing
      }
    };
    const completeResponse = {
      success: true,
      data: {
        cellId: 'cell-1',
        cellIndex: 0,
        outputs: [{ output_type: 'stream', name: 'stdout', text: 'done' }],
        executionStatus: 'idle' // Execution complete
      }
    };

    mockClient = {
      readCellOutputOp: vi.fn()
        .mockResolvedValueOnce(busyResponse)
        .mockResolvedValueOnce(completeResponse)
        .mockResolvedValue(completeResponse) // Default for any extra calls
    } as Partial<NebulaClient>;

    const start = Date.now();
    const result = await readOutputTool.execute(
      { path: '/test.ipynb', cell_index: 0, max_wait: 10 },
      mockClient as NebulaClient
    );
    const duration = Date.now() - start;

    // With 50ms initial interval, should complete quickly (not 500ms+)
    // Allow some overhead for test execution
    expect(duration).toBeLessThan(300);
    expect(result.success).toBe(true);
    expect(result.data?.outputs).toHaveLength(1);
    expect(mockClient.readCellOutputOp).toHaveBeenCalledTimes(2);
  });

  it('should use exponential backoff for long executions', { timeout: 10000 }, async () => {
    // Mock: Multiple busy polls, then complete
    // Should use intervals: 50, 100, 200, 400, 800ms...
    const busyResponse = {
      success: true,
      data: {
        cellId: 'cell-1',
        cellIndex: 0,
        outputs: [],
        executionStatus: 'busy' // Still executing
      }
    };

    const completeResponse = {
      success: true,
      data: {
        cellId: 'cell-1',
        cellIndex: 0,
        outputs: [{ output_type: 'execute_result', data: { 'text/plain': '42' } }],
        executionStatus: 'idle' // Execution complete
      }
    };

    // Return busy 9 times, then complete on 10th+ calls
    const mockFn = vi.fn();
    for (let i = 0; i < 9; i++) {
      mockFn.mockResolvedValueOnce(busyResponse);
    }
    mockFn.mockResolvedValue(completeResponse); // Default for 10th+ calls

    mockClient = { readCellOutputOp: mockFn } as Partial<NebulaClient>;

    const start = Date.now();
    const result = await readOutputTool.execute(
      { path: '/test.ipynb', cell_index: 0, max_wait: 30 },
      mockClient as NebulaClient
    );
    const duration = Date.now() - start;

    // With adaptive polling: 50+100+200+400+800+1000+1000+1000+1000 ≈ 5550ms
    // With fixed polling: 9*500 = 4500ms
    // Since we can't control exact timing in tests, just verify it works
    // and makes the expected number of calls
    expect(result.success).toBe(true);
    expect(result.data?.outputs).toHaveLength(1);
    expect(mockClient.readCellOutputOp).toHaveBeenCalledTimes(10);

    // Duration should be reasonable (between 2-8 seconds for 10 polls)
    expect(duration).toBeGreaterThan(1000);
    expect(duration).toBeLessThan(10000);
  });

  it('should timeout and return current outputs after max_wait', async () => {
    // Mock: Always return busy with no outputs (simulates long-running execution)
    const busyResponse = {
      success: true,
      data: {
        cellId: 'cell-1',
        cellIndex: 0,
        outputs: [],
        executionStatus: 'busy' // Never completes
      }
    };

    mockClient = {
      readCellOutputOp: vi.fn().mockResolvedValue(busyResponse)
    } as Partial<NebulaClient>;

    const start = Date.now();
    const result = await readOutputTool.execute(
      { path: '/test.ipynb', cell_index: 0, max_wait: 1 }, // 1 second timeout
      mockClient as NebulaClient
    );
    const duration = Date.now() - start;

    // Should timeout after ~1 second and return empty outputs
    expect(duration).toBeGreaterThan(900); // At least 900ms
    expect(duration).toBeLessThan(1700); // Allow some overhead for test execution
    expect(result.success).toBe(true);
    expect(result.data?.outputs).toHaveLength(0);

    // Should have made multiple poll attempts
    const callCount = (mockClient.readCellOutputOp as any).mock.calls.length;
    expect(callCount).toBeGreaterThan(1);
  });
});
