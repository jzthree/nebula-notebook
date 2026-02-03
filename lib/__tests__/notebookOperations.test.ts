/**
 * Tests for notebook operations library
 *
 * These tests verify:
 * 1. Operations correctly transform state
 * 2. Operations are reversible (undo works)
 * 3. History can reconstruct state at any point
 * 4. Execution trajectories can be extracted for analysis
 */

import { describe, it, expect } from 'vitest';
import {
  NotebookState,
  EditOperation,
  HistoryEntry,
  applyOperation,
  reverseOperation,
  reconstructStateAt,
  getCellContentAt,
  extractExecutionTrajectory,
  validateHistory,
  createCell,
  createSnapshot,
  createHistoryEntry,
  isEditOperation,
} from '../notebookOperations';
import { Cell } from '../../types';

// ============================================================================
// Test Helpers
// ============================================================================

function makeCell(id: string, content: string, type: 'code' | 'markdown' = 'code', scrolled?: boolean): Cell {
  const cell: Cell = { id, type, content, outputs: [], isExecuting: false };
  if (scrolled !== undefined) cell.scrolled = scrolled;
  return cell;
}

function makeState(cells: Cell[]): NotebookState {
  return { cells };
}

// ============================================================================
// Apply Operation Tests
// ============================================================================

describe('applyOperation', () => {
  describe('insertCell', () => {
    it('inserts cell at beginning', () => {
      const state = makeState([makeCell('a', 'print(1)')]);
      const newCell = makeCell('b', 'print(2)');
      const result = applyOperation(state, {
        type: 'insertCell',
        index: 0,
        cell: newCell
      });

      expect(result.cells).toHaveLength(2);
      expect(result.cells[0].id).toBe('b');
      expect(result.cells[1].id).toBe('a');
    });

    it('inserts cell at end', () => {
      const state = makeState([makeCell('a', 'print(1)')]);
      const newCell = makeCell('b', 'print(2)');
      const result = applyOperation(state, {
        type: 'insertCell',
        index: 1,
        cell: newCell
      });

      expect(result.cells).toHaveLength(2);
      expect(result.cells[0].id).toBe('a');
      expect(result.cells[1].id).toBe('b');
    });

    it('inserts cell in middle', () => {
      const state = makeState([makeCell('a', '1'), makeCell('c', '3')]);
      const newCell = makeCell('b', '2');
      const result = applyOperation(state, {
        type: 'insertCell',
        index: 1,
        cell: newCell
      });

      expect(result.cells).toHaveLength(3);
      expect(result.cells.map(c => c.id)).toEqual(['a', 'b', 'c']);
    });
  });

  describe('deleteCell', () => {
    it('deletes cell at index', () => {
      const state = makeState([
        makeCell('a', '1'),
        makeCell('b', '2'),
        makeCell('c', '3')
      ]);
      const result = applyOperation(state, {
        type: 'deleteCell',
        index: 1,
        cell: state.cells[1]
      });

      expect(result.cells).toHaveLength(2);
      expect(result.cells.map(c => c.id)).toEqual(['a', 'c']);
    });
  });

  describe('moveCell', () => {
    it('moves cell forward', () => {
      const state = makeState([
        makeCell('a', '1'),
        makeCell('b', '2'),
        makeCell('c', '3')
      ]);
      const result = applyOperation(state, {
        type: 'moveCell',
        fromIndex: 0,
        toIndex: 2
      });

      expect(result.cells.map(c => c.id)).toEqual(['b', 'c', 'a']);
    });

    it('moves cell backward', () => {
      const state = makeState([
        makeCell('a', '1'),
        makeCell('b', '2'),
        makeCell('c', '3')
      ]);
      const result = applyOperation(state, {
        type: 'moveCell',
        fromIndex: 2,
        toIndex: 0
      });

      expect(result.cells.map(c => c.id)).toEqual(['c', 'a', 'b']);
    });
  });

  describe('updateContent', () => {
    it('updates cell content', () => {
      const state = makeState([makeCell('a', 'old content')]);
      const result = applyOperation(state, {
        type: 'updateContent',
        cellId: 'a',
        oldContent: 'old content',
        newContent: 'new content'
      });

      expect(result.cells[0].content).toBe('new content');
    });

    it('does not affect other cells', () => {
      const state = makeState([
        makeCell('a', 'unchanged'),
        makeCell('b', 'old')
      ]);
      const result = applyOperation(state, {
        type: 'updateContent',
        cellId: 'b',
        oldContent: 'old',
        newContent: 'new'
      });

      expect(result.cells[0].content).toBe('unchanged');
      expect(result.cells[1].content).toBe('new');
    });
  });

  describe('updateMetadata', () => {
    it('changes cell type', () => {
      const state = makeState([makeCell('a', '# Title', 'code')]);
      const result = applyOperation(state, {
        type: 'updateMetadata',
        cellId: 'a',
        changes: { type: { old: 'code', new: 'markdown' } }
      });

      expect(result.cells[0].type).toBe('markdown');
    });

    it('changes multiple properties at once', () => {
      const state = makeState([makeCell('a', 'content', 'code')]);
      const result = applyOperation(state, {
        type: 'updateMetadata',
        cellId: 'a',
        changes: {
          type: { old: 'code', new: 'markdown' },
          scrolled: { old: true, new: false }
        }
      });

      expect(result.cells[0].type).toBe('markdown');
      expect(result.cells[0].scrolled).toBe(false);
    });

    it('sets scrolled from undefined to false', () => {
      const state = makeState([makeCell('a', 'content', 'code')]); // scrolled is undefined
      const result = applyOperation(state, {
        type: 'updateMetadata',
        cellId: 'a',
        changes: { scrolled: { old: undefined, new: false } }
      });

      expect(result.cells[0].scrolled).toBe(false);
    });

    it('sets scrolled from undefined to true', () => {
      const state = makeState([makeCell('a', 'content', 'code')]); // scrolled is undefined
      const result = applyOperation(state, {
        type: 'updateMetadata',
        cellId: 'a',
        changes: { scrolled: { old: undefined, new: true } }
      });

      expect(result.cells[0].scrolled).toBe(true);
    });

    it('preserves scrolled through insertCell', () => {
      const state = makeState([]);
      const cellWithScrolled = makeCell('a', 'content', 'code', false);
      const result = applyOperation(state, {
        type: 'insertCell',
        index: 0,
        cell: cellWithScrolled
      });

      expect(result.cells[0].scrolled).toBe(false);
    });

    it('preserves scrolled when other properties change', () => {
      const state = makeState([makeCell('a', 'content', 'code', false)]);
      const result = applyOperation(state, {
        type: 'updateContent',
        cellId: 'a',
        oldContent: 'content',
        newContent: 'new content'
      });

      expect(result.cells[0].scrolled).toBe(false);
      expect(result.cells[0].content).toBe('new content');
    });

    it('only modifies target cell scrolled, not others', () => {
      const state = makeState([
        makeCell('a', 'a', 'code', false),
        makeCell('b', 'b', 'code', true),
        makeCell('c', 'c', 'code') // undefined
      ]);
      const result = applyOperation(state, {
        type: 'updateMetadata',
        cellId: 'b',
        changes: { scrolled: { old: true, new: false } }
      });

      expect(result.cells[0].scrolled).toBe(false); // unchanged
      expect(result.cells[1].scrolled).toBe(false); // changed
      expect(result.cells[2].scrolled).toBeUndefined(); // unchanged
    });
  });

  describe('batch', () => {
    it('applies multiple operations in order', () => {
      const state = makeState([]);
      const cell1 = makeCell('a', '1');
      const cell2 = makeCell('b', '2');

      const result = applyOperation(state, {
        type: 'batch',
        operations: [
          { type: 'insertCell', index: 0, cell: cell1 },
          { type: 'insertCell', index: 1, cell: cell2 },
          { type: 'updateContent', cellId: 'a', oldContent: '1', newContent: 'updated' }
        ]
      });

      expect(result.cells).toHaveLength(2);
      expect(result.cells[0].content).toBe('updated');
      expect(result.cells[1].content).toBe('2');
    });
  });
});

