
import { useState, useCallback, useRef } from 'react';
import { Cell, CellType } from '../types';

// Maximum number of operations to keep in history
const MAX_HISTORY = 100;

// Operation types - each knows how to apply and reverse itself
export type Operation =
  | { type: 'insertCell'; index: number; cell: Cell }
  | { type: 'deleteCell'; index: number; cell: Cell }
  | { type: 'moveCell'; fromIndex: number; toIndex: number }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string }
  | { type: 'changeType'; cellId: string; oldType: CellType; newType: CellType }
  | { type: 'batch'; operations: Operation[] }; // For grouping multiple operations

interface UseUndoRedoResult {
  cells: Cell[];
  setCells: (newCells: Cell[] | ((prev: Cell[]) => Cell[])) => void;
  // Operation dispatchers
  insertCell: (index: number, cell: Cell) => void;
  deleteCell: (index: number) => Cell | null;
  moveCell: (fromIndex: number, toIndex: number) => void;
  updateContent: (cellId: string, newContent: string) => void;
  changeType: (cellId: string, newType: CellType) => void;
  // Batch operations (for compound actions)
  batch: (operations: Operation[]) => void;
  // Undo/Redo
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  // Reset
  resetHistory: (initialCells: Cell[]) => void;
  // Legacy support - for operations that don't fit the model
  saveCheckpoint: () => void;
}

// Apply an operation to cells (forward)
function applyOperation(cells: Cell[], op: Operation): Cell[] {
  switch (op.type) {
    case 'insertCell': {
      const newCells = [...cells];
      newCells.splice(op.index, 0, op.cell);
      return newCells;
    }
    case 'deleteCell': {
      return cells.filter((_, i) => i !== op.index);
    }
    case 'moveCell': {
      const newCells = [...cells];
      const [moved] = newCells.splice(op.fromIndex, 1);
      newCells.splice(op.toIndex, 0, moved);
      return newCells;
    }
    case 'updateContent': {
      return cells.map(c =>
        c.id === op.cellId ? { ...c, content: op.newContent } : c
      );
    }
    case 'changeType': {
      return cells.map(c =>
        c.id === op.cellId ? { ...c, type: op.newType } : c
      );
    }
    case 'batch': {
      return op.operations.reduce((acc, subOp) => applyOperation(acc, subOp), cells);
    }
    default:
      return cells;
  }
}

// Reverse an operation (for undo)
function reverseOperation(op: Operation): Operation {
  switch (op.type) {
    case 'insertCell':
      return { type: 'deleteCell', index: op.index, cell: op.cell };
    case 'deleteCell':
      return { type: 'insertCell', index: op.index, cell: op.cell };
    case 'moveCell':
      return { type: 'moveCell', fromIndex: op.toIndex, toIndex: op.fromIndex };
    case 'updateContent':
      return {
        type: 'updateContent',
        cellId: op.cellId,
        oldContent: op.newContent,
        newContent: op.oldContent
      };
    case 'changeType':
      return {
        type: 'changeType',
        cellId: op.cellId,
        oldType: op.newType,
        newType: op.oldType
      };
    case 'batch':
      // Reverse batch operations in reverse order
      return {
        type: 'batch',
        operations: op.operations.map(reverseOperation).reverse()
      };
    default:
      return op;
  }
}

