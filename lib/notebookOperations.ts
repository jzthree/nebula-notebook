/**
 * Notebook Operations Library
 *
 * Pure functions for notebook manipulation that can be used:
 * - In React components (via hooks)
 * - In tests (headless)
 * - By agentic copilot (API)
 *
 * This is the source of truth for notebook state transformations.
 *
 * History Design:
 * - Can reconstruct FORWARD from initial state (snapshot → apply ops)
 * - Can reconstruct BACKWARD from current state (current → reverse ops)
 * - Snapshot is optional redundancy for integrity verification
 * - Integrity hash detects external edits outside Nebula
 */

import { Cell, CellType } from '../types';
import { Patch, applyPatch, reversePatch, hashNotebookState } from './diffUtils';

// ============================================================================
// Types
// ============================================================================

export interface NotebookState {
  cells: Cell[];
  // Could add metadata, kernel state, etc.
}

/**
 * Generic metadata change - each key maps to old/new values
 * This is intentionally typed as unknown to be maximally extensible.
 * The operation system never needs to change when new cell properties are added.
 */
export type MetadataChanges = Record<string, { old: unknown; new: unknown }>;

/**
 * Undoable operations that modify notebook state
 *
 * updateContent supports two formats:
 * - Full: oldContent/newContent (simple, used in memory)
 * - Patch: patch string (compact, used for storage)
 */
export type EditOperation =
  | { type: 'insertCell'; index: number; cell: Cell }
  | { type: 'deleteCell'; index: number; cell: Cell }
  | { type: 'moveCell'; fromIndex: number; toIndex: number }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string }
  | { type: 'updateContentPatch'; cellId: string; patch: Patch; oldHash: string; newHash: string }
  | { type: 'updateMetadata'; cellId: string; changes: MetadataChanges }
  | { type: 'batch'; operations: EditOperation[] };

/**
 * Execution events (logged but not undoable)
 */
export type ExecutionEvent =
  | { type: 'runCell'; cellId: string; cellIndex: number }
  | { type: 'runAllCells'; cellIds: string[] }
  | { type: 'executionComplete'; cellId: string; cellIndex: number; durationMs: number; success: boolean; output?: string }
  | { type: 'interruptKernel' }
  | { type: 'restartKernel' };

/**
 * Snapshot of notebook state at a point in time
 * Note: timestamp is added via HistoryEntry, not here
 *
 * Snapshots are optional - state can be reconstructed from:
 * - Forward: snapshot + apply operations
 * - Backward: current state + reverse operations
 *
 * The hash allows detecting external edits (outside Nebula)
 */
export type NotebookSnapshot = {
  type: 'snapshot';
  cells: Cell[];
  hash: string;  // Hash of cells for integrity check
};

/**
 * Integrity marker - lightweight alternative to full snapshot
 * Just stores hash of expected state at a point in time
 */
export type IntegrityMarker = {
  type: 'integrity';
  hash: string;
};

/**
 * Any operation in the history
 */
export type HistoryEntry = {
  timestamp: number;
} & (EditOperation | ExecutionEvent | NotebookSnapshot | IntegrityMarker);

// ============================================================================
// Pure Operations - Apply operation to state
// ============================================================================

/**
 * Apply an edit operation to notebook state (forward)
 */
export function applyOperation(state: NotebookState, op: EditOperation): NotebookState {
  switch (op.type) {
    case 'insertCell': {
      const cells = [...state.cells];
      cells.splice(op.index, 0, op.cell);
      return { ...state, cells };
    }
    case 'deleteCell': {
      return { ...state, cells: state.cells.filter((_, i) => i !== op.index) };
    }
    case 'moveCell': {
      const cells = [...state.cells];
      const [moved] = cells.splice(op.fromIndex, 1);
      cells.splice(op.toIndex, 0, moved);
      return { ...state, cells };
    }
    case 'updateContent': {
      return {
        ...state,
        cells: state.cells.map(c =>
          c.id === op.cellId ? { ...c, content: op.newContent } : c
        )
      };
    }
    case 'updateContentPatch': {
      return {
        ...state,
        cells: state.cells.map(c => {
          if (c.id !== op.cellId) return c;
          const { result } = applyPatch(c.content, op.patch);
          return { ...c, content: result };
        })
      };
    }
    case 'updateMetadata': {
      // Generic metadata update - applies any key/value changes
      return {
        ...state,
        cells: state.cells.map(c => {
          if (c.id !== op.cellId) return c;
          const updated = { ...c };
          for (const [key, change] of Object.entries(op.changes)) {
            (updated as Record<string, unknown>)[key] = change.new;
          }
          return updated as Cell;
        })
      };
    }
    case 'batch': {
      return op.operations.reduce((s, subOp) => applyOperation(s, subOp), state);
    }
    default:
      return state;
  }
}