// ============================================================================
// Reverse Operation Tests
// ============================================================================

describe('reverseOperation', () => {
  it('insert reverses to delete', () => {
    const cell = makeCell('a', 'content');
    const op: EditOperation = { type: 'insertCell', index: 0, cell };
    const reversed = reverseOperation(op);

    expect(reversed.type).toBe('deleteCell');
    expect(reversed).toEqual({ type: 'deleteCell', index: 0, cell });
  });

  it('delete reverses to insert', () => {
    const cell = makeCell('a', 'content');
    const op: EditOperation = { type: 'deleteCell', index: 0, cell };
    const reversed = reverseOperation(op);

    expect(reversed.type).toBe('insertCell');
    expect(reversed).toEqual({ type: 'insertCell', index: 0, cell });
  });

  it('move reverses to opposite move', () => {
    const op: EditOperation = { type: 'moveCell', fromIndex: 0, toIndex: 2 };
    const reversed = reverseOperation(op);

    expect(reversed).toEqual({ type: 'moveCell', fromIndex: 2, toIndex: 0 });
  });

  it('updateContent swaps old and new', () => {
    const op: EditOperation = {
      type: 'updateContent',
      cellId: 'a',
      oldContent: 'old',
      newContent: 'new'
    };
    const reversed = reverseOperation(op);

    expect(reversed).toEqual({
      type: 'updateContent',
      cellId: 'a',
      oldContent: 'new',
      newContent: 'old'
    });
  });

  it('updateMetadata swaps old and new for all changes', () => {
    const op: EditOperation = {
      type: 'updateMetadata',
      cellId: 'a',
      changes: {
        type: { old: 'code', new: 'markdown' },
        scrolled: { old: true, new: false }
      }
    };
    const reversed = reverseOperation(op);

    expect(reversed).toEqual({
      type: 'updateMetadata',
      cellId: 'a',
      changes: {
        type: { old: 'markdown', new: 'code' },
        scrolled: { old: false, new: true }
      }
    });
  });

  it('batch reverses in reverse order', () => {
    const op: EditOperation = {
      type: 'batch',
      operations: [
        { type: 'updateContent', cellId: 'a', oldContent: '1', newContent: '2' },
        { type: 'updateContent', cellId: 'a', oldContent: '2', newContent: '3' }
      ]
    };
    const reversed = reverseOperation(op);

    expect(reversed.type).toBe('batch');
    if (reversed.type === 'batch') {
      expect(reversed.operations).toHaveLength(2);
      // Order should be reversed
      expect(reversed.operations[0]).toEqual({
        type: 'updateContent', cellId: 'a', oldContent: '3', newContent: '2'
      });
      expect(reversed.operations[1]).toEqual({
        type: 'updateContent', cellId: 'a', oldContent: '2', newContent: '1'
      });
    }
  });
});

