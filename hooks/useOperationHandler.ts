/**
 * Operation Handler Hook - UI-Side Agent Operation Processor
 *
 * This hook is the UI counterpart to HeadlessOperationHandler. When an agent
 * sends operations through NebulaClient, the Operation Router checks if the
 * notebook is open in a browser. If so, operations are forwarded HERE via
 * WebSocket for real-time UI updates.
 *
 * ## Architecture
 *
 * ```
 * Agent → NebulaClient → POST /api/notebook/operation
 *                                    ↓
 *                          ┌─────────────────────┐
 *                          │   Operation Router   │
 *                          └──────────┬──────────┘
 *                                     │
 *              UI Connected?  ────────┼──────── No UI?
 *                     │               │              │
 *                     ▼               │              ▼
 *    ┌─────────────────────────┐      │   ┌──────────────────────┐
 *    │  useOperationHandler    │      │   │ HeadlessOperation    │
 *    │  (this hook via WS)     │      │   │ Handler (file-based) │
 *    └─────────────────────────┘      │   └──────────────────────┘
 *              │                      │
 *              ▼                      │
 *    Apply to React state             │
 *    (insertCell, etc.)               │
 *              │                      │
 *              ▼                      │
 *    Send result back via WS ─────────┘
 * ```
 *
 * ## Responsibilities
 *
 * 1. **WebSocket Connection**: Maintains connection to `/api/notebook/{path}/ws`
 * 2. **Operation Processing**: Receives and applies operations to React state
 * 3. **Result Reporting**: Sends operation results back to router
 * 4. **UI Feedback**: Updates agent session indicator and triggers toasts
 * 5. **Notebook State**: Serves current cell state for read operations
 *
 * ## Agent Sessions
 *
 * When an agent calls `startAgentSession`, this hook:
 * - Sets `agentSession` state (shows purple badge in UI)
 * - Tracks session start time and agent ID
 * - Returns session duration on `endAgentSession`
 *
 * ## Supported Operations
 *
 * Cell: insertCell, deleteCell, updateContent, updateMetadata, moveCell,
 *       duplicateCell, updateOutputs, clearNotebook
 * Notebook: createNotebook, readCell, readCellOutput
 * Session: startAgentSession, endAgentSession
 * History: undo, redo (UI-only - requires notebook open in browser)
 *
 * ## Usage
 *
 * ```tsx
 * const {
 *   isConnected,      // WebSocket connection status
 *   activeOperation,  // Current operation being processed (for UI indicator)
 *   agentSession,     // Active session info (null if no session)
 * } = useOperationHandler({
 *   filePath,
 *   cells,
 *   insertCell,
 *   deleteCell,
 *   // ... other callbacks from useUndoRedo
 *   onAgentOperation: (op, result) => toast(`Agent: ${op.type}`)
 * });
 * ```
 *
 * @see server/headless_handler.py - Headless equivalent
 * @see docs/AGENTIC_ARCHITECTURE.md - Full system documentation
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Cell, CellType } from '../types';
import { validateMetadataValue, CELL_METADATA_SCHEMA } from '../lib/cellMetadata';
import { authService } from '../services/authService';

// Operation types (matching backend/MCP types)
export interface InsertCellOp {
  type: 'insertCell';
  notebookPath: string;
  index: number;
  cell: {
    id: string;
    type: 'code' | 'markdown';
    content: string;
    metadata?: Record<string, unknown>;
  };
}

export interface DeleteCellOp {
  type: 'deleteCell';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
}

export interface UpdateContentOp {
  type: 'updateContent';
  notebookPath: string;
  cellId: string;
  content: string;
}

export interface UpdateMetadataOp {
  type: 'updateMetadata';
  notebookPath: string;
  cellId: string;
  changes: Record<string, unknown>;
}

export interface MoveCellOp {
  type: 'moveCell';
  notebookPath: string;
  fromIndex: number;
  toIndex: number;
}

export interface DuplicateCellOp {
  type: 'duplicateCell';
  notebookPath: string;
  cellIndex: number;
  newCellId: string;
}

export interface UpdateOutputsOp {
  type: 'updateOutputs';
  notebookPath: string;
  cellId: string;
  outputs: Array<{ type: string; content: string }>;
  executionCount?: number;
}

export interface CreateNotebookOp {
  type: 'createNotebook';
  notebookPath: string;
  overwrite?: boolean;
  kernelName?: string;
  kernelDisplayName?: string;
}

export interface ReadCellOp {
  type: 'readCell';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
}

export interface ReadCellOutputOp {
  type: 'readCellOutput';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
}

export interface SearchCellsOp {
  type: 'searchCells';
  notebookPath: string;
  query: string;
  includeOutputs?: boolean;
  limit?: number;
}

export interface ClearNotebookOp {
  type: 'clearNotebook';
  notebookPath: string;
}

export interface ClearOutputsOp {
  type: 'clearOutputs';
  notebookPath: string;
  cellIds?: string[];  // If not provided, clears all cells
}

export interface ExecuteCellOp {
  type: 'executeCell';
  notebookPath: string;
  cellId?: string;
  cellIndex?: number;
  sessionId?: string;
  maxWait?: number;
  saveOutputs?: boolean;
}

export interface StartAgentSessionOp {
  type: 'startAgentSession';
  notebookPath: string;
  agentId?: string;  // Optional identifier for the agent
  clientName?: string;  // e.g., "claude-code", "cursor"
  clientVersion?: string;  // Client app version
}

export interface EndAgentSessionOp {
  type: 'endAgentSession';
  notebookPath: string;
}

export interface UndoOp {
  type: 'undo';
  notebookPath: string;
}

export interface RedoOp {
  type: 'redo';
  notebookPath: string;
}

export type NotebookOperation =
  | InsertCellOp
  | DeleteCellOp
  | StartAgentSessionOp
  | EndAgentSessionOp
  | UpdateContentOp
  | UpdateMetadataOp
  | MoveCellOp
  | DuplicateCellOp
  | UpdateOutputsOp
  | CreateNotebookOp
  | ReadCellOp
  | ReadCellOutputOp
  | SearchCellsOp
  | ClearNotebookOp
  | ClearOutputsOp
  | ExecuteCellOp
  | UndoOp
  | RedoOp;

export interface OperationResult {
  success: boolean;
  cellId?: string;
  cellIndex?: number;
  idModified?: boolean;
  requestedId?: string;
  error?: string;
  path?: string;
  mtime?: number;
  // For readCell operation
  cell?: {
    id: string;
    type: 'code' | 'markdown';
    content: string;
    outputs: Array<{ type: string; content: string }>;
    executionCount?: number;
    metadata?: Record<string, unknown>;
  };
  // For readCellOutput operation
  outputs?: Array<{ type: string; content: string }>;
  executionCount?: number;
  // For searchCells operation
  query?: string;
  matchCount?: number;
  matches?: Array<{
    cellId: string;
    cellIndex: number;
    matchLocation: 'source' | 'output';
    matchLine?: number;
    outputIndex?: number;
    outputType?: string;
    preview: string;
  }>;
  hasMore?: boolean;
  // For clearNotebook operation
  deletedCount?: number;
  // For clearOutputs operation
  clearedCount?: number;
  // For session operations
  warning?: string;
  previousSession?: AgentSessionInfo;
  sessionDuration?: number;
  // For executeCell operation
  executionStatus?: 'idle' | 'busy' | 'error';
  executionTime?: number;
  sessionId?: string;
  queuePosition?: number;
  queueLength?: number;
  // For undo/redo operations
  affectedCellIds?: string[];
  operationType?: string;
  canUndo?: boolean;
  canRedo?: boolean;
}

interface OperationMessage {
  type: 'operation';
  operation: NotebookOperation;
  requestId: string;
}

interface ReadNotebookMessage {
  type: 'readNotebook';
  requestId: string;
}

type IncomingMessage = OperationMessage | ReadNotebookMessage | { type: 'pong' };

/** Info about an agent operation for UI display */
export interface AgentOperationInfo {
  type: NotebookOperation['type'];
  cellIndex?: number;
  cellId?: string;
  timestamp: number;
}

