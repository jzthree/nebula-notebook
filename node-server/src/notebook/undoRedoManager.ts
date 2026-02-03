/**
 * Headless Undo/Redo Manager
 *
 * Manages undo/redo state for notebooks when operated via the headless backend (MCP).
 * This mirrors the frontend UndoRedoManager but uses NebulaCell types.
 *
 * Note: This is a simplified version of lib/undoRedoCore.ts adapted for the backend.
 * The core logic is intentionally similar to maintain feature parity.
 */

import { v4 as uuidv4 } from 'uuid';
import { NebulaCell } from '../fs/types';
import { FilesystemService } from '../fs/fs-service';

// ============================================================================
// TYPE DEFINITIONS
// ============================================================================

export type EditSource = 'user' | 'ai' | 'mcp' | 'system' | 'error';

export type MetadataChanges = Record<string, { old: unknown; new: unknown }>;

/** Patch format for content updates (diff-match-patch compatible) */
export interface Patch {
  diffs: Array<[number, string]>;
  start1: number;
  start2: number;
  length1: number;
  length2: number;
}

export type UndoableOperation =
  | { type: 'insertCell'; index: number; cell: NebulaCell; source?: EditSource }
  | { type: 'deleteCell'; index: number; cell: NebulaCell; source?: EditSource }
  | { type: 'moveCell'; fromIndex: number; toIndex: number; source?: EditSource }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string; source?: EditSource }
  | { type: 'updateMetadata'; cellId: string; changes: MetadataChanges; source?: EditSource }
  | { type: 'batch'; operations: UndoableOperation[]; source?: EditSource };

export type EventCategory = 'execution' | 'kernel' | 'system' | 'ui';

export type EventTarget = {
  cellId?: string;
  cellIndex?: number;
};

export type EventOperation = {
  type: 'event';
  category: EventCategory;
  name: string;
  target?: EventTarget;
  runId?: string;
  data?: Record<string, unknown>;
  source?: EditSource;
};

// Legacy log operations (kept for backwards compatibility with persisted history)
export type LegacyLogOperation =
  | { type: 'runCell'; cellId: string; cellIndex: number; runId?: string }
  | { type: 'runAllCells'; cellCount?: number; cellIds?: string[] }
  | { type: 'interruptKernel' }
  | { type: 'restartKernel' }
  | {
      type: 'runCellComplete';
      cellId: string;
      cellIndex: number;
      durationMs: number;
      success: boolean;
      output?: string;
      runId?: string;
    };

export type LogOperation = EventOperation | LegacyLogOperation;

export interface SnapshotOperation {
  type: 'snapshot';
  cells: NebulaCell[];
}

export interface BaseOperation {
  timestamp: number;
  operationId?: string;
  isUndo?: boolean;
  undoesOperationId?: string;
}

export type TimestampedOperation = BaseOperation & (UndoableOperation | LogOperation | SnapshotOperation);

export type Operation = UndoableOperation;

export interface UndoRedoResult {
  success: boolean;
  affectedCellIds: string[];
  operationType: string;
  error?: string;
}

/** Summary of an update for agent awareness */
export interface UpdateSummary {
  kind: 'edit' | 'event';
  type: string;
  category?: EventCategory;
  name?: string;
  cellId?: string;
  cellIndex?: number;
  timestamp: number;
  description: string;
  source?: EditSource;
  runId?: string;
  data?: Record<string, unknown>;
}

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

function cloneCell(cell: NebulaCell): NebulaCell {
  return {
    ...cell,
    outputs: (cell.outputs || []).map(output => ({ ...output }))
  };
}

function stripCellOutputs(cell: NebulaCell): NebulaCell {
  return {
    ...cell,
    outputs: [],
    isExecuting: false
  };
}