// ============================================================================
// Undo/Redo Roundtrip Tests
// ============================================================================

describe('undo/redo roundtrip', () => {
  it('applying operation then reverse restores original state', () => {
    const original = makeState([makeCell('a', 'original content')]);
    const op: EditOperation = {
      type: 'updateContent',
      cellId: 'a',
      oldContent: 'original content',
      newContent: 'modified content'
    };

    const modified = applyOperation(original, op);
    expect(modified.cells[0].content).toBe('modified content');

    const reversed = reverseOperation(op);
    const restored = applyOperation(modified, reversed);
    expect(restored.cells[0].content).toBe('original content');
  });

  it('insert then undo restores original', () => {
    const original = makeState([makeCell('a', '1')]);
    const newCell = makeCell('b', '2');
    const op: EditOperation = { type: 'insertCell', index: 1, cell: newCell };

    const modified = applyOperation(original, op);
    expect(modified.cells).toHaveLength(2);

    const restored = applyOperation(modified, reverseOperation(op));
    expect(restored.cells).toHaveLength(1);
    expect(restored.cells[0].id).toBe('a');
  });

  it('complex batch operation roundtrips correctly', () => {
    const cell1 = makeCell('a', '1');
    const cell2 = makeCell('b', '2');
    const original = makeState([cell1, cell2]);

    const batchOp: EditOperation = {
      type: 'batch',
      operations: [
        { type: 'updateContent', cellId: 'a', oldContent: '1', newContent: 'modified-a' },
        { type: 'updateContent', cellId: 'b', oldContent: '2', newContent: 'modified-b' },
        { type: 'moveCell', fromIndex: 0, toIndex: 1 }
      ]
    };

    const modified = applyOperation(original, batchOp);
    expect(modified.cells[0].id).toBe('b');
    expect(modified.cells[1].id).toBe('a');
    expect(modified.cells[0].content).toBe('modified-b');
    expect(modified.cells[1].content).toBe('modified-a');

    const restored = applyOperation(modified, reverseOperation(batchOp));
    expect(restored.cells[0].id).toBe('a');
    expect(restored.cells[1].id).toBe('b');
    expect(restored.cells[0].content).toBe('1');
    expect(restored.cells[1].content).toBe('2');
  });
});

