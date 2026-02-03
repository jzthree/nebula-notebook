
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Cell as CellComponent } from './Cell';
import { Cell, CellType, NotebookMetadata } from '../types';
import { kernelService, KernelSpec, PythonEnvironment } from '../services/kernelService';
import { getClusterInfo, ClusterServer, ClusterInfo } from '../services/clusterService';
import { getSettings, saveSettings, IndentationPreference } from '../services/llmService';
import { Plus, Play, Save, Menu, ChevronDown, RotateCw, Power, Sparkles, Undo2, Redo2, Settings, Square, Cloud, CloudOff, Loader2, Check, AlertCircle, RefreshCw, Download, Cpu, Keyboard, X, CheckCircle, XCircle, Layers, Bot, Shield, ShieldCheck, ShieldOff, Terminal, History, MemoryStick, Server, Clock } from 'lucide-react';
import { VirtuosoHandle } from 'react-virtuoso';
import {
  getFiles,
  getFileContentWithMtime,
  getActiveFileId,
  saveActiveFileId,
  updateNotebookMetadata,
  renameFile,
  loadNotebookHistory,
  loadNotebookSession,
  saveNotebookSession,
  saveNotebookCells,
  saveNotebookHistory,
  getAgentPermissionStatus,
  setAgentPermission,
  AgentPermissionStatus,
  getNotebookSettings,
  updateNotebookSettings,
  OutputLoggingMode
} from '../services/fileService';
import { FileBrowser } from './FileBrowser';
import { TextFileEditor } from './TextFileEditor';
import { addRecentNotebook } from './Dashboard';
import { AIChatSidebar } from './AIChatSidebar';
import { TerminalPanel } from './TerminalPanel';
import { HistoryPanel } from './HistoryPanel';
import { RestoreDialog } from './RestoreDialog';
import { VirtualCellList } from './VirtualCellList';
import { useUndoRedo, EditSource } from '../hooks/useUndoRedo';
import { useOperationHandler } from '../hooks/useOperationHandler';
import { SettingsModal } from './SettingsModal';
import { KernelManager } from './KernelManager';
import { NotebookSearch } from './NotebookSearch';
import { NotebookBreadcrumb } from './NotebookBreadcrumb';
import { ResourceStatusBar } from './ResourceStatusBar';
import { useAutosave, formatLastSaved } from '../hooks/useAutosave';
import { useNotification } from './NotificationSystem';
import { useConflictResolution } from '../hooks/useConflictResolution';
import { detectIndentationFromCells, IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';
import { getNotebookAvatar, updateFavicon, resetFavicon } from '../utils/notebookAvatar';
import { playSuccessSound } from '../utils/notificationSound';
import { generateCellId } from '../utils/cellId';
import { reconstructStateAt, HistoryEntry } from '../lib/notebookOperations';
import { perfDebugger } from '../lib/performanceDebugger';

// Initial cell for reset
const INITIAL_CELL: Cell = {
  id: generateCellId(),
  type: 'code',
  content: '',
  outputs: [],
  isExecuting: false
};

// Output limits - shared between execution and loading
const MAX_OUTPUT_LINES = 10000; // Max lines of text output
const MAX_OUTPUT_CHARS = 100000000; // 100MB - generous for images

// Convert user indentation preference to config
function getIndentConfigFromPreference(pref: IndentationPreference): IndentationConfig | null {
  switch (pref) {
    case 'auto': return null; // Use autodetection
    case '2': return { useTabs: false, tabSize: 2, indentSize: 2 };
    case '4': return { useTabs: false, tabSize: 4, indentSize: 4 };
    case '8': return { useTabs: false, tabSize: 8, indentSize: 8 };
    case 'tab': return { useTabs: true, tabSize: 4, indentSize: 1 };
    default: return null;
  }
}

type CellClipboardItem = {
  type: CellType;
  content: string;
  sourceId: string;
  isCut: boolean;
};

// Helper to extract filename from path
function getFilenameFromPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || 'Untitled';
}

function getDirectoryFromPath(filePath: string | null): string | undefined {
  if (!filePath) return undefined;
  const idx = filePath.lastIndexOf('/');
  if (idx === -1) return undefined;
  if (idx === 0) return '/';
  return filePath.slice(0, idx);
}

// Get initial file ID synchronously to avoid "Untitled" flash
function getInitialFileId(): string | null {
  // Check URL parameter first
  const url = new URL(window.location.href);
  const fileParam = url.searchParams.get('file');
  if (fileParam) return fileParam;

  // Fall back to saved active file
  return getActiveFileId();
}