function applyOperation(cells: NebulaCell[], op: Operation): NebulaCell[] {
  switch (op.type) {
    case 'insertCell': {
      const newCells = [...cells];
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
    case 'updateMetadata': {
      return cells.map(c => {
        if (c.id !== op.cellId) return c;
        const updated = { ...c };
        for (const [key, change] of Object.entries(op.changes)) {
          (updated as Record<string, unknown>)[key] = change.new;
        }
        return updated as NebulaCell;
      });
    }
    case 'batch': {
      return op.operations.reduce((acc, subOp) => applyOperation(acc, subOp), cells);
    }
    default:
      return cells;
  }
}

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
    case 'updateMetadata': {
      const reversed: MetadataChanges = {};
      for (const [key, change] of Object.entries(op.changes)) {
        reversed[key] = { old: change.new, new: change.old };
      }
      return { type: 'updateMetadata', cellId: op.cellId, changes: reversed };
    }
    case 'batch':
      return {
        type: 'batch',
        operations: op.operations.map(reverseOperation).reverse()
      };
    default:
      return op;
  }
}

function getAffectedCellIds(op: Operation, cells?: NebulaCell[]): string[] {
  switch (op.type) {
    case 'insertCell':
    case 'deleteCell':
      return [op.cell.id];
    case 'moveCell':
      if (cells && op.toIndex >= 0 && op.toIndex < cells.length) {
        return [cells[op.toIndex].id];
      }
      return [];
    case 'updateContent':
    case 'updateMetadata':
      return [op.cellId];
    case 'batch': {
      const ids = new Set<string>();
      for (const subOp of op.operations) {
        for (const id of getAffectedCellIds(subOp, cells)) {
          ids.add(id);
        }
      }
      return Array.from(ids);
    }
    default:
      return [];
  }
}

// ============================================================================
// NOTEBOOK UNDO/REDO STATE
// ============================================================================

interface NotebookUndoState {
  undoStack: Operation[];
  redoStack: Operation[];
  fullHistory: TimestampedOperation[];
  lastContent: Map<string, string>;
}

// ============================================================================
// HEADLESS UNDO/REDO MANAGER
// ============================================================================

/**
 * Manages undo/redo state for multiple notebooks in the headless backend.
 */
export class HeadlessUndoRedoManager {
  private states: Map<string, NotebookUndoState> = new Map();
  private fsService: FilesystemService;

  constructor(fsService: FilesystemService) {
    this.fsService = fsService;
  }

  /**
   * Get or initialize undo state for a notebook.
   */
  getState(notebookPath: string, cells: NebulaCell[]): NotebookUndoState {
    if (!this.states.has(notebookPath)) {
      // Try to load existing history
      let loadedHistory: TimestampedOperation[] = [];

      try {
        loadedHistory = this.fsService.loadHistory(notebookPath) as TimestampedOperation[];
      } catch (err) {
        console.warn(`[UndoRedoManager] Failed to load history for ${notebookPath}:`, err);
      }

      // Initialize state
      const state: NotebookUndoState = {
        undoStack: [],
        redoStack: [],
        fullHistory: loadedHistory.length > 0 ? loadedHistory : [{
          type: 'snapshot',
          cells: cells.map(stripCellOutputs),
          timestamp: Date.now()
        }],
        lastContent: new Map(cells.map(c => [c.id, c.content]))
      };

      // Rebuild undo stack from history
      if (loadedHistory.length > 0) {
        state.undoStack = this.rebuildUndoStack(loadedHistory);
      }

      this.states.set(notebookPath, state);
    }

    return this.states.get(notebookPath)!;
  }

  /**
   * Rebuild undo stack from history.
   */
  private rebuildUndoStack(history: TimestampedOperation[]): Operation[] {
    const undoneIds = new Set<string>();
    for (const op of history) {
      if ((op as any).isUndo && (op as any).undoesOperationId) {
        undoneIds.add((op as any).undoesOperationId);
      }
    }

    const undoableOps: Operation[] = [];
    for (const op of history) {
      if ((op as any).isUndo) continue;
      if ((op as any).operationId && undoneIds.has((op as any).operationId)) continue;

      if (op.type === 'insertCell' || op.type === 'deleteCell' ||
          op.type === 'moveCell' || op.type === 'updateContent' ||
          op.type === 'updateMetadata' || op.type === 'batch') {
        const { timestamp, operationId, isUndo, undoesOperationId, ...operation } = op as any;
        undoableOps.push(operation as Operation);
      }
    }
    return undoableOps;
  }