// ============================================================================
// History Reconstruction Tests
// ============================================================================

describe('reconstructStateAt', () => {
  it('returns snapshot state when timestamp equals snapshot', () => {
    const cells = [makeCell('a', 'initial')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000)
    ];

    const state = reconstructStateAt(history, 1000);
    expect(state?.cells[0].content).toBe('initial');
  });

  it('applies operations after snapshot', () => {
    const cells = [makeCell('a', 'initial')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({
        type: 'updateContent',
        cellId: 'a',
        oldContent: 'initial',
        newContent: 'modified'
      }, 2000)
    ];

    const state = reconstructStateAt(history, 2000);
    expect(state?.cells[0].content).toBe('modified');
  });

  it('stops at target timestamp', () => {
    const cells = [makeCell('a', 'v1')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'v1', newContent: 'v2'
      }, 2000),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'v2', newContent: 'v3'
      }, 3000),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'v3', newContent: 'v4'
      }, 4000)
    ];

    expect(reconstructStateAt(history, 1000)?.cells[0].content).toBe('v1');
    expect(reconstructStateAt(history, 2000)?.cells[0].content).toBe('v2');
    expect(reconstructStateAt(history, 2500)?.cells[0].content).toBe('v2'); // Between edits
    expect(reconstructStateAt(history, 3000)?.cells[0].content).toBe('v3');
    expect(reconstructStateAt(history, 4000)?.cells[0].content).toBe('v4');
  });

  it('returns null if no snapshot exists', () => {
    const history: HistoryEntry[] = [
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'old', newContent: 'new'
      }, 1000)
    ];

    const state = reconstructStateAt(history, 1000);
    expect(state).toBeNull();
  });

  it('ignores execution events during reconstruction', () => {
    const cells = [makeCell('a', 'code')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({ type: 'runCell', cellId: 'a', cellIndex: 0 }, 2000),
      createHistoryEntry({
        type: 'runCellComplete', cellId: 'a', cellIndex: 0, durationMs: 100, success: true
      }, 2100),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'code', newContent: 'modified'
      }, 3000)
    ];

    // State at 2500 should still be 'code' (runCell doesn't change content)
    expect(reconstructStateAt(history, 2500)?.cells[0].content).toBe('code');
    // State at 3000 should be 'modified'
    expect(reconstructStateAt(history, 3000)?.cells[0].content).toBe('modified');
  });
});

describe('getCellContentAt', () => {
  it('returns cell content at specific timestamp', () => {
    const cells = [makeCell('a', 'v1')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'v1', newContent: 'v2'
      }, 2000),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'v2', newContent: 'v3'
      }, 3000)
    ];

    expect(getCellContentAt(history, 'a', 1500)).toBe('v1');
    expect(getCellContentAt(history, 'a', 2500)).toBe('v2');
    expect(getCellContentAt(history, 'a', 3500)).toBe('v3');
  });

  it('returns null for non-existent cell', () => {
    const cells = [makeCell('a', 'content')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000)
    ];

    expect(getCellContentAt(history, 'nonexistent', 1500)).toBeNull();
  });
});

// ============================================================================
// Execution Trajectory Tests
// ============================================================================