/**
 * Reverse an edit operation (for undo)
 */
export function reverseOperation(op: EditOperation): EditOperation {
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
      return {
        type: 'batch',
        operations: op.operations.map(reverseOperation).reverse()
      };
    default:
      return op;
  }
}

// ============================================================================
// History Replay - Reconstruct state at any point
// ============================================================================

/**
 * Find the most recent snapshot before a given timestamp
 * Returns the full HistoryEntry (including timestamp) for the snapshot
 */
export function findSnapshot(
  history: HistoryEntry[],
  beforeTimestamp: number
): (HistoryEntry & NotebookSnapshot) | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.timestamp <= beforeTimestamp && entry.type === 'snapshot') {
      return entry as HistoryEntry & NotebookSnapshot;
    }
  }
  return null;
}

/**
 * Reconstruct notebook state at a specific timestamp by replaying history
 */
export function reconstructStateAt(
  history: HistoryEntry[],
  targetTimestamp: number
): NotebookState | null {
  // Find the most recent snapshot before target
  const snapshot = findSnapshot(history, targetTimestamp);
  if (!snapshot) {
    return null; // Can't reconstruct without a starting snapshot
  }

  let state: NotebookState = { cells: snapshot.cells };

  // Apply all edit operations between snapshot and target
  for (const entry of history) {
    if (entry.timestamp <= snapshot.timestamp) continue;
    if (entry.timestamp > targetTimestamp) break;

    // Only apply edit operations (not execution events)
    if (isEditOperation(entry)) {
      state = applyOperation(state, entry);
    }
  }

  return state;
}

/**
 * Get the content of a specific cell at a specific timestamp
 */
export function getCellContentAt(
  history: HistoryEntry[],
  cellId: string,
  timestamp: number
): string | null {
  const state = reconstructStateAt(history, timestamp);
  if (!state) return null;

  const cell = state.cells.find(c => c.id === cellId);
  return cell?.content ?? null;
}

/**
 * Type guard for edit operations
 */
export function isEditOperation(entry: HistoryEntry): entry is { timestamp: number } & EditOperation {
  return ['insertCell', 'deleteCell', 'moveCell', 'updateContent', 'updateContentPatch', 'updateMetadata', 'batch'].includes(entry.type);
}

/**
 * Type guard for execution events
 */
export function isExecutionEvent(entry: HistoryEntry): entry is { timestamp: number } & ExecutionEvent {
  return ['runCell', 'runAllCells', 'executionComplete', 'interruptKernel', 'restartKernel'].includes(entry.type);
}

// ============================================================================
// Trajectory Extraction - For analysis and replay
// ============================================================================

export interface ExecutionStep {
  timestamp: number;
  cellId: string;
  cellIndex: number;
  code: string;
  durationMs?: number;
  success?: boolean;
  output?: string;
}

/**
 * Extract the execution trajectory from history
 * Each step includes the code that was executed (reconstructed from edit history)
 */