/** Info about active agent session */
export interface AgentSessionInfo {
  agentId?: string;
  clientName?: string;
  clientVersion?: string;
  startedAt: number;
}

interface UseOperationHandlerOptions {
  /** Current file path (null if no file open) */
  filePath: string | null;

  /** Current cells state */
  cells: Cell[];

  /** Insert cell callback (from useUndoRedo) */
  insertCell: (index: number, cell: Cell) => void;

  /** Delete cell callback (from useUndoRedo) */
  deleteCell: (index: number) => void;

  /** Move cell callback (from useUndoRedo) */
  moveCell: (fromIndex: number, toIndex: number) => void;

  /** Update cell content callback (from useUndoRedo) */
  updateContent: (cellId: string, content: string) => void;

  /** Update cell content from AI callback (from useUndoRedo) */
  updateContentAI?: (cellId: string, content: string) => void;

  /** Generic metadata update callback (from useUndoRedo) - schema-driven */
  updateMetadata: (cellId: string, changes: Record<string, { old: unknown; new: unknown }>) => void;

  /** Set cell outputs callback */
  setCellOutputs?: (cellId: string, outputs: Cell['outputs'], executionCount?: number) => void;

  /** Create notebook callback - returns promise with mtime */
  createNotebook?: (path: string, overwrite: boolean, kernelName: string) => Promise<{ success: boolean; mtime?: number; error?: string }>;