describe('extractExecutionTrajectory', () => {
  it('extracts execution steps with reconstructed code', () => {
    const cells = [makeCell('cell-1', 'print("hello")')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({ type: 'runCell', cellId: 'cell-1', cellIndex: 0 }, 2000),
      createHistoryEntry({
        type: 'runCellComplete',
        cellId: 'cell-1',
        cellIndex: 0,
        durationMs: 50,
        success: true,
        output: 'hello'
      }, 2050)
    ];

    const trajectory = extractExecutionTrajectory(history);
    expect(trajectory).toHaveLength(1);
    expect(trajectory[0]).toEqual({
      timestamp: 2000,
      cellId: 'cell-1',
      cellIndex: 0,
      code: 'print("hello")',
      durationMs: 50,
      success: true,
      output: 'hello'
    });
  });

  it('supports event envelope for runCell/runCellComplete', () => {
    const cells = [makeCell('cell-1', 'print(1)')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({
        type: 'event',
        category: 'execution',
        name: 'runCell',
        target: { cellId: 'cell-1', cellIndex: 0 },
        runId: 'run-1',
      }, 2000),
      createHistoryEntry({
        type: 'event',
        category: 'execution',
        name: 'runCellComplete',
        target: { cellId: 'cell-1', cellIndex: 0 },
        runId: 'run-1',
        data: { durationMs: 10, success: true },
      }, 2010),
    ];

    const trajectory = extractExecutionTrajectory(history);
    expect(trajectory).toHaveLength(1);
    expect(trajectory[0].runId).toBe('run-1');
    expect(trajectory[0].durationMs).toBe(10);
    expect(trajectory[0].success).toBe(true);
  });

  it('handles edit-then-run sequence', () => {
    const cells = [makeCell('a', 'v1')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'v1', newContent: 'v2'
      }, 1500),
      createHistoryEntry({ type: 'runCell', cellId: 'a', cellIndex: 0 }, 2000),
      createHistoryEntry({
        type: 'runCellComplete', cellId: 'a', cellIndex: 0, durationMs: 100, success: true
      }, 2100),
      createHistoryEntry({
        type: 'updateContent', cellId: 'a', oldContent: 'v2', newContent: 'v3'
      }, 3000),
      createHistoryEntry({ type: 'runCell', cellId: 'a', cellIndex: 0 }, 3500),
      createHistoryEntry({
        type: 'runCellComplete', cellId: 'a', cellIndex: 0, durationMs: 200, success: false
      }, 3700)
    ];

    const trajectory = extractExecutionTrajectory(history);
    expect(trajectory).toHaveLength(2);

    // First run should have v2 (content at time 2000)
    expect(trajectory[0].code).toBe('v2');
    expect(trajectory[0].success).toBe(true);

    // Second run should have v3 (content at time 3500)
    expect(trajectory[1].code).toBe('v3');
    expect(trajectory[1].success).toBe(false);
  });

  it('handles multiple cells', () => {
    const cells = [
      makeCell('a', 'import pandas'),
      makeCell('b', 'df = pd.read_csv("data.csv")')
    ];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({ type: 'runCell', cellId: 'a', cellIndex: 0 }, 2000),
      createHistoryEntry({
        type: 'runCellComplete', cellId: 'a', cellIndex: 0, durationMs: 50, success: true
      }, 2050),
      createHistoryEntry({ type: 'runCell', cellId: 'b', cellIndex: 1 }, 3000),
      createHistoryEntry({
        type: 'runCellComplete', cellId: 'b', cellIndex: 1, durationMs: 1000, success: true
      }, 4000)
    ];

    const trajectory = extractExecutionTrajectory(history);
    expect(trajectory).toHaveLength(2);
    expect(trajectory[0].code).toBe('import pandas');
    expect(trajectory[1].code).toBe('df = pd.read_csv("data.csv")');
  });
});

// ============================================================================
// Validation Tests
// ============================================================================