// Format elapsed time in a compact form (e.g., "1.2s", "1m 23s")
function formatElapsedTime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const tenths = Math.floor((ms % 1000) / 100);

  if (seconds < 60) {
    return `${seconds}.${tenths}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// Format kernel uptime from createdAt timestamp
function formatKernelUptime(createdAtSeconds: number): string {
  const now = Date.now() / 1000;
  const seconds = Math.floor(now - createdAtSeconds);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export const Notebook: React.FC = () => {
  const { toast, confirm } = useNotification();

  // File System State
  const [files, setFiles] = useState<NotebookMetadata[]>([]);
  const [currentFileId, setCurrentFileId] = useState<string | null>(getInitialFileId);
  const [isLoadingFile, setIsLoadingFile] = useState(!!getInitialFileId());
  const [currentFileMetadata, setCurrentFileMetadata] = useState<NotebookMetadata | null>(null);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [textEditorPath, setTextEditorPath] = useState<string | null>(null);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isTerminalOpen, setIsTerminalOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  // History preview - timestamp of the point in history to preview (null = present)
  const [previewTimestamp, setPreviewTimestamp] = useState<number | null>(null);
  // Restore dialog state
  const [restoreDialogTimestamp, setRestoreDialogTimestamp] = useState<number | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isKernelManagerOpen, setIsKernelManagerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isKeyboardHelpOpen, setIsKeyboardHelpOpen] = useState(false);
  const [memoryUsage, setMemoryUsage] = useState<{ used: number; total: number } | null>(null);
  const [searchQuery, setSearchQuery] = useState<{
    query: string;
    caseSensitive: boolean;
    useRegex: boolean;
    currentMatch?: { cellId: string; startIndex: number; endIndex: number } | null;
  } | null>(null);

  // Notebook rename state
  const [isRenamingNotebook, setIsRenamingNotebook] = useState(false);
  const [renameValue, setRenameValue] = useState('');

  // Conflict detection state
  // IMPORTANT: The ref is the source of truth for mtime during save operations.
  // We DON'T sync ref from state on every render, because that could overwrite
  // a freshly saved mtime with stale state due to React's batched updates.
  // The state is only for triggering re-renders when needed.
  const [lastKnownMtime, setLastKnownMtimeState] = useState<number | null>(null);
  const lastKnownMtimeRef = useRef<number | null>(null);

  // Track whether history has been loaded for this notebook
  // Prevents saving history before it's loaded, and can be used to lock editing
  const [historyReady, setHistoryReady] = useState(false);

  // Helper to update both state AND ref synchronously to prevent race conditions
  const setLastKnownMtime = useCallback((mtime: number | null) => {
    lastKnownMtimeRef.current = mtime;  // Update ref immediately (source of truth)
    setLastKnownMtimeState(mtime);      // Update state for re-render
  }, []);
  const [pendingSave, setPendingSave] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  useEffect(() => {
    if (!textEditorPath) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [textEditorPath]);


  // Kernel State
  const [isKernelMenuOpen, setIsKernelMenuOpen] = useState(false);
  const [isExecutionQueueOpen, setIsExecutionQueueOpen] = useState(false);
  const [availableKernels, setAvailableKernels] = useState<KernelSpec[]>([]);
  const [pythonEnvironments, setPythonEnvironments] = useState<PythonEnvironment[]>([]);
  const [currentKernel, setCurrentKernel] = useState<string>('python3');
  const [kernelSessionId, setKernelSessionId] = useState<string | null>(null);
  const [kernelStatus, setKernelStatus] = useState<'idle' | 'busy' | 'starting' | 'disconnected'>('disconnected');
  const [kernelCreatedAt, setKernelCreatedAt] = useState<number | null>(null);
  const [isDiscoveringPythons, setIsDiscoveringPythons] = useState(false);
  const [isInstallingKernel, setIsInstallingKernel] = useState<string | null>(null);

  // Cluster State
  const [clusterInfo, setClusterInfo] = useState<ClusterInfo | null>(null);
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null); // null = local

  // Agent permission state
  const [agentPermissionStatus, setAgentPermissionStatus] = useState<AgentPermissionStatus | null>(null);

  // Output logging mode for history - 'minimal' logs no output, 'full' logs complete output
  const [outputLoggingMode, setOutputLoggingMode] = useState<OutputLoggingMode>('minimal');

  // Undo/Redo & State Management (operation-based)
  const {
    cells,
    setCells,
    insertCell: undoableInsertCell,
    deleteCell: undoableDeleteCell,
    moveCell: undoableMoveCell,
    updateContent,
    updateMetadata,
    changeType,
    setCellScrolled,
    setCellScrolledHeight,
    saveCheckpoint,
    flushCell,
    peekUndo,
    peekRedo,
    undo: rawUndo,
    redo: rawRedo,
    canUndo,
    canRedo,
    loadCells,
    initializeNewHistory,
    getFullHistory,
    loadHistory,
    logOperation,
    updateContentAI,
    redoStackLength,
    commitHistoryBeforeKeyframe,
    hasRedoToFlush,
    getUnflushedState,
    setUnflushedState,
    getUpdatesSince,
  } = useUndoRedo([]);  // Start with empty cells

  const logKernelEvent = useCallback((
    name: string,
    data?: Record<string, unknown>,
    source: EditSource = 'user'
  ) => {
    logOperation({
      type: 'event',
      category: 'kernel',
      name,
      data,
      source,
    });
  }, [logOperation]);

  // Compute preview cells when viewing history
  // Reconstruct cells at preview timestamp
  const previewCells = useMemo(() => {
    if (!previewTimestamp) return null;
    const history = getFullHistory();
    // Cast to HistoryEntry[] - types are structurally compatible
    const state = reconstructStateAt(history as unknown as HistoryEntry[], previewTimestamp);
    return state?.cells ?? null;
  }, [previewTimestamp, getFullHistory]);

  const isPreviewMode = previewTimestamp !== null;

  // Map of current cells for O(1) lookup - reused by multiple computations
  const currentCellMap = useMemo(() =>
    new Map(cells.map(c => [c.id, c])),
  [cells]);

  // Set of cell IDs that were executed after the preview timestamp
  // If a cell wasn't re-run, its current outputs are still valid for preview
  const cellsExecutedAfterPreview = useMemo(() => {
    if (!previewTimestamp) return new Set<string>();

    const executed = new Set<string>();
    const history = getFullHistory();

    for (const entry of history) {
      if (entry.timestamp <= previewTimestamp) continue;
      const isRunCell = entry.type === 'runCell' ||
        (entry.type === 'event' && (entry as any).name === 'runCell');
      if (!isRunCell) continue;
      const cellId = entry.type === 'event' ? (entry as any).target?.cellId : (entry as any).cellId;
      if (cellId) executed.add(cellId);
    }
    return executed;
  }, [previewTimestamp, getFullHistory]);

  // Cells to display - preview cells with preserved outputs where possible
  const displayCells = useMemo(() => {
    if (!previewCells) return cells;

    return previewCells.map(previewCell => {
      const currentCell = currentCellMap.get(previewCell.id);

      // Preserve outputs if cell exists and wasn't re-run after preview point
      if (currentCell && !cellsExecutedAfterPreview.has(previewCell.id)) {
        return { ...previewCell, outputs: currentCell.outputs };
      }

      return previewCell;
    });
  }, [previewCells, cells, currentCellMap, cellsExecutedAfterPreview]);

  // Compute diff between preview and current for highlighting
  // 'same' = unchanged, 'modified' = content differs, 'deleted' = exists in preview but not current
  type CellDiffStatus = 'same' | 'modified' | 'deleted';
  const previewDiffMap = useMemo(() => {
    const map = new Map<string, CellDiffStatus>();
    if (!previewCells) return map;

    for (const previewCell of previewCells) {
      const currentCell = currentCellMap.get(previewCell.id);
      if (!currentCell) {
        // Cell was deleted after this point in history
        map.set(previewCell.id, 'deleted');
      } else if (currentCell.content !== previewCell.content || currentCell.type !== previewCell.type) {
        // Cell content or type changed
        map.set(previewCell.id, 'modified');
      } else {
        map.set(previewCell.id, 'same');
      }
    }

    return map;
  }, [previewCells, currentCellMap]);

  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [indentConfig, setIndentConfig] = useState<IndentationConfig>(DEFAULT_INDENTATION);
  const [showLineNumbers, setShowLineNumbers] = useState<boolean>(() => getSettings().showLineNumbers ?? false);
  const [showCellIds, setShowCellIds] = useState<boolean>(() => getSettings().showCellIds ?? false);
  const [showResourceMonitor, setShowResourceMonitor] = useState<boolean>(() => getSettings().showResourceMonitor ?? false);

  // Conflict resolution hook
  // Note: When loading remote version during conflict, we initialize fresh history
  // since we're discarding local changes
  const {
    conflictDialog,
    saveWithCheck,
    keepLocal,
    loadRemote,
    dismissDialog: dismissConflictDialog
  } = useConflictResolution(
    setLastKnownMtime,
    initializeNewHistory  // Conflict resolution resets history since local changes are discarded
  );

  // Helper to set cell outputs (for operation sync)
  const setCellOutputs = useCallback((cellId: string, outputs: Cell['outputs'], executionCount?: number) => {
    setCells(prevCells => prevCells.map(c =>
      c.id === cellId
        ? { ...c, outputs, executionCount: executionCount ?? c.executionCount }
        : c
    ));
  }, [setCells]);

  // Helper to create notebook (for operation sync)
  const handleCreateNotebook = useCallback(async (
    path: string,
    overwrite: boolean,
    kernelName: string,
    kernelDisplayName?: string
  ): Promise<{ success: boolean; mtime?: number; error?: string }> => {
    try {
      // First check if file exists (if not overwriting)
      if (!overwrite) {
        const checkResponse = await fetch(`/api/fs/read?path=${encodeURIComponent(path)}`);
        if (checkResponse.ok) {
          // File exists
          return {
            success: false,
            error: `Notebook already exists: ${path}. Use overwrite=true to replace.`,
          };
        }
        // 404 means file doesn't exist - that's what we want
      }

      // Create empty notebook structure
      const notebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {
          kernelspec: {
            name: kernelName,
            display_name: kernelDisplayName ?? (kernelName === 'python3' ? 'Python 3' : kernelName),
          },
          language_info: { name: 'python' },
        },
        cells: [],
      };

      // Write directly via fs API (avoids routing loop)
      const response = await fetch('/api/fs/write', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path,
          content: JSON.stringify(notebook, null, 2),
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        return { success: false, error: error.detail || 'Failed to create notebook' };
      }

      // Get mtime from the created file
      const mtimeResponse = await fetch(`/api/fs/file-mtime?path=${encodeURIComponent(path)}`);
      let mtime: number | undefined;
      if (mtimeResponse.ok) {
        const data = await mtimeResponse.json();
        mtime = data.mtime;

        // Update our mtime tracking if this is the current file
        if (path === currentFileId) {
          setLastKnownMtime(mtime);
        }
      }

      return { success: true, mtime };
    } catch (e) {
      return {
        success: false,
        error: String(e),
      };
    }
  }, [currentFileId, setLastKnownMtime]);

  // Format agent operation for toast notification
  const formatAgentOperation = useCallback((opType: string, result: { success: boolean; cellIndex?: number; error?: string }) => {
    if (!result.success) return `Agent error: ${result.error}`;
    const cellNum = result.cellIndex !== undefined ? ` #${result.cellIndex + 1}` : '';
    switch (opType) {
      case 'insertCell': return `Agent inserted cell${cellNum}`;
      case 'deleteCell': return `Agent deleted cell${cellNum}`;
      case 'updateContent': return `Agent updated cell${cellNum}`;
      case 'updateOutputs': return `Agent updated outputs${cellNum}`;
      case 'moveCell': return `Agent moved cell`;
      case 'duplicateCell': return `Agent duplicated cell${cellNum}`;
      case 'clearNotebook': return `Agent cleared notebook`;
      default: return `Agent: ${opType}`;
    }
  }, []);

  // Execute cell callback for agent operations
  // Uses the same execution queue as UI - just adds timeout wrapper for agent
  const handleAgentExecuteCell = useCallback(async (
    cellId: string,
    options?: {
      sessionId?: string;
      maxWait?: number;
      saveOutputs?: boolean;
    }
  ): Promise<{
    success: boolean;
    executionStatus?: 'idle' | 'busy' | 'error';
    executionCount?: number;
    executionTime?: number;
    outputs?: Array<{ type: string; content: string }>;
    sessionId?: string;
    queuePosition?: number;
    queueLength?: number;
    error?: string;
  }> => {
    // Use ref for current cell state
    const currentCells = cellsRef.current;
    const cellIndex = currentCells.findIndex(c => c.id === cellId);
    const cell = cellIndex >= 0 ? currentCells[cellIndex] : null;

    if (!cell) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    if (cell.type !== 'code') {
      return { success: false, error: `Cell ${cellId} is not a code cell` };
    }

    const effectiveSessionId = options?.sessionId || kernelSessionId;
    if (!effectiveSessionId) {
      return { success: false, error: 'No kernel session available. Start a kernel first.' };
    }

    if (!cell.content.trim()) {
      return {
        success: true,
        executionStatus: 'idle',
        outputs: [],
        executionCount: undefined,
        sessionId: effectiveSessionId,
      };
    }

    const startTime = Date.now();
    const maxWait = (options?.maxWait ?? 10) * 1000; // Convert to ms
    const pollInterval = 100; // Poll every 100ms

    const currentQueue = executionQueueRef.current;
    const existingIndex = currentQueue.indexOf(cellId);
    const queuePosition = existingIndex >= 0 ? existingIndex : currentQueue.length;
    const queueLength = existingIndex >= 0 ? currentQueue.length : currentQueue.length + 1;

    // Add to execution queue - this triggers the existing UI execution logic
    // The useEffect execution processor will handle the actual execution
    // Only add and log if not already in queue (matches queueExecution behavior)
    if (existingIndex < 0) {
      const runId = createRunId();
      executionRunIdsRef.current.set(cellId, runId);
      setExecutionQueue(prev => [...prev, cellId]);
      // Log cell run for history (same as UI queueExecution)
      logOperation({
        type: 'event',
        category: 'execution',
        name: 'runCell',
        target: { cellId, cellIndex },
        runId,
      });
    } else if (!executionRunIdsRef.current.has(cellId)) {
      executionRunIdsRef.current.set(cellId, createRunId());
    }

    // Wait for execution to complete (isExecuting becomes false) or timeout
    return new Promise((resolve) => {
      let wasExecuting = false; // Track if execution ever started

      const checkCompletion = () => {
        const elapsed = Date.now() - startTime;

        // Get current cell state from ref (not closure) to get live data
        const currentCell = cellsRef.current.find(c => c.id === cellId);

        if (!currentCell) {
          // Cell was deleted during execution
          resolve({
            success: false,
            error: 'Cell was deleted during execution',
            executionTime: elapsed,
            sessionId: effectiveSessionId,
            queuePosition,
            queueLength,
          });
          return;
        }

        // Track if execution started
        if (currentCell.isExecuting) {
          wasExecuting = true;
        }

        // Check if execution completed (was executing, now not)
        if (wasExecuting && !currentCell.isExecuting) {
          // Execution complete - get outputs from cell state
          const hasError = currentCell.outputs.some(o => o.type === 'error');
          resolve({
            success: true,
            executionStatus: hasError ? 'error' : 'idle',
            executionCount: currentCell.executionCount,
            executionTime: elapsed,
            outputs: currentCell.outputs.map(o => ({ type: o.type, content: o.content })),
            sessionId: effectiveSessionId,
            queuePosition,
            queueLength,
          });
          return;
        }

        // Check timeout
        if (elapsed >= maxWait) {
          // Timeout - return current outputs, execution continues in background
          resolve({
            success: true,
            executionStatus: 'busy',
            executionTime: elapsed,
            outputs: currentCell.outputs.map(o => ({ type: o.type, content: o.content })),
            sessionId: effectiveSessionId,
            queuePosition,
            queueLength,
          });
          return;
        }

        // Still waiting for execution to start or complete, poll again
        setTimeout(checkCompletion, pollInterval);
      };

      // Start polling after a small delay to let execution start
      setTimeout(checkCompletion, pollInterval);
    });
  }, [kernelSessionId]);

  const kernelOpsRef = useRef<{
    startKernel?: (kernelName?: string, source?: EditSource) => Promise<{ success: boolean; sessionId?: string; kernelName?: string; error?: string }>;
    shutdownKernel?: (source?: EditSource) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    restartKernel?: (source?: EditSource) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
    interruptKernel?: (source?: EditSource) => Promise<{ success: boolean; sessionId?: string; error?: string }>;
  }>({});

  const startKernelForAgent = useCallback(async (kernelName?: string, source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.startKernel) {
      return { success: false, error: 'startKernel not initialized' };
    }
    return kernelOpsRef.current.startKernel(kernelName, source);
  }, []);

  const shutdownKernelForAgent = useCallback(async (source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.shutdownKernel) {
      return { success: false, error: 'shutdownKernel not initialized' };
    }
    return kernelOpsRef.current.shutdownKernel(source);
  }, []);

  const restartKernelForAgent = useCallback(async (source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.restartKernel) {
      return { success: false, error: 'restartKernel not initialized' };
    }
    return kernelOpsRef.current.restartKernel(source);
  }, []);

  const interruptKernelForAgent = useCallback(async (source: EditSource = 'mcp') => {
    if (!kernelOpsRef.current.interruptKernel) {
      return { success: false, error: 'interruptKernel not initialized' };
    }
    return kernelOpsRef.current.interruptKernel(source);
  }, []);

  // Operation handler - receives operations routed from backend OperationRouter
  const { isConnected: isAgentConnected, activeOperation: agentOperation, agentSession } = useOperationHandler({
    filePath: currentFileId,
    cells,
    insertCell: undoableInsertCell,
    deleteCell: undoableDeleteCell,
    moveCell: undoableMoveCell,
    updateContent,
    updateContentAI,
    updateMetadata,
    setCellOutputs,
    createNotebook: handleCreateNotebook,
    executeCell: handleAgentExecuteCell,
    startKernel: startKernelForAgent,
    shutdownKernel: shutdownKernelForAgent,
    restartKernel: restartKernelForAgent,
    interruptKernel: interruptKernelForAgent,
    undo: rawUndo,
    redo: rawRedo,
    canUndo,
    canRedo,
    getUpdatesSince,
    onAgentOperation: useCallback((operation, result) => {
      // Skip read-only operations
      if (operation.type === 'readCell' || operation.type === 'readCellOutput') return;

      // Handle output updates - only show toast when execution completes (has executionCount)
      if (operation.type === 'updateOutputs') {
        if ('executionCount' in operation && operation.executionCount) {
          toast(`Agent executed cell #${(result.cellIndex ?? 0) + 1}`, 'info', 2000);
        }
        return;
      }

      // Handle session operations specially
      if (operation.type === 'startAgentSession') {
        if (result.warning) {
          toast(`⚠️ ${result.warning}`, 'warning', 3000);
        } else {
          toast('🤖 Agent session started', 'info', 2000);
        }
        return;
      }
      if (operation.type === 'endAgentSession') {
        const duration = result.sessionDuration ? ` (${Math.round(result.sessionDuration / 1000)}s)` : '';
        toast(`🤖 Agent session ended${duration}`, 'info', 2000);
        return;
      }

      // Handle executeCell operation
      if (operation.type === 'executeCell') {
        const cellNum = result.cellIndex !== undefined ? ` #${result.cellIndex + 1}` : '';
        if (result.success) {
          if (result.executionStatus === 'busy') {
            toast(`Agent started executing cell${cellNum}`, 'info', 2000);
          } else if (result.executionStatus === 'error') {
            toast(`Agent executed cell${cellNum} (with errors)`, 'warning', 2000);
          } else {
            toast(`Agent executed cell${cellNum}`, 'info', 2000);
          }
        } else {
          toast(`Agent execution failed: ${result.error}`, 'error', 3000);
        }
        return;
      }

      // Handle undo/redo operations
      if (operation.type === 'undo') {
        if (result.success) {
          const affectedCount = result.affectedCellIds?.length ?? 0;
          toast(`Agent undid ${result.operationType || 'operation'} (${affectedCount} cell${affectedCount !== 1 ? 's' : ''})`, 'info', 2000);
        } else {
          toast(result.error || 'Nothing to undo', 'warning', 2000);
        }
        return;
      }
      if (operation.type === 'redo') {
        if (result.success) {
          const affectedCount = result.affectedCellIds?.length ?? 0;
          toast(`Agent redid ${result.operationType || 'operation'} (${affectedCount} cell${affectedCount !== 1 ? 's' : ''})`, 'info', 2000);
        } else {
          toast(result.error || 'Nothing to redo', 'warning', 2000);
        }
        return;
      }

      const msg = formatAgentOperation(operation.type, result);
      toast(msg, result.success ? 'info' : 'error', 2000);
    }, [formatAgentOperation, toast]),
  });

  // Clipboard for cut/copy/paste cells
  const [cellClipboard, setCellClipboard] = useState<CellClipboardItem | null>(null);

  // FIFO queue for cells (separate from clipboard) - enqueue with 'e', dequeue with 'd'
  const [cellQueue, setCellQueue] = useState<CellClipboardItem[]>([]);
  const cellQueueRef = useRef<CellClipboardItem[]>([]);
  const executionQueueRef = useRef<string[]>([]);
  const executionRunIdsRef = useRef<Map<string, string>>(new Map());

  const cellsRef = useRef<Cell[]>(cells);
  const activeCellIdRef = useRef<string | null>(activeCellId);
  const cellClipboardRef = useRef<CellClipboardItem | null>(cellClipboard);
  const getFullHistoryRef = useRef(getFullHistory);

  // ⚠️ PERFORMANCE CRITICAL: Refs for renderCell callback stability
  // These allow the memoized renderCell to access current values without recreating
  // Note: Initialized with defaults, updated on each render after state is defined
  const highlightedCellIdsRef = useRef<Set<string>>(new Set());
  const searchQueryRef = useRef<typeof searchQuery>(null);
  const indentConfigRef = useRef<IndentationConfig>(DEFAULT_INDENTATION);
  const pendingFocusRef = useRef<{ cellId: string; mode: 'cell' | 'editor' } | null>(null);
  const isSearchOpenRef = useRef(false);
  const queuePositionMapRef = useRef<Map<string, number>>(new Map());
  const showLineNumbersRef = useRef(showLineNumbers);

  cellsRef.current = cells;
  activeCellIdRef.current = activeCellId;
  cellClipboardRef.current = cellClipboard;
  cellQueueRef.current = cellQueue;
  getFullHistoryRef.current = getFullHistory;
  // Note: Other ref updates for renderCell stability are done after their state is defined

  // Flush active cell's pending content changes before keyframe operations
  const flushActiveCell = useCallback(() => {
    const activeId = activeCellIdRef.current;
    if (!activeId) return;
    const cell = cellsRef.current.find(c => c.id === activeId);
    if (cell) {
      flushCell(activeId, cell.content);
    }
  }, [flushCell]);

  // Visual feedback for undo/redo
  const [highlightedCellIds, setHighlightedCellIds] = useState<Set<string>>(new Set());
  const highlightTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  // Update refs for renderCell stability (state must be defined before these)
  highlightedCellIdsRef.current = highlightedCellIds;
  searchQueryRef.current = searchQuery;
  indentConfigRef.current = indentConfig;
  isSearchOpenRef.current = isSearchOpen;
  showLineNumbersRef.current = showLineNumbers;

  // Track visible cell range for smart scrolling
  const [visibleRange, setVisibleRange] = useState<{ startIndex: number; endIndex: number }>({ startIndex: 0, endIndex: 10 });
  
  // Memoize range change handler to prevent Virtuoso from resetting scroll
  const handleRangeChange = useCallback((range: { startIndex: number; endIndex: number }) => {
    setVisibleRange(range);
  }, []);

  // Virtuoso Handle for programmatic scrolling
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Pending scroll after cell changes (for undo/redo of insert/delete)
  const pendingScrollCellIdRef = useRef<string | null>(null);

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIFIED SCROLL UTILITY
  // All scroll operations should use this to work properly with Virtuoso
  // ═══════════════════════════════════════════════════════════════════════════
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingScrollRef = useRef<{ index: number; attempts: number; id: number } | null>(null);
  const scrollIdRef = useRef(0); // Unique ID to prevent double-scrolling in Strict Mode

  // Unified scroll function - ALL scroll operations should use this
  const scrollToCell = useCallback((
    index: number, 
    options?: { 
      behavior?: 'smooth' | 'auto';
      delay?: number;      // Delay before scrolling (for debouncing)
      retryOnce?: boolean; // Retry after heights settle (for dynamic content)
    }
  ) => {
    const { behavior = 'smooth', delay = 0, retryOnce = false } = options || {};
    
    // Cancel any pending scroll
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // Generate unique ID for this scroll request (prevents double-scroll in Strict Mode)
    const scrollId = ++scrollIdRef.current;
    pendingScrollRef.current = { index, attempts: 0, id: scrollId };

    const performScroll = () => {
      // Abort if a newer scroll was requested or this scroll was cancelled
      if (!pendingScrollRef.current || 
          pendingScrollRef.current.index !== index ||
          pendingScrollRef.current.id !== scrollId) {
        return;
      }

      virtuosoRef.current?.scrollToIndex({
        index,
        align: 'start',
        behavior,
        offset: -80 // Account for header
      });

      // Optionally retry after heights settle (for dynamic content)
      if (retryOnce && pendingScrollRef.current.attempts === 0) {
        pendingScrollRef.current.attempts = 1;
        scrollTimeoutRef.current = setTimeout(() => {
          if (pendingScrollRef.current?.index === index && 
              pendingScrollRef.current?.id === scrollId) {
            virtuosoRef.current?.scrollToIndex({
              index,
              align: 'start',
              behavior: 'auto', // Instant adjustment
              offset: -80
            });
            pendingScrollRef.current = null;
          }
        }, 150);
      } else {
        pendingScrollRef.current = null;
      }
    };

    if (delay > 0) {
      scrollTimeoutRef.current = setTimeout(performScroll, delay);
    } else {
      performScroll();
    }
  }, []);

  // Cleanup scroll timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Enable performance debugger once on mount
  useEffect(() => {
    perfDebugger.enable();
    console.log('[PerfDebug] Use Ctrl+Shift+P to toggle profiling, or window.__nebulaPerf in console');
  }, []);

  // Register performance debugger callbacks once (uses refs defined above)
  useEffect(() => {
    perfDebugger.registerCallbacks({
      getHistorySize: () => getFullHistoryRef.current().length,
      getCellCount: () => cellsRef.current.length,
      getTotalOutputSize: () => {
        let total = 0;
        for (const cell of cellsRef.current) {
          for (const output of cell.outputs) {
            total += output.content.length;
          }
        }
        return total;
      },
    });
  }, []);

  // Helper to check if ANY part of a cell is currently visible
  // If any part of the cell (code or output) can be seen, it's considered visible
  const isCellVisible = useCallback((cellIndex: number): boolean => {
    // Virtuoso's rangeChanged gives us the indices of cells that are rendered/visible
    // A cell is visible if its index falls within the visible range (inclusive)
    // No buffer needed - if ANY part of the cell is visible, we don't scroll
    return cellIndex >= visibleRange.startIndex && cellIndex <= visibleRange.endIndex;
  }, [visibleRange]);

  // Effect to handle pending scroll after cells change (for undo/redo of insert/delete)
  // Clear the ref BEFORE scrolling to prevent double-scroll in Strict Mode
  useEffect(() => {
    const cellId = pendingScrollCellIdRef.current;
    if (cellId) {
      // Clear immediately to prevent double-invocation in Strict Mode
      pendingScrollCellIdRef.current = null;
      const index = cells.findIndex(c => c.id === cellId);
      if (index >= 0) {
        scrollToCell(index);
      }
    }
  }, [cells, scrollToCell]);

  // Helper to show visual feedback for undo/redo (highlight only, no scrolling)
  const showUndoRedoFeedback = useCallback((affectedCellIds: string[]) => {
    // Clear any pending highlight timeout
    if (highlightTimeoutRef.current) {
      clearTimeout(highlightTimeoutRef.current);
    }

    // Set highlighted cells
    setHighlightedCellIds(new Set(affectedCellIds));

    // Clear highlights after animation
    highlightTimeoutRef.current = setTimeout(() => {
      setHighlightedCellIds(new Set());
    }, 1500); // Match CSS animation duration
  }, []);

  // Helper to apply undo/redo with scroll and feedback
  // - If operation DELETES a cell: scroll first (so user sees the cell), then operate
  // - Otherwise: operate first, then scroll (only if cell not visible) and highlight
  const applyWithScrollFeedback = useCallback((
    peekFn: () => { affectedCellIds: string[]; operationType: string } | null,
    applyFn: () => { affectedCellIds: string[] } | null,
    willDeleteCell: boolean
  ) => {
    flushActiveCell();

    const peek = peekFn();
    if (!peek || peek.affectedCellIds.length === 0) {
      applyFn();
      return;
    }

    const firstCellId = peek.affectedCellIds[0];
    const cellIndex = cells.findIndex(c => c.id === firstCellId);
    const cellExists = cellIndex >= 0;
    // Only scroll if no part of the cell is currently visible
    const needsScroll = cellExists && !isCellVisible(cellIndex);

    if (willDeleteCell && needsScroll) {
      // Scroll to cell first so user sees it before deletion
      scrollToCell(cellIndex);
      setTimeout(() => {
        const result = applyFn();
        if (result?.affectedCellIds.length) showUndoRedoFeedback(result.affectedCellIds);
      }, 300);
    } else {
      // Apply first, then scroll (only if not visible) and highlight
      const result = applyFn();
      if (result?.affectedCellIds.length) {
        showUndoRedoFeedback(result.affectedCellIds);
        // Only schedule scroll if cell is not visible (or is a new cell that needs finding)
        // For operations on existing visible cells (like metadata changes), don't scroll
        if (!cellExists || !isCellVisible(cellIndex)) {
          pendingScrollCellIdRef.current = result.affectedCellIds[0];
        }
      }
    }
  }, [flushActiveCell, cells, isCellVisible, showUndoRedoFeedback, scrollToCell]);

  // Undo: deleteCell restores a cell, insertCell removes it
  const undo = useCallback(() => {
    const peek = peekUndo();
    const willDelete = peek?.operationType === 'insertCell'; // Undo insert = delete
    applyWithScrollFeedback(peekUndo, rawUndo, willDelete);
  }, [peekUndo, rawUndo, applyWithScrollFeedback]);

  // Redo: insertCell adds a cell, deleteCell removes it
  const redo = useCallback(() => {
    const peek = peekRedo();
    const willDelete = peek?.operationType === 'deleteCell'; // Redo delete = delete
    applyWithScrollFeedback(peekRedo, rawRedo, willDelete);
  }, [peekRedo, rawRedo, applyWithScrollFeedback]);

  // Ref for saveNow to avoid stale closures in keyboard handler
  const saveNowRef = useRef<() => Promise<void>>(() => Promise.resolve());
  // Ref for handleManualSave to avoid stale closures in keyboard handler
  const handleManualSaveRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Autosave hook with conflict detection
  const performSaveToFile = useCallback(async (fileId: string, cellsToSave: Cell[]) => {
    try {
      // Get history to save alongside notebook
      // IMPORTANT: Skip history if not ready to prevent overwriting persisted history
      // History is ready after loadHistory() or initializeNewHistory() completes
      const history = historyReady ? getFullHistory() : undefined;

      // Use ref for mtime to avoid stale closures causing false conflicts
      const result = await saveWithCheck(
        fileId,
        cellsToSave,
        lastKnownMtimeRef.current,
        currentKernel,
        history
      );

      if (result.needsResolution) {
        // Conflict detected - dialog is shown, wait for user action
        // The hook will handle mtime updates when resolved
        return;
      }

      if (result.success) {
        // Note: setLastKnownMtime is called by saveWithCheck in the hook,
        // which now updates both state AND ref synchronously
        setPendingSave(false);
        await updateNotebookMetadata(fileId, {});

        // Save session state (unflushed edits and active cell) alongside notebook
        const unflushedState = getUnflushedState(activeCellIdRef.current, cellsToSave);
        await saveNotebookSession(fileId, {
          unflushedEdit: unflushedState ?? undefined,
          activeCellId: activeCellIdRef.current ?? undefined,
        });
      } else if (result.error) {
        throw new Error(result.error);
      }
    } catch (error) {
      // Network error - mark as pending and will retry when online
      console.warn('Save failed, will retry:', error);
      setPendingSave(true);
      throw error; // Re-throw so autosave knows it failed
    }
  }, [historyReady, getFullHistory, currentKernel, saveWithCheck, getUnflushedState]);

  const { status: autosaveStatus, saveNow } = useAutosave({
    fileId: currentFileId,
    cells,
    onSave: performSaveToFile,
    enabled: true,
    hasRedoHistory: canRedo, // Block autosave when redo history exists
  });

  // Keep saveNow ref updated synchronously (not in useEffect which runs after render)
  saveNowRef.current = saveNow;

  // Online/offline detection and retry pending saves
  useEffect(() => {
    const handleOnline = () => {
      setIsOnline(true);
      // Retry pending save when coming back online
      if (pendingSave && currentFileId) {
        saveNow().catch(() => {
          // Save retry failed, will try again next time
        });
      }
    };

    const handleOffline = () => {
      setIsOnline(false);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [pendingSave, currentFileId, saveNow]);

  // Handle kernel WebSocket reconnection
  useEffect(() => {
    const unsubscribeReconnect = kernelService.onReconnect(async (sessionId, filePath) => {
      // Only handle reconnection for current file's kernel
      if (!currentFileId || filePath !== currentFileId) return;

      if (kernelSessionId !== sessionId) {
        console.log(`Kernel session updated for ${filePath}: ${kernelSessionId} -> ${sessionId}`);
        setKernelSessionId(sessionId);
      }

      console.log('Kernel reconnected, checking for file changes...');
      setKernelStatus('idle');
      setIsKernelReady(true);

      // Trigger save which will check for conflicts via saveWithCheck
      // If there's a conflict, the hook will show the dialog automatically
      try {
        await saveNow();
      } catch (error) {
        console.error('Error saving after reconnect:', error);
      }
    });

    const unsubscribeDisconnect = kernelService.onDisconnect((sessionId) => {
      if (kernelSessionId === sessionId) {
        console.log('Kernel disconnected, will attempt reconnection...');
        setKernelStatus('disconnected');
        setIsKernelReady(false);
      }
    });

    // Subscribe to status updates from server
    const unsubscribeStatus = kernelService.onStatus((sessionId, status) => {
      if (kernelSessionId === sessionId) {
        console.log(`Kernel status update: ${status}`);
        if (status === 'idle' || status === 'busy') {
          setKernelStatus(status);
          setIsKernelReady(true);
        } else if (status === 'starting') {
          setKernelStatus('starting');
        }
      }
    });

    return () => {
      unsubscribeReconnect();
      unsubscribeDisconnect();
      unsubscribeStatus();
    };
  }, [currentFileId, kernelSessionId, saveNow]);

  // Execution State
  const [isKernelReady, setIsKernelReady] = useState(false);
  const [executionQueue, setExecutionQueue] = useState<string[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [kernelExecutionCount, setKernelExecutionCount] = useState(0); // Global execution counter
  const executionStartTimeRef = useRef<number | null>(null); // Track when queue execution started

  // Execution indicator state - persists after completion until dismissed
  const [executionElapsedMs, setExecutionElapsedMs] = useState(0);
  const [lastExecutionResult, setLastExecutionResult] = useState<{
    cellId: string;
    cellIndex: number;
    status: 'completed' | 'error';
    elapsedMs: number;
  } | null>(null);
  const lastCompletedCellRef = useRef<{ cellId: string; cellIndex: number } | null>(null);
  const cellExecutionStartRef = useRef<number | null>(null); // Track when current cell started

  // Close execution queue dropdown when queue becomes empty
  useEffect(() => {
    if (executionQueue.length === 0) {
      setIsExecutionQueueOpen(false);
    }
  }, [executionQueue.length]);

  // Memoize execution indicator state to avoid O(N) findIndex on every render
  const executionIndicator = useMemo(() => {
    if (executionQueue.length === 0) return null;
    const executingCellId = executionQueue[0];
    const executingCellIndex = cells.findIndex(c => c.id === executingCellId);
    return { cellId: executingCellId, cellIndex: executingCellIndex, queueLength: executionQueue.length };
  }, [executionQueue, cells]);

  // Memoize queue position lookup to avoid O(N) indexOf for each cell during render
  const queuePositionMap = useMemo(() => {
    const map = new Map<string, number>();
    executionQueue.forEach((id, idx) => map.set(id, idx));
    return map;
  }, [executionQueue]);
  executionQueueRef.current = executionQueue;
  queuePositionMapRef.current = queuePositionMap;

  // Cleanup runIds for cells removed from the queue
  useEffect(() => {
    const currentIds = new Set(executionQueue);
    for (const id of executionRunIdsRef.current.keys()) {
      if (!currentIds.has(id)) {
        executionRunIdsRef.current.delete(id);
      }
    }
  }, [executionQueue]);

  // Timer to update elapsed time while execution is in progress
  useEffect(() => {
    if (!isProcessingQueue || !cellExecutionStartRef.current) {
      return;
    }

    const interval = setInterval(() => {
      if (cellExecutionStartRef.current) {
        setExecutionElapsedMs(Date.now() - cellExecutionStartRef.current);
      }
    }, 100); // Update every 100ms for smooth display

    return () => clearInterval(interval);
  }, [isProcessingQueue]);

  // Clear last result when new execution starts
  useEffect(() => {
    if (executionQueue.length > 0 && !isProcessingQueue) {
      setLastExecutionResult(null);
    }
  }, [executionQueue.length, isProcessingQueue]);

  // Dismiss execution result indicator
  const dismissExecutionResult = useCallback(() => {
    setLastExecutionResult(null);
  }, []);

  // Kernel memory usage tracking (only when tab is visible)
  useEffect(() => {
    if (!kernelSessionId) {
      setMemoryUsage(null);
      return;
    }

    let notFoundCount = 0;
    const updateMemory = async () => {
      // Skip polling when tab is hidden to reduce load
      if (document.hidden) return;

      try {
        const response = await fetch(`/api/kernels/${kernelSessionId}/status`);
        if (response.ok) {
          notFoundCount = 0; // Reset on success
          const status = await response.json();
          if (status.memory_mb != null) {
            setMemoryUsage({
              used: status.memory_mb * 1024 * 1024, // Convert back to bytes for consistent display
              total: 0 // Not applicable for kernel memory
            });
          }
        } else if (response.status === 404) {
          notFoundCount++;
          // After 2 consecutive 404s, clear stale session (server probably restarted)
          if (notFoundCount >= 2) {
            console.log('[Notebook] Kernel session not found on server, clearing stale session');
            toast('Kernel session was lost on the server. Reconnect to start a new kernel.', 'warning', 4000);
            setKernelSessionId(null);
            setKernelStatus('disconnected');
            setIsKernelReady(false);
            setMemoryUsage(null);
          }
        }
      } catch {
        // Ignore fetch errors (network issues)
      }
    };
    updateMemory();
    const interval = setInterval(updateMemory, 10000); // Update every 10 seconds (reduced from 5)
    return () => clearInterval(interval);
  }, [kernelSessionId]);

  // Fetch available kernels and initialize
  // Load Python environments (separate from kernel init for faster startup)
  const loadPythonEnvironments = useCallback(async (refresh: boolean = false, serverId?: string | null, autoSelectKernel = true) => {
    try {
      setIsDiscoveringPythons(true);
      const targetServerId = serverId ?? selectedServerId;
      const data = await kernelService.getPythonEnvironments(refresh, targetServerId);
      setAvailableKernels(data.kernelspecs);
      setPythonEnvironments(data.environments);
      // Only auto-select first kernel if requested (skip during server switch)
      if (autoSelectKernel && data.kernelspecs.length > 0 && !data.kernelspecs.some(k => k.name === currentKernel)) {
        setCurrentKernel(data.kernelspecs[0].name);
      }
    } catch (error) {
      console.error('Failed to load Python environments:', error);
    } finally {
      setIsDiscoveringPythons(false);
    }
  }, [selectedServerId, currentKernel]);

  useEffect(() => {
    const initKernels = async () => {
      try {
        // Load cluster info for multi-server support
        let initialServerId: string | null = null;
        try {
          const cluster = await getClusterInfo();
          setClusterInfo(cluster);
          initialServerId = cluster.localServerId;
          // Default to local server
          setSelectedServerId(cluster.localServerId);
        } catch (clusterError) {
          console.error('Failed to load cluster info:', clusterError);
          // Cluster feature is optional, continue without it
        }

        // Just load available kernels on startup, don't start one yet
        // Kernel will be started when a file is loaded
        const kernels = await kernelService.getAvailableKernels(initialServerId);
        setAvailableKernels(kernels);

        // Get saved kernel preference
        const settings = getSettings();
        const preferredKernel = settings.lastKernel || 'python3';
        const kernelExists = kernels.some(k => k.name === preferredKernel);
        setCurrentKernel(kernelExists ? preferredKernel : (kernels[0]?.name || 'python3'));

        // Load Python environments in background (uses cache)
        loadPythonEnvironments(false, initialServerId);
      } catch (error) {
        console.error('Failed to load kernels:', error);
      }
    };

    initKernels();

    // Note: We don't stop the kernel on unmount anymore
    // Kernels are tied to notebook files, not browser tabs
    // The kernel stays running on the server until explicitly stopped
  }, []);

  // Load the initial file (currentFileId is already set synchronously from URL/localStorage)
  useEffect(() => {
    if (currentFileId) {
      loadFile(currentFileId);
    } else {
      setIsLoadingFile(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount

  // Update browser tab title, URL, and favicon when file changes
  useEffect(() => {
    if (currentFileId) {
      // Update tab title from file path
      const filename = getFilenameFromPath(currentFileId);
      document.title = `${filename} - Nebula Notebook`;

      // Update URL - don't encode slashes for readability
      const baseUrl = window.location.pathname;
      window.history.replaceState({}, '', `${baseUrl}?file=${currentFileId}`);

      // Update favicon with notebook-specific avatar
      const avatarUrl = getNotebookAvatar(currentFileId);
      updateFavicon(avatarUrl);
    } else {
      document.title = 'Nebula Notebook';
      window.history.replaceState({}, '', window.location.pathname);
      resetFavicon();
    }
  }, [currentFileId]);

  // Refs for functions used in keyboard handler (defined later in component)
  const lastKeyRef = useRef<{ key: string; time: number } | null>(null);
  const deleteCellRef = useRef<((id: string) => void) | null>(null);
  const addCellRef = useRef<((type: CellType, content?: string, afterIndex?: number) => void) | null>(null);
  const changeCellTypeRef = useRef<((id: string, type: CellType) => void) | null>(null);
  const runAndAdvanceRef = useRef<((id: string, focusMode: 'cell' | 'editor') => void) | null>(null);
  const queueExecutionRef = useRef<((id: string) => void) | null>(null);
  const kernelStatusRef = useRef<string>(kernelStatus);
  const interruptKernelRef = useRef<(() => void) | null>(null);
  // Track pending focus for next cell - Cell component handles the actual focusing
  const [pendingFocus, setPendingFocus] = useState<{ cellId: string; mode: 'cell' | 'editor' } | null>(null);
  const clearPendingFocus = useCallback(() => setPendingFocus(null), []);
  pendingFocusRef.current = pendingFocus;

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

      // Ctrl+S: Save (works everywhere) - uses handleManualSave for redo confirmation
      if ((e.metaKey || e.ctrlKey) && key === 's') {
        e.preventDefault();
        handleManualSaveRef.current().catch(err => {
          console.error('Save failed:', err);
        });
        return;
      }

      // Ctrl+C: Interrupt kernel when busy (global override)
      // When kernel is idle, Ctrl+C works as normal copy
      if ((e.metaKey || e.ctrlKey) && key === 'c' && kernelStatusRef.current === 'busy') {
        e.preventDefault();
        interruptKernelRef.current?.();
        return;
      }

      // Ctrl+F: Search (works everywhere)
      if ((e.metaKey || e.ctrlKey) && key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      // Ctrl+`: Toggle terminal (works everywhere)
      if ((e.metaKey || e.ctrlKey) && key === '`') {
        e.preventDefault();
        setIsTerminalOpen(prev => !prev);
        return;
      }

      // DUAL UNDO/REDO ARCHITECTURE (intentional design):
      //
      // 1. Keyboard Ctrl/Cmd+Z → CodeMirror's per-cell text history
      //    - Fine-grained character-level undo for text edits
      //    - Each cell has its own independent undo stack
      //    - Optimal for fixing typos and local text changes
      //
      // 2. Toolbar Undo/Redo → Notebook-level structural history (useUndoRedo hook)
      //    - Coarse-grained operations: add/delete/move cells, type changes
      //    - Content updates are batched at keyframe boundaries
      //    - Preserves full notebook trajectory for session replay
      //
      // This separation is intentional - users get both fine-grained text
      // editing and structural notebook operations at appropriate granularities.
      // Keyboard shortcuts go to CodeMirror; toolbar buttons access notebook history.

      // Determine focus context:
      // - Edit mode: CodeMirror editor is focused (let CM handle shortcuts)
      // - Cell mode: Cell div is focused (Notebook handles Jupyter-style shortcuts)
      const isInEditor = target.closest?.('.cm-editor') !== null;
      const focusedCellId = target.getAttribute?.('data-cell-id') ?? null;

      // Skip if typing in input fields or editing in CodeMirror
      if (isInput || isInEditor) return;

      // Jupyter-style shortcuts (cell mode only - when cell div itself is focused)
      if (!focusedCellId) return;

      // Skip single-letter shortcuts when Cmd/Ctrl is pressed
      // This allows Cmd+C to work as native copy instead of cell copy
      // Note: Shift is allowed for Shift+V (paste above)
      if (e.metaKey || e.ctrlKey) return;

      const currentCells = cellsRef.current;
      const currentIndex = currentCells.findIndex(c => c.id === focusedCellId);

      // A - Insert cell above
      if (key === 'a' && addCellRef.current) {
        e.preventDefault();
        // Insert above = insert after (currentIndex - 1), so new cell appears at currentIndex
        const afterIdx = currentIndex === -1 ? undefined : currentIndex - 1;
        addCellRef.current('code', '', afterIdx);
        return;
      }

      // B - Insert cell below
      if (key === 'b' && addCellRef.current) {
        e.preventDefault();
        // Insert below = insert after currentIndex
        const afterIdx = currentIndex !== -1 ? currentIndex : currentCells.length - 1;
        addCellRef.current('code', '', afterIdx);
        return;
      }

      // M - Convert cell to Markdown
      if (key === 'm' && changeCellTypeRef.current) {
        e.preventDefault();
        changeCellTypeRef.current(focusedCellId, 'markdown');
        return;
      }

      // Y - Convert cell to Code
      if (key === 'y' && changeCellTypeRef.current) {
        e.preventDefault();
        changeCellTypeRef.current(focusedCellId, 'code');
        return;
      }

      // X - Cut cell (copy to clipboard + delete)
      if (key === 'x' && deleteCellRef.current) {
        e.preventDefault();
        const cellToCut = currentCells.find(c => c.id === focusedCellId);
        if (cellToCut) {
          // Copy to clipboard first, then delete (last cell will be cleared, not deleted)
          const clipboardItem: CellClipboardItem = {
            type: cellToCut.type,
            content: cellToCut.content,
            sourceId: cellToCut.id,
            isCut: true
          };
          cellClipboardRef.current = clipboardItem;
          setCellClipboard(clipboardItem);
          deleteCellRef.current(focusedCellId);
        }
        return;
      }

      // C - Copy cell
      if (key === 'c') {
        e.preventDefault();
        const cellToCopy = currentCells.find(c => c.id === focusedCellId);
        if (cellToCopy) {
          const clipboardItem: CellClipboardItem = {
            type: cellToCopy.type,
            content: cellToCopy.content,
            sourceId: cellToCopy.id,
            isCut: false
          };
          cellClipboardRef.current = clipboardItem;
          setCellClipboard(clipboardItem);
        }
        return;
      }

      // V - Paste cell below, Shift+V - Paste cell above
      const clipboard = cellClipboardRef.current;
      if (key === 'v' && clipboard && addCellRef.current) {
        e.preventDefault();
        const pasteAbove = e.shiftKey;
        // Use activeCellId to find current position, fallback to start/end
        const currentIdx = currentCells.findIndex(c => c.id === focusedCellId);
        const baseIdx = currentIdx >= 0 ? currentIdx : (pasteAbove ? -1 : currentCells.length - 1);
        // For paste below: afterIndex = currentIdx (inserts at currentIdx + 1)
        // For paste above: afterIndex = currentIdx - 1 (inserts at currentIdx)
        const afterIdx = pasteAbove ? baseIdx - 1 : baseIdx;
        addCellRef.current(clipboard.type, clipboard.content, afterIdx);
        return;
      }

      // E - Enqueue cell (cut to FIFO queue), then focus next cell
      if (key === 'e' && deleteCellRef.current) {
        e.preventDefault();
        const currentIdx = currentCells.findIndex(c => c.id === focusedCellId);
        const cellToQueue = currentIdx >= 0 ? currentCells[currentIdx] : null;
        if (cellToQueue) {
          const queueItem: CellClipboardItem = {
            type: cellToQueue.type,
            content: cellToQueue.content,
            sourceId: cellToQueue.id,
            isCut: true
          };
          setCellQueue(prev => [...prev, queueItem]);
          cellQueueRef.current = [...cellQueueRef.current, queueItem];

          // Determine next cell to focus (prefer next, fallback to same cell if last one)
          const nextIdx = currentIdx < currentCells.length - 1 ? currentIdx + 1 : currentIdx - 1;
          const nextCellId = nextIdx >= 0 ? currentCells[nextIdx]?.id : focusedCellId;

          // Delete the cell (last cell will be cleared, not deleted)
          deleteCellRef.current(focusedCellId);

          // Explicitly focus the next cell in cell mode
          if (nextCellId) {
            setActiveCellId(nextCellId);
            setPendingFocus({ cellId: nextCellId, mode: 'cell' });
          }
        }
        return;
      }

      // D - Dequeue cell (paste oldest from FIFO queue below current cell)
      if (key === 'd' && addCellRef.current) {
        e.preventDefault();
        const queue = cellQueueRef.current;
        if (queue.length > 0) {
          const [first, ...rest] = queue;
          setCellQueue(rest);
          cellQueueRef.current = rest;
          // Insert below current cell
          const currentIdx = currentCells.findIndex(c => c.id === focusedCellId);
          const afterIdx = currentIdx >= 0 ? currentIdx : currentCells.length - 1;
          addCellRef.current(first.type, first.content, afterIdx);
        }
        return;
      }

      // Enter - Focus active cell editor (enter edit mode)
      if (key === 'Enter') {
        e.preventDefault();
        // Find and focus the CodeMirror editor for the active cell
        const cellElement = document.querySelector(`[data-cell-id="${focusedCellId}"] .cm-content`);
        if (cellElement instanceof HTMLElement) {
          cellElement.focus({ preventScroll: true });
        }
        return;
      }
    };

    // Use capture phase to intercept shortcuts before they're handled by child components
    // This is especially important for Cmd+S which browsers might try to handle natively
    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', handleKeyDown, { capture: true });
  }, []);

  const refreshFileList = async () => {
    const updatedFiles = await getFiles();
    setFiles(updatedFiles);
    if (currentFileId) {
      const current = updatedFiles.find(f => f.id === currentFileId);
      if (current) setCurrentFileMetadata(current);
    }
  };

  // Called when settings are saved - updates local state from settings
  const handleSettingsChange = useCallback(() => {
    refreshFileList();
    const settings = getSettings();
    setShowLineNumbers(settings.showLineNumbers ?? false);
    setShowCellIds(settings.showCellIds ?? false);
    setShowResourceMonitor(settings.showResourceMonitor ?? false);
  }, []);

  // Get current notebook filename (without extension)
  const currentFilename = currentFileId
    ? getFilenameFromPath(currentFileId).replace(/\.ipynb$/, '')
    : 'Untitled';

  // Start renaming the notebook
  const startRenameNotebook = () => {
    if (!currentFileId) return;
    setRenameValue(currentFilename);
    setIsRenamingNotebook(true);
  };

  // Finish renaming the notebook
  const finishRenameNotebook = async () => {
    if (!currentFileId || !renameValue.trim()) {
      setIsRenamingNotebook(false);
      return;
    }

    const newName = renameValue.trim();
    // If name unchanged, just close the editor
    if (newName === currentFilename) {
      setIsRenamingNotebook(false);
      return;
    }

    // Build new path
    const dir = currentFileId.substring(0, currentFileId.lastIndexOf('/'));
    const newPath = `${dir}/${newName}.ipynb`;

    try {
      await renameFile(currentFileId, newPath);
      setCurrentFileId(newPath);
      saveActiveFileId(newPath);
      setIsRenamingNotebook(false);
    } catch (err: any) {
      toast(err.message || 'Failed to rename notebook', 'error');
    }
  };

  // Handle rename keydown
  const handleRenameKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finishRenameNotebook();
    } else if (e.key === 'Escape') {
      setIsRenamingNotebook(false);
    }
  };

  const loadFileAsync = async (id: string, content: Cell[], notebookKernel?: string) => {
    if (currentFileId && currentFileId !== id) {
      // Keyframe: flush active cell before switching files
      flushActiveCell();
      saveNow(); // Save current file before switching
    }

    // Set indentation based on user preference or autodetect
    const settings = getSettings();
    const userIndent = getIndentConfigFromPreference(settings.indentation || 'auto');
    if (userIndent) {
      setIndentConfig(userIndent);
    } else {
      // Autodetect from file content
      const detectedIndent = detectIndentationFromCells(content);
      setIndentConfig(detectedIndent);
    }

    // IMPORTANT: History loading flow to prevent data loss
    // 1. Set cells WITHOUT creating a new snapshot (preserves existing history)
    // 2. Load history from file
    // 3. If history exists: call loadHistory() to restore undo/redo stack
    // 4. If no history: call initializeNewHistory() to create initial snapshot
    // 5. Mark history as ready so saves can include history
    setHistoryReady(false);
    loadCells(content);

    // Set UI state immediately - don't block on history loading
    setCurrentFileId(id);
    saveActiveFileId(id);

    // Track in recently opened notebooks
    const fileName = id.split('/').pop()?.replace('.ipynb', '') || id;
    addRecentNotebook(id, fileName);
    setActiveCellId(content.length > 0 ? content[0].id : null);
    setIsLoadingFile(false);

    // Load persisted history, session state, agent permission, and notebook settings
    Promise.all([
      loadNotebookHistory(id),
      loadNotebookSession(id),
      getAgentPermissionStatus(id),
      getNotebookSettings(id)
    ])
      .then(([savedHistory, savedSession, permissionStatus, notebookSettings]) => {
        // Initialize history appropriately
        if (savedHistory.length > 0) {
          // Existing history file - restore it (includes snapshot and operations)
          loadHistory(savedHistory);
        } else {
          // No history file - create initial snapshot for this notebook
          initializeNewHistory(content);
        }

        // Set agent permission status
        if (permissionStatus) {
          setAgentPermissionStatus(permissionStatus);
        }
        // Set output logging mode from notebook settings
        if (notebookSettings) {
          setOutputLoggingMode(notebookSettings.output_logging);
        }
        // Restore unflushed edit state so undo can capture pending changes
        // Also navigate to the cell with unflushed edits so flushActiveCell works
        if (savedSession.unflushedEdit) {
          setUnflushedState(savedSession.unflushedEdit);
          const cellId = savedSession.unflushedEdit.cellId;
          const cellIndex = content.findIndex(c => c.id === cellId);
          if (cellIndex >= 0) {
            // Enter edit mode - this triggers focus which calls onActivate to set active cell
            // The blur when leaving this cell will flush the unflushed edits
            setPendingFocus({ cellId, mode: 'editor' });
            scrollToCell(cellIndex, { behavior: 'auto' });
          }
        } else if (savedSession.activeCellId) {
          // No unflushed edits, but restore last focused cell position
          const cellId = savedSession.activeCellId;
          const cellIndex = content.findIndex(c => c.id === cellId);
          if (cellIndex >= 0) {
            setActiveCellId(cellId);
            scrollToCell(cellIndex, { behavior: 'auto' });
          }
        }
      })
      .catch((err) => {
        // History/session load failed - initialize new history to allow editing
        console.warn('Failed to load history/session, initializing new:', err);
        initializeNewHistory(content);
      })
      .finally(() => {
        // History is now ready - saves can include history
        setHistoryReady(true);
      });

    const meta = files.find(f => f.id === id);
    if (meta) setCurrentFileMetadata(meta);
    // Note: No need to scroll to top - Virtuoso resets when key={currentFileId} changes

    // Resolve kernel/server preference (server is the source of truth)
    let preferredKernel = notebookKernel || currentKernel;
    let preferredServerId = selectedServerId;
    try {
      const preference = await kernelService.getKernelPreference(id);
      if (preference?.kernel_name) {
        preferredKernel = preference.kernel_name;
      }
      if (preference?.server_id) {
        preferredServerId = preference.server_id;
      }
    } catch (error) {
      console.warn('Failed to load kernel preference:', error);
    }

    let kernelsForCheck = availableKernels;
    if (preferredServerId && preferredServerId !== selectedServerId) {
      setSelectedServerId(preferredServerId);
      try {
        kernelsForCheck = await kernelService.getAvailableKernels(preferredServerId);
        setAvailableKernels(kernelsForCheck);
        // Refresh environments in background for the selected server
        loadPythonEnvironments(false, preferredServerId, false);
      } catch (error) {
        console.error('Failed to load kernels for preferred server:', error);
      }
    }

    // Use preferred kernel and verify it exists
    let kernelToUse = preferredKernel;
    const kernelExists = kernelsForCheck.some(k => k.name === kernelToUse);
    if (!kernelExists && kernelsForCheck.length > 0) {
      // Fall back to first available kernel if the specified one doesn't exist
      kernelToUse = kernelsForCheck[0].name;
    }

    // Update current kernel state to reflect what we're actually using
    if (kernelToUse !== currentKernel) {
      setCurrentKernel(kernelToUse);
    }

    // Get or create kernel for this file (one notebook = one kernel)
    try {
      setKernelStatus('starting');
      const { sessionId, created, createdAt, serverId: resolvedServerId } = await kernelService.getOrCreateKernelForFile(
        id,
        kernelToUse,
        preferredServerId
      );
      setKernelSessionId(sessionId);
      if (createdAt) setKernelCreatedAt(createdAt);
      if (resolvedServerId && resolvedServerId !== selectedServerId) {
        setSelectedServerId(resolvedServerId);
      }
      if (created) {
        logKernelEvent('startKernel', {
          sessionId,
          kernelName: kernelToUse,
          serverId: resolvedServerId,
          reason: 'auto',
        }, 'system');
      }
      setIsKernelReady(true);
      // Note: Don't set status to 'idle' here - the WebSocket will send the actual status
      // which could be 'busy' if a cell was executing when the page was refreshed

      // Query the kernel's execution count so cell counters continue from where they left off
      // Also get the actual status (could be 'busy' if execution was in progress during refresh)
      const status = await kernelService.getStatus(sessionId);
      if (status) {
        if (status.execution_count != null) {
          setKernelExecutionCount(status.execution_count);
        }
        // Set status from query (WebSocket may also update this, which is fine)
        if (status.status === 'idle' || status.status === 'busy') {
          setKernelStatus(status.status);
        }
      } else {
        // Fallback if status query fails
        setKernelStatus('idle');
      }
    } catch (error) {
      console.error('Failed to get/create kernel for file:', error);
      setKernelStatus('disconnected');
    }
  };

  const loadFile = async (id: string) => {
    setIsLoadingFile(true);
    try {
      const result = await getFileContentWithMtime(id);
      if (result) {
        setLastKnownMtime(result.mtime);
        setPendingSave(false);
        loadFileAsync(id, result.cells, result.kernelspec);
      } else {
        // File doesn't exist or is empty
        setIsLoadingFile(false);
        setCurrentFileId(null);
        setLastKnownMtime(null);
        saveActiveFileId('');
      }
    } catch (error) {
      console.error('Failed to load file:', error);
      setIsLoadingFile(false);
      setCurrentFileId(null);
      setLastKnownMtime(null);
      saveActiveFileId('');
    }
  };

  const saveCurrentNotebook = useCallback(async () => {
    // Keyframe: flush active cell before save
    flushActiveCell();
    await saveNow();
    await refreshFileList();
  }, [flushActiveCell, saveNow]);

  // Manual save with confirmation when redo history exists
  // This function is called by both the Save button and Ctrl+S keyboard shortcut
  const handleManualSave = useCallback(async () => {
    if (canRedo) {
      const confirmed = await confirm({
        title: 'Save will clear redo history',
        message: 'You have undone changes. Saving now will permanently remove your ability to redo those changes.',
        confirmLabel: 'Save Anyway',
        variant: 'warning',
      });
      if (!confirmed) return;
    }

    // Keyframe: flush active cell and commit history before save
    flushActiveCell();
    commitHistoryBeforeKeyframe();
    await saveNow();
    await refreshFileList();
  }, [canRedo, confirm, flushActiveCell, commitHistoryBeforeKeyframe, saveNow]);

  // Update ref synchronously (useLayoutEffect runs before browser paint and event handlers)
  useLayoutEffect(() => {
    handleManualSaveRef.current = handleManualSave;
  }, [handleManualSave]);

  // --- RESTORE OPERATIONS ---

  // Generate a suggested filename for restored notebook
  const generateRestoredFilename = useCallback((originalPath: string, timestamp: number): string => {
    const date = new Date(timestamp);
    const dateStr = date.toISOString().slice(0, 10); // YYYY-MM-DD
    const timeStr = date.toTimeString().slice(0, 5).replace(':', ''); // HHMM

    // Extract directory and filename from path
    const lastSlash = originalPath.lastIndexOf('/');
    const dir = lastSlash >= 0 ? originalPath.slice(0, lastSlash) : '';
    const filename = lastSlash >= 0 ? originalPath.slice(lastSlash + 1) : originalPath;
    const baseName = filename.replace(/\.ipynb$/, '');

    return `${dir}/${baseName}_restored_${dateStr}_${timeStr}.ipynb`;
  }, []);

  // Handle "Restore Here" - generates new operations to transform current to target state
  const handleRestoreHere = useCallback(async () => {
    if (!restoreDialogTimestamp || !previewCells) return;

    // Flush any pending edits first
    flushActiveCell();
    commitHistoryBeforeKeyframe();

    // Build maps for efficient lookup
    const currentMap = new Map(cells.map((c, i) => [c.id, { cell: c, index: i }]));
    const previewMap = new Map(previewCells.map((c, i) => [c.id, { cell: c, index: i }]));

    // Compute operations needed to transform current → preview
    // Strategy: Use batch of operations to do this atomically

    // 1. Delete cells that don't exist in preview (in reverse order to preserve indices)
    const cellsToDelete: { id: string; index: number }[] = [];
    for (const [id, { index }] of currentMap) {
      if (!previewMap.has(id)) {
        cellsToDelete.push({ id, index });
      }
    }
    // Sort by index descending so we delete from end first
    cellsToDelete.sort((a, b) => b.index - a.index);
    for (const { index } of cellsToDelete) {
      undoableDeleteCell(index);
    }

    // 2. Update content for cells that exist in both but have different content
    // Need to re-compute current indices after deletions
    const remainingCells = cells.filter(c => previewMap.has(c.id));
    for (const currentCell of remainingCells) {
      const previewData = previewMap.get(currentCell.id);
      if (previewData && (currentCell.content !== previewData.cell.content || currentCell.type !== previewData.cell.type)) {
        // Update content
        updateContent(currentCell.id, previewData.cell.content);
        // Update type if different
        if (currentCell.type !== previewData.cell.type) {
          changeType(currentCell.id, previewData.cell.type);
        }
      }
    }

    // 3. Insert cells that exist in preview but not in current
    // We need to insert them at the correct positions according to preview order
    const currentCellIds = new Set(cells.map(c => c.id));
    const cellsToInsert: { cell: Cell; targetIndex: number }[] = [];
    previewCells.forEach((previewCell, targetIndex) => {
      if (!currentCellIds.has(previewCell.id)) {
        cellsToInsert.push({
          cell: {
            ...previewCell,
            outputs: [], // Don't restore outputs
            isExecuting: false,
          },
          targetIndex
        });
      }
    });

    // Insert in order (adjusting indices as we go)
    let insertionOffset = 0;
    for (const { cell, targetIndex } of cellsToInsert) {
      undoableInsertCell(targetIndex + insertionOffset, cell);
      insertionOffset++;
    }

    // Clear preview mode and close dialog
    setPreviewTimestamp(null);
    setRestoreDialogTimestamp(null);

    toast('Notebook restored to previous state', 'success', 2000);
  }, [restoreDialogTimestamp, previewCells, cells, flushActiveCell, commitHistoryBeforeKeyframe, undoableDeleteCell, updateContent, changeType, undoableInsertCell, toast]);

  // Handle "Save as New File" - creates new file with truncated history
  const handleSaveAsNew = useCallback(async () => {
    if (!restoreDialogTimestamp || !previewCells || !currentFileId) return;

    try {
      // Generate new filename
      const newPath = generateRestoredFilename(currentFileId, restoreDialogTimestamp);

      // Get truncated history (all entries up to and including target timestamp)
      const fullHistory = getFullHistory();
      const truncatedHistory = fullHistory.filter(entry => entry.timestamp <= restoreDialogTimestamp);

      // Find cells that were executed after restore point - their outputs are stale
      const cellsExecutedAfter = new Set<string>();
      for (const entry of fullHistory) {
        if (entry.timestamp <= restoreDialogTimestamp) continue;
        const isRunCell = entry.type === 'runCell' ||
          (entry.type === 'event' && (entry as any).name === 'runCell');
        if (!isRunCell) continue;
        const cellId = entry.type === 'event' ? (entry as any).target?.cellId : (entry as any).cellId;
        if (cellId) cellsExecutedAfter.add(cellId);
      }

      // Preserve outputs for cells that weren't re-executed after restore point
      const cellsToSave = previewCells.map(cell => {
        const currentCell = currentCellMap.get(cell.id);

        // If cell exists in current state and wasn't re-run, preserve its outputs
        if (currentCell && !cellsExecutedAfter.has(cell.id)) {
          return { ...cell, outputs: currentCell.outputs, isExecuting: false };
        }

        // Otherwise clear outputs (cell was re-run or doesn't exist)
        return { ...cell, outputs: [], isExecuting: false };
      });

      // Save the new notebook with truncated history
      await saveNotebookCells(newPath, cellsToSave, currentKernel || undefined, truncatedHistory);

      // Also save the history file separately (in case the combined save doesn't handle it)
      await saveNotebookHistory(newPath, truncatedHistory);

      // Clear preview mode and close dialog
      setPreviewTimestamp(null);
      setRestoreDialogTimestamp(null);

      // Refresh file list to show new file
      await refreshFileList();

      toast(`Saved restored notebook to ${newPath.split('/').pop()}`, 'success', 3000);
    } catch (error) {
      console.error('Failed to save restored notebook:', error);
      toast('Failed to save restored notebook', 'error');
    }
  }, [restoreDialogTimestamp, previewCells, currentFileId, currentCellMap, generateRestoredFilename, getFullHistory, currentKernel, toast, refreshFileList]);

  // Toggle agent permission for the notebook
  const handleToggleAgentPermission = useCallback(async () => {
    if (!currentFileId) return;

    const newPermitted = !agentPermissionStatus?.agent_permitted;
    const result = await setAgentPermission(currentFileId, newPermitted);
    if (result) {
      setAgentPermissionStatus(result);
      toast(
        newPermitted ? 'Agent can now modify this notebook' : 'Agent access revoked',
        'info',
        2000
      );
    } else {
      toast('Failed to update agent permission', 'error');
    }
  }, [currentFileId, agentPermissionStatus, toast]);

  const handleToggleOutputLogging = useCallback(async () => {
    if (!currentFileId) return;

    const newMode: OutputLoggingMode = outputLoggingMode === 'minimal' ? 'full' : 'minimal';
    const result = await updateNotebookSettings(currentFileId, { output_logging: newMode });
    if (result) {
      setOutputLoggingMode(result.output_logging);
      toast(
        newMode === 'full' ? 'Full output logging enabled' : 'Minimal output logging enabled',
        'info',
        2000
      );
    } else {
      toast('Failed to update output logging mode', 'error');
    }
  }, [currentFileId, outputLoggingMode, toast]);

  // --- KERNEL OPERATIONS ---

  const switchKernel = async (
    kernelName: string,
    serverId?: string | null,
    keepMenuOpen = false,
    source: EditSource = 'user'
  ): Promise<{ success: boolean; sessionId?: string; kernelName?: string; error?: string }> => {
    if (!keepMenuOpen) {
      setIsKernelMenuOpen(false);
    }
    setKernelStatus('starting');
    setIsKernelReady(false);
    setCurrentKernel(kernelName); // Update name immediately so UI shows new kernel with "starting" status

    // Use provided serverId or fall back to currently selected server
    const targetServerId = serverId !== undefined ? serverId : selectedServerId;

    try {
      let startedSessionId: string | undefined;
      // Use getOrCreateKernelForFile which handles kernel switching on the backend
      // (it will stop the old kernel if kernel type differs)
      if (currentFileId) {
        const { sessionId: newSessionId, created, createdAt, serverId: resolvedServerId } = await kernelService.getOrCreateKernelForFile(
          currentFileId,
          kernelName,
          targetServerId
        );
        startedSessionId = newSessionId;
        setKernelSessionId(newSessionId);
        if (createdAt) setKernelCreatedAt(createdAt);
        if (resolvedServerId && resolvedServerId !== selectedServerId) {
          setSelectedServerId(resolvedServerId);
        }
        if (created) {
          logKernelEvent('startKernel', {
            sessionId: newSessionId,
            kernelName,
            serverId: resolvedServerId,
            reason: kernelSessionId ? 'switch' : 'start',
          }, source);
        }
      } else {
        // No file open, just start a standalone kernel
        if (kernelSessionId) {
          await kernelService.stopKernel(kernelSessionId);
        }
        const newSessionId = await kernelService.startKernel(kernelName, undefined, undefined, targetServerId);
        startedSessionId = newSessionId;
        resolvedServer = targetServerId ?? undefined;
        setKernelSessionId(newSessionId);
        logKernelEvent('startKernel', {
          sessionId: newSessionId,
          kernelName,
          serverId: targetServerId,
          reason: kernelSessionId ? 'switch' : 'start',
        }, source);
      }
      setIsKernelReady(true);
      setKernelStatus('idle');
      // Reset execution counter since it's a new kernel
      setCells(prev => prev.map(c => ({ ...c, executionCount: undefined })));
      setKernelExecutionCount(0);
      saveSettings({ lastKernel: kernelName });
      return { success: true, sessionId: startedSessionId, kernelName: kernelName || undefined, error: undefined };
    } catch (error) {
      console.error('Failed to switch kernel:', error);
      setKernelStatus('disconnected');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  // Install kernel for a Python environment
  const installKernelForPython = useCallback(async (pythonPath: string) => {
    try {
      setIsInstallingKernel(pythonPath);
      const result = await kernelService.installKernel(pythonPath, undefined, selectedServerId);

      // Refresh the environments list to show the new kernel
      await loadPythonEnvironments(true, selectedServerId);

      // Optionally switch to the new kernel
      if (result.kernel_name) {
        await switchKernel(result.kernel_name);
      }
    } catch (error) {
      console.error('Failed to install kernel:', error);
      toast(`Failed to install kernel: ${error}`, 'error');
    } finally {
      setIsInstallingKernel(null);
    }
  }, [loadPythonEnvironments, selectedServerId, switchKernel, toast]);

  /**
   * Switch to a different server for kernel execution
   * This loads the available kernels for the new server but does NOT start a kernel.
   * User must manually select a kernel from the menu.
   */
  const switchServer = async (serverId: string) => {
    if (serverId === selectedServerId) return; // No change

    setSelectedServerId(serverId);

    try {
      // Load environments without auto-selecting a kernel - user must choose
      loadPythonEnvironments(false, serverId, false);
    } catch (error) {
      console.error('Failed to load kernels for server:', error);
    }

    // Stop the current kernel if it exists (we're switching servers)
    if (kernelSessionId) {
      try {
        await kernelService.stopKernel(kernelSessionId);
        logKernelEvent('shutdownKernel', { sessionId: kernelSessionId, reason: 'switchServer' }, 'user');
      } catch (e) {
        console.error('Failed to stop kernel:', e);
      }
      setKernelSessionId(null);
      setKernelStatus('idle');
      setIsKernelReady(false);
    }
    // Menu stays open so user can choose a kernel on the new server
  };

  const restartKernel = async (
    source: EditSource = 'user'
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> => {
    setIsKernelMenuOpen(false);
    setKernelStatus('starting');

    if (!kernelSessionId) {
      setKernelStatus('disconnected');
      return { success: false, error: 'No kernel session to restart' };
    }

    try {
      await kernelService.restartKernel(kernelSessionId);
      setKernelStatus('idle');
      // Reset execution counter but preserve outputs
      setCells(prev => prev.map(c => ({ ...c, executionCount: undefined })));
      setKernelExecutionCount(0);
      // Log kernel restart for history
      logKernelEvent('restartKernel', kernelSessionId ? { sessionId: kernelSessionId } : undefined, source);
      return { success: true, sessionId: kernelSessionId ?? undefined };
    } catch (error) {
      console.error('Failed to restart kernel:', error);
      // If session not found, start a fresh kernel
      if (error instanceof Error && error.message.includes('Session not found')) {
        console.log('[Notebook] Session not found, starting fresh kernel');
        try {
          // Clear stale session
          setKernelSessionId(null);
          // Start a new kernel (use getOrCreateKernelForFile if file is open)
          const kernelToUse = currentKernel || 'python3';
          let newSessionId: string;
          if (currentFileId) {
            const result = await kernelService.getOrCreateKernelForFile(currentFileId, kernelToUse, selectedServerId);
            newSessionId = result.sessionId;
            if (result.createdAt) setKernelCreatedAt(result.createdAt);
            if (result.serverId && result.serverId !== selectedServerId) {
              setSelectedServerId(result.serverId);
            }
          } else {
            newSessionId = await kernelService.startKernel(kernelToUse);
          }
          setKernelSessionId(newSessionId);
          setKernelStatus('idle');
          setIsKernelReady(true);
          setCells(prev => prev.map(c => ({ ...c, executionCount: undefined })));
          setKernelExecutionCount(0);
          logKernelEvent('restartKernel', newSessionId ? { sessionId: newSessionId } : undefined, source);
          return { success: true, sessionId: newSessionId };
        } catch (startError) {
          console.error('Failed to start fresh kernel:', startError);
        }
      }
      setKernelStatus('disconnected');
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const shutdownKernel = async (
    source: EditSource = 'user'
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> => {
    setIsKernelMenuOpen(false);
    if (!kernelSessionId) {
      return { success: false, error: 'No kernel session to shutdown' };
    }

    try {
      await kernelService.stopKernel(kernelSessionId);
      logKernelEvent('shutdownKernel', { sessionId: kernelSessionId }, source);
    } catch (error) {
      console.error('Failed to shutdown kernel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      setKernelSessionId(null);
      setKernelStatus('disconnected');
      setIsKernelReady(false);
      setMemoryUsage(null);
    }
    return { success: true, sessionId: kernelSessionId ?? undefined };
  };

  const interruptKernel = async (
    source: EditSource = 'user'
  ): Promise<{ success: boolean; sessionId?: string; error?: string }> => {
    if (!kernelSessionId) {
      return { success: false, error: 'No kernel session to interrupt' };
    }

    try {
      if (kernelSessionId) {
        await kernelService.interruptKernel(kernelSessionId);
      }
      setExecutionQueue([]);
      setIsProcessingQueue(false);
      setCells(prev => prev.map(c => ({ ...c, isExecuting: false })));
      // Log kernel interrupt for history
      logKernelEvent('interruptKernel', kernelSessionId ? { sessionId: kernelSessionId } : undefined, source);
      return { success: true, sessionId: kernelSessionId ?? undefined };
    } catch (error) {
      console.error('Failed to interrupt kernel:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  kernelOpsRef.current = {
    startKernel: async (kernelName?: string, source: EditSource = 'user') => {
      const nameToUse = kernelName || currentKernel || 'python3';
      return switchKernel(nameToUse, undefined, true, source);
    },
    shutdownKernel,
    restartKernel,
    interruptKernel,
  };

  // --- CELL OPERATIONS ---

  const addCell = (type: CellType = 'code', content: string = '', afterIndex?: number, noScroll?: boolean | 'cell' | 'editor') => {
    // Keyframe: flush active cell before insert
    flushActiveCell();

    const currentCells = cellsRef.current;
    const existingIds = new Set(currentCells.map(c => c.id));
    let newId = generateCellId();
    while (existingIds.has(newId)) {
      newId = generateCellId();
    }

    const newCell: Cell = {
      id: newId,
      type,
      content,
      outputs: [],
      isExecuting: false
    };

    // Calculate insertion index
    const insertIndex = (() => {
      if (afterIndex === undefined) return currentCells.length;
      if (afterIndex < 0) return 0;
      if (afterIndex >= currentCells.length) return currentCells.length;
      return afterIndex + 1;
    })();

    undoableInsertCell(insertIndex, newCell);
    setActiveCellId(newCell.id);

    // Handle focus mode if provided (for Shift+Enter creating new cell)
    const focusMode = typeof noScroll === 'string' ? noScroll : null;
    const shouldScroll = noScroll !== true && typeof noScroll !== 'string';

    if (focusMode) {
      // Set pending focus for the new cell
      setPendingFocus({ cellId: newCell.id, mode: focusMode });
    }

    // Only scroll if not explicitly disabled (e.g., toolbar plus button shouldn't scroll)
    if (shouldScroll) {
      scrollToCell(insertIndex);
    }
  };

  const handleAddCell = (type: CellType) => {
    const index = activeCellId ? cells.findIndex(c => c.id === activeCellId) : -1;
    if (index !== -1) {
      addCell(type, '', index);
    } else {
      addCell(type);
    }
  };

  const handleInsertCode = (code: string, targetIndex?: number) => {
    let indexToInsert = -1;
    if (targetIndex !== undefined) {
      indexToInsert = targetIndex;
    } else if (activeCellId) {
      indexToInsert = cells.findIndex(c => c.id === activeCellId);
    } else {
      indexToInsert = cells.length - 1;
    }

    addCell('code', code, indexToInsert);
  };

  // Text edits - not individually undoable (too many operations)
  // Use setCells directly for per-keystroke updates
  // Note: We previously used startTransition here, but it caused a bug where deferred
  // state updates would overwrite CodeMirror's current content when typing fast.
  // CodeMirror renders synchronously, so we don't need startTransition for perceived performance.
  const handleUpdateCell = useCallback((id: string, content: string) => {
    // First edit while redo stack is non-empty is a keyframe
    // This commits the redo history before the new edit timeline begins
    if (hasRedoToFlush()) {
      flushCell(id, content);
    }
    setCells(prev => prev.map(c => c.id === id ? { ...c, content } : c));
  }, [setCells, hasRedoToFlush, flushCell]);

  // AI/bulk update with undo tracking - for AI edits, annotated as AI source
  const handleAIUpdateCell = useCallback((id: string, content: string) => {
    updateContentAI(id, content);
  }, [updateContentAI]);

  // Edit cell from copilot sidebar - also AI-generated content
  const handleEditCell = (index: number, newContent: string) => {
    if (index >= 0 && index < cells.length) {
      updateContentAI(cells[index].id, newContent);
    }
  };

  // Handle cell click - set as active cell
  const handleCellClick = useCallback((id: string, _event: React.MouseEvent) => {
    setActiveCellId(id);
  }, [setActiveCellId]);

  const handleDeleteCellByIndex = async (index: number) => {
    if (index >= 0 && index < cells.length) {
      // Capture cell ID before async operation to avoid race condition
      const cellId = cells[index].id;
      const confirmed = await confirm({
        title: 'Delete Cell',
        message: `Are you sure you want to delete Cell #${index + 1}?`,
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (confirmed) {
        deleteCell(cellId);
      }
    }
  };

  const changeCellType = (id: string, type: CellType) => {
    // Keyframe: flush active cell before type change
    flushActiveCell();
    changeType(id, type);
  };

  const deleteCell = (id: string) => {
    // Keyframe: flush active cell before delete
    flushActiveCell();

    const currentCells = cellsRef.current;

    // Can't delete the last cell - clear it instead
    if (currentCells.length <= 1) {
      updateContent(currentCells[0].id, '');
      setActiveCellId(currentCells[0].id);
      return;
    }

    const idx = currentCells.findIndex(c => c.id === id);
    if (idx === -1) return;

    // Find the next cell to select after deletion
    const nextCellId = currentCells[Math.min(idx + 1, currentCells.length - 1) === idx
      ? Math.max(idx - 1, 0)
      : Math.min(idx + 1, currentCells.length - 1)]?.id;

    undoableDeleteCell(idx);

    if (nextCellId && nextCellId !== id) {
      setActiveCellId(nextCellId);
    }
  };
  // Update refs for keyboard shortcut handler
  deleteCellRef.current = deleteCell;
  addCellRef.current = addCell;
  changeCellTypeRef.current = changeCellType;
  kernelStatusRef.current = kernelStatus;
  interruptKernelRef.current = interruptKernel;

  const moveCell = (id: string, direction: 'up' | 'down') => {
    // Keyframe: flush active cell before move
    flushActiveCell();

    const idx = cells.findIndex(c => c.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === cells.length - 1) return;

    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    undoableMoveCell(idx, targetIdx);

    // Don't auto-scroll for move operations - the cell only moves by one position
    // and typically stays visible. Auto-scrolling causes flickering due to
    // race conditions between state updates and scroll calculations.
    // User can manually scroll if needed.
  };

  const updateCellOutputs = (id: string, newOutputs: any[], isExec: boolean) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, outputs: newOutputs, isExecuting: isExec } : c));
  };

  const createRunId = () => {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const queueExecution = (id: string) => {
    // Keyframe: flush active cell before execution
    flushActiveCell();

    // Check if already in queue (idempotent - safe to call multiple times)
    if (executionQueueRef.current.includes(id)) {
      if (!executionRunIdsRef.current.has(id)) {
        executionRunIdsRef.current.set(id, createRunId());
      }
      return;
    }

    const runId = createRunId();
    executionRunIdsRef.current.set(id, runId);
    setExecutionQueue(prev => [...prev, id]);
    // Log cell run for history
    // Note: content is NOT stored here - it's reconstructed from edit history + snapshot
    const cellIndex = cells.findIndex(c => c.id === id);
    if (cellIndex >= 0) {
      logOperation({
        type: 'event',
        category: 'execution',
        name: 'runCell',
        target: { cellId: id, cellIndex },
        runId,
      });
    }
  };

  const runAndAdvance = (id: string, focusMode: 'cell' | 'editor') => {
    queueExecution(id);
    const currentIndex = cells.findIndex(c => c.id === id);
    if (currentIndex < cells.length - 1) {
      // Move to next cell and scroll to it
      const nextIndex = currentIndex + 1;
      const nextCellId = cells[nextIndex].id;
      setActiveCellId(nextCellId);
      scrollToCell(nextIndex, { delay: 50, retryOnce: true });
      // Set pending focus - will poll for DOM element after virtualization renders
      setPendingFocus({ cellId: nextCellId, mode: focusMode });
    } else {
      // Create new cell at the end with focus mode
      addCell('code', '', currentIndex, focusMode);
    }
  };

  // Update refs for keyboard shortcut handler
  runAndAdvanceRef.current = runAndAdvance;
  queueExecutionRef.current = queueExecution;

  // Navigate to a specific cell (used by search)
  const navigateToCell = useCallback((_cellIndex: number, cellId: string) => {
    setActiveCellId(cellId);
    // Find current index by ID in case cells have been modified since search
    const currentIndex = cells.findIndex(c => c.id === cellId);
    if (currentIndex !== -1) {
      scrollToCell(currentIndex, { retryOnce: true });
    }
  }, [cells, scrollToCell]);

  // Navigate to adjacent cell with virtualization support (used by arrow keys in cell mode)
  const navigateCellRelative = useCallback((fromCellId: string, direction: 'up' | 'down') => {
    const currentIndex = cells.findIndex(c => c.id === fromCellId);
    if (currentIndex === -1) return;

    const targetIndex = direction === 'up' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= cells.length) return;

    const targetCellId = cells[targetIndex].id;
    setActiveCellId(targetCellId);
    scrollToCell(targetIndex, { delay: 50, retryOnce: true });
    // Use polling to wait for virtualization to render the target cell
    setPendingFocus({ cellId: targetCellId, mode: 'cell' });
  }, [cells, scrollToCell]);

  // Handle search query changes for highlighting
  const handleSearchChange = useCallback((
    query: string,
    caseSensitive: boolean,
    useRegex: boolean,
    currentMatch: { cellId: string; startIndex: number; endIndex: number } | null
  ) => {
    setSearchQuery(query ? { query, caseSensitive, useRegex, currentMatch } : null);
  }, []);

  // Handle search close
  const handleSearchClose = useCallback(() => {
    setIsSearchOpen(false);
    setSearchQuery(null);
  }, []);

  // Replace a single match in a cell
  const handleReplace = useCallback((cellId: string, startIndex: number, endIndex: number, replacement: string) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;

    const newContent = cell.content.slice(0, startIndex) + replacement + cell.content.slice(endIndex);
    updateContent(cellId, newContent);
  }, [cells, updateContent]);

  // Replace all matches in a specific cell
  const handleReplaceAllInCell = useCallback((cellId: string, query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;

    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(pattern, flags);
    const newContent = cell.content.replace(regex, replacement);

    if (newContent !== cell.content) {
      updateContent(cellId, newContent);
    }
  }, [cells, updateContent]);

  // Replace all matches in the entire notebook
  const handleReplaceAllInNotebook = useCallback((query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => {
    saveCheckpoint(); // Save undo state before bulk replace

    const flags = caseSensitive ? 'g' : 'gi';
    const pattern = useRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(pattern, flags);

    setCells(prev => prev.map(cell => {
      const newContent = cell.content.replace(regex, replacement);
      return newContent !== cell.content ? { ...cell, content: newContent } : cell;
    }));
  }, [saveCheckpoint, setCells]);

  // Execution Processor
  useEffect(() => {
    if (isProcessingQueue || executionQueue.length === 0 || !isKernelReady || !kernelSessionId) return;

    const processNext = async () => {
      setIsProcessingQueue(true);
      setKernelStatus('busy');
      const cellId = executionQueue[0];
      const cellIndex = cells.findIndex(c => c.id === cellId);
      const cell = cellIndex >= 0 ? cells[cellIndex] : null;

      // Start timing for this cell
      const cellStartTime = Date.now();
      cellExecutionStartRef.current = cellStartTime;
      setExecutionElapsedMs(0);

      if (cell && cell.type === 'code') {
        let hasError = false;
        const collectedOutputs: string[] = []; // Track outputs for history

        // Output limits (uses module-level constants)
        let totalOutputChars = 0;
        let totalOutputLines = 0;
        let outputLimitReached = false;

        // Accumulate outputs and flush periodically to update UI
        // Key: We never clear this array - each flush replaces cell.outputs entirely
        // This avoids race conditions with React's async state updates
        const allOutputs: typeof cell.outputs = [];
        let lastFlushTime = 0; // Start at 0 so first output flushes immediately
        const FLUSH_INTERVAL_MS = 100; // Flush at most every 100ms
        let pendingFlush: number | null = null;

        const flushToCell = () => {
          pendingFlush = null;
          if (allOutputs.length === 0) return;
          // Copy current accumulated outputs - don't clear, keep accumulating
          const snapshot = [...allOutputs];
          lastFlushTime = Date.now();

          // Replace entire outputs array - this is idempotent and race-condition-free
          setCells(prev => prev.map(c => {
            if (c.id !== cellId) return c;
            return { ...c, outputs: snapshot };
          }));
        };

        const scheduleFlush = () => {
          if (pendingFlush !== null) return;
          const timeSinceLastFlush = Date.now() - lastFlushTime;
          if (timeSinceLastFlush >= FLUSH_INTERVAL_MS) {
            // Flush immediately
            flushToCell();
          } else {
            // Schedule flush for later
            pendingFlush = window.setTimeout(flushToCell, FLUSH_INTERVAL_MS - timeSinceLastFlush);
          }
        };

        setCells(prev => prev.map(c => c.id === cellId ? { ...c, isExecuting: true, outputs: [], lastExecutionMs: undefined } : c));

        try {
          await kernelService.executeCode(kernelSessionId, cell.content, (output) => {
            if (output.type === 'error') {
              hasError = true;
            }

            // Check output limits
            if (outputLimitReached) return;

            const outputSize = output.content?.length || 0;
            totalOutputChars += outputSize;

            // Count lines for text outputs
            if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'error') {
              const lineCount = (output.content?.match(/\n/g) || []).length + 1;
              totalOutputLines += lineCount;
              collectedOutputs.push(output.content);
            }

            // Add to accumulated outputs
            allOutputs.push(output);

            // Check if we've hit any limit (lines or size)
            if (totalOutputLines >= MAX_OUTPUT_LINES || totalOutputChars >= MAX_OUTPUT_CHARS) {
              outputLimitReached = true;
              allOutputs.push({
                id: `limit-${Date.now()}`,
                type: 'stderr',
                content: `\n⚠️ Output limit reached (${totalOutputLines.toLocaleString()} lines). Additional output not displayed.`,
                timestamp: Date.now(),
              });
              // Cancel any pending flush and flush immediately
              if (pendingFlush !== null) {
                clearTimeout(pendingFlush);
                pendingFlush = null;
              }
              flushToCell();
              return;
            }

            // Schedule a throttled flush to update UI
            scheduleFlush();
          });

          // Cancel any pending flush and do final flush
          if (pendingFlush !== null) {
            clearTimeout(pendingFlush);
            pendingFlush = null;
          }
          flushToCell();
        } catch (error) {
          console.error('Execution error:', error);
          hasError = true;
          // Cancel any pending flush and flush what we have
          if (pendingFlush !== null) {
            clearTimeout(pendingFlush);
            pendingFlush = null;
          }
          flushToCell();
        }

        // Log execution completion for history
        const durationMs = Date.now() - cellStartTime;
        // Output logging depends on notebook-level setting:
        // - 'minimal': no output logged (saves space)
        // - 'full': complete output logged (for debugging/replay)
        const fullOutput = collectedOutputs.join('\n');
        const loggedOutput = outputLoggingMode === 'full' ? fullOutput : undefined;

        const runId = executionRunIdsRef.current.get(cellId);
        logOperation({
          type: 'event',
          category: 'execution',
          name: 'runCellComplete',
          target: { cellId, cellIndex },
          runId,
          data: {
            durationMs,
            success: !hasError,
            output: loggedOutput,
          },
        });
        executionRunIdsRef.current.delete(cellId);

        // Increment global counter and assign to cell
        setKernelExecutionCount(prev => {
          const newCount = prev + 1;
          setCells(cells => cells.map(c => c.id === cellId ? {
            ...c,
            isExecuting: false,
            executionCount: newCount,
            lastExecutionMs: durationMs
          } : c));
          return newCount;
        });

        // Handle error: clear queue and show error indicator
        if (hasError) {
          setExecutionQueue([]); // Clear remaining queue on error
          lastCompletedCellRef.current = { cellId, cellIndex };
          setLastExecutionResult({
            cellId,
            cellIndex,
            status: 'error',
            elapsedMs: durationMs
          });
        } else {
          // Use functional update to get current queue state (not stale closure)
          // This ensures cells added during execution aren't lost
          setExecutionQueue(prev => {
            const remainingQueue = prev.slice(1);
            if (remainingQueue.length === 0) {
              // Queue complete - show success indicator
              lastCompletedCellRef.current = { cellId, cellIndex };
              setLastExecutionResult({
                cellId,
                cellIndex,
                status: 'completed',
                elapsedMs: durationMs
              });
            }
            return remainingQueue;
          });
        }
      } else {
        // Non-code cell or cell not found, just mark as done
        if (cellIndex >= 0) {
          lastCompletedCellRef.current = { cellId, cellIndex };
        }
        setCells(prev => prev.map(c => c.id === cellId ? { ...c, isExecuting: false } : c));
        setExecutionQueue(prev => prev.slice(1));
      }

      cellExecutionStartRef.current = null;
      setIsProcessingQueue(false);
      setKernelStatus('idle');
    };

    processNext();
  }, [executionQueue, isProcessingQueue, isKernelReady, kernelSessionId, cells, setCells, logOperation]);

  // Track execution timing for notifications
  const prevQueueLengthRef = useRef(0);
  useEffect(() => {
    const prevLength = prevQueueLengthRef.current;
    const currentLength = executionQueue.length;

    // Queue just became non-empty - start timing
    if (prevLength === 0 && currentLength > 0) {
      executionStartTimeRef.current = Date.now();
    }

    // Queue just became empty after having items - check if we should notify
    if (prevLength > 0 && currentLength === 0 && executionStartTimeRef.current) {
      const elapsedSeconds = (Date.now() - executionStartTimeRef.current) / 1000;
      const settings = getSettings();

      const threshold = settings.notifyThresholdSeconds ?? 60;

      if (elapsedSeconds >= threshold) {
        // Play sound notification if enabled
        if (settings.notifySoundEnabled) {
          playSuccessSound();
        }

        // Send browser notification if enabled
        if (settings.notifyOnLongRun) {
          if (typeof window === 'undefined' || !('Notification' in window)) {
            // Notification API not available in this environment
          } else if (Notification.permission === 'granted') {
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = Math.floor(elapsedSeconds % 60);
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
            const lastCell = lastCompletedCellRef.current;
            const cellLabel = lastCell && lastCell.cellIndex >= 0
              ? `Cell #${lastCell.cellIndex + 1}`
              : 'Cell completed';
            const notebookLabel = currentFilename || 'Untitled';
            const notification = new Notification('Nebula Notebook', {
              body: `${notebookLabel} - ${cellLabel} - completed in ${timeStr}`,
              icon: '/favicon.svg',
              tag: 'execution-complete', // Prevents duplicate notifications
              renotify: true,
              requireInteraction: true,
            } as NotificationOptions);
            notification.onclick = () => {
              window.focus();
              if (lastCell && lastCell.cellIndex >= 0) {
                setActiveCellId(lastCell.cellId);
                scrollToCell(lastCell.cellIndex, { behavior: 'auto', retryOnce: true });
              }
              notification.close();
            };
          } else if (Notification.permission === 'default') {
            // Request permission for future notifications
            Notification.requestPermission();
          } else {
            // Permission denied - do nothing
          }
        }
      }

      executionStartTimeRef.current = null;
    }

    prevQueueLengthRef.current = currentLength;
  }, [executionQueue.length, currentFilename, scrollToCell]);

  const getKernelDisplayName = () => {
    const kernel = availableKernels.find(k => k.name === currentKernel);
    return kernel?.display_name || currentKernel;
  };

  const getStatusColor = () => {
    switch (kernelStatus) {
      case 'idle': return 'bg-green-500';
      case 'busy': return 'bg-amber-500 animate-pulse';
      case 'starting': return 'bg-blue-500 animate-pulse';
      default: return 'bg-red-500';
    }
  };

  const fileBrowserInitialPath = getDirectoryFromPath(currentFileId);

  return (
    <div className="flex min-h-screen bg-slate-50 relative overflow-hidden">

      {/* File Browser Sidebar */}
      <FileBrowser
        files={files}
        currentFileId={currentFileId}
        onSelect={loadFile}
        onOpenTextFile={(path) => setTextEditorPath(path)}
        onRefresh={refreshFileList}
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
        initialPath={fileBrowserInitialPath}
      />

      {/* Main Content */}
      <div className={`relative flex-1 flex flex-col h-screen transition-all duration-300 ${isFileBrowserOpen ? 'nebula-filebrowser-offset' : ''} ${isChatOpen ? 'lg:mr-80' : ''}`}>

        {textEditorPath && (
          <div className="fixed inset-0 z-50 bg-slate-900/40 backdrop-blur-sm flex items-center justify-center p-6 overflow-hidden">
            <div className="w-full h-full max-w-5xl max-h-[85vh] bg-white rounded-xl shadow-2xl border border-slate-200 overflow-hidden">
              <TextFileEditor filePath={textEditorPath} variant="modal" onClose={() => setTextEditorPath(null)} />
            </div>
          </div>
        )}

        {/* Conflict Dialog */}
        {conflictDialog?.show && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
              <div className="flex items-start gap-3 mb-4">
                <AlertCircle className="w-6 h-6 text-orange-500 flex-shrink-0 mt-0.5" />
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">Notebook Changed on Server</h3>
                  <p className="text-sm text-slate-600 mt-1">
                    The notebook was modified on the server while you were editing.
                    How would you like to proceed?
                  </p>
                </div>
              </div>
              <div className="flex flex-col gap-2">
                <button
                  onClick={keepLocal}
                  className="w-full px-4 py-2.5 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors"
                >
                  Keep My Changes
                  <span className="block text-xs font-normal text-blue-200 mt-0.5">
                    Overwrite server version with your local edits
                  </span>
                </button>
                <button
                  onClick={loadRemote}
                  className="w-full px-4 py-2.5 text-sm font-medium bg-slate-100 text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
                >
                  Load Server Version
                  <span className="block text-xs font-normal text-slate-500 mt-0.5">
                    Discard your changes and reload from server
                  </span>
                </button>
              </div>
            </div>
          </div>
        )}

        <header className="flex-none bg-slate-50/90 backdrop-blur py-3 border-b border-slate-200 px-4 z-20">
            <div className="flex justify-between items-center max-w-5xl mx-auto w-full">
               <div className="flex items-center gap-3">
                 <button
                    onClick={() => setIsFileBrowserOpen(!isFileBrowserOpen)}
                    className="p-2 hover:bg-white hover:shadow-sm rounded-md text-slate-600 transition-all"
                 >
                   <Menu className="w-5 h-5" />
                 </button>
                 <div>
                    <h1 className="text-lg font-bold text-slate-800 flex items-center gap-2 truncate max-w-[18rem] sm:max-w-2xl">
                      {isRenamingNotebook ? (
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={finishRenameNotebook}
                          onKeyDown={handleRenameKeyDown}
                          className="text-lg font-bold bg-white border-2 border-blue-400 rounded px-1 py-0 focus:outline-none focus:border-blue-500 leading-normal"
                          style={{ width: `${Math.min(Math.max(renameValue.length + 2, 12), 48)}ch`, maxWidth: '100%' }}
                          autoFocus
                        />
                      ) : isLoadingFile ? (
                        <span className="flex items-center gap-2 text-slate-400">
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Loading...
                        </span>
                      ) : (
                        <span
                          onClick={startRenameNotebook}
                          className="cursor-pointer hover:bg-slate-100 px-1 rounded transition-colors"
                          title="Click to rename"
                        >
                          {currentFilename || "Untitled"}
                        </span>
                      )}
                      <span className="text-xs font-normal text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                        .ipynb
                      </span>
                    </h1>

                    {/* Second row: Kernel Selector + Save Status */}
                    <div className="flex items-center gap-3">
                      {/* Kernel Selector */}
                      <div className="relative">
                      <button
                        onClick={() => setIsKernelMenuOpen(!isKernelMenuOpen)}
                        className="flex items-center gap-1.5 text-xs text-slate-600 hover:bg-slate-200/50 px-1.5 py-0.5 rounded -ml-1.5 transition-colors"
                      >
                         <span className={`w-2 h-2 rounded-full ${getStatusColor()}`}></span>
                         <span className="font-medium">{getKernelDisplayName()}</span>
                         <ChevronDown className="w-3 h-3 text-slate-400" />
                      </button>

                      {isKernelMenuOpen && (
                        <div
                          className="absolute top-full left-0 mt-1 w-80 bg-white rounded-lg shadow-xl border border-slate-200 py-1 z-50 max-h-[70vh] overflow-hidden flex flex-col"
                          onMouseLeave={() => setIsKernelMenuOpen(false)}
                        >
                          <div className="px-3 py-2 border-b border-slate-100 flex items-center justify-between">
                             <div>
                               <div className="text-xs font-semibold text-slate-900 flex items-center gap-1.5">
                                 Active Kernel
                                 {kernelCreatedAt && (
                                   <span className="text-[0.625rem] font-normal text-slate-400 flex items-center gap-0.5" title="Kernel uptime">
                                     <Clock className="w-2.5 h-2.5" />
                                     {formatKernelUptime(kernelCreatedAt)}
                                   </span>
                                 )}
                               </div>
                               <div className="text-[0.625rem] text-slate-500">
                                 {getKernelDisplayName()} ({kernelStatus})
                                 {clusterInfo && clusterInfo.servers.length > 1 && selectedServerId && (() => {
                                   const server = clusterInfo.servers.find(s => s.id === selectedServerId);
                                   const displayName = server?.isLocal && server?.resources?.hostname
                                     ? server.resources.hostname
                                     : server?.name || selectedServerId;
                                   return (
                                     <span className="text-blue-500 ml-1">
                                       @ {displayName}
                                     </span>
                                   );
                                 })()}
                               </div>
                             </div>
                             <button
                               onClick={(e) => { e.stopPropagation(); loadPythonEnvironments(true, selectedServerId); }}
                               disabled={isDiscoveringPythons}
                               className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors"
                               title="Refresh Python environments"
                             >
                               <RefreshCw className={`w-3.5 h-3.5 ${isDiscoveringPythons ? 'animate-spin' : ''}`} />
                             </button>
                          </div>

                          {/* Kernel Actions */}
                          <div className="border-b border-slate-100 py-1">
                            <button
                              onClick={() => interruptKernel()}
                              disabled={kernelStatus !== 'busy'}
                              className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              <Square className="w-3 h-3" /> Interrupt
                            </button>
                            <button
                              onClick={() => restartKernel()}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <RotateCw className="w-3 h-3" /> Restart Kernel
                            </button>
                            <button
                              onClick={() => shutdownKernel()}
                              disabled={!kernelSessionId}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              <Power className="w-3 h-3" /> Shutdown Kernel
                            </button>
                            <button
                              onClick={() => { setIsKernelMenuOpen(false); setIsKernelManagerOpen(true); }}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <Cpu className="w-3 h-3" /> Manage All Kernels
                            </button>
                          </div>

                          <div className="overflow-y-auto flex-1">
                            {/* Server Selector (only show if cluster has multiple servers) */}
                            {clusterInfo && clusterInfo.servers.length > 1 && (
                              <>
                                <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 flex items-center gap-1">
                                  <Server className="w-3 h-3" />
                                  <span>Server</span>
                                </div>
                                {clusterInfo.servers.map(server => (
                                  <button
                                    key={server.id}
                                    onClick={() => switchServer(server.id)}
                                    disabled={server.status !== 'online'}
                                    className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 ${
                                      server.id === selectedServerId ? 'bg-blue-50 text-blue-700' : 'text-slate-700'
                                    } ${server.status !== 'online' ? 'opacity-50' : ''}`}
                                  >
                                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                      server.status === 'online' ? 'bg-green-500' : 'bg-red-500'
                                    }`}></span>
                                    <span className="truncate flex-1">
                                      {server.isLocal && server.resources?.hostname
                                        ? server.resources.hostname
                                        : server.name}
                                    </span>
                                    {server.isLocal && <span className="text-[0.625rem] text-slate-400">(local)</span>}
                                    {server.status !== 'online' && <span className="text-[0.625rem] text-red-400">offline</span>}
                                  </button>
                                ))}
                              </>
                            )}

                            {/* Registered Kernels */}
                            <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50">
                              Jupyter Kernels
                            </div>
                            {availableKernels.map(kernel => {
                              // Match kernel to environment using the actual Python path from kernel.json
                              const matchedEnv = pythonEnvironments.find(env =>
                                env.kernel_name === kernel.name ||
                                (kernel.python_path && env.path && kernel.python_path === env.path)
                              );
                              const envLabel = matchedEnv?.env_name || (matchedEnv && matchedEnv.display_name !== kernel.display_name ? matchedEnv.display_name : null);

                              return (
                                <button
                                  key={kernel.name}
                                  onClick={() => switchKernel(kernel.name)}
                                  className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 ${
                                    kernel.name === currentKernel ? 'bg-green-50 text-green-700' : 'text-slate-700'
                                  }`}
                                >
                                  <span className="w-2 h-2 rounded-full flex-shrink-0 bg-green-500"></span>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-baseline gap-1.5 min-w-0">
                                      <span className="truncate">{kernel.display_name}</span>
                                      {envLabel && (
                                        <span className="text-[0.625rem] text-slate-400 truncate">
                                          {envLabel}
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                  <span className="text-[0.625rem] text-slate-400">{kernel.language}</span>
                                </button>
                              );
                            })}

                            {/* Discovered Python Environments */}
                            {pythonEnvironments.length > 0 && (
                              <>
                                <div className="px-3 py-1.5 text-[0.625rem] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 mt-1 flex items-center justify-between">
                                  <span>Python Environments ({pythonEnvironments.length})</span>
                                  {isDiscoveringPythons && <Loader2 className="w-3 h-3 animate-spin" />}
                                </div>
                                {pythonEnvironments.map(env => {
                                  // Check if this env is already a registered kernel using the actual Python path
                                  const isRegistered = availableKernels.some(k =>
                                    (k.python_path && k.python_path === env.path) ||
                                    env.kernel_name === k.name
                                  );

                                  return (
                                    <div
                                      key={env.path}
                                      className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 text-slate-600"
                                    >
                                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                                        isRegistered ? 'bg-green-500' : env.has_ipykernel ? 'bg-amber-400' : 'bg-slate-300'
                                      }`}></span>
                                      <div className="flex-1 min-w-0">
                                        <div className="truncate">{env.display_name}</div>
                                        <div className="text-[0.625rem] text-slate-400 truncate">{env.path}</div>
                                      </div>
                                      {isRegistered ? (
                                        <span className="text-[0.625rem] text-green-600 flex-shrink-0">Registered</span>
                                      ) : (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); installKernelForPython(env.path); }}
                                          disabled={isInstallingKernel === env.path}
                                          className={`flex items-center gap-1 px-2 py-1 text-[0.625rem] rounded transition-colors flex-shrink-0 ${
                                            env.has_ipykernel
                                              ? 'bg-amber-50 text-amber-600 hover:bg-amber-100'
                                              : 'bg-blue-50 text-blue-600 hover:bg-blue-100'
                                          }`}
                                          title={env.has_ipykernel ? "Register as Jupyter kernel" : "Install ipykernel and register"}
                                        >
                                          {isInstallingKernel === env.path ? (
                                            <Loader2 className="w-3 h-3 animate-spin" />
                                          ) : (
                                            <Download className="w-3 h-3" />
                                          )}
                                          <span>{isInstallingKernel === env.path ? 'Installing...' : env.has_ipykernel ? 'Register' : 'Install'}</span>
                                        </button>
                                      )}
                                    </div>
                                  );
                                })}
                              </>
                            )}
                          </div>

                        </div>
                      )}
                      </div>

                      {/* Agent Session Indicator - only shows when session is active */}
                      {agentSession && (() => {
                        const shortId = agentSession.agentId?.slice(0, 8) || '';
                        const displayName = agentSession.clientName || 'Agent';
                        const fullLabel = shortId ? `${displayName} (${shortId})` : displayName;
                        const durationSec = Math.floor((Date.now() - agentSession.startedAt) / 1000);
                        const durationStr = durationSec < 60
                          ? `${durationSec}s`
                          : `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;
                        const tooltipLines = [
                          `🤖 Agent Session Active`,
                          `Client: ${agentSession.clientName || 'Unknown'}${agentSession.clientVersion ? ` v${agentSession.clientVersion}` : ''}`,
                          `Session ID: ${agentSession.agentId || 'N/A'}`,
                          `Duration: ${durationStr}`,
                        ];
                        return (
                          <span
                            className="flex items-center gap-1 text-xs mr-2 px-1.5 py-0.5 rounded text-purple-800 bg-purple-200 border border-purple-300 cursor-help max-w-[15rem]"
                            title={tooltipLines.join('\n')}
                          >
                            <Bot className="w-3 h-3 animate-pulse flex-shrink-0" />
                            <span className="min-w-0 truncate">
                              {agentOperation
                                ? agentOperation.type.replace(/([A-Z])/g, ' $1').trim()
                                : fullLabel}
                            </span>
                          </span>
                        );
                      })()}

                      {/* Save Status Indicator */}
                      <span className="flex items-center gap-1 text-xs">
                        {currentFileId && !isAgentConnected && (
                          <span className="flex items-center gap-1 text-amber-600 mr-2" title="Reconnecting to server...">
                            <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse"></span>
                            <span>Reconnecting</span>
                          </span>
                        )}
                        {!isOnline && (
                          <span className="flex items-center gap-1 text-orange-600 mr-2" title="No internet connection">
                            <CloudOff className="w-3 h-3" />
                            <span>Offline</span>
                          </span>
                        )}
                        {pendingSave && isOnline && (
                          <span className="flex items-center gap-1 text-orange-600 mr-2" title="Syncing changes...">
                            <RefreshCw className="w-3 h-3 animate-spin" />
                            <span>Syncing</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'saving' && (
                          <span className="flex items-center gap-1 text-blue-600">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Saving...</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'saved' && !pendingSave && (
                          <span className="flex items-center gap-1 text-green-600" title={autosaveStatus.lastSaved ? `Last saved ${formatLastSaved(autosaveStatus.lastSaved)}` : ''}>
                            <Check className="w-3 h-3" />
                            <span className="text-slate-400">{formatLastSaved(autosaveStatus.lastSaved)}</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'unsaved' && !pendingSave && !canRedo && (
                          <span className="flex items-center gap-1 text-amber-600" title="Unsaved changes">
                            <Cloud className="w-3 h-3" />
                            <span className="text-slate-400">Unsaved</span>
                          </span>
                        )}
                        {canRedo && (
                          <span className="flex items-center gap-1 text-amber-600" title="Autosave paused while redo history exists. Saving will clear redo history.">
                            <Undo2 className="w-3 h-3" />
                            <span>Autosave paused</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'error' && !pendingSave && (
                          <span className="flex items-center gap-1 text-red-600" title="Save failed">
                            <AlertCircle className="w-3 h-3" />
                            <span>Save failed</span>
                          </span>
                        )}
                      </span>

                      {/* Execution Indicator - shows running cell or last result */}
                      {executionIndicator ? (
                          <div className="relative">
                            <div
                              className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-500 hover:bg-gray-100 rounded transition-colors cursor-pointer"
                              onClick={() => setIsExecutionQueueOpen(!isExecutionQueueOpen)}
                              title={`Running cell ${executionIndicator.cellIndex + 1}${executionIndicator.queueLength > 1 ? ` (${executionIndicator.queueLength - 1} more queued)` : ''} - Click to manage queue`}
                            >
                              <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                              <span 
                                className="tabular-nums hover:text-blue-600 cursor-pointer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  if (executionIndicator.cellIndex >= 0) {
                                    setActiveCellId(executionIndicator.cellId);
                                    scrollToCell(executionIndicator.cellIndex);
                                  }
                                }}
                                title="Jump to cell"
                              >
                                #{executionIndicator.cellIndex + 1}
                              </span>
                              <span className="text-gray-400 tabular-nums">{formatElapsedTime(executionElapsedMs)}</span>
                              {executionIndicator.queueLength > 1 && (
                                <span className="text-gray-400">+{executionIndicator.queueLength - 1}</span>
                              )}
                            </div>
                            {/* Execution Queue Dropdown - click to toggle */}
                            {isExecutionQueueOpen && executionQueue.length > 0 && (
                              <div 
                                className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-50 min-w-[12.5rem] py-1"
                                onMouseLeave={() => setIsExecutionQueueOpen(false)}
                              >
                                {/* Header */}
                                <div className="px-3 py-2 border-b border-slate-100">
                                  <div className="text-xs font-semibold text-slate-900">Execution Queue</div>
                                  <div className="text-[0.625rem] text-slate-500">{executionQueue.length} cell{executionQueue.length > 1 ? 's' : ''} queued</div>
                                </div>
                                
                                {/* Queue Items */}
                                <div className="max-h-[18.75rem] overflow-y-auto">
                                  {executionQueue.map((cellId, queueIndex) => {
                                    const cellIndex = cells.findIndex(c => c.id === cellId);
                                    const isExecuting = queueIndex === 0;
                                    const cellContent = cells[cellIndex]?.content.split('\n')[0].slice(0, 20) || 'Empty';
                                    return (
                                      <div
                                        key={`${cellId}-${queueIndex}`}
                                        className={`flex items-center justify-between px-3 py-1.5 text-xs ${isExecuting ? 'bg-amber-50' : 'hover:bg-slate-50'}`}
                                      >
                                        <div className="flex items-center gap-2 min-w-0 flex-1">
                                          <span className="w-3 h-3 flex items-center justify-center flex-shrink-0">
                                            {isExecuting ? (
                                              <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                                            ) : (
                                              <span className="w-1.5 h-1.5 rounded-full bg-slate-300" />
                                            )}
                                          </span>
                                          <span
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              if (cellIndex >= 0) {
                                                setActiveCellId(cellId);
                                                scrollToCell(cellIndex);
                                                setIsExecutionQueueOpen(false);
                                              }
                                            }}
                                            className="tabular-nums font-medium text-slate-700 hover:text-blue-600 cursor-pointer"
                                            title="Jump to cell"
                                          >
                                            #{cellIndex + 1}
                                          </span>
                                          <span className="text-slate-400 truncate">{cellContent}</span>
                                        </div>
                                        {!isExecuting && (
                                          <button
                                            onClick={(e) => {
                                              e.stopPropagation();
                                              setExecutionQueue(prev => prev.filter((_, idx) => idx !== queueIndex));
                                            }}
                                            className="p-1 text-slate-400 hover:text-red-500 hover:bg-red-50 rounded flex-shrink-0 ml-1"
                                            title="Remove from queue"
                                          >
                                            <X className="w-3 h-3" />
                                          </button>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                
                                {/* Clear All Button */}
                                {executionQueue.length > 1 && (
                                  <div className="border-t border-slate-100 py-1">
                                    <button
                                      onClick={() => setExecutionQueue(prev => [prev[0]])}
                                      className="w-full text-left px-3 py-1.5 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                                    >
                                      <X className="w-3 h-3" />
                                      <span>Clear Queued</span>
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                      ) : lastExecutionResult && (
                          <button
                            onClick={() => {
                              if (lastExecutionResult.cellIndex >= 0) {
                                setActiveCellId(lastExecutionResult.cellId);
                                scrollToCell(lastExecutionResult.cellIndex);
                              }
                              dismissExecutionResult();
                            }}
                            className={`flex items-center gap-1 px-1.5 py-0.5 text-xs rounded transition-colors ${
                              lastExecutionResult.status === 'error'
                                ? 'text-red-600 hover:text-red-700 hover:bg-red-50'
                                : 'text-green-600 hover:text-green-700 hover:bg-green-50'
                            }`}
                            title={`${lastExecutionResult.status === 'error' ? 'Error in' : 'Completed'} cell ${lastExecutionResult.cellIndex + 1} - Click to jump and dismiss`}
                          >
                            {lastExecutionResult.status === 'error' ? (
                              <XCircle className="w-3 h-3" />
                            ) : (
                              <CheckCircle className="w-3 h-3" />
                            )}
                            <span className="tabular-nums">#{lastExecutionResult.cellIndex + 1}</span>
                            <span className="tabular-nums opacity-70">{formatElapsedTime(lastExecutionResult.elapsedMs)}</span>
                          </button>
                      )}
                    </div>

                 </div>
               </div>

               <div className="flex gap-2 items-center">
                  {/* Undo / Redo Controls */}
                  <div className="flex items-center gap-1 mr-2 border-r border-slate-200 pr-2">
                    <button
                      onClick={undo}
                      disabled={!canUndo}
                      className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
                      title="Notebook Undo"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={redo}
                      disabled={!canRedo}
                      className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
                      title="Notebook Redo"
                    >
                      <Redo2 className="w-4 h-4" />
                    </button>
                  </div>

                  {/* Cell Queue Indicator */}
                  {cellQueue.length > 0 && (
                    <div
                      className="flex items-center gap-1 px-2 py-1 text-xs text-indigo-600 bg-indigo-50 rounded-md border border-indigo-200"
                      title={`${cellQueue.length} cell${cellQueue.length > 1 ? 's' : ''} in queue (E to add, D to paste)`}
                    >
                      <Layers className="w-3.5 h-3.5" />
                      <span className="font-medium tabular-nums">{cellQueue.length}</span>
                    </div>
                  )}

                  <button
                    onClick={() => setIsKeyboardHelpOpen(true)}
                    className="btn-secondary hidden sm:flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors"
                    title="Keyboard Shortcuts"
                  >
                    <Keyboard className="w-4 h-4" />
                  </button>
                  {/* Output Logging Mode Toggle - Hidden for now to prevent history bloat.
                      The feature is fully implemented and can be enabled via:
                      - API: POST /api/notebook/settings { path, output_logging: 'full' | 'minimal' }
                      - Stored in notebook metadata.nebula.output_logging
                      - 'minimal' (default): no output in history
                      - 'full': complete output saved to history
                  */}
                  {/* Agent Permission Toggle */}
                  <button
                    onClick={handleToggleAgentPermission}
                    disabled={agentSession !== null}
                    className={`btn-secondary hidden sm:flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs font-medium transition-colors ${
                      agentSession
                        ? 'bg-purple-100 text-purple-600 cursor-not-allowed'
                        : agentPermissionStatus?.can_agent_modify
                          ? 'bg-green-50 text-green-700 hover:bg-green-100 border border-green-200'
                          : 'hover:bg-slate-200 text-slate-600'
                    }`}
                    title={
                      agentSession
                        ? 'Agent session active - cannot change permission'
                        : agentPermissionStatus?.agent_created
                          ? 'Agent-created notebook (always permitted)'
                          : agentPermissionStatus?.can_agent_modify
                            ? 'Click to revoke agent access'
                            : agentPermissionStatus?.agent_permitted && !agentPermissionStatus?.has_history
                              ? 'Agent permitted but history not enabled yet - make an edit first'
                              : 'Click to allow agent modifications'
                    }
                  >
                    {agentPermissionStatus?.can_agent_modify ? (
                      <ShieldOff className="w-4 h-4" />
                    ) : agentPermissionStatus?.agent_permitted ? (
                      <Shield className="w-4 h-4 text-amber-500" />
                    ) : (
                      <ShieldCheck className="w-4 h-4" />
                    )}
                  </button>
                  <button
                    onClick={() => setIsSettingsOpen(true)}
                    className="btn-secondary hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button onClick={handleManualSave} className="btn-secondary hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors">
                      <Save className="w-4 h-4" /> Save
                  </button>
                  <button onClick={() => {
                    const codeCellCount = cells.filter(c => c.type === 'code').length;
                    logOperation({
                      type: 'event',
                      category: 'execution',
                      name: 'runAllCells',
                      data: { cellCount: codeCellCount },
                    });
                    cells.forEach(c => queueExecution(c.id));
                  }} className="btn-primary flex items-center gap-2 bg-slate-900 text-white px-3 py-1.5 rounded-md hover:bg-slate-700 text-xs font-medium transition-colors shadow-sm">
                      <Play className="w-4 h-4" /> Run All
                  </button>

                  <button
                    onClick={() => setIsChatOpen(!isChatOpen)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-md font-medium text-xs transition-all shadow-sm
                      ${isChatOpen
                        ? 'bg-purple-600 text-white ring-2 ring-purple-200'
                        : 'bg-white text-slate-700 border border-purple-200 hover:border-purple-300 hover:bg-purple-50'
                      }`}
                    title="Toggle AI Copilot"
                  >
                    <Sparkles className={`w-4 h-4 ${isChatOpen ? 'text-purple-200' : 'text-purple-600'}`} />
                    Copilot
                  </button>

               </div>
            </div>
        </header>

        {/* Loading progress bar */}
        {isLoadingFile && (
          <div className="h-0.5 bg-slate-100 overflow-hidden">
            <div className="h-full bg-blue-500 animate-loading-bar" />
          </div>
        )}

        {/* Breadcrumb navigation for markdown headers */}
        <NotebookBreadcrumb
          cells={cells}
          activeCellId={activeCellId}
          onNavigate={navigateToCell}
        />

        {/* History Preview Banner */}
        {isPreviewMode && (
          <div className="px-3 py-2 bg-blue-50 border-b border-blue-200 flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm text-blue-700">
              <History className="w-4 h-4" />
              <span>
                Previewing notebook at{' '}
                <span className="font-medium">
                  {new Date(previewTimestamp!).toLocaleString()}
                </span>
              </span>
              <span className="text-blue-500 text-xs">(read-only, outputs shown for cells not re-executed)</span>
              <span className="flex items-center gap-3 ml-4 text-xs">
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded border-2 border-orange-400 bg-orange-50"></span>
                  <span className="text-slate-500">Modified</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-3 h-3 rounded border-2 border-red-400 bg-red-50"></span>
                  <span className="text-slate-500">Deleted</span>
                </span>
              </span>
            </div>
            <button
              onClick={() => setPreviewTimestamp(null)}
              className="flex items-center gap-1.5 px-3 py-1 text-sm font-medium text-blue-600 hover:text-blue-800 hover:bg-blue-100 rounded transition-colors"
            >
              Return to present
            </button>
          </div>
        )}

        {/* Virtuoso Scrollable Area */}
        <div className="flex-1 min-h-0 pt-2">
            {/* Force remount when file changes to recalculate cell heights */}
            <VirtualCellList
              key={currentFileId || 'empty'}
              cells={displayCells}
              virtuosoRef={virtuosoRef}
              className="h-full"
              onRangeChange={handleRangeChange}
              renderKey={`${showLineNumbers ? 'line-numbers-on' : 'line-numbers-off'}-${showCellIds ? 'cell-ids-on' : 'cell-ids-off'}-${isPreviewMode ? 'preview' : 'live'}`}
              renderCell={(cell, idx) => (
                  <CellComponent
                  key={cell.id}
                  cell={cell}
                  index={idx}
                  isActive={!isPreviewMode && activeCellId === cell.id}
                  isHighlighted={highlightedCellIds.has(cell.id)}
                  isLocked={agentSession !== null || isPreviewMode}
                  allCells={displayCells}
                  onUpdate={handleUpdateCell}
                  onAIUpdate={handleAIUpdateCell}
                  onFlush={flushCell}
                  onRun={queueExecution}
                  onRunAndAdvance={runAndAdvance}
                  onDelete={deleteCell}
                  onMove={moveCell}
                  onChangeType={changeCellType}
                  onClick={handleCellClick}
                  onActivate={setActiveCellId}
                  onNavigateCell={(direction) => navigateCellRelative(cell.id, direction)}
                  onAddCell={(afterIndex) => addCell('code', '', afterIndex, true)}
                  onSave={handleManualSave}
                  onSetCellScrolled={setCellScrolled}
                  onSetCellScrolledHeight={setCellScrolledHeight}
                  searchHighlight={searchQuery}
                  queuePosition={queuePositionMap.get(cell.id) ?? -1}
                  indentConfig={indentConfig}
                  requestedFocusMode={pendingFocus?.cellId === cell.id ? pendingFocus.mode : null}
                  onFocusModeApplied={clearPendingFocus}
                  isSearchOpen={isSearchOpen}
                  onCloseSearch={handleSearchClose}
                  showLineNumbers={showLineNumbers}
                  showCellIds={showCellIds}
                  previewDiffStatus={isPreviewMode ? previewDiffMap.get(cell.id) : undefined}
                  kernelSessionId={kernelSessionId ?? undefined}
                />
              )}
            />
        </div>

        {/* Terminal Panel */}
        <TerminalPanel
          isOpen={isTerminalOpen}
          onClose={() => setIsTerminalOpen(false)}
          notebookPath={currentFileId}
        />

        {/* History Panel - toggle with ?history=true or status bar */}
        <HistoryPanel
          isOpen={isHistoryOpen}
          onClose={() => setIsHistoryOpen(false)}
          history={getFullHistory()}
          onPreview={setPreviewTimestamp}
          onExitPreview={() => setPreviewTimestamp(null)}
          previewTimestamp={previewTimestamp}
          onRequestRestore={setRestoreDialogTimestamp}
        />

        {/* Restore Dialog */}
        {restoreDialogTimestamp && previewCells && (
          <RestoreDialog
            isOpen={true}
            onClose={() => setRestoreDialogTimestamp(null)}
            targetTimestamp={restoreDialogTimestamp}
            currentCells={cells}
            previewCells={previewCells}
            onRestoreHere={handleRestoreHere}
            onSaveAsNew={handleSaveAsNew}
            suggestedFilename={currentFileId ? generateRestoredFilename(currentFileId, restoreDialogTimestamp) : undefined}
          />
        )}

        {/* Status Bar */}
        <div className="h-6 flex items-center justify-between px-2 bg-slate-100 dark:bg-slate-800 border-t border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-400 select-none shrink-0">
          {/* Left side */}
          <div className="flex items-center gap-3">
            <button
              onClick={() => setIsTerminalOpen(!isTerminalOpen)}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
                isTerminalOpen
                  ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
              title="Toggle Terminal (Ctrl+`)"
            >
              <Terminal className="w-3 h-3" />
              <span>Terminal</span>
            </button>
            <button
              onClick={() => setIsHistoryOpen(!isHistoryOpen)}
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
                isHistoryOpen
                  ? 'bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300'
                  : 'hover:bg-slate-200 dark:hover:bg-slate-700'
              }`}
              title="Toggle History Panel"
            >
              <History className="w-3 h-3" />
              <span>History</span>
            </button>
          </div>

          {/* Right side */}
          <div className="flex items-center gap-3">
            {/* Cell count */}
            <span className="flex items-center gap-1" title={`${cells.filter(c => c.type === 'code').length} code, ${cells.filter(c => c.type === 'markdown').length} markdown`}>
              <Layers className="w-3 h-3" />
              {cells.length} cells
            </span>

            {/* Kernel memory usage */}
            {memoryUsage && (
              <span className="flex items-center gap-1 tabular-nums" title="Kernel memory (RSS)">
                <MemoryStick className="w-3 h-3" />
                {(memoryUsage.used / 1024 / 1024).toFixed(0)} MB
              </span>
            )}

            {/* System resources (RAM, GPU) - opt-in to avoid any render overhead */}
            {showResourceMonitor && (
              <div className="border-l border-slate-200 pl-3">
                <ResourceStatusBar serverId={selectedServerId} />
              </div>
            )}
          </div>
        </div>

        <div className={`absolute bottom-14 left-1/2 -translate-x-1/2 flex gap-4 bg-white p-2 rounded-full shadow-lg border border-slate-200 z-20 ${agentSession ? 'opacity-50' : ''} ${isTerminalOpen ? 'hidden' : ''}`}>
            <button
              onClick={() => handleAddCell('code')}
              disabled={agentSession !== null}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${agentSession ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-blue-50 text-blue-600 hover:bg-blue-100'}`}
              title={agentSession ? 'Locked during agent session' : 'Add Code Cell'}
            >
              <Plus className="w-4 h-4" /> Code
            </button>
            <button
              onClick={() => handleAddCell('markdown')}
              disabled={agentSession !== null}
              className={`flex items-center gap-2 px-4 py-2 rounded-full font-medium transition-colors ${agentSession ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'}`}
              title={agentSession ? 'Locked during agent session' : 'Add Text Cell'}
            >
              <Plus className="w-4 h-4" /> Text
            </button>
        </div>
      </div>

      {/* AI Chat Sidebar */}
      <AIChatSidebar
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        cells={cells}
        fileId={currentFileId}
        onInsertCode={handleInsertCode}
        onEditCell={handleEditCell}
        onDeleteCell={handleDeleteCellByIndex}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onRefresh={handleSettingsChange}
      />

      {/* Kernel Manager Modal */}
      <KernelManager
        isOpen={isKernelManagerOpen}
        onClose={() => setIsKernelManagerOpen(false)}
        currentSessionId={kernelSessionId}
        serverId={selectedServerId}
        onKernelKilled={(sessionId) => {
          // If the killed kernel was our current session, reset state
          if (sessionId === kernelSessionId) {
            setKernelSessionId(null);
            setIsKernelReady(false);
            setKernelStatus('disconnected');
          }
        }}
      />

      {/* Notebook Search */}
      <NotebookSearch
        cells={cells}
        isOpen={isSearchOpen}
        onClose={handleSearchClose}
        onNavigateToCell={navigateToCell}
        onSearchChange={handleSearchChange}
        onReplace={handleReplace}
        onReplaceAllInCell={handleReplaceAllInCell}
        onReplaceAllInNotebook={handleReplaceAllInNotebook}
        activeCellId={activeCellId}
      />

      {/* Keyboard Shortcuts Help Modal */}
      {isKeyboardHelpOpen && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setIsKeyboardHelpOpen(false)}>
          <div className="bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 max-h-[80vh] overflow-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b">
              <h2 className="text-lg font-semibold text-slate-800">Keyboard Shortcuts</h2>
              <button onClick={() => setIsKeyboardHelpOpen(false)} className="p-1 hover:bg-slate-100 rounded">
                <X className="w-5 h-5 text-slate-500" />
              </button>
            </div>
            <div className="p-4 space-y-4">
              {/* Mode explanation */}
              <div className="bg-slate-50 rounded p-3 text-xs text-slate-600">
                <div className="flex items-center gap-2 mb-1">
                  <span className="inline-block w-3 h-3 rounded border-2 border-blue-400"></span>
                  <strong>Edit mode</strong>: Click editor to edit code
                </div>
                <div className="flex items-center gap-2">
                  <span className="inline-block w-3 h-3 rounded border-2 border-green-500"></span>
                  <strong>Cell mode</strong>: Click header or press Escape for cell commands
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Run (works in both modes)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Run and advance (preserves mode)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Shift + Enter</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Run cell</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Ctrl/Cmd + Enter</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Interrupt (when busy)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Ctrl/Cmd + C</kbd></div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Cell Mode (green border)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Navigate cells</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">↑ / ↓</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Enter edit mode</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Enter</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Insert cell above / below</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">A / B</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Delete cell</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Delete / Backspace</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Move cell up / down</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + Shift + ↑/↓</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Cut / Copy / Paste cell</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">X / C / V</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Enqueue / Dequeue cell (FIFO)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">E / D</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Convert to Markdown / Code</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">M / Y</kbd></div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Edit Mode (blue border)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Exit to cell mode</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Escape</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Undo / Redo (text only)</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + Z / Y</kbd></div>
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium text-slate-600 mb-2">Global (works everywhere)</h3>
                <div className="space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-slate-600">Save</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + S</kbd></div>
                  <div className="flex justify-between"><span className="text-slate-600">Search</span><kbd className="px-2 py-0.5 bg-slate-100 rounded text-xs">Cmd/Ctrl + F</kbd></div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
