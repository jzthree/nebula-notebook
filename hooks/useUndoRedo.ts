/**
 * NOTEBOOK-LEVEL UNDO/REDO SYSTEM
 *
 * This hook manages the structural history of the notebook - operations that
 * affect the notebook as a whole rather than individual text edits.
 *
 * ## Dual Undo Architecture
 *
 * The notebook uses two complementary undo systems:
 *
 * 1. **CodeMirror (keyboard Ctrl/Cmd+Z)**: Fine-grained per-cell text history
 *    - Character-level undo for each cell's content
 *    - Each cell has independent undo stacks
 *    - Optimal for typos and local text editing
 *
 * 2. **This hook (toolbar buttons)**: Coarse-grained notebook operations
 *    - Structural: insertCell, deleteCell, moveCell, changeType
 *    - Content: updateContent (batched at keyframe boundaries)
 *    - Batch: compound operations as single undo step
 *
 * This separation is intentional - users get fine-grained text editing via
 * keyboard and structural notebook changes via toolbar, each at the appropriate
 * granularity level.
 *
 * ## Keyframe Pattern
 *
 * Content changes are NOT tracked on every keystroke. Instead, we use "keyframes":
 * - Before structural operations (add/delete/move cell)
 * - Before execution (run cell)
 * - On save
 * - On explicit flush calls
 *
 * Call `flushCell(cellId, content)` before keyframe operations to capture
 * pending content changes.
 *
 * ## Full History
 *
 * Beyond undo/redo, this hook maintains a complete timestamped operation log
 * (fullHistoryRef) for session replay, AI training data, and debugging.
 */

import { useState, useCallback, useRef } from 'react';
import { Cell, CellType } from '../types';
import { createDiff, diffToPatch, applyPatch, reversePatch, hashText, Patch } from '../lib/diffUtils';

// Base operation data shared by all operations
interface BaseOperation {
  timestamp: number; // Unix timestamp in milliseconds
  operationId?: string; // Unique ID for pairing undo ops with original ops
  isUndo?: boolean; // True if this is an undo-generated op (for history filtering)
  undoesOperationId?: string; // ID of the operation being undone (for pairing)
}

// Source of content edit (for tracking AI vs user edits)
export type EditSource = 'user' | 'ai';

/**
 * Generic metadata change - each key maps to old/new values
 * This is intentionally typed as unknown to be maximally extensible.
 * The operation system never needs to change when new cell properties are added.
 */
export type MetadataChanges = Record<string, { old: unknown; new: unknown }>;

// Undoable operations - can be reversed
// All operations can have a source field to track if they came from user or AI
export type UndoableOperation =
  | { type: 'insertCell'; index: number; cell: Cell; source?: EditSource }
  | { type: 'deleteCell'; index: number; cell: Cell; source?: EditSource }
  | { type: 'moveCell'; fromIndex: number; toIndex: number; source?: EditSource }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string; source?: EditSource }
  | { type: 'updateContentPatch'; cellId: string; patch: Patch; oldHash: string; newHash: string; source?: EditSource }
  | { type: 'updateMetadata'; cellId: string; changes: MetadataChanges; source?: EditSource }
  | { type: 'batch'; operations: UndoableOperation[]; source?: EditSource };

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

// Result from undo/redo operations for visual feedback
export interface UndoRedoResult {
  affectedCellIds: string[];  // Cell IDs that were modified
  operationType: string;       // Type of operation (for potential animation variants)
}

// Unflushed edit state for session persistence
export interface UnflushedState {
  cellId: string;
  lastFlushedContent: string;
}

/** Summary of a user change for agent awareness */
export interface UserChangeSummary {
  type: string;
  cellId?: string;
  cellIndex?: number;
  timestamp: number;
  description: string;
}

