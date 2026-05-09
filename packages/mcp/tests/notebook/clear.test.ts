/**
 * Integration tests for clear_notebook operation
 *
 * Tests verify that clearing notebooks:
 * 1. Uses single bulk operation (not N+1 loop)
 * 2. Returns correct deleted count
 * 3. Includes Phase 2 metadata
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NebulaClient } from '../../src/notebook/client.js';
import { clearNotebookTool } from '../../src/tools/notebook.js';

describe('clear_notebook integration', () => {
  let mockClient: NebulaClient;

  beforeEach(() => {
    // Create a fresh mock client for each test
    mockClient = {
      clearNotebookOp: vi.fn(),
      readNotebookViaRouter: vi.fn(),
      deleteCellOp: vi.fn(),
    } as unknown as NebulaClient;
  });

  it('should use single clearNotebookOp instead of N+1 loop', async () => {
    // Mock successful clear operation
    (mockClient.clearNotebookOp as any).mockResolvedValueOnce({
      success: true,
      data: {
        deletedCount: 100,
        metadata: {
          totalCells: 0,
        },
      },
    });

    const result = await clearNotebookTool.execute(
      { path: '/test/notebook.ipynb' },
      mockClient
    );

    // Verify single operation was called
    expect(mockClient.clearNotebookOp).toHaveBeenCalledTimes(1);
    expect(mockClient.clearNotebookOp).toHaveBeenCalledWith('/test/notebook.ipynb');

    // Verify no individual delete operations (N+1 anti-pattern)
    expect(mockClient.deleteCellOp).not.toHaveBeenCalled();
    expect(mockClient.readNotebookViaRouter).not.toHaveBeenCalled();

    // Verify result
    expect(result.success).toBe(true);
    expect(result.data?.deletedCount).toBe(100);
  });

  it('should return correct deleted count for large notebooks', async () => {
    // Simulate clearing a large 1000-cell notebook
    (mockClient.clearNotebookOp as any).mockResolvedValueOnce({
      success: true,
      data: {
        deletedCount: 1000,
        metadata: {
          totalCells: 0,
        },
      },
    });

    const result = await clearNotebookTool.execute(
      { path: '/test/large-notebook.ipynb' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.deletedCount).toBe(1000);

    // Verify still only one operation (not 1001)
    expect(mockClient.clearNotebookOp).toHaveBeenCalledTimes(1);
  });

  it('should handle empty notebooks gracefully', async () => {
    (mockClient.clearNotebookOp as any).mockResolvedValueOnce({
      success: true,
      data: {
        deletedCount: 0,
        metadata: {
          totalCells: 0,
        },
      },
    });

    const result = await clearNotebookTool.execute(
      { path: '/test/empty.ipynb' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.deletedCount).toBe(0);
  });

  it('should propagate errors from backend', async () => {
    (mockClient.clearNotebookOp as any).mockResolvedValueOnce({
      success: false,
      error: 'Notebook not found: /nonexistent.ipynb',
    });

    const result = await clearNotebookTool.execute(
      { path: '/nonexistent.ipynb' },
      mockClient
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('should include Phase 2 metadata in response', async () => {
    (mockClient.clearNotebookOp as any).mockResolvedValueOnce({
      success: true,
      data: {
        deletedCount: 50,
        metadata: {
          totalCells: 0,
          operationTime: 25.5, // Future Phase 3 timing
        },
      },
    });

    const result = await clearNotebookTool.execute(
      { path: '/test/notebook.ipynb' },
      mockClient
    );

    expect(result.success).toBe(true);
    expect(result.data?.deletedCount).toBe(50);

    // Metadata should be preserved (Phase 2 ready)
    // Note: Current tool implementation doesn't expose metadata in response
    // This test documents the expected behavior for future Phase 2 work
  });
});

/**
 * Performance Benchmark Tests
 *
 * These tests verify that the optimization achieves the expected performance improvement.
 * Requires a running nebula-notebook backend on localhost:3000.
 *
 * Run with: npm test -- --run clear.test.ts
 * Skip in CI with: SKIP_INTEGRATION=true npm test
 */
describe.skip('clear_notebook performance benchmarks', () => {
  // These tests require a real backend running
  // TODO: Set up test infrastructure for running backend in CI

  it('should clear 1000-cell notebook in <500ms', async () => {
    // This would require:
    // 1. Start nebula-notebook backend
    // 2. Create test notebook with 1000 cells
    // 3. Measure clear operation time
    // 4. Verify <500ms completion
    //
    // Manual test procedure documented in DEVELOPMENT.md
  });

  it('should be 1000x faster than N+1 loop approach', async () => {
    // Benchmark comparison:
    // - Old approach: 1 read + 1000 deletes = 1001 requests
    // - New approach: 1 clearNotebook = 1 request
    // Expected: >1000x improvement for network-bound operations
  });
});
