/**
 * HeadlessUndoRedoManager Tests
 */

import { describe, it, expect } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell } from '../fs/types';
import { HeadlessUndoRedoManager, UndoableOperation } from '../notebook/undoRedoManager';

function makeCell(id: string, content: string): NebulaCell {
  return {
    id,
    type: 'code',
    content,
    outputs: [],
    isExecuting: false,
    executionCount: null,
  };
}

describe('HeadlessUndoRedoManager', () => {
  it('should undo and redo batch operations in order', () => {
    const fsService = new FilesystemService();
    const manager = new HeadlessUndoRedoManager(fsService);
    const notebookPath = path.join(os.tmpdir(), `undo-batch-${Date.now()}.ipynb`);

    const insertedCell = makeCell('cell-2', 'b');
    const afterCells: NebulaCell[] = [
      makeCell('cell-1', 'a2'),
      insertedCell,
    ];

    const batchOp: UndoableOperation = {
      type: 'batch',
      operations: [
        { type: 'insertCell', index: 1, cell: insertedCell },
        { type: 'updateContent', cellId: 'cell-1', oldContent: 'a', newContent: 'a2' },
      ],
      source: 'mcp',
    };

    manager.recordOperation(notebookPath, afterCells, batchOp);

    const undoResult = manager.undo(notebookPath, afterCells);
    expect(undoResult.result.success).toBe(true);
    expect(undoResult.cells).toHaveLength(1);
    expect(undoResult.cells[0].content).toBe('a');

    const redoResult = manager.redo(notebookPath, undoResult.cells);
    expect(redoResult.result.success).toBe(true);
    expect(redoResult.cells).toHaveLength(2);
    expect(redoResult.cells[0].content).toBe('a2');
  });
});
