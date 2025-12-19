
import { useState, useCallback, useRef } from 'react';
import { Cell, CellType } from '../types';
import { createDiff, diffToPatch, applyPatch, reversePatch, hashText, Patch } from '../lib/diffUtils';

// Maximum number of operations to keep in history
const MAX_HISTORY = 100;

// Base operation data shared by all operations
interface BaseOperation {
  timestamp: number; // Unix timestamp in milliseconds
}

// Undoable operations - can be reversed
export type UndoableOperation =
  | { type: 'insertCell'; index: number; cell: Cell }
  | { type: 'deleteCell'; index: number; cell: Cell }
  | { type: 'moveCell'; fromIndex: number; toIndex: number }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string }
  | { type: 'updateContentPatch'; cellId: string; patch: Patch; oldHash: string; newHash: string }
  | { type: 'changeType'; cellId: string; oldType: CellType; newType: CellType }
  | { type: 'batch'; operations: UndoableOperation[] };

// Non-undoable operations - for tracking/logging only
// Note: runCell does NOT include content - it can be reconstructed from edit history
// by finding the most recent snapshot and replaying updateContent operations
export type LogOperation =
  | { type: 'runCell'; cellId: string; cellIndex: number }
  | { type: 'runAllCells'; cellCount: number }
  | { type: 'interruptKernel' }
  | { type: 'restartKernel' }
  | { type: 'executionComplete'; cellId: string; cellIndex: number; durationMs: number; success: boolean; output?: string };

// Snapshot of notebook state at a point in time (for reconstruction)
export interface SnapshotOperation {
  type: 'snapshot';
  cells: Cell[];
}

// Combined operation type with timestamp
export type TimestampedOperation = BaseOperation & (UndoableOperation | LogOperation | SnapshotOperation);

