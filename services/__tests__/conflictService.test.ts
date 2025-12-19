/**
 * Tests for conflictService - conflict detection and cell serialization
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Cell } from '../../types';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Import after mocks are set up
import {
  checkForConflict,
  serializeCellsForComparison,
  haveCellsChanged,
  ConflictCheckResult,
} from '../conflictService';

describe('conflictService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('checkForConflict', () => {
    it('returns no conflict when lastKnownMtime is null', async () => {
      const result = await checkForConflict('/test.ipynb', null);

      expect(result.hasConflict).toBe(false);
      expect(result.localMtime).toBeNull();
      expect(result.remoteMtime).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('returns no conflict when remote mtime equals local', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ path: '/test.ipynb', mtime: 1000 }),
      });

      const result = await checkForConflict('/test.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.localMtime).toBe(1000);
      expect(result.remoteMtime).toBe(1000);
    });

    it('returns no conflict when remote mtime is older than local', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ path: '/test.ipynb', mtime: 500 }),
      });

      const result = await checkForConflict('/test.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.localMtime).toBe(1000);
      expect(result.remoteMtime).toBe(500);
    });

    it('returns conflict when remote mtime is newer than local', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ path: '/test.ipynb', mtime: 2000 }),
      });

      const result = await checkForConflict('/test.ipynb', 1000);

      expect(result.hasConflict).toBe(true);
      expect(result.localMtime).toBe(1000);
      expect(result.remoteMtime).toBe(2000);
    });

    it('handles network errors gracefully - fails open (no conflict)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await checkForConflict('/test.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.localMtime).toBe(1000);
      expect(result.remoteMtime).toBeNull();
      expect(consoleSpy).toHaveBeenCalledWith(
        'Could not check remote mtime:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    it('handles API errors gracefully - fails open (no conflict)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ detail: 'File not found' }),
      });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await checkForConflict('/test.ipynb', 1000);

      expect(result.hasConflict).toBe(false);
      expect(result.localMtime).toBe(1000);
      expect(result.remoteMtime).toBeNull();

      consoleSpy.mockRestore();
    });
  });

  describe('serializeCellsForComparison', () => {
    it('serializes cells consistently', () => {
      const cells: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ];

      const result1 = serializeCellsForComparison(cells);
      const result2 = serializeCellsForComparison(cells);

      expect(result1).toBe(result2);
    });

    it('includes only id, type, and content (excludes outputs)', () => {
      const cells: Cell[] = [
        {
          id: 'cell-1',
          type: 'code',
          content: 'print("hello")',
          outputs: [
            { id: 'out-1', type: 'stdout', content: 'hello\n', timestamp: 12345 },
          ],
          isExecuting: false,
        },
      ];

      const result = serializeCellsForComparison(cells);
      const parsed = JSON.parse(result);

      expect(parsed[0].id).toBe('cell-1');
      expect(parsed[0].type).toBe('code');
      expect(parsed[0].content).toBe('print("hello")');
      // Outputs should NOT be included - they can be regenerated
      expect(parsed[0].outputs).toBeUndefined();
    });

    it('ignores isExecuting field (transient state)', () => {
      const cells1: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ];
      const cells2: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: true },
      ];

      const result1 = serializeCellsForComparison(cells1);
      const result2 = serializeCellsForComparison(cells2);

      expect(result1).toBe(result2);
    });

    it('ignores executionCount field', () => {
      const cells1: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false, executionCount: 1 },
      ];
      const cells2: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false, executionCount: 5 },
      ];

      const result1 = serializeCellsForComparison(cells1);
      const result2 = serializeCellsForComparison(cells2);

      expect(result1).toBe(result2);
    });

    it('ignores outputs entirely (cells with different outputs are equal)', () => {
      const cells1: Cell[] = [
        {
          id: '1',
          type: 'code',
          content: 'x = 1',
          outputs: [{ id: 'out-1', type: 'stdout', content: 'hi', timestamp: 1000 }],
          isExecuting: false,
        },
      ];
      const cells2: Cell[] = [
        {
          id: '1',
          type: 'code',
          content: 'x = 1',
          outputs: [{ id: 'out-2', type: 'stderr', content: 'error', timestamp: 9999 }],
          isExecuting: false,
        },
      ];

      const result1 = serializeCellsForComparison(cells1);
      const result2 = serializeCellsForComparison(cells2);

      // Outputs are excluded, so these should be equal
      expect(result1).toBe(result2);
    });

    it('handles empty cells array', () => {
      const result = serializeCellsForComparison([]);
      expect(result).toBe('[]');
    });

    it('handles cells with undefined outputs', () => {
      const cells: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: undefined as any, isExecuting: false },
      ];

      const result = serializeCellsForComparison(cells);
      const parsed = JSON.parse(result);

      expect(parsed[0].outputs).toBeUndefined();
    });

    it('handles markdown cells', () => {
      const cells: Cell[] = [
        { id: '1', type: 'markdown', content: '# Title', outputs: [], isExecuting: false },
      ];

      const result = serializeCellsForComparison(cells);
      const parsed = JSON.parse(result);

      expect(parsed[0].type).toBe('markdown');
      expect(parsed[0].content).toBe('# Title');
    });
  });

  describe('haveCellsChanged', () => {
    it('returns false when cells match saved content', () => {
      const cells: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ];
      const savedContent = serializeCellsForComparison(cells);

      const result = haveCellsChanged(cells, savedContent);

      expect(result).toBe(false);
    });

    it('returns true when cell content differs', () => {
      const cells: Cell[] = [
        { id: '1', type: 'code', content: 'x = 2', outputs: [], isExecuting: false },
      ];
      const savedContent = JSON.stringify([{ id: '1', type: 'code', content: 'x = 1', outputs: [] }]);

      const result = haveCellsChanged(cells, savedContent);

      expect(result).toBe(true);
    });

    it('returns true when cell is added', () => {
      const cells: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
        { id: '2', type: 'code', content: 'y = 2', outputs: [], isExecuting: false },
      ];
      const savedContent = serializeCellsForComparison([
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ]);

      const result = haveCellsChanged(cells, savedContent);

      expect(result).toBe(true);
    });

    it('returns true when cell is deleted', () => {
      const cells: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ];
      const savedContent = serializeCellsForComparison([
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
        { id: '2', type: 'code', content: 'y = 2', outputs: [], isExecuting: false },
      ]);

      const result = haveCellsChanged(cells, savedContent);

      expect(result).toBe(true);
    });

    it('returns true when cell type changes', () => {
      const cells: Cell[] = [
        { id: '1', type: 'markdown', content: '# Title', outputs: [], isExecuting: false },
      ];
      const savedContent = serializeCellsForComparison([
        { id: '1', type: 'code', content: '# Title', outputs: [], isExecuting: false },
      ]);

      const result = haveCellsChanged(cells, savedContent);

      expect(result).toBe(true);
    });

    it('returns false when only outputs change (outputs are regeneratable)', () => {
      const cells: Cell[] = [
        {
          id: '1',
          type: 'code',
          content: 'print("hi")',
          outputs: [{ id: 'out-1', type: 'stdout', content: 'hi\n', timestamp: 1000 }],
          isExecuting: false,
        },
      ];
      const savedContent = serializeCellsForComparison([
        { id: '1', type: 'code', content: 'print("hi")', outputs: [], isExecuting: false },
      ]);

      const result = haveCellsChanged(cells, savedContent);

      // Outputs are excluded from comparison - they can be regenerated
      expect(result).toBe(false);
    });

    it('returns false when only isExecuting changes', () => {
      const cellsWithExecuting: Cell[] = [
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: true },
      ];
      const savedContent = serializeCellsForComparison([
        { id: '1', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      ]);

      const result = haveCellsChanged(cellsWithExecuting, savedContent);

      expect(result).toBe(false);
    });
  });
});