interface UseUndoRedoResult {
  cells: Cell[];
  setCells: (newCells: Cell[] | ((prev: Cell[]) => Cell[])) => void;
  // Operation dispatchers
  insertCell: (index: number, cell: Cell) => void;
  deleteCell: (index: number) => Cell | null;
  moveCell: (fromIndex: number, toIndex: number) => void;
  updateContent: (cellId: string, newContent: string, source?: EditSource) => void;
  updateContentAI: (cellId: string, newContent: string) => void; // Convenience for AI edits
  // Generic metadata update - stable API that never needs to change
  updateMetadata: (cellId: string, changes: MetadataChanges) => void;
  // Convenience wrappers (call updateMetadata internally)
  changeType: (cellId: string, newType: CellType) => void;
  setCellScrolled: (cellId: string, scrolled: boolean) => void;
  setCellScrolledHeight: (cellId: string, height: number) => void;
  // Batch operations (for compound actions)
  batch: (operations: Operation[]) => void;
  // Flush pending content for a single cell (O(1) - call before keyframe operations)
  flushCell: (cellId: string, currentContent: string) => void;
  // Peek at next undo/redo without applying (for scroll-before-apply)
  peekUndo: () => UndoRedoResult | null;
  peekRedo: () => UndoRedoResult | null;
  // Undo/Redo - returns affected cells for visual feedback
  undo: () => UndoRedoResult | null;
  redo: () => UndoRedoResult | null;
  canUndo: boolean;
  canRedo: boolean;
  // Load cells when opening a notebook (history loaded separately via loadHistory)
  loadCells: (cells: Cell[]) => void;
  // Initialize new history with snapshot (ONLY for new notebooks without existing history)
  initializeNewHistory: (cells: Cell[]) => void;
  // Legacy support - for operations that don't fit the model
  saveCheckpoint: () => void;
  // History access for persistence
  getFullHistory: () => TimestampedOperation[];
  loadHistory: (history: TimestampedOperation[]) => void;
  // Log non-undoable operations (for history tracking)
  logOperation: (op: LogOperation) => void;
  // New for autosave integration
  redoStackLength: number;
  commitHistoryBeforeKeyframe: () => void;
  // Check if editing should trigger a keyframe (redo stack non-empty)
  // Uses ref for immediate reads after state updates
  hasRedoToFlush: () => boolean;
  // Session state for unflushed edits
  getUnflushedState: (activeCellId: string | null, cells: Cell[]) => UnflushedState | null;
  setUnflushedState: (state: UnflushedState | null) => void;
  // User change tracking for agent awareness
  getUserChangesSince: (sinceTimestamp: number) => UserChangeSummary[];
}

function cloneCell(cell: Cell): Cell {
  return {
    ...cell,
    outputs: cell.outputs.map(output => ({ ...output }))
  };
}

