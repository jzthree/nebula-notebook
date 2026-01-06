/**
 * Tests for useUndoRedo hook - History Size Limits
 *
 * TDD tests for enforcing maximum history sizes on undo, redo, and full history stacks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useUndoRedo,
  MAX_UNDO_STACK_SIZE,
  MAX_REDO_STACK_SIZE,
  MAX_FULL_HISTORY_SIZE,
  UseUndoRedoOptions
} from '../useUndoRedo';
import type { Cell } from '../../types';

// Helper to create a test cell
function makeCell(id: string, content: string = '', type: 'code' | 'markdown' = 'code'): Cell {
  return {
    id,
    type,
    content,
    outputs: [],
    isExecuting: false
  };
}

// Use very small test limits to avoid memory issues
const TEST_UNDO_LIMIT = 5;
const TEST_REDO_LIMIT = 3;
const TEST_HISTORY_LIMIT = 10;

const testOptions: UseUndoRedoOptions = {
  maxUndoStackSize: TEST_UNDO_LIMIT,
  maxRedoStackSize: TEST_REDO_LIMIT,
  maxFullHistorySize: TEST_HISTORY_LIMIT
};

describe('useUndoRedo', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
  });

  describe('default limits', () => {
    it('should export correct default limit constants', () => {
      expect(MAX_UNDO_STACK_SIZE).toBe(100);
      expect(MAX_REDO_STACK_SIZE).toBe(50);
      expect(MAX_FULL_HISTORY_SIZE).toBe(500);
    });
  });

  describe('undo stack size limits', () => {
    it('should enforce max undo stack size when adding operations', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      // Add 7 operations (limit is 5)
      act(() => {
        for (let i = 0; i < 7; i++) {
          result.current.insertCell(0, makeCell(`cell-${i}`));
        }
      });

      // Count undos available - should be capped at 5
      let undoCount = 0;
      while (result.current.canUndo && undoCount < 20) {
        act(() => {
          result.current.undo();
        });
        undoCount++;
      }

      expect(undoCount).toBe(TEST_UNDO_LIMIT);
    });

    it('should evict oldest operations first (FIFO)', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      // Insert 7 cells at index 0 (they stack on top)
      // After all inserts: [cell-6, cell-5, cell-4, cell-3, cell-2, cell-1, cell-0]
      // Limit is 5, so first 2 inserts (cell-0, cell-1) are evicted from undo stack
      act(() => {
        for (let i = 0; i < 7; i++) {
          result.current.insertCell(0, makeCell(`cell-${i}`));
        }
      });

      // 7 cells exist
      expect(result.current.cells.length).toBe(7);

      // Undo all available (5) - removes cell-6, cell-5, cell-4, cell-3, cell-2
      act(() => {
        for (let i = 0; i < TEST_UNDO_LIMIT; i++) {
          result.current.undo();
        }
      });

      // Should have cells 0-1 remaining (evicted inserts can't be undone)
      expect(result.current.cells.length).toBe(2);
      expect(result.current.cells[0].id).toBe('cell-1');
      expect(result.current.cells[1].id).toBe('cell-0');
    });

    it('should not evict when under limit', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      // Add 3 operations (under limit of 5)
      act(() => {
        for (let i = 0; i < 3; i++) {
          result.current.insertCell(0, makeCell(`cell-${i}`));
        }
      });

      // Should be able to undo all 3
      let undoCount = 0;
      while (result.current.canUndo && undoCount < 10) {
        act(() => {
          result.current.undo();
        });
        undoCount++;
      }

      expect(undoCount).toBe(3);
      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });

    it('should emit console.warn when evicting operations', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      act(() => {
        for (let i = 0; i < 7; i++) {
          result.current.insertCell(0, makeCell(`cell-${i}`));
        }
      });

      expect(consoleWarnSpy).toHaveBeenCalled();
      expect(consoleWarnSpy.mock.calls.some(call =>
        call[0].includes('[useUndoRedo]') && call[0].includes('undo')
      )).toBe(true);
    });
  });

  describe('redo stack size limits', () => {
    it('should enforce max redo stack size during undo', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      // Add 5 operations (at undo limit)
      act(() => {
        for (let i = 0; i < 5; i++) {
          result.current.insertCell(i, makeCell(`cell-${i}`));
        }
      });

      // Undo all 5 - redo limit is 3, so 2 should be evicted
      act(() => {
        for (let i = 0; i < 5; i++) {
          result.current.undo();
        }
      });

      // Should only be able to redo 3
      let redoCount = 0;
      while (result.current.canRedo && redoCount < 10) {
        act(() => {
          result.current.redo();
        });
        redoCount++;
      }

      expect(redoCount).toBe(TEST_REDO_LIMIT);
    });

    it('should clear redo stack on new operation', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      act(() => {
        result.current.insertCell(0, makeCell('cell-1'));
        result.current.insertCell(1, makeCell('cell-2'));
      });

      act(() => {
        result.current.undo();
      });

      expect(result.current.canRedo).toBe(true);

      act(() => {
        result.current.insertCell(0, makeCell('cell-3'));
      });

      expect(result.current.canRedo).toBe(false);
    });
  });

  describe('full history size limits', () => {
    it('should enforce max full history size', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      act(() => {
        result.current.resetHistory([]);
      });

      // Add 15 operations (limit is 10)
      act(() => {
        for (let i = 0; i < 15; i++) {
          result.current.insertCell(0, makeCell(`cell-${i}`));
        }
      });

      const history = result.current.getFullHistory();

      // Should be capped at 10 + 1 (for snapshot)
      expect(history.length).toBeLessThanOrEqual(TEST_HISTORY_LIMIT + 1);
    });

    it('should preserve snapshot during eviction', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      act(() => {
        result.current.resetHistory([makeCell('initial')]);
      });

      act(() => {
        for (let i = 0; i < 15; i++) {
          result.current.insertCell(1, makeCell(`cell-${i}`));
        }
      });

      const history = result.current.getFullHistory();

      // First entry should still be a snapshot
      expect(history[0].type).toBe('snapshot');
    });
  });

  describe('console.warn on eviction', () => {
    it('should warn when redo stack is pruned', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      act(() => {
        for (let i = 0; i < 5; i++) {
          result.current.insertCell(i, makeCell(`cell-${i}`));
        }
      });

      consoleWarnSpy.mockClear();

      // Undo all - triggers redo stack pruning (5 undos, limit 3)
      act(() => {
        for (let i = 0; i < 5; i++) {
          result.current.undo();
        }
      });

      expect(consoleWarnSpy.mock.calls.some(call =>
        call[0].includes('redo')
      )).toBe(true);
    });

    it('should warn when full history is pruned', () => {
      const { result } = renderHook(() => useUndoRedo([], testOptions));

      act(() => {
        result.current.resetHistory([]);
      });

      consoleWarnSpy.mockClear();

      act(() => {
        for (let i = 0; i < 15; i++) {
          result.current.insertCell(0, makeCell(`cell-${i}`));
        }
      });

      expect(consoleWarnSpy.mock.calls.some(call =>
        call[0].includes('history')
      )).toBe(true);
    });
  });
});
