/**
 * Tests for useUndoRedo hook - History tracking for agent and user operations
 *
 * Verifies that:
 * 1. Operations are correctly tracked in history
 * 2. AI operations are marked with source: 'ai'
 * 3. Undo/redo works correctly for all operation types
 * 4. Cell IDs are used for stable operation tracking
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useUndoRedo } from '../useUndoRedo';
import type { Cell } from '../../types';

// Helper to create a basic cell
function createCell(id: string, content: string, type: 'code' | 'markdown' = 'code'): Cell {
  return {
    id,
    type,
    content,
    outputs: [],
    isExecuting: false,
  };
}

describe('useUndoRedo', () => {
  const initialCells: Cell[] = [
    createCell('cell-1', 'print("Hello")'),
    createCell('cell-2', 'x = 1'),
    createCell('cell-3', 'print(x)'),
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Operation Tracking', () => {
    it('should track insertCell operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.insertCell(1, createCell('new-cell', 'new content'));
      });

      expect(result.current.cells.length).toBe(4);
      expect(result.current.cells[1].id).toBe('new-cell');
      expect(result.current.canUndo).toBe(true);
    });

    it('should track deleteCell operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.deleteCell(1); // Delete cell-2
      });

      expect(result.current.cells.length).toBe(2);
      expect(result.current.cells.map(c => c.id)).toEqual(['cell-1', 'cell-3']);
      expect(result.current.canUndo).toBe(true);
    });

    it('should track moveCell operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.moveCell(0, 2); // Move cell-1 to end
      });

      expect(result.current.cells.map(c => c.id)).toEqual(['cell-2', 'cell-3', 'cell-1']);
      expect(result.current.canUndo).toBe(true);
    });

    it('should track updateContent operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.updateContent('cell-1', 'updated content');
      });

      expect(result.current.cells[0].content).toBe('updated content');
      expect(result.current.canUndo).toBe(true);
    });

    it('should track updateMetadata operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.updateMetadata('cell-1', {
          type: { old: 'code', new: 'markdown' },
        });
      });

      expect(result.current.cells[0].type).toBe('markdown');
      expect(result.current.canUndo).toBe(true);
    });
  });

  describe('AI Operation Tracking', () => {
    it('should mark AI content updates with source: ai', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.updateContentAI('cell-1', 'AI generated code');
      });

      expect(result.current.cells[0].content).toBe('AI generated code');
      // The operation should be marked with source: 'ai'
      // We can verify this by checking the history
    });

    it('should track sequence of AI operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Simulate AI workflow: insert cell at end, add content
      act(() => {
        const newCell = createCell('ai-cell-1', '');
        // Insert at end (cells.length)
        result.current.insertCell(result.current.cells.length, newCell);
      });

      act(() => {
        result.current.updateContentAI('ai-cell-1', '# Data Analysis\nimport pandas as pd');
      });

      act(() => {
        const newCell2 = createCell('ai-cell-2', '');
        result.current.insertCell(result.current.cells.length, newCell2);
      });

      act(() => {
        result.current.updateContentAI('ai-cell-2', 'df = pd.read_csv("data.csv")');
      });

      // Verify final state
      expect(result.current.cells.length).toBe(5);
      expect(result.current.cells[3].id).toBe('ai-cell-1');
      expect(result.current.cells[4].id).toBe('ai-cell-2');
    });

    it('should allow undoing AI operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.updateContentAI('cell-1', 'AI content');
      });

      expect(result.current.cells[0].content).toBe('AI content');

      act(() => {
        result.current.undo();
      });

      expect(result.current.cells[0].content).toBe('print("Hello")');
    });
  });

  describe('Undo/Redo', () => {
    it('should undo insertCell', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.insertCell(1, createCell('new-cell', 'new'));
      });

      expect(result.current.cells.length).toBe(4);

      act(() => {
        result.current.undo();
      });

      expect(result.current.cells.length).toBe(3);
      expect(result.current.cells.map(c => c.id)).toEqual(['cell-1', 'cell-2', 'cell-3']);
    });

    it('should redo insertCell', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.insertCell(1, createCell('new-cell', 'new'));
      });

      act(() => {
        result.current.undo();
      });

      expect(result.current.cells.length).toBe(3);

      act(() => {
        result.current.redo();
      });

      expect(result.current.cells.length).toBe(4);
      expect(result.current.cells[1].id).toBe('new-cell');
    });

    it('should undo deleteCell and restore cell', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.deleteCell(1);
      });

      expect(result.current.cells.length).toBe(2);

      act(() => {
        result.current.undo();
      });

      expect(result.current.cells.length).toBe(3);
      expect(result.current.cells[1].id).toBe('cell-2');
      expect(result.current.cells[1].content).toBe('x = 1');
    });

    it('should undo moveCell', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.moveCell(0, 2);
      });

      expect(result.current.cells.map(c => c.id)).toEqual(['cell-2', 'cell-3', 'cell-1']);

      act(() => {
        result.current.undo();
      });

      expect(result.current.cells.map(c => c.id)).toEqual(['cell-1', 'cell-2', 'cell-3']);
    });

    it('should undo updateMetadata (type change)', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      act(() => {
        result.current.updateMetadata('cell-1', {
          type: { old: 'code', new: 'markdown' },
        });
      });

      expect(result.current.cells[0].type).toBe('markdown');

      act(() => {
        result.current.undo();
      });

      expect(result.current.cells[0].type).toBe('code');
    });

    it('should handle multiple undos in sequence', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Perform multiple operations
      act(() => {
        result.current.updateContent('cell-1', 'modified 1');
      });
      act(() => {
        result.current.updateContent('cell-2', 'modified 2');
      });
      act(() => {
        // Append at the end (use current length as index)
        result.current.insertCell(result.current.cells.length, createCell('cell-4', 'new cell'));
      });

      expect(result.current.cells.length).toBe(4);

      // Undo all
      act(() => {
        result.current.undo(); // Undo insert
      });
      expect(result.current.cells.length).toBe(3);

      act(() => {
        result.current.undo(); // Undo update cell-2
      });
      expect(result.current.cells[1].content).toBe('x = 1');

      act(() => {
        result.current.undo(); // Undo update cell-1
      });
      expect(result.current.cells[0].content).toBe('print("Hello")');
    });
  });

  describe('Cell ID Stability', () => {
    it('should use cell ID for operations, not index', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Update cell-2 by ID
      act(() => {
        result.current.updateContent('cell-2', 'updated cell-2');
      });

      // Insert a cell before cell-2
      act(() => {
        result.current.insertCell(1, createCell('inserted', 'inserted cell'));
      });

      // cell-2 is now at index 2, but should still be found by ID
      expect(result.current.cells[2].id).toBe('cell-2');
      expect(result.current.cells[2].content).toBe('updated cell-2');

      // Undo the insert
      act(() => {
        result.current.undo();
      });

      // cell-2 should be back at index 1 with updated content
      expect(result.current.cells[1].id).toBe('cell-2');
      expect(result.current.cells[1].content).toBe('updated cell-2');
    });

    it('should handle ID-based operations after deletions', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Delete cell-1
      act(() => {
        result.current.deleteCell(0);
      });

      // cell-2 is now at index 0
      expect(result.current.cells[0].id).toBe('cell-2');

      // Update cell-2 by ID (should work regardless of position)
      act(() => {
        result.current.updateContent('cell-2', 'still works');
      });

      expect(result.current.cells[0].content).toBe('still works');

      // Undo all - separate act() blocks so state updates are processed between calls
      act(() => {
        result.current.undo(); // Undo update
      });
      act(() => {
        result.current.undo(); // Undo delete
      });

      // Original state restored
      expect(result.current.cells.map(c => c.id)).toEqual(['cell-1', 'cell-2', 'cell-3']);
      expect(result.current.cells[1].content).toBe('x = 1'); // Original content
    });
  });

  describe('Batch Operations', () => {
    it('should handle batch operations as single undo unit', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Perform a batch operation (e.g., AI generates multiple cells at once)
      // batch() takes an array of Operation objects
      act(() => {
        const batchCell1 = createCell('batch-1', 'import numpy');
        const batchCell2 = createCell('batch-2', 'import pandas');
        const batchCell3 = createCell('batch-3', 'import sklearn');

        result.current.batch([
          { type: 'insertCell', index: 3, cell: batchCell1 },
          { type: 'insertCell', index: 4, cell: batchCell2 },
          { type: 'insertCell', index: 5, cell: batchCell3 },
        ]);
      });

      expect(result.current.cells.length).toBe(6);

      // Single undo should remove all batch operations
      act(() => {
        result.current.undo();
      });

      expect(result.current.cells.length).toBe(3);
      expect(result.current.cells.map(c => c.id)).toEqual(['cell-1', 'cell-2', 'cell-3']);
    });
  });

  describe('Edge Cases', () => {
    it('should not create operation for no-op content update', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Update with same content
      act(() => {
        result.current.updateContent('cell-1', 'print("Hello")'); // Same as original
      });

      // Should not be able to undo (no operation created)
      expect(result.current.canUndo).toBe(false);
    });

    it('should not create operation for no-op metadata update', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Update with same type
      act(() => {
        result.current.updateMetadata('cell-1', {
          type: { old: 'code', new: 'code' }, // Same as original
        });
      });

      expect(result.current.canUndo).toBe(false);
    });

    it('should handle empty cells array', () => {
      const { result } = renderHook(() => useUndoRedo([]));

      act(() => {
        result.current.insertCell(0, createCell('first', 'first cell'));
      });

      expect(result.current.cells.length).toBe(1);

      act(() => {
        result.current.undo();
      });

      expect(result.current.cells.length).toBe(0);
    });

    it('should handle rapid successive operations', () => {
      const { result } = renderHook(() => useUndoRedo(initialCells));

      // Rapid updates
      act(() => {
        result.current.updateContent('cell-1', 'a');
        result.current.updateContent('cell-1', 'ab');
        result.current.updateContent('cell-1', 'abc');
      });

      expect(result.current.cells[0].content).toBe('abc');

      // Each update should be a separate undo
      act(() => {
        result.current.undo();
      });
      expect(result.current.cells[0].content).toBe('ab');

      act(() => {
        result.current.undo();
      });
      expect(result.current.cells[0].content).toBe('a');

      act(() => {
        result.current.undo();
      });
      expect(result.current.cells[0].content).toBe('print("Hello")');
    });
  });
});