  /**
   * Execute cell callback - runs a cell and returns results
   * Returns a promise with execution result including outputs
   */
  executeCell?: (cellId: string, options?: {
    sessionId?: string;
    maxWait?: number;
    saveOutputs?: boolean;
  }) => Promise<{
    success: boolean;
    executionStatus?: 'idle' | 'busy' | 'error';
    executionCount?: number;
    executionTime?: number;
    outputs?: Array<{ type: string; content: string }>;
    sessionId?: string;
    queuePosition?: number;
    queueLength?: number;
    error?: string;
  }>;

  /** Callback when an agent operation is applied (for toasts/notifications) */
  onAgentOperation?: (operation: NotebookOperation, result: OperationResult) => void;

  /** Undo callback (from useUndoRedo) */
  undo?: () => { affectedCellIds: string[]; operationType: string } | null;

  /** Redo callback (from useUndoRedo) */
  redo?: () => { affectedCellIds: string[]; operationType: string } | null;

  /** Whether undo is available */
  canUndo?: boolean;

  /** Whether redo is available */
  canRedo?: boolean;
}

export function useOperationHandler(options: UseOperationHandlerOptions) {
  const {
    filePath,
    cells,
    insertCell,
    deleteCell,
    moveCell,
    updateContent,
    updateContentAI,
    updateMetadata,
    setCellOutputs,
    createNotebook,
    executeCell,
    onAgentOperation,
    undo,
    redo,
    canUndo,
    canRedo,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const intentionalCloseRef = useRef(false); // Track if we closed intentionally

  // Use refs for callbacks to avoid reconnecting when callbacks change
  const cellsRef = useRef(cells);
  const insertCellRef = useRef(insertCell);
  const deleteCellRef = useRef(deleteCell);
  const moveCellRef = useRef(moveCell);
  const updateContentRef = useRef(updateContent);
  const updateContentAIRef = useRef(updateContentAI);
  const updateMetadataRef = useRef(updateMetadata);
  const setCellOutputsRef = useRef(setCellOutputs);
  const createNotebookRef = useRef(createNotebook);
  const executeCellRef = useRef(executeCell);
  const onAgentOperationRef = useRef(onAgentOperation);
  const undoRef = useRef(undo);
  const redoRef = useRef(redo);
  const canUndoRef = useRef(canUndo);
  const canRedoRef = useRef(canRedo);

  // Update refs on each render
  cellsRef.current = cells;
  insertCellRef.current = insertCell;
  deleteCellRef.current = deleteCell;
  moveCellRef.current = moveCell;
  updateContentRef.current = updateContent;
  updateContentAIRef.current = updateContentAI;
  updateMetadataRef.current = updateMetadata;
  setCellOutputsRef.current = setCellOutputs;
  createNotebookRef.current = createNotebook;
  executeCellRef.current = executeCell;
  onAgentOperationRef.current = onAgentOperation;
  undoRef.current = undo;
  redoRef.current = redo;
  canUndoRef.current = canUndo;
  canRedoRef.current = canRedo;

  const [isConnected, setIsConnected] = useState(false);
  const [activeOperation, setActiveOperation] = useState<AgentOperationInfo | null>(null);
  const [agentSession, setAgentSessionState] = useState<AgentSessionInfo | null>(null);
  const agentSessionRef = useRef<AgentSessionInfo | null>(null);

  // Helper to update both ref and state for agentSession
  const setAgentSession = useCallback((session: AgentSessionInfo | null) => {
    agentSessionRef.current = session;
    setAgentSessionState(session);
  }, []);

  /**
   * Check if a cell ID is unique
   */
  const isIdUnique = useCallback((id: string): boolean => {
    return !cellsRef.current.some(c => c.id === id);
  }, []);

  /**
   * Generate a unique ID by appending suffix if needed
   */
  const makeUniqueId = useCallback((baseId: string): string => {
    if (isIdUnique(baseId)) return baseId;
    let suffix = 2;
    while (!isIdUnique(`${baseId}-${suffix}`)) suffix++;
    return `${baseId}-${suffix}`;
  }, [isIdUnique]);

  /**
   * Apply an operation and return the result
   */
  const applyOperation = useCallback(async (operation: NotebookOperation): Promise<OperationResult> => {
    const currentCells = cellsRef.current;

    try {
      switch (operation.type) {
        case 'insertCell': {
          const { index, cell } = operation;
          let cellId = cell.id;
          let idModified = false;

          // Check for duplicate ID
          if (!isIdUnique(cellId)) {
            const originalId = cellId;
            cellId = makeUniqueId(cellId);
            idModified = true;
          }

          // Create the new cell
          const newCell: Cell = {
            id: cellId,
            type: cell.type,
            content: cell.content,
            outputs: [],
            isExecuting: false,
            scrolled: cell.metadata?.scrolled as boolean | undefined,
            scrolledHeight: cell.metadata?.scrolledHeight as number | undefined,
          };

          // Calculate actual index
          const actualIndex = index === -1 || index >= currentCells.length
            ? currentCells.length
            : index;

          insertCellRef.current(actualIndex, newCell);

          // Update cellsRef immediately to avoid stale reads before re-render
          const updatedCells = [...currentCells];
          updatedCells.splice(actualIndex, 0, newCell);
          cellsRef.current = updatedCells;

          return {
            success: true,
            cellId,
            cellIndex: actualIndex,
            idModified,
            requestedId: idModified ? cell.id : undefined,
          };
        }

        case 'deleteCell': {
          const { cellId, cellIndex } = operation;

          let targetIndex: number | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          deleteCellRef.current(targetIndex);

          // Update cellsRef immediately to avoid stale reads before re-render
          cellsRef.current = currentCells.filter((_, i) => i !== targetIndex);

          return { success: true, cellIndex: targetIndex };
        }

        case 'updateContent': {
          const { cellId, content } = operation;

          const cell = currentCells.find(c => c.id === cellId);
          if (!cell) {
            return { success: false, error: `Cell with ID "${cellId}" not found` };
          }

          // Use AI update function if available (marks operation source)
          if (updateContentAIRef.current) {
            updateContentAIRef.current(cellId, content);
          } else {
            updateContentRef.current(cellId, content);
          }

          return {
            success: true,
            cellId,
            cellIndex: currentCells.findIndex(c => c.id === cellId),
          };
        }

        case 'updateMetadata': {
          const { cellId, changes } = operation;

          const cellIndex = currentCells.findIndex(c => c.id === cellId);
          if (cellIndex === -1) {
            return { success: false, error: `Cell with ID "${cellId}" not found` };
          }

          const cell = currentCells[cellIndex];

          // Validate all changes against schema before applying any
          const errors: string[] = [];
          for (const [key, value] of Object.entries(changes)) {
            const validation = validateMetadataValue(key, value);
            if (!validation.valid) {
              errors.push(validation.error!);
            }
          }
          if (errors.length > 0) {
            return { success: false, error: errors.join('; ') };
          }

          // ID changes are not supported (would require delete + recreate)
          if ('id' in changes && changes.id !== cellId) {
            return { success: false, error: 'ID changes are not supported via updateMetadata' };
          }

          // Convert operation format { key: value } to MetadataChanges format { key: { old, new } }
          // Schema validation passed, so all keys are valid
          const metadataChanges: Record<string, { old: unknown; new: unknown }> = {};
          for (const [key, newValue] of Object.entries(changes)) {
            if (key === 'id') continue; // Skip ID (handled above)
            const oldValue = (cell as Record<string, unknown>)[key];
            metadataChanges[key] = { old: oldValue, new: newValue };
          }

          // Apply all changes through the generic updateMetadata callback
          if (Object.keys(metadataChanges).length > 0) {
            updateMetadataRef.current(cellId, metadataChanges);
          }

          return {
            success: true,
            cellId,
            cellIndex,
          };
        }

        case 'moveCell': {
          const { fromIndex, toIndex } = operation;

          if (fromIndex < 0 || fromIndex >= currentCells.length) {
            return { success: false, error: `Source index ${fromIndex} out of range` };
          }
          if (toIndex < 0 || toIndex >= currentCells.length) {
            return { success: false, error: `Target index ${toIndex} out of range` };
          }

          moveCellRef.current(fromIndex, toIndex);

          return { success: true };
        }

        case 'duplicateCell': {
          const { cellIndex, newCellId } = operation;

          if (cellIndex < 0 || cellIndex >= currentCells.length) {
            return { success: false, error: `Cell index ${cellIndex} out of range` };
          }

          const originalCell = currentCells[cellIndex];
          let actualId = newCellId;
          let idModified = false;

          if (!isIdUnique(actualId)) {
            const originalId = actualId;
            actualId = makeUniqueId(actualId);
            idModified = true;
          }

          const newCell: Cell = {
            id: actualId,
            type: originalCell.type,
            content: originalCell.content,
            outputs: [], // Don't copy outputs
            isExecuting: false,
          };

          insertCellRef.current(cellIndex + 1, newCell);

          return {
            success: true,
            cellId: actualId,
            cellIndex: cellIndex + 1,
            idModified,
            requestedId: idModified ? newCellId : undefined,
          };
        }

        case 'updateOutputs': {
          const { cellId, outputs, executionCount } = operation;

          const cell = currentCells.find(c => c.id === cellId);
          if (!cell) {
            return { success: false, error: `Cell with ID "${cellId}" not found` };
          }

          // Convert output format (add required id and timestamp)
          const cellOutputs: Cell['outputs'] = outputs.map((o, i) => ({
            id: `${cellId}-output-${i}-${Date.now()}`,
            type: o.type as Cell['outputs'][0]['type'],
            content: o.content,
            timestamp: Date.now(),
          }));

          if (setCellOutputsRef.current) {
            setCellOutputsRef.current(cellId, cellOutputs, executionCount);
          }

          return {
            success: true,
            cellId,
            cellIndex: currentCells.findIndex(c => c.id === cellId),
          };
        }

        case 'clearOutputs': {
          const { cellId, cellIds = [] } = operation;

          // Support both single ID and list of IDs
          const targetIds = cellId && cellIds.length === 0 ? [cellId] : cellIds;
          const clearedIds: string[] = [];
          const notFound: string[] = [];

          if (targetIds.length === 0) {
            // Clear all cells if no IDs specified
            for (const cell of currentCells) {
              if (cell.outputs.length > 0 && setCellOutputsRef.current) {
                setCellOutputsRef.current(cell.id, [], undefined);
                clearedIds.push(cell.id);
              }
            }
          } else {
            // Clear specific cells
            for (const cid of targetIds) {
              const cell = currentCells.find(c => c.id === cid);
              if (cell) {
                if (setCellOutputsRef.current) {
                  setCellOutputsRef.current(cid, [], undefined);
                }
                clearedIds.push(cid);
              } else {
                notFound.push(cid);
              }
            }
          }

          return {
            success: true,
            clearedCount: clearedIds.length,
            clearedIds,
            notFound: notFound.length > 0 ? notFound : undefined,
          };
        }

        case 'createNotebook': {
          const { notebookPath, overwrite = false, kernelName = 'python3' } = operation;

          if (!createNotebookRef.current) {
            return { success: false, error: 'createNotebook callback not provided' };
          }

          const result = await createNotebookRef.current(notebookPath, overwrite, kernelName);
          return {
            success: result.success,
            path: notebookPath,
            mtime: result.mtime,
            error: result.error,
          };
        }

        case 'readCell': {
          const { cellId, cellIndex } = operation;

          let cell: Cell | undefined;
          let targetIndex: number | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
            cell = currentCells[targetIndex];
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
            cell = currentCells[cellIndex];
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          return {
            success: true,
            cellId: cell.id,
            cellIndex: targetIndex,
            cell: {
              id: cell.id,
              type: cell.type,
              content: cell.content,
              outputs: cell.outputs.map(o => ({ type: o.type, content: o.content })),
              executionCount: cell.executionCount,
              metadata: {
                scrolled: cell.scrolled,
                scrolledHeight: cell.scrolledHeight,
              },
            },
          };
        }

        case 'readCellOutput': {
          const { cellId, cellIndex, maxWait = 0 } = operation as ReadCellOutputOp & { maxWait?: number };

          let targetIndex: number | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          // If maxWait > 0, poll for new outputs
          let cell = currentCells[targetIndex];
          if (maxWait > 0) {
            const initialOutputCount = cell.outputs.length;
            const initialOutputChars = cell.outputs.reduce((sum, o) => sum + o.content.length, 0);
            const startTime = Date.now();
            const pollInterval = 500; // 500ms

            while (Date.now() - startTime < maxWait * 1000) {
              await new Promise(resolve => setTimeout(resolve, pollInterval));
              // Re-read from current ref (cells may have updated)
              const updatedCells = cellsRef.current;
              if (targetIndex >= updatedCells.length) break; // Cell deleted
              cell = updatedCells[targetIndex];
              const currentOutputCount = cell.outputs.length;
              const currentOutputChars = cell.outputs.reduce((sum, o) => sum + o.content.length, 0);

              // Check if outputs changed
              if (currentOutputCount > initialOutputCount || currentOutputChars > initialOutputChars) {
                break; // New output arrived
              }
            }
          }

          return {
            success: true,
            cellId: cell.id,
            cellIndex: targetIndex,
            outputs: cell.outputs.map(o => ({ type: o.type, content: o.content })),
            executionCount: cell.executionCount,
          };
        }

        case 'searchCells': {
          const { query, includeOutputs = false, limit = 10 } = operation as SearchCellsOp;

          if (!query) {
            return { success: false, error: 'No search query provided' };
          }

          const queryLower = query.toLowerCase();
          const matches: NonNullable<OperationResult['matches']> = [];

          for (let i = 0; i < currentCells.length && matches.length < limit; i++) {
            const cell = currentCells[i];
            const content = cell.content || '';

            if (content.toLowerCase().includes(queryLower)) {
              const lines = content.split('\n');
              let matchLine: number | null = null;
              for (let j = 0; j < lines.length; j++) {
                if (lines[j].toLowerCase().includes(queryLower)) {
                  matchLine = j;
                  break;
                }
              }

              matches.push({
                cellId: cell.id,
                cellIndex: i,
                matchLocation: 'source',
                matchLine: matchLine ?? undefined,
                preview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
              });
            }

            if (includeOutputs) {
              for (let j = 0; j < (cell.outputs || []).length; j++) {
                const output = cell.outputs[j];
                const outContent = output.content || '';
                if (outContent.toLowerCase().includes(queryLower)) {
                  matches.push({
                    cellId: cell.id,
                    cellIndex: i,
                    matchLocation: 'output',
                    outputIndex: j,
                    outputType: output.type || 'unknown',
                    preview: outContent.slice(0, 200) + (outContent.length > 200 ? '...' : ''),
                  });
                }
              }
            }
          }

          return {
            success: true,
            query,
            matchCount: matches.length,
            matches: matches.slice(0, limit),
            hasMore: matches.length > limit,
          };
        }

        case 'clearNotebook': {
          const deletedCount = currentCells.length;

          if (deletedCount === 0) {
            return { success: true, deletedCount: 0 };
          }

          // Delete from end to start to avoid index shifting issues
          for (let i = currentCells.length - 1; i >= 0; i--) {
            deleteCellRef.current(i);
          }

          // Update cellsRef immediately to avoid stale reads before re-render
          cellsRef.current = [];

          return { success: true, deletedCount };
        }

        case 'startAgentSession': {
          const { agentId, clientName, clientVersion } = operation;

          // Check if there's already an active session
          if (agentSessionRef.current) {
            console.warn('[OperationHandler] Starting new agent session without ending previous one');
            return {
              success: true,
              warning: 'Previous session was not ended. Starting new session.',
              previousSession: agentSessionRef.current,
            };
          }

          setAgentSession({
            agentId,
            clientName,
            clientVersion,
            startedAt: Date.now(),
          });

          return { success: true };
        }

        case 'endAgentSession': {
          if (!agentSessionRef.current) {
            return { success: true, warning: 'No active session to end' };
          }

          const sessionDuration = Date.now() - agentSessionRef.current.startedAt;
          setAgentSession(null);

          return { success: true, sessionDuration };
        }

        case 'executeCell': {
          const { cellId, cellIndex, sessionId, maxWait, saveOutputs } = operation;

          // Find the cell
          let targetIndex: number | undefined;
          let targetCellId: string | undefined;

          if (cellId) {
            targetIndex = currentCells.findIndex(c => c.id === cellId);
            if (targetIndex === -1) {
              return { success: false, error: `Cell with ID "${cellId}" not found` };
            }
            targetCellId = cellId;
          } else if (cellIndex !== undefined) {
            if (cellIndex < 0 || cellIndex >= currentCells.length) {
              return { success: false, error: `Cell index ${cellIndex} out of range` };
            }
            targetIndex = cellIndex;
            targetCellId = currentCells[cellIndex].id;
          } else {
            return { success: false, error: 'Must provide cellId or cellIndex' };
          }

          // Check if executeCell callback is available
          if (!executeCellRef.current) {
            return { success: false, error: 'executeCell callback not provided - UI cannot execute cells' };
          }

          // Execute the cell through the UI's execution mechanism
          const result = await executeCellRef.current(targetCellId!, {
            sessionId,
            maxWait,
            saveOutputs,
          });

          return {
            success: result.success,
            cellId: targetCellId,
            cellIndex: targetIndex,
            executionStatus: result.executionStatus,
            executionCount: result.executionCount,
            executionTime: result.executionTime,
            outputs: result.outputs,
            sessionId: result.sessionId,
            queuePosition: result.queuePosition,
            queueLength: result.queueLength,
            error: result.error,
          };
        }

        case 'undo': {
          if (!undoRef.current) {
            return { success: false, error: 'Undo not available (callback not provided)' };
          }

          const result = undoRef.current();
          if (!result) {
            return {
              success: false,
              error: 'Nothing to undo',
              canUndo: false,
              canRedo: canRedoRef.current ?? false,
            };
          }

          return {
            success: true,
            affectedCellIds: result.affectedCellIds,
            operationType: result.operationType,
            canUndo: canUndoRef.current ?? false,
            canRedo: true, // After undo, redo is always available
          };
        }

        case 'redo': {
          if (!redoRef.current) {
            return { success: false, error: 'Redo not available (callback not provided)' };
          }

          const result = redoRef.current();
          if (!result) {
            return {
              success: false,
              error: 'Nothing to redo',
              canUndo: canUndoRef.current ?? false,
              canRedo: false,
            };
          }

          return {
            success: true,
            affectedCellIds: result.affectedCellIds,
            operationType: result.operationType,
            canUndo: true, // After redo, undo is always available
            canRedo: canRedoRef.current ?? false,
          };
        }

        default:
          return { success: false, error: `Unknown operation type: ${(operation as any).type}` };
      }
    } catch (e) {
      return { success: false, error: String(e) };
    }
  }, [isIdUnique, makeUniqueId]);

  /**
   * Handle incoming WebSocket message
   */
  const handleMessage = useCallback(async (data: IncomingMessage) => {
    if (data.type === 'pong') {
      // Keep-alive response, ignore
      return;
    }

    if (data.type === 'operation') {
      const { operation, requestId } = data;

      // Extract cell info for UI display
      const cellIndex = 'cellIndex' in operation ? operation.cellIndex :
                        'index' in operation ? operation.index : undefined;
      const cellId = 'cellId' in operation ? operation.cellId :
                     'cell' in operation ? (operation as InsertCellOp).cell.id : undefined;

      // Set active operation for UI indicator
      setActiveOperation({
        type: operation.type,
        cellIndex,
        cellId,
        timestamp: Date.now(),
      });

      const result = await applyOperation(operation);

      // Clear active operation after a brief delay (for visual feedback)
      setTimeout(() => setActiveOperation(null), 300);

      // Call the notification callback if provided
      if (onAgentOperationRef.current) {
        onAgentOperationRef.current(operation, result);
      }

      // Send result back
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'operationResult',
          requestId,
          result,
        }));
      }
    }

    if (data.type === 'readNotebook') {
      const { requestId } = data;

      // Send current notebook state
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({
          type: 'notebookData',
          requestId,
          result: {
            success: true,
            data: {
              path: filePath,
              // Return cells in standardized format (matching headless)
              cells: cellsRef.current.map(c => ({
                id: c.id,
                type: c.type,
                content: c.content,
                // Strip internal fields (id, timestamp) from outputs for API consistency
                outputs: c.outputs.map(o => ({ type: o.type, content: o.content })),
                executionCount: c.executionCount,
                metadata: {
                  scrolled: c.scrolled,
                  scrolledHeight: c.scrolledHeight,
                },
              })),
            },
          },
        }));
      }
    }
  }, [applyOperation, filePath]);

  /**
   * Connect to WebSocket
   */
  const connect = useCallback(() => {
    if (!filePath) return;

    // Clear any pending reconnect before connecting
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Close existing connection (mark as intentional to prevent reconnect loop)
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const encodedPath = encodeURIComponent(filePath);
    const baseWsUrl = `${protocol}//${host}/api/notebook/${encodedPath}/ws`;
    const wsUrl = authService.getAuthenticatedWebSocketUrl(baseWsUrl);

    console.log('[OperationHandler] Connecting to:', baseWsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[OperationHandler] Connected');
      setIsConnected(true);
      intentionalCloseRef.current = false; // Reset flag on successful connect

      // Set up ping interval to keep connection alive
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 10000); // Ping every 10 seconds (helps with SSH tunnels)
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        console.error('[OperationHandler] Failed to parse message:', e);
      }
    };

    ws.onerror = (error) => {
      console.error('[OperationHandler] WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('[OperationHandler] Disconnected');
      setIsConnected(false);

      // Clear ping interval
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Only auto-reconnect if this was NOT an intentional close
      // (intentional closes happen when connect() replaces the connection)
      if (!intentionalCloseRef.current) {
        reconnectTimeoutRef.current = setTimeout(() => {
          if (filePath) {
            console.log('[OperationHandler] Attempting reconnect...');
            connect();
          }
        }, 1000);
      }
    };
  }, [filePath, handleMessage]);

  /**
   * Disconnect from WebSocket
   */
  const disconnect = useCallback(() => {
    // Clear reconnect timeout
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    // Clear ping interval
    if (pingIntervalRef.current) {
      clearInterval(pingIntervalRef.current);
      pingIntervalRef.current = null;
    }

    // Close WebSocket (mark as intentional to prevent auto-reconnect)
    if (wsRef.current) {
      intentionalCloseRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    setIsConnected(false);
  }, []);

  // Connect when file path changes
  useEffect(() => {
    if (filePath) {
      connect();
    } else {
      disconnect();
    }

    return () => {
      disconnect();
    };
  }, [filePath, connect, disconnect]);

  return {
    isConnected,
    activeOperation,
    agentSession,
    disconnect,
    reconnect: connect,
  };
}