// Legacy Operation type for backwards compatibility with undo/redo logic
export type Operation = UndoableOperation;

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
  // History access for persistence
  getFullHistory: () => TimestampedOperation[];
  loadHistory: (history: TimestampedOperation[]) => void;
  // Log non-undoable operations (for history tracking)
  logOperation: (op: LogOperation) => void;
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
    case 'updateContentPatch': {
      return cells.map(c => {
        if (c.id !== op.cellId) return c;
        const { result } = applyPatch(c.content, op.patch);
        return { ...c, content: result };
      });
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
    case 'updateContentPatch':
      return {
        type: 'updateContentPatch',
        cellId: op.cellId,
        patch: reversePatch(op.patch),
        oldHash: op.newHash,
        newHash: op.oldHash
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

// Maximum operations to keep in full history
const MAX_FULL_HISTORY = 10000;

export const useUndoRedo = (initialCells: Cell[]): UseUndoRedoResult => {
  // Current state
  const [cells, setCellsInternal] = useState<Cell[]>(initialCells);

  // Operation history stacks
  const [undoStack, setUndoStack] = useState<Operation[]>([]);
  const [redoStack, setRedoStack] = useState<Operation[]>([]);

  // Track last content per cell for updateContent operations
  const lastContentRef = useRef<Map<string, string>>(new Map());

  // Full timestamped history for persistence (includes both undoable and log operations)
  const fullHistoryRef = useRef<TimestampedOperation[]>([]);

  const canUndo = undoStack.length > 0;
  const canRedo = redoStack.length > 0;

  // Helper to add operation to full history
  const addToFullHistory = useCallback((op: UndoableOperation | LogOperation) => {
    const timestampedOp: TimestampedOperation = {
      ...op,
      timestamp: Date.now()
    };
    fullHistoryRef.current.push(timestampedOp);
    // Trim if exceeds max
    if (fullHistoryRef.current.length > MAX_FULL_HISTORY) {
      fullHistoryRef.current = fullHistoryRef.current.slice(-MAX_FULL_HISTORY);
    }
  }, []);

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
    addToFullHistory(op); // Track in full history
  }, [addToFullHistory]);

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

        const op: Operation = {
          type: 'updateContent',
          cellId,
          oldContent,
          newContent
        };

        // Push operation to undo stack
        setUndoStack(prevStack => {
          const newStack = [...prevStack, op];
          if (newStack.length > MAX_HISTORY) {
            newStack.shift();
          }
          return newStack;
        });
        setRedoStack([]);
        addToFullHistory(op); // Track in full history
      }

      return prev.map(c => c.id === cellId ? { ...c, content: newContent } : c);
    });
  }, [addToFullHistory]);

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
      addToFullHistory(op); // Track in full history

      return prev.map(c => c.id === cellId ? { ...c, type: newType } : c);
    });
  }, [addToFullHistory]);

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

    // Start fresh history with a snapshot (required for trajectory reconstruction)
    fullHistoryRef.current = [{
      type: 'snapshot',
      cells: newCells.map(c => ({ ...c })), // Deep copy
      timestamp: Date.now()
    }];
  }, []);

  // Legacy: saveCheckpoint does nothing in operation-based system
  // Content changes are automatically tracked
  const saveCheckpoint = useCallback(() => {
    // No-op - operations are tracked automatically
  }, []);

  // Strip outputs from cell for compact storage (outputs can be huge - images, dataframes)
  const stripCellOutputs = useCallback((cell: Cell): Cell => ({
    ...cell,
    outputs: [],
    isExecuting: false
  }), []);

  // Convert updateContent to updateContentPatch for compact storage
  const convertToCompactFormat = useCallback((op: TimestampedOperation): TimestampedOperation => {
    if (op.type === 'snapshot') {
      // Strip outputs from snapshot cells to reduce storage size
      return {
        ...op,
        cells: op.cells.map(stripCellOutputs)
      };
    }
    if (op.type === 'updateContent') {
      // Convert to patch format for smaller storage
      const diff = createDiff(op.oldContent, op.newContent);
      const patch = diffToPatch(op.oldContent, diff);
      return {
        type: 'updateContentPatch',
        cellId: op.cellId,
        patch,
        oldHash: hashText(op.oldContent),
        newHash: hashText(op.newContent),
        timestamp: op.timestamp
      };
    }
    if (op.type === 'insertCell') {
      // Strip outputs from inserted cell
      return {
        ...op,
        cell: stripCellOutputs(op.cell)
      };
    }
    if (op.type === 'deleteCell') {
      // Strip outputs from deleted cell
      return {
        ...op,
        cell: stripCellOutputs(op.cell)
      };
    }
    if (op.type === 'batch') {
      // Recursively convert batch operations
      return {
        ...op,
        operations: op.operations.map(subOp =>
          convertToCompactFormat({ ...subOp, timestamp: op.timestamp }) as UndoableOperation
        )
      };
    }
    return op;
  }, [stripCellOutputs]);

  // Get full history for persistence (converts to compact patch format)
  const getFullHistory = useCallback((): TimestampedOperation[] => {
    return fullHistoryRef.current.map(convertToCompactFormat);
  }, [convertToCompactFormat]);

  // Load history from persistence (e.g., when loading a notebook)
  // Rebuilds undoStack from loaded operations so undo works
  const loadHistory = useCallback((history: TimestampedOperation[]) => {
    // If loaded history starts with a snapshot, use it entirely
    if (history.length > 0 && history[0].type === 'snapshot') {
      fullHistoryRef.current = [...history];
    } else if (history.length > 0) {
      // Loaded history has no snapshot - append to current (which has the snapshot)
      const currentSnapshot = fullHistoryRef.current.find(op => op.type === 'snapshot');
      if (currentSnapshot) {
        fullHistoryRef.current = [currentSnapshot, ...history];
      } else {
        fullHistoryRef.current = [...history];
      }
    }

    // Rebuild undoStack from the loaded history (only undoable operations)
    const undoableOps: Operation[] = [];
    for (const op of fullHistoryRef.current) {
      if (op.type === 'insertCell' || op.type === 'deleteCell' ||
          op.type === 'moveCell' || op.type === 'updateContent' ||
          op.type === 'updateContentPatch' || op.type === 'changeType' || op.type === 'batch') {
        const { timestamp, ...operation } = op as any;
        undoableOps.push(operation as Operation);
      }
    }
    setUndoStack(undoableOps);
    setRedoStack([]);
  }, []);

  // Log a non-undoable operation (for history tracking)
  const logOperation = useCallback((op: LogOperation) => {
    addToFullHistory(op);
  }, [addToFullHistory]);

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
    getFullHistory,
    loadHistory,
    logOperation,
  };
};