  /**
   * Record an operation (called by headless handler after executing an operation).
   */
  recordOperation(
    notebookPath: string,
    cells: NebulaCell[],
    op: UndoableOperation
  ): void {
    const state = this.getState(notebookPath, cells);

    // Clear redo stack (can't redo after new operation)
    if (state.redoStack.length > 0) {
      // Record the undos that would have been in redo stack
      for (const redoOp of state.redoStack) {
        const reversedOp = reverseOperation(redoOp);
        const timestampedOp: TimestampedOperation = {
          ...reversedOp,
          timestamp: Date.now(),
          operationId: uuidv4(),
          isUndo: true,
          undoesOperationId: (redoOp as any).operationId,
        };
        state.fullHistory.push(timestampedOp);
      }
      state.redoStack = [];
    }

    // Add operation to history
    const operationId = uuidv4();
    const timestampedOp: TimestampedOperation = {
      ...op,
      timestamp: Date.now(),
      operationId,
    };
    state.fullHistory.push(timestampedOp);

    // Add to undo stack
    const opWithId = { ...op, operationId } as unknown as Operation;
    state.undoStack.push(opWithId);

    // Update content tracking
    if (op.type === 'updateContent') {
      state.lastContent.set(op.cellId, op.newContent);
    } else if (op.type === 'insertCell') {
      state.lastContent.set(op.cell.id, op.cell.content);
    } else if (op.type === 'deleteCell') {
      state.lastContent.delete(op.cell.id);
    }

  }

  /**
   * Record a non-undoable log operation (history only).
   */
  recordLogOperation(
    notebookPath: string,
    cells: NebulaCell[],
    op: LogOperation
  ): void {
    const state = this.getState(notebookPath, cells);
    const timestampedOp: TimestampedOperation = {
      ...op,
      timestamp: Date.now(),
      operationId: uuidv4(),
    };
    state.fullHistory.push(timestampedOp);
  }

  /**
   * Undo the last operation.
   */
  undo(notebookPath: string, cells: NebulaCell[]): { cells: NebulaCell[]; result: UndoRedoResult } {
    const state = this.getState(notebookPath, cells);

    if (state.undoStack.length === 0) {
      return {
        cells,
        result: { success: false, affectedCellIds: [], operationType: '', error: 'Nothing to undo' }
      };
    }

    const op = state.undoStack.pop()!;
    const reversedOp = reverseOperation(op);

    // Apply the reversed operation
    const newCells = applyOperation(cells, reversedOp);

    // Push to redo stack
    state.redoStack.push(op);

    // Update content tracking
    this.updateContentTrackingAfterUndo(state, op, newCells);

    return {
      cells: newCells,
      result: {
        success: true,
        affectedCellIds: getAffectedCellIds(reversedOp, newCells),
        operationType: op.type
      }
    };
  }

  /**
   * Redo the last undone operation.
   */
  redo(notebookPath: string, cells: NebulaCell[]): { cells: NebulaCell[]; result: UndoRedoResult } {
    const state = this.getState(notebookPath, cells);

    if (state.redoStack.length === 0) {
      return {
        cells,
        result: { success: false, affectedCellIds: [], operationType: '', error: 'Nothing to redo' }
      };
    }

    const op = state.redoStack.pop()!;

    // Apply the operation
    const newCells = applyOperation(cells, op);

    // Push to undo stack
    state.undoStack.push(op);

    // Update content tracking
    this.updateContentTrackingAfterRedo(state, op, newCells);

    return {
      cells: newCells,
      result: {
        success: true,
        affectedCellIds: getAffectedCellIds(op, newCells),
        operationType: op.type
      }
    };
  }