export function extractExecutionTrajectory(history: HistoryEntry[]): ExecutionStep[] {
  const steps: ExecutionStep[] = [];

  for (const entry of history) {
    if (entry.type === 'runCell') {
      // Reconstruct what the cell content was at execution time
      const code = getCellContentAt(history, entry.cellId, entry.timestamp);
      if (code !== null) {
        steps.push({
          timestamp: entry.timestamp,
          cellId: entry.cellId,
          cellIndex: entry.cellIndex,
          code
        });
      }
    } else if (entry.type === 'executionComplete') {
      // Find the corresponding runCell and add execution results
      const runStep = steps.find(s =>
        s.cellId === entry.cellId &&
        s.timestamp < entry.timestamp &&
        s.durationMs === undefined
      );
      if (runStep) {
        runStep.durationMs = entry.durationMs;
        runStep.success = entry.success;
        runStep.output = entry.output;
      }
    }
  }

  return steps;
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Verify that history is complete and can reconstruct all states
 */
export function validateHistory(history: HistoryEntry[]): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  // Must start with a snapshot
  if (history.length === 0 || history[0].type !== 'snapshot') {
    errors.push('History must start with a snapshot');
  }

  // Timestamps must be monotonically increasing
  for (let i = 1; i < history.length; i++) {
    if (history[i].timestamp < history[i - 1].timestamp) {
      errors.push(`Timestamp at index ${i} is before previous entry`);
    }
  }

  // Every runCell must have a reconstructable cell content
  for (const entry of history) {
    if (entry.type === 'runCell') {
      const content = getCellContentAt(history, entry.cellId, entry.timestamp);
      if (content === null) {
        errors.push(`Cannot reconstruct cell content for runCell at ${entry.timestamp}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// Helpers for creating operations
// ============================================================================

export function createCell(type: CellType = 'code', content: string = ''): Cell {
  return {
    id: crypto.randomUUID(),
    type,
    content,
    outputs: [],
    isExecuting: false
  };
}

export function createSnapshot(cells: Cell[]): NotebookSnapshot {
  return {
    type: 'snapshot',
    cells: cells.map(c => ({ ...c })), // Deep copy
    hash: hashNotebookState(cells)
  };
}

export function createIntegrityMarker(cells: Cell[]): IntegrityMarker {
  return {
    type: 'integrity',
    hash: hashNotebookState(cells)
  };
}

export function createHistoryEntry<T extends EditOperation | ExecutionEvent | NotebookSnapshot | IntegrityMarker>(
  op: T,
  timestamp: number = Date.now()
): HistoryEntry {
  return { ...op, timestamp } as HistoryEntry;
}

// ============================================================================
// Backward Reconstruction - From current state
// ============================================================================

/**
 * Reconstruct state at a timestamp by going BACKWARD from current state
 * This is useful when we don't have a snapshot but have current state
 */
export function reconstructStateBackward(
  currentState: NotebookState,
  history: HistoryEntry[],
  targetTimestamp: number
): NotebookState {
  // Find all edit operations after target timestamp (in reverse order)
  const opsToReverse: EditOperation[] = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.timestamp <= targetTimestamp) break;
    if (isEditOperation(entry)) {
      opsToReverse.push(entry);
    }
  }

  // Apply reversed operations
  let state = currentState;
  for (const op of opsToReverse) {
    state = applyOperation(state, reverseOperation(op));
  }

  return state;
}

// ============================================================================
// Integrity Checking
// ============================================================================

/**
 * Verify that current state matches what history says it should be
 * Returns details about any mismatches
 */
export function verifyIntegrity(
  currentState: NotebookState,
  history: HistoryEntry[]
): { valid: boolean; details: string } {
  const currentHash = hashNotebookState(currentState.cells);

  // Find the most recent snapshot or integrity marker
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.type === 'snapshot' || entry.type === 'integrity') {
      // Reconstruct state at that point and check hash
      const reconstructed = reconstructStateBackward(currentState, history, entry.timestamp);
      const reconstructedHash = hashNotebookState(reconstructed.cells);

      if (reconstructedHash !== entry.hash) {
        return {
          valid: false,
          details: `State mismatch at timestamp ${entry.timestamp}. Expected hash ${entry.hash}, got ${reconstructedHash}. Notebook may have been edited outside Nebula.`
        };
      }
      break;
    }
  }

  return { valid: true, details: 'History integrity verified' };
}

/**
 * Check if history can reconstruct the target state
 * Works in both directions
 */
export function canReconstruct(
  history: HistoryEntry[],
  targetTimestamp: number,
  currentState?: NotebookState
): boolean {
  // Try forward reconstruction (from snapshot)
  const forwardResult = reconstructStateAt(history, targetTimestamp);
  if (forwardResult) return true;

  // Try backward reconstruction (from current state)
  if (currentState) {
    try {
      reconstructStateBackward(currentState, history, targetTimestamp);
      return true;
    } catch {
      return false;
    }
  }

  return false;
}
