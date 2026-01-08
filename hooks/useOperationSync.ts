/**
 * Operation Sync Hook - Real-time sync between MCP tools and UI
 *
 * Connects to the backend WebSocket to:
 * 1. Receive operations from MCP tools
 * 2. Apply them to the notebook state
 * 3. Send back results
 *
 * This enables real-time collaboration where an AI agent can modify
 * the notebook and the UI reflects changes immediately.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import { Cell, CellType } from '../types';

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

export type NotebookOperation =
  | InsertCellOp
  | DeleteCellOp
  | UpdateContentOp
  | UpdateMetadataOp
  | MoveCellOp
  | DuplicateCellOp
  | UpdateOutputsOp
  | CreateNotebookOp;

export interface OperationResult {
  success: boolean;
  cellId?: string;
  cellIndex?: number;
  idModified?: boolean;
  requestedId?: string;
  error?: string;
  path?: string;
  mtime?: number;
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

interface UseOperationSyncOptions {
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

  /** Change cell type callback (from useUndoRedo) */
  changeType: (cellId: string, newType: CellType) => void;

  /** Set cell outputs callback */
  setCellOutputs?: (cellId: string, outputs: Cell['outputs'], executionCount?: number) => void;

  /** Create notebook callback - returns promise with mtime */
  createNotebook?: (path: string, overwrite: boolean, kernelName: string) => Promise<{ success: boolean; mtime?: number; error?: string }>;
}

export function useOperationSync(options: UseOperationSyncOptions) {
  const {
    filePath,
    cells,
    insertCell,
    deleteCell,
    moveCell,
    updateContent,
    updateContentAI,
    changeType,
    setCellOutputs,
    createNotebook,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pingIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Use refs for callbacks to avoid reconnecting when callbacks change
  const cellsRef = useRef(cells);
  const insertCellRef = useRef(insertCell);
  const deleteCellRef = useRef(deleteCell);
  const moveCellRef = useRef(moveCell);
  const updateContentRef = useRef(updateContent);
  const updateContentAIRef = useRef(updateContentAI);
  const changeTypeRef = useRef(changeType);
  const setCellOutputsRef = useRef(setCellOutputs);
  const createNotebookRef = useRef(createNotebook);

  // Update refs on each render
  cellsRef.current = cells;
  insertCellRef.current = insertCell;
  deleteCellRef.current = deleteCell;
  moveCellRef.current = moveCell;
  updateContentRef.current = updateContent;
  updateContentAIRef.current = updateContentAI;
  changeTypeRef.current = changeType;
  setCellOutputsRef.current = setCellOutputs;
  createNotebookRef.current = createNotebook;

  const [isConnected, setIsConnected] = useState(false);

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
          let newCellId = cellId;

          // Handle type change
          if ('type' in changes && changes.type !== cell.type) {
            changeTypeRef.current(cellId, changes.type as CellType);
          }

          // Handle ID change (not directly supported, would need to delete and recreate)
          if ('id' in changes && changes.id !== cellId) {
            // For now, return error - ID changes are complex
            return { success: false, error: 'ID changes are not supported via this method' };
          }

          return {
            success: true,
            cellId: newCellId,
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
      const result = await applyOperation(operation);

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
              cells: cellsRef.current.map(c => ({
                id: c.id,
                type: c.type,
                content: c.content,
                outputs: c.outputs,
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

    // Close existing connection
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;
    const encodedPath = encodeURIComponent(filePath);
    const wsUrl = `${protocol}//${host}/api/notebook/${encodedPath}/ws`;

    console.log('[OperationSync] Connecting to:', wsUrl);

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onopen = () => {
      console.log('[OperationSync] Connected');
      setIsConnected(true);

      // Set up ping interval to keep connection alive
      pingIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 30000); // Ping every 30 seconds
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleMessage(data);
      } catch (e) {
        console.error('[OperationSync] Failed to parse message:', e);
      }
    };

    ws.onerror = (error) => {
      console.error('[OperationSync] WebSocket error:', error);
    };

    ws.onclose = () => {
      console.log('[OperationSync] Disconnected');
      setIsConnected(false);

      // Clear ping interval
      if (pingIntervalRef.current) {
        clearInterval(pingIntervalRef.current);
        pingIntervalRef.current = null;
      }

      // Attempt to reconnect after 5 seconds
      reconnectTimeoutRef.current = setTimeout(() => {
        if (filePath) {
          console.log('[OperationSync] Attempting reconnect...');
          connect();
        }
      }, 5000);
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

    // Close WebSocket
    if (wsRef.current) {
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
    disconnect,
    reconnect: connect,
  };
}