  private updateContentTrackingAfterUndo(state: NotebookUndoState, op: Operation, cells: NebulaCell[]): void {
    if (op.type === 'updateContent') {
      state.lastContent.set(op.cellId, op.oldContent);
    } else if (op.type === 'insertCell') {
      state.lastContent.delete(op.cell.id);
    } else if (op.type === 'deleteCell') {
      state.lastContent.set(op.cell.id, op.cell.content);
    } else if (op.type === 'batch') {
      for (let i = op.operations.length - 1; i >= 0; i--) {
        this.updateContentTrackingAfterUndo(state, op.operations[i], cells);
      }
    }
  }

  private updateContentTrackingAfterRedo(state: NotebookUndoState, op: Operation, cells: NebulaCell[]): void {
    if (op.type === 'updateContent') {
      state.lastContent.set(op.cellId, op.newContent);
    } else if (op.type === 'insertCell') {
      state.lastContent.set(op.cell.id, op.cell.content);
    } else if (op.type === 'deleteCell') {
      state.lastContent.delete(op.cell.id);
    } else if (op.type === 'batch') {
      for (const subOp of op.operations) {
        this.updateContentTrackingAfterRedo(state, subOp, cells);
      }
    }
  }

  /**
   * Check if undo is available.
   */
  canUndo(notebookPath: string, cells: NebulaCell[]): boolean {
    const state = this.getState(notebookPath, cells);
    return state.undoStack.length > 0;
  }

  /**
   * Check if redo is available.
   */
  canRedo(notebookPath: string, cells: NebulaCell[]): boolean {
    const state = this.getState(notebookPath, cells);
    return state.redoStack.length > 0;
  }

  /**
   * Get history for a notebook.
   */
  getHistory(notebookPath: string, cells: NebulaCell[]): TimestampedOperation[] {
    const state = this.getState(notebookPath, cells);
    return state.fullHistory;
  }

  /**
   * Clear state for a notebook (e.g., when closing).
   */
  clearState(notebookPath: string): void {
    this.states.delete(notebookPath);
  }