export const useUndoRedo = (initialCells: Cell[]): UseUndoRedoResult => {
  // Current state
  const [cells, setCellsInternal] = useState<Cell[]>(initialCells);

  // Operation history stacks
  const [undoStack, setUndoStack] = useState<Operation[]>([]);
  const [redoStack, setRedoStack] = useState<Operation[]>([]);

  // Track last content per cell for updateContent operations
  const lastContentRef = useRef<Map<string, string>>(new Map());

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  // Execute an operation and push to undo stack
  const executeOperation = useCallback((op: Operation) => {
    setCellsInternal(prev => applyOperation(prev, op));
    setUndoStack(prev => {
      const newStack = [...prev, op];
      if (newStack.length > MAX_HISTORY) {
        newStack.shift();
      }
      return newStack;
    });
    setRedoStack([]); // Clear redo stack on new operation
  }, []);

  // Insert a cell at index
  const insertCell = useCallback((index: number, cell: Cell) => {
    executeOperation({ type: 'insertCell', index, cell });
  }, [executeOperation]);

  // Delete a cell at index, returns the deleted cell
  const deleteCell = useCallback((index: number): Cell | null => {
    let deletedCell: Cell | null = null;
    setCellsInternal(prev => {
      if (index < 0 || index >= prev.length) return prev;
      deletedCell = prev[index];
      return prev;
    });

    if (deletedCell) {
      executeOperation({ type: 'deleteCell', index, cell: deletedCell });
    }
    return deletedCell;
  }, [executeOperation]);

  // Move a cell from one index to another
  const moveCell = useCallback((fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    executeOperation({ type: 'moveCell', fromIndex, toIndex });
  }, [executeOperation]);

  // Update cell content - tracks old content for undo
  const updateContent = useCallback((cellId: string, newContent: string) => {
    setCellsInternal(prev => {
      const cell = prev.find(c => c.id === cellId);
      if (!cell) return prev;

      const oldContent = lastContentRef.current.get(cellId) ?? cell.content;

      // Only create operation if content actually changed
      if (oldContent !== newContent) {
        // Update last known content
        lastContentRef.current.set(cellId, newContent);

        // Push operation to undo stack
        setUndoStack(prevStack => {
          const op: Operation = {
            type: 'updateContent',
            cellId,
            oldContent,
            newContent
          };
          const newStack = [...prevStack, op];
          if (newStack.length > MAX_HISTORY) {
            newStack.shift();
          }
          return newStack;
        });
        setRedoStack([]);
      }

      return prev.map(c => c.id === cellId ? { ...c, content: newContent } : c);
    });
  }, []);

  // Change cell type
  const changeType = useCallback((cellId: string, newType: CellType) => {
    setCellsInternal(prev => {
      const cell = prev.find(c => c.id === cellId);
      if (!cell || cell.type === newType) return prev;

      const op: Operation = {
        type: 'changeType',
        cellId,
        oldType: cell.type,
        newType
      };

      setUndoStack(prevStack => {
        const newStack = [...prevStack, op];
        if (newStack.length > MAX_HISTORY) {
          newStack.shift();
        }
        return newStack;
      });
      setRedoStack([]);

      return prev.map(c => c.id === cellId ? { ...c, type: newType } : c);
    });
  }, []);

  // Execute a batch of operations as a single undoable action
  const batch = useCallback((operations: Operation[]) => {
    if (operations.length === 0) return;
    if (operations.length === 1) {
      executeOperation(operations[0]);
    } else {
      executeOperation({ type: 'batch', operations });
    }
  }, [executeOperation]);

  // Undo last operation
  const undo = useCallback(() => {
    if (undoStack.length === 0) return;

    const op = undoStack[undoStack.length - 1];
    const reversedOp = reverseOperation(op);

    setCellsInternal(prev => applyOperation(prev, reversedOp));
    setUndoStack(prev => prev.slice(0, -1));
    setRedoStack(prev => [...prev, op]);

    // Update content tracking for content operations
    if (op.type === 'updateContent') {
      lastContentRef.current.set(op.cellId, op.oldContent);
    }
  }, [undoStack]);

  // Redo last undone operation
  const redo = useCallback(() => {
    if (redoStack.length === 0) return;

    const op = redoStack[redoStack.length - 1];

    setCellsInternal(prev => applyOperation(prev, op));
    setRedoStack(prev => prev.slice(0, -1));
    setUndoStack(prev => [...prev, op]);

    // Update content tracking for content operations
    if (op.type === 'updateContent') {
      lastContentRef.current.set(op.cellId, op.newContent);
    }
  }, [redoStack]);

  // Direct setCells for non-undoable changes (like execution outputs)
  const setCells = useCallback((newCells: Cell[] | ((prev: Cell[]) => Cell[])) => {
    setCellsInternal(newCells);
  }, []);

  // Reset history (e.g., when loading a new file)
  const resetHistory = useCallback((newCells: Cell[]) => {
    setCellsInternal(newCells);
    setUndoStack([]);
    setRedoStack([]);
    lastContentRef.current.clear();
    // Initialize content tracking
    newCells.forEach(c => lastContentRef.current.set(c.id, c.content));
  }, []);

  // Legacy: saveCheckpoint does nothing in operation-based system
  // Content changes are automatically tracked
  const saveCheckpoint = useCallback(() => {
    // No-op - operations are tracked automatically
  }, []);

  return {
    cells,
    setCells,
    insertCell,
    deleteCell,
    moveCell,
    updateContent,
    changeType,
    batch,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
    saveCheckpoint,
  };
};