// Apply an operation to cells (forward)
function applyOperation(cells: Cell[], op: Operation): Cell[] {
  switch (op.type) {
    case 'insertCell': {
      const newCells = [...cells];
      // Create new object to ensure React memo comparisons detect the change
      // (important for undo - the stored cell object might be the same reference)
      newCells.splice(op.index, 0, cloneCell(op.cell));
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
        const { result, success } = applyPatch(c.content, op.patch);
        if (!success) {
          console.warn(`Failed to apply patch to cell ${c.id}, keeping original content`);
          return c;
        }
        return { ...c, content: result };
      });
    }
    case 'updateMetadata': {
      // Generic metadata update - applies any key/value changes
      return cells.map(c => {
        if (c.id !== op.cellId) return c;
        const updated = { ...c };
        for (const [key, change] of Object.entries(op.changes)) {
          (updated as Record<string, unknown>)[key] = change.new;
        }
        return updated as Cell;
      });
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
    case 'updateMetadata': {
      // Generic reversal - swap old/new for each change
      const reversed: MetadataChanges = {};
      for (const [key, change] of Object.entries(op.changes)) {
        reversed[key] = { old: change.new, new: change.old };
      }
      return { type: 'updateMetadata', cellId: op.cellId, changes: reversed };
    }
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

// Extract affected cell IDs from an operation
// For moveCell, we need the cells array to look up the cell ID by index
function getAffectedCellIds(op: Operation, cells?: Cell[]): string[] {
  switch (op.type) {
    case 'insertCell':
    case 'deleteCell':
      return [op.cell.id];
    case 'moveCell':
      // Look up cell ID from the destination index (where it ends up after the op)
      if (cells && op.toIndex >= 0 && op.toIndex < cells.length) {
        return [cells[op.toIndex].id];
      }
      return [];
    case 'updateContent':
    case 'updateContentPatch':
    case 'updateMetadata':
      return [op.cellId];
    case 'batch':
      // Collect all unique cell IDs from batch operations
      const ids = new Set<string>();
      for (const subOp of op.operations) {
        for (const id of getAffectedCellIds(subOp, cells)) {
          ids.add(id);
        }
      }
      return Array.from(ids);
    default:
      return [];
  }
}

export const useUndoRedo = (initialCells: Cell[]): UseUndoRedoResult => {
  // Current state
  const [cells, setCellsState] = useState<Cell[]>(initialCells);

  // Ref to track current cells for synchronous reads (avoids stale closures and Strict Mode issues)
  const cellsRef = useRef<Cell[]>(initialCells);

  // Wrapper that updates both state and ref for cells
  const setCellsInternal = useCallback((update: Cell[] | ((prev: Cell[]) => Cell[])) => {
    if (typeof update === 'function') {
      setCellsState(prev => {
        const newCells = update(prev);
        cellsRef.current = newCells;
        return newCells;
      });
    } else {
      cellsRef.current = update;
      setCellsState(update);
    }
  }, []);

  // Operation history stacks - stored in refs for O(1) mutations
  // Only boolean state triggers re-renders (for undo/redo button enabled state)
  const undoStackRef = useRef<Operation[]>([]);
  const redoStackRef = useRef<Operation[]>([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Track last content per cell for updateContent operations
  const lastContentRef = useRef<Map<string, string>>(new Map());

  // Full timestamped history for persistence (includes both undoable and log operations)
  const fullHistoryRef = useRef<TimestampedOperation[]>([]);

  // Track redo stack length for keyframe detection (first undo, first edit after undo)
  const prevRedoLengthRef = useRef<number>(0);

  // Helper to add operation to full history
  // Returns the generated operationId for linking undo ops
  const addToFullHistory = useCallback((op: UndoableOperation | LogOperation): string => {
    const operationId = crypto.randomUUID();
    const timestampedOp: TimestampedOperation = {
      ...op,
      timestamp: Date.now(),
      operationId,
    };
    fullHistoryRef.current.push(timestampedOp);
    return operationId;
  }, []);

  // Convert redo stack entries to undo ops in history (for keyframe events)
  // This records the undo steps in history while keeping history append-only
  const convertRedoStackToHistory = useCallback((redoOps: Operation[]) => {
    redoOps.forEach(op => {
      const reversedOp = reverseOperation(op);
      const timestampedOp: TimestampedOperation = {
        ...reversedOp,
        timestamp: Date.now(),
        operationId: crypto.randomUUID(),
        isUndo: true,
        undoesOperationId: (op as any).operationId,
      };
      fullHistoryRef.current.push(timestampedOp);
    });
  }, []);

  // Execute an operation and push to undo stack
  const executeOperation = useCallback((op: Operation) => {
    setCellsInternal(prev => applyOperation(prev, op));
    // Keyframe: first edit after undo - convert redo stack to history before clearing
    if (redoStackRef.current.length > 0) {
      convertRedoStackToHistory(redoStackRef.current);
      redoStackRef.current.length = 0; // O(1) clear
      setCanRedo(false);
    }
    // Add to history first to get the operationId
    const operationId = addToFullHistory(op);
    // Store operationId on the op for later linking when it moves to redo stack
    const opWithId = { ...op, operationId } as unknown as Operation;
    undoStackRef.current.push(opWithId); // O(1) push
    setCanUndo(true);
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Insert a cell at index
  const insertCell = useCallback((index: number, cell: Cell, source: EditSource = 'user') => {
    const snapshot = cloneCell(cell);
    // Initialize content tracking for the new cell
    lastContentRef.current.set(snapshot.id, snapshot.content);
    executeOperation({ type: 'insertCell', index, cell: snapshot, source });
  }, [executeOperation]);

  // Delete a cell at index, returns the deleted cell
  const deleteCell = useCallback((index: number, source: EditSource = 'user'): Cell | null => {
    const cellToDelete = cells[index];
    if (!cellToDelete) return null;
    const snapshot = cloneCell(cellToDelete);
    executeOperation({ type: 'deleteCell', index, cell: snapshot, source });
    return snapshot;
  }, [cells, executeOperation]);

  // Move a cell from one index to another
  const moveCell = useCallback((fromIndex: number, toIndex: number, source: EditSource = 'user') => {
    if (fromIndex === toIndex) return;
    executeOperation({ type: 'moveCell', fromIndex, toIndex, source });
  }, [executeOperation]);

  // Update cell content - tracks old content for undo
  // source: 'user' (default) or 'ai' for AI-generated edits
  const updateContent = useCallback((cellId: string, newContent: string, source: EditSource = 'user') => {
    setCellsInternal(prev => {
      const cell = prev.find(c => c.id === cellId);
      if (!cell) return prev;

      const oldContent = lastContentRef.current.get(cellId) ?? cell.content;

      // Only create operation if content actually changed
      if (oldContent !== newContent) {
        // Update last known content
        lastContentRef.current.set(cellId, newContent);

        // Keyframe: first edit after undo - convert redo stack to history before clearing
        if (redoStackRef.current.length > 0) {
          convertRedoStackToHistory(redoStackRef.current);
          redoStackRef.current.length = 0; // O(1) clear
          setCanRedo(false);
        }

        const op: Operation = {
          type: 'updateContent',
          cellId,
          oldContent,
          newContent,
          source
        };

        // Add to history first to get the operationId
        const operationId = addToFullHistory(op);
        // Store operationId on the op for later linking
        const opWithId = { ...op, operationId } as Operation;
        undoStackRef.current.push(opWithId); // O(1) push
        setCanUndo(true);
      }

      return prev.map(c => c.id === cellId ? { ...c, content: newContent } : c);
    });
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Convenience function for AI edits - automatically marks source as 'ai'
  const updateContentAI = useCallback((cellId: string, newContent: string) => {
    updateContent(cellId, newContent, 'ai');
  }, [updateContent]);

  // Change cell type
  // Generic metadata update - the stable core that never needs to change
  // New cell properties just need to be passed in the changes object
  const updateMetadata = useCallback((cellId: string, changes: MetadataChanges, source: EditSource = 'user') => {
    // Read current cells to compute changes (this is a synchronous read, not inside a state updater)
    const currentCells = cellsRef.current;
    const cell = currentCells.find(c => c.id === cellId);
    if (!cell) return;

    // Build the actual changes, filtering out no-ops
    const actualChanges: MetadataChanges = {};
    let hasChanges = false;
    for (const [key, change] of Object.entries(changes)) {
      const currentValue = (cell as unknown as Record<string, unknown>)[key];
      // Use nullish coalescing for properties that default to a value
      const effectiveOld = currentValue ?? change.old;
      if (effectiveOld !== change.new) {
        actualChanges[key] = { old: effectiveOld, new: change.new };
        hasChanges = true;
      }
    }
    if (!hasChanges) return;

    // Keyframe: first edit after undo - convert redo stack to history before clearing
    if (redoStackRef.current.length > 0) {
      convertRedoStackToHistory(redoStackRef.current);
      redoStackRef.current.length = 0; // O(1) clear
      setCanRedo(false);
    }

    const op: Operation = {
      type: 'updateMetadata',
      cellId,
      changes: actualChanges,
      source
    };

    // Add to history first to get the operationId (side effect, but only runs once per call)
    const operationId = addToFullHistory(op);
    // Store operationId on the op for later linking
    const opWithId = { ...op, operationId } as Operation;
    undoStackRef.current.push(opWithId); // O(1) push
    setCanUndo(true);

    // Apply the changes - pure state updater
    setCellsInternal(prev => {
      return prev.map(c => {
        if (c.id !== cellId) return c;
        const updated = { ...c };
        for (const [key, change] of Object.entries(actualChanges)) {
          (updated as Record<string, unknown>)[key] = change.new;
        }
        return updated as Cell;
      });
    });
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Convenience wrapper: change cell type (code/markdown)
  const changeType = useCallback((cellId: string, newType: CellType) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    updateMetadata(cellId, { type: { old: cell.type, new: newType } });
  }, [cells, updateMetadata]);

  // Convenience wrapper: set cell scrolled state (Jupyter standard: collapsed output)
  const setCellScrolled = useCallback((cellId: string, scrolled: boolean) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    // Default scrolled to false if undefined (expanded by default)
    const oldScrolled = cell.scrolled ?? false;
    if (oldScrolled === scrolled) return; // No-op guard
    updateMetadata(cellId, { scrolled: { old: oldScrolled, new: scrolled } });
  }, [cells, updateMetadata]);

  // Convenience wrapper: set cell scrolled height (output area height in scroll mode)
  const setCellScrolledHeight = useCallback((cellId: string, height: number) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;
    const oldHeight = cell.scrolledHeight;
    if (oldHeight === height) return; // No-op guard
    updateMetadata(cellId, { scrolledHeight: { old: oldHeight, new: height } });
  }, [cells, updateMetadata]);

  // Execute a batch of operations as a single undoable action
  const batch = useCallback((operations: Operation[]) => {
    if (operations.length === 0) return;
    if (operations.length === 1) {
      executeOperation(operations[0]);
    } else {
      executeOperation({ type: 'batch', operations });
    }
  }, [executeOperation]);

  // Flush pending content for a single cell - O(1)
  // Call this before keyframe operations (undo, insert, delete, move, run, save)
  const flushCell = useCallback((cellId: string, currentContent: string) => {
    const lastContent = lastContentRef.current.get(cellId);
    // Only record if content actually changed
    if (lastContent !== undefined && lastContent !== currentContent) {
      // Keyframe: first edit after undo (redo stack about to become empty)
      // Convert redo stack to history before clearing
      if (redoStackRef.current.length > 0) {
        convertRedoStackToHistory(redoStackRef.current);
        redoStackRef.current.length = 0; // O(1) clear
        setCanRedo(false);
      }

      const op: Operation = {
        type: 'updateContent',
        cellId,
        oldContent: lastContent,
        newContent: currentContent,
        source: 'user'
      };
      // Update tracking
      lastContentRef.current.set(cellId, currentContent);
      // Add to history first to get operationId
      const operationId = addToFullHistory(op);
      // Store operationId on the op for later linking
      const opWithId = { ...op, operationId } as Operation;
      undoStackRef.current.push(opWithId); // O(1) push
      setCanUndo(true);
    }
  }, [addToFullHistory, convertRedoStackToHistory]);

  // Helper to update lastContentRef after undoing an operation
  const updateContentTrackingAfterUndo = useCallback((op: Operation) => {
    if (op.type === 'updateContent') {
      lastContentRef.current.set(op.cellId, op.oldContent);
    } else if (op.type === 'insertCell') {
      // Undoing an insert means the cell is removed
      lastContentRef.current.delete(op.cell.id);
    } else if (op.type === 'deleteCell') {
      // Undoing a delete means the cell is restored
      lastContentRef.current.set(op.cell.id, op.cell.content);
    } else if (op.type === 'batch') {
      // Undo batch in reverse order
      for (let i = op.operations.length - 1; i >= 0; i--) {
        updateContentTrackingAfterUndo(op.operations[i]);
      }
    }
  }, []);

  // Helper to update lastContentRef after applying an operation
  const updateContentTrackingAfterOp = useCallback((op: Operation) => {
    if (op.type === 'updateContent') {
      lastContentRef.current.set(op.cellId, op.newContent);
    } else if (op.type === 'insertCell') {
      // When redoing an insert, initialize content tracking for the cell
      lastContentRef.current.set(op.cell.id, op.cell.content);
    } else if (op.type === 'deleteCell') {
      // When redoing a delete, remove from content tracking
      lastContentRef.current.delete(op.cell.id);
    } else if (op.type === 'batch') {
      for (const subOp of op.operations) {
        updateContentTrackingAfterOp(subOp);
      }
    }
  }, []);

  // Peek at what the next undo would affect (without applying)
  // Uses ref instead of state for immediate reads after flushCell writes
  const peekUndo = useCallback((): UndoRedoResult | null => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return null;
    const op = stack[stack.length - 1];
    const reversedOp = reverseOperation(op);
    // For moveCell, we need to simulate where the cell will be after undo
    // The reversed op's toIndex is where the cell will end up
    return {
      affectedCellIds: getAffectedCellIds(reversedOp, cells),
      operationType: op.type
    };
  }, [cells]);

  // Peek at what the next redo would affect (without applying)
  const peekRedo = useCallback((): UndoRedoResult | null => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return null;
    const op = stack[stack.length - 1];
    // For moveCell, op.toIndex is where the cell will end up after redo
    return {
      affectedCellIds: getAffectedCellIds(op, cells),
      operationType: op.type
    };
  }, [cells]);

  // Undo last operation
  // Note: Caller should call flushCell(activeCellId, content) before undo
  // to capture any pending content changes in the active cell
  // Returns affected cell IDs for visual feedback
  // Uses ref instead of state for immediate reads after flushCell writes
  const undo = useCallback((): UndoRedoResult | null => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return null;

    const op = stack.pop()!; // O(1) pop
    setCanUndo(stack.length > 0);

    const reversedOp = reverseOperation(op);

    let newCells: Cell[] = [];
    setCellsInternal(prev => {
      newCells = applyOperation(prev, reversedOp);
      return newCells;
    });

    redoStackRef.current.push(op); // O(1) push
    setCanRedo(true);

    // Update content tracking after undo
    updateContentTrackingAfterUndo(op);

    // Return affected cells for visual feedback (use newCells for moveCell lookup)
    return {
      affectedCellIds: getAffectedCellIds(reversedOp, newCells),
      operationType: op.type
    };
  }, [updateContentTrackingAfterUndo]);

  // Redo last undone operation
  // Returns affected cell IDs for visual feedback
  const redo = useCallback((): UndoRedoResult | null => {
    const stack = redoStackRef.current;
    if (stack.length === 0) return null;

    const op = stack.pop()!; // O(1) pop
    setCanRedo(stack.length > 0);

    let newCells: Cell[] = [];
    setCellsInternal(prev => {
      newCells = applyOperation(prev, op);
      return newCells;
    });

    undoStackRef.current.push(op); // O(1) push
    setCanUndo(true);

    // Update content tracking
    updateContentTrackingAfterOp(op);

    // Return affected cells for visual feedback (use newCells for moveCell lookup)
    return {
      affectedCellIds: getAffectedCellIds(op, newCells),
      operationType: op.type
    };
  }, [updateContentTrackingAfterOp]);

  // Direct setCells for non-undoable changes (like execution outputs)
  const setCells = useCallback((newCells: Cell[] | ((prev: Cell[]) => Cell[])) => {
    setCellsInternal(newCells);
  }, []);

  // Load cells when opening a notebook (clears stacks since we're switching notebooks)
  // Call this, then loadHistory() to restore history and rebuild undo stack
  // The stack clearing is needed because we're switching notebooks - loadHistory will rebuild
  const loadCells = useCallback((newCells: Cell[]) => {
    setCellsInternal(newCells);
    // Clear stacks from previous notebook - loadHistory will rebuild for this notebook
    undoStackRef.current.length = 0;
    redoStackRef.current.length = 0;
    setCanUndo(false);
    setCanRedo(false);
    // Initialize content tracking for updateContent operations
    lastContentRef.current.clear();
    newCells.forEach(c => lastContentRef.current.set(c.id, c.content));
    // Note: fullHistoryRef is NOT modified here - loadHistory() will set it
  }, []);

  // Initialize new history with a snapshot (ONLY for NEW notebooks without existing history)
  // WARNING: This overwrites any existing history! Only call when creating a new notebook
  // or when the notebook has no history file.
  const initializeNewHistory = useCallback((newCells: Cell[]) => {
    setCellsInternal(newCells);
    undoStackRef.current.length = 0; // O(1) clear
    redoStackRef.current.length = 0; // O(1) clear
    setCanUndo(false);
    setCanRedo(false);
    lastContentRef.current.clear();
    // Initialize content tracking
    newCells.forEach(c => lastContentRef.current.set(c.id, c.content));

    // Start fresh history with a snapshot (required for trajectory reconstruction)
    fullHistoryRef.current = [{
      type: 'snapshot',
      cells: newCells.map(cloneCell), // Deep copy
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
        timestamp: op.timestamp,
        ...(op.source && { source: op.source }), // Preserve AI annotation
        // Preserve undo/redo tracking metadata
        ...(op.operationId && { operationId: op.operationId }),
        ...(op.isUndo && { isUndo: op.isUndo }),
        ...(op.undoesOperationId && { undoesOperationId: op.undoesOperationId }),
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
  // Filters out undo ops and their canceled counterparts (history remains append-only)
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

    // Build set of operation IDs that have been undone
    const undoneIds = new Set<string>();
    for (const op of fullHistoryRef.current) {
      if ((op as any).isUndo && (op as any).undoesOperationId) {
        undoneIds.add((op as any).undoesOperationId);
      }
    }

    // Rebuild undoStack from the loaded history
    // Filter out: undo ops (isUndo=true) and their canceled counterparts (undoneIds)
    const undoableOps: Operation[] = [];
    for (const op of fullHistoryRef.current) {
      // Skip undo ops themselves
      if ((op as any).isUndo) continue;
      // Skip operations that were undone
      if ((op as any).operationId && undoneIds.has((op as any).operationId)) continue;

      if (op.type === 'insertCell' || op.type === 'deleteCell' ||
          op.type === 'moveCell' || op.type === 'updateContent' ||
          op.type === 'updateContentPatch' || op.type === 'updateMetadata' || op.type === 'batch') {
        const { timestamp, operationId, isUndo, undoesOperationId, ...operation } = op as any;
        undoableOps.push(operation as Operation);
      }
    }
    undoStackRef.current = undoableOps;
    redoStackRef.current = [];
    setCanUndo(undoableOps.length > 0);
    setCanRedo(false);
  }, []);

  // Log a non-undoable operation (for history tracking)
  const logOperation = useCallback((op: LogOperation) => {
    addToFullHistory(op);
  }, [addToFullHistory]);

  // Commit history before keyframe events (e.g., save)
  // Converts redo stack to undo ops in history and clears redo stack
  const commitHistoryBeforeKeyframe = useCallback(() => {
    if (redoStackRef.current.length > 0) {
      convertRedoStackToHistory(redoStackRef.current);
      redoStackRef.current.length = 0; // O(1) clear
      setCanRedo(false);
    }
  }, [convertRedoStackToHistory]);

  // Get unflushed state for session persistence
  // Returns the active cell's unflushed edit state if there are pending changes
  const getUnflushedState = useCallback((activeCellId: string | null, currentCells: Cell[]): UnflushedState | null => {
    if (!activeCellId) return null;

    const cell = currentCells.find(c => c.id === activeCellId);
    if (!cell) return null;

    const lastFlushedContent = lastContentRef.current.get(activeCellId);
    if (lastFlushedContent === undefined) return null;

    // Only return state if there are actual unflushed changes
    if (lastFlushedContent === cell.content) return null;

    return {
      cellId: activeCellId,
      lastFlushedContent
    };
  }, []);

  // Restore unflushed state from session persistence
  // Sets the lastContentRef for a cell to recreate the unflushed edit boundary
  const setUnflushedState = useCallback((state: UnflushedState | null) => {
    if (!state) return;
    lastContentRef.current.set(state.cellId, state.lastFlushedContent);
  }, []);

  // Check if editing should trigger a keyframe (redo stack non-empty)
  // Uses ref for immediate reads - first edit after undo should flush
  const hasRedoToFlush = useCallback(() => {
    return redoStackRef.current.length > 0;
  }, []);

  // Get user changes since a timestamp (for agent awareness)
  // Returns summaries of user operations, filtering out AI operations
  const getUserChangesSince = useCallback((sinceTimestamp: number): UserChangeSummary[] => {
    const currentCells = cellsRef.current;
    const summaries: UserChangeSummary[] = [];

    for (const op of fullHistoryRef.current) {
      // Skip operations before the timestamp
      if (op.timestamp <= sinceTimestamp) continue;
      // Skip undo operations (they're tracked separately)
      if ((op as any).isUndo) continue;
      // Skip AI-sourced operations
      if ((op as any).source === 'ai') continue;
      // Skip log-only operations (runCell, etc.) - they don't change content
      if (op.type === 'runCell' || op.type === 'runAllCells' ||
          op.type === 'interruptKernel' || op.type === 'restartKernel' ||
          op.type === 'executionComplete' || op.type === 'snapshot') continue;

      // Build a human-readable summary
      let description = '';
      let cellId: string | undefined;
      let cellIndex: number | undefined;

      switch (op.type) {
        case 'insertCell':
          cellId = op.cell.id;
          cellIndex = op.index;
          description = `Inserted ${op.cell.type} cell at #${op.index + 1}`;
          break;
        case 'deleteCell':
          cellId = op.cell.id;
          cellIndex = op.index;
          description = `Deleted cell #${op.index + 1}`;
          break;
        case 'moveCell':
          // Find cell at the destination index
          if (op.toIndex >= 0 && op.toIndex < currentCells.length) {
            cellId = currentCells[op.toIndex].id;
          }
          description = `Moved cell from #${op.fromIndex + 1} to #${op.toIndex + 1}`;
          break;
        case 'updateContent':
        case 'updateContentPatch':
          cellId = op.cellId;
          cellIndex = currentCells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const preview = op.type === 'updateContent'
            ? op.newContent.slice(0, 50).replace(/\n/g, ' ')
            : '[content updated]';
          description = `Edited cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}: "${preview}${preview.length >= 50 ? '...' : ''}"`;
          break;
        case 'updateMetadata':
          cellId = op.cellId;
          cellIndex = currentCells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const changes = Object.keys(op.changes).join(', ');
          description = `Changed ${changes} on cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}`;
          break;
        case 'batch':
          description = `Batch operation (${op.operations.length} changes)`;
          break;
        default:
          // This handles any unexpected operation types
          description = `Operation: ${(op as TimestampedOperation).type}`;
      }

      summaries.push({
        type: (op as TimestampedOperation).type,
        cellId,
        cellIndex,
        timestamp: (op as TimestampedOperation).timestamp,
        description,
      });
    }

    return summaries;
  }, []);

  return {
    cells,
    setCells,
    insertCell,
    deleteCell,
    moveCell,
    updateContent,
    updateContentAI,
    updateMetadata,
    changeType,
    setCellScrolled,
    setCellScrolledHeight,
    batch,
    flushCell,
    peekUndo,
    peekRedo,
    undo,
    redo,
    canUndo,
    canRedo,
    loadCells,
    initializeNewHistory,
    saveCheckpoint,
    getFullHistory,
    loadHistory,
    logOperation,
    // New exports for autosave integration
    redoStackLength: redoStackRef.current.length,
    commitHistoryBeforeKeyframe,
    hasRedoToFlush,
    // Session state for unflushed edits
    getUnflushedState,
    setUnflushedState,
    // User change tracking for agent awareness
    getUserChangesSince,
  };
};