  /**
   * Get updates since a timestamp (for agent awareness).
   * Returns human-readable summaries of operations made between agent sessions.
   * Includes both edits and non-undoable events (no source filtering).
   */
  getUpdatesSince(notebookPath: string, cells: NebulaCell[], sinceTimestamp: number): UpdateSummary[] {
    const state = this.getState(notebookPath, cells);
    const summaries: UpdateSummary[] = [];

    const describeEvent = (event: {
      category: EventCategory;
      name: string;
      target?: EventTarget;
      data?: Record<string, unknown>;
      runId?: string;
      source?: EditSource;
    }, timestamp: number): void => {
      const cellId = event.target?.cellId;
      const cellIndex = event.target?.cellIndex;
      const data = event.data ? { ...event.data } : undefined;
      if (data && event.name === 'runCellComplete' && 'output' in data) {
        delete (data as Record<string, unknown>).output;
      }

      let description = '';
      switch (event.name) {
        case 'runCell': {
          description = `Ran cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}`;
          break;
        }
        case 'runAllCells': {
          const count = typeof data?.cellCount === 'number'
            ? data.cellCount
            : (Array.isArray(data?.cellIds) ? data.cellIds.length : undefined);
          description = `Ran all cells${count !== undefined ? ` (${count})` : ''}`;
          break;
        }
        case 'runCellComplete': {
          const durationMs = typeof data?.durationMs === 'number' ? data.durationMs : undefined;
          const success = typeof data?.success === 'boolean' ? data.success : undefined;
          const status = success === undefined ? 'complete' : (success ? 'success' : 'failed');
          description = `Run complete${cellIndex !== undefined ? ` for cell #${cellIndex + 1}` : ''}${durationMs !== undefined ? ` (${durationMs}ms)` : ''} • ${status}`;
          break;
        }
        case 'interruptKernel':
          description = 'Kernel interrupted';
          break;
        case 'restartKernel':
          description = 'Kernel restarted';
          break;
        case 'startKernel': {
          const kernelName = typeof data?.kernelName === 'string' ? data.kernelName : undefined;
          description = `Kernel started${kernelName ? ` (${kernelName})` : ''}`;
          break;
        }
        case 'shutdownKernel':
          description = 'Kernel shutdown';
          break;
        default:
          description = `Event: ${event.name}`;
      }

      summaries.push({
        kind: 'event',
        type: event.name,
        category: event.category,
        name: event.name,
        cellId,
        cellIndex,
        timestamp,
        description,
        source: event.source,
        runId: event.runId,
        data,
      });
    };

    const toEvent = (op: TimestampedOperation): {
      category: EventCategory;
      name: string;
      target?: EventTarget;
      data?: Record<string, unknown>;
      runId?: string;
      source?: EditSource;
    } | null => {
      if (op.type === 'event') {
        return {
          category: op.category,
          name: op.name,
          target: op.target,
          data: op.data as Record<string, unknown> | undefined,
          runId: op.runId,
          source: op.source,
        };
      }

      switch (op.type) {
        case 'runCell':
          return {
            category: 'execution',
            name: 'runCell',
            target: { cellId: op.cellId, cellIndex: op.cellIndex },
            runId: (op as any).runId,
          };
        case 'runAllCells':
          return {
            category: 'execution',
            name: 'runAllCells',
            data: {
              cellCount: (op as any).cellCount,
              cellIds: (op as any).cellIds,
            },
          };
        case 'runCellComplete':
          return {
            category: 'execution',
            name: 'runCellComplete',
            target: { cellId: op.cellId, cellIndex: op.cellIndex },
            data: {
              durationMs: (op as any).durationMs,
              success: (op as any).success,
              output: (op as any).output,
            },
            runId: (op as any).runId,
          };
        case 'interruptKernel':
        case 'restartKernel':
          return {
            category: 'kernel',
            name: op.type,
          };
        default:
          return null;
      }
    };

    for (const op of state.fullHistory) {
      if (op.timestamp <= sinceTimestamp) continue;
      if ((op as any).isUndo) continue;
      if (op.type === 'snapshot') continue;

      const event = toEvent(op);
      if (event) {
        describeEvent(event, op.timestamp);
        continue;
      }

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
          if (op.toIndex >= 0 && op.toIndex < cells.length) {
            cellId = cells[op.toIndex].id;
          }
          description = `Moved cell from #${op.fromIndex + 1} to #${op.toIndex + 1}`;
          break;
        case 'updateContent': {
          cellId = op.cellId;
          cellIndex = cells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const preview = op.newContent.slice(0, 50).replace(/\n/g, ' ');
          description = `Edited cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}: \"${preview}${preview.length >= 50 ? '...' : ''}\"`;
          break;
        }
        case 'updateMetadata': {
          cellId = op.cellId;
          cellIndex = cells.findIndex(c => c.id === op.cellId);
          if (cellIndex === -1) cellIndex = undefined;
          const changes = Object.keys(op.changes).join(', ');
          description = `Changed ${changes} on cell${cellIndex !== undefined ? ` #${cellIndex + 1}` : ''}`;
          break;
        }
        case 'batch':
          description = `Batch operation (${op.operations.length} changes)`;
          break;
        default:
          description = `Operation: ${(op as TimestampedOperation).type}`;
      }

      summaries.push({
        kind: 'edit',
        type: (op as TimestampedOperation).type,
        cellId,
        cellIndex,
        timestamp: (op as TimestampedOperation).timestamp,
        description,
        source: (op as any).source as EditSource | undefined,
      });
    }

    return summaries;
  }

}

// Manager instances per FilesystemService to avoid cross-root leakage in tests/multi-root setups
const managers = new WeakMap<FilesystemService, HeadlessUndoRedoManager>();

export function getUndoRedoManager(fsService: FilesystemService): HeadlessUndoRedoManager {
  let manager = managers.get(fsService);
  if (!manager) {
    manager = new HeadlessUndoRedoManager(fsService);
    managers.set(fsService, manager);
  }
  return manager;
}