describe('validateHistory', () => {
  it('valid history passes validation', () => {
    const cells = [makeCell('a', 'code')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({ type: 'runCell', cellId: 'a', cellIndex: 0 }, 2000),
      createHistoryEntry({
        type: 'runCellComplete', cellId: 'a', cellIndex: 0, durationMs: 100, success: true
      }, 2100)
    ];

    const result = validateHistory(history);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('fails if no snapshot at start', () => {
    const history: HistoryEntry[] = [
      createHistoryEntry({ type: 'runCell', cellId: 'a', cellIndex: 0 }, 1000)
    ];

    const result = validateHistory(history);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('History must start with a snapshot');
  });

  it('fails if timestamps not monotonic', () => {
    const cells = [makeCell('a', 'code')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 2000),
      createHistoryEntry({ type: 'runCell', cellId: 'a', cellIndex: 0 }, 1000) // Earlier!
    ];

    const result = validateHistory(history);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Timestamp'))).toBe(true);
  });

  it('fails if runCell references non-existent cell', () => {
    const cells = [makeCell('a', 'code')];
    const history: HistoryEntry[] = [
      createHistoryEntry(createSnapshot(cells), 1000),
      createHistoryEntry({ type: 'runCell', cellId: 'nonexistent', cellIndex: 0 }, 2000)
    ];

    const result = validateHistory(history);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Cannot reconstruct cell content'))).toBe(true);
  });
});

// ============================================================================
// Integration Test: Full Analysis Session
// ============================================================================

describe('full analysis session', () => {
  it('can reproduce complete data analysis trajectory', () => {
    // Simulate a real data analysis session
    const history: HistoryEntry[] = [];
    let timestamp = 1000;

    // 1. Start with empty notebook
    const cell1 = makeCell('imports', '');
    history.push(createHistoryEntry(createSnapshot([cell1]), timestamp));

    // 2. User types import statement
    timestamp += 1000;
    history.push(createHistoryEntry({
      type: 'updateContent',
      cellId: 'imports',
      oldContent: '',
      newContent: 'import pandas as pd'
    }, timestamp));

    // 3. User runs the cell
    timestamp += 500;
    history.push(createHistoryEntry({
      type: 'runCell', cellId: 'imports', cellIndex: 0
    }, timestamp));

    timestamp += 100;
    history.push(createHistoryEntry({
      type: 'runCellComplete',
      cellId: 'imports',
      cellIndex: 0,
      durationMs: 100,
      success: true
    }, timestamp));

    // 4. User adds new cell
    const cell2 = makeCell('load-data', '');
    timestamp += 1000;
    history.push(createHistoryEntry({
      type: 'insertCell', index: 1, cell: cell2
    }, timestamp));

    // 5. User types data loading code
    timestamp += 2000;
    history.push(createHistoryEntry({
      type: 'updateContent',
      cellId: 'load-data',
      oldContent: '',
      newContent: 'df = pd.read_csv("sales.csv")\ndf.head()'
    }, timestamp));

    // 6. User runs it
    timestamp += 500;
    history.push(createHistoryEntry({
      type: 'runCell', cellId: 'load-data', cellIndex: 1
    }, timestamp));

    timestamp += 2000;
    history.push(createHistoryEntry({
      type: 'runCellComplete',
      cellId: 'load-data',
      cellIndex: 1,
      durationMs: 2000,
      success: true,
      output: '   date  amount\n0  2024-01-01  100\n...'
    }, timestamp));

    // 7. User modifies the code (adds filtering)
    timestamp += 5000;
    history.push(createHistoryEntry({
      type: 'updateContent',
      cellId: 'load-data',
      oldContent: 'df = pd.read_csv("sales.csv")\ndf.head()',
      newContent: 'df = pd.read_csv("sales.csv")\ndf = df[df["amount"] > 50]\ndf.head()'
    }, timestamp));

    // 8. User runs again
    timestamp += 500;
    history.push(createHistoryEntry({
      type: 'runCell', cellId: 'load-data', cellIndex: 1
    }, timestamp));

    timestamp += 1500;
    history.push(createHistoryEntry({
      type: 'runCellComplete',
      cellId: 'load-data',
      cellIndex: 1,
      durationMs: 1500,
      success: true,
      output: '   date  amount\n0  2024-01-01  100\n...'
    }, timestamp));

    // Validate history
    const validation = validateHistory(history);
    expect(validation.valid).toBe(true);

    // Extract trajectory
    const trajectory = extractExecutionTrajectory(history);
    expect(trajectory).toHaveLength(3);

    // First execution: import
    expect(trajectory[0].code).toBe('import pandas as pd');
    expect(trajectory[0].success).toBe(true);

    // Second execution: original data loading
    expect(trajectory[1].code).toBe('df = pd.read_csv("sales.csv")\ndf.head()');

    // Third execution: modified data loading with filter
    expect(trajectory[2].code).toBe('df = pd.read_csv("sales.csv")\ndf = df[df["amount"] > 50]\ndf.head()');

    // Verify we can reconstruct state at any point
    const stateAfterImport = reconstructStateAt(history, 2600);
    expect(stateAfterImport?.cells).toHaveLength(1);
    expect(stateAfterImport?.cells[0].content).toBe('import pandas as pd');

    const stateAfterAddCell = reconstructStateAt(history, 4000);
    expect(stateAfterAddCell?.cells).toHaveLength(2);

    const finalState = reconstructStateAt(history, timestamp);
    expect(finalState?.cells).toHaveLength(2);
    expect(finalState?.cells[1].content).toContain('df["amount"] > 50');
  });
});
