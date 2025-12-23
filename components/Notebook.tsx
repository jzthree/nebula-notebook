
import React, { useEffect, useLayoutEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Cell as CellComponent } from './Cell';
import { Cell, CellType, NotebookMetadata } from '../types';
import { kernelService, KernelSpec, PythonEnvironment } from '../services/kernelService';
import { getSettings, saveSettings, IndentationPreference } from '../services/llmService';
import { Plus, Play, Save, Menu, ChevronDown, RotateCw, Power, Sparkles, Undo2, Redo2, Settings, Square, Cloud, CloudOff, Loader2, Check, AlertCircle, RefreshCw, Download, Cpu, Keyboard, X, CheckCircle, XCircle, Layers } from 'lucide-react';
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
  saveNotebookSession
} from '../services/fileService';
import { FileBrowser } from './FileBrowser';
import { AIChatSidebar } from './AIChatSidebar';
import { VirtualCellList } from './VirtualCellList';
import { useUndoRedo } from '../hooks/useUndoRedo';
import { SettingsModal } from './SettingsModal';
import { KernelManager } from './KernelManager';
import { NotebookSearch } from './NotebookSearch';
import { NotebookBreadcrumb } from './NotebookBreadcrumb';
import { useAutosave, formatLastSaved } from '../hooks/useAutosave';
import { useNotification } from './NotificationSystem';
import { useConflictResolution } from '../hooks/useConflictResolution';
import { detectIndentationFromCells, IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';
import { getNotebookAvatar, updateFavicon, resetFavicon } from '../utils/notebookAvatar';
import { playSuccessSound } from '../utils/notificationSound';

// Initial cell for reset
const INITIAL_CELL: Cell = {
  id: crypto.randomUUID(),
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

export const Notebook: React.FC = () => {
  const { toast, confirm } = useNotification();

  // File System State
  const [files, setFiles] = useState<NotebookMetadata[]>([]);
  const [currentFileId, setCurrentFileId] = useState<string | null>(getInitialFileId);
  const [isLoadingFile, setIsLoadingFile] = useState(!!getInitialFileId());
  const [currentFileMetadata, setCurrentFileMetadata] = useState<NotebookMetadata | null>(null);
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isKernelManagerOpen, setIsKernelManagerOpen] = useState(false);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isKeyboardHelpOpen, setIsKeyboardHelpOpen] = useState(false);
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

  // Helper to update both state AND ref synchronously to prevent race conditions
  const setLastKnownMtime = useCallback((mtime: number | null) => {
    lastKnownMtimeRef.current = mtime;  // Update ref immediately (source of truth)
    setLastKnownMtimeState(mtime);      // Update state for re-render
  }, []);
  const [pendingSave, setPendingSave] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);


  // Kernel State
  const [isKernelMenuOpen, setIsKernelMenuOpen] = useState(false);
  const [isExecutionQueueOpen, setIsExecutionQueueOpen] = useState(false);
  const [availableKernels, setAvailableKernels] = useState<KernelSpec[]>([]);
  const [pythonEnvironments, setPythonEnvironments] = useState<PythonEnvironment[]>([]);
  const [currentKernel, setCurrentKernel] = useState<string>('python3');
  const [kernelSessionId, setKernelSessionId] = useState<string | null>(null);
  const [kernelStatus, setKernelStatus] = useState<'idle' | 'busy' | 'starting' | 'disconnected'>('disconnected');
  const [isDiscoveringPythons, setIsDiscoveringPythons] = useState(false);
  const [isInstallingKernel, setIsInstallingKernel] = useState<string | null>(null);

  // Undo/Redo & State Management (operation-based)
  const {
    cells,
    setCells,
    insertCell: undoableInsertCell,
    deleteCell: undoableDeleteCell,
    moveCell: undoableMoveCell,
    updateContent,
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
    resetHistory,
    getFullHistory,
    loadHistory,
    logOperation,
    updateContentAI,
    redoStackLength,
    commitHistoryBeforeKeyframe,
    hasRedoToFlush,
    getUnflushedState,
    setUnflushedState,
  } = useUndoRedo([]);  // Start with empty cells

  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [indentConfig, setIndentConfig] = useState<IndentationConfig>(DEFAULT_INDENTATION);

  // Conflict resolution hook
  const {
    conflictDialog,
    saveWithCheck,
    keepLocal,
    loadRemote,
    dismissDialog: dismissConflictDialog
  } = useConflictResolution(
    setLastKnownMtime,
    resetHistory
  );

  // Clipboard for cut/copy/paste cells
  const [cellClipboard, setCellClipboard] = useState<CellClipboardItem | null>(null);

  // FIFO queue for cells (separate from clipboard) - enqueue with 'e', dequeue with 'd'
  const [cellQueue, setCellQueue] = useState<CellClipboardItem[]>([]);
  const cellQueueRef = useRef<CellClipboardItem[]>([]);

  const cellsRef = useRef<Cell[]>(cells);
  const activeCellIdRef = useRef<string | null>(activeCellId);
  const cellClipboardRef = useRef<CellClipboardItem | null>(cellClipboard);

  cellsRef.current = cells;
  activeCellIdRef.current = activeCellId;
  cellClipboardRef.current = cellClipboard;
  cellQueueRef.current = cellQueue;

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
      const history = getFullHistory();

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

        // Save session state (unflushed edits) alongside notebook
        const unflushedState = getUnflushedState(activeCellIdRef.current, cellsToSave);
        await saveNotebookSession(fileId, { unflushedEdit: unflushedState ?? undefined });
      } else if (result.error) {
        throw new Error(result.error);
      }
    } catch (error) {
      // Network error - mark as pending and will retry when online
      console.warn('Save failed, will retry:', error);
      setPendingSave(true);
      throw error; // Re-throw so autosave knows it failed
    }
  }, [getFullHistory, currentKernel, saveWithCheck, getUnflushedState]);

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

    return () => {
      unsubscribeReconnect();
      unsubscribeDisconnect();
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

  // Fetch available kernels and initialize
  // Load Python environments (separate from kernel init for faster startup)
  const loadPythonEnvironments = useCallback(async (refresh: boolean = false) => {
    try {
      setIsDiscoveringPythons(true);
      const data = await kernelService.getPythonEnvironments(refresh);
      setAvailableKernels(data.kernelspecs);
      setPythonEnvironments(data.environments);
    } catch (error) {
      console.error('Failed to load Python environments:', error);
    } finally {
      setIsDiscoveringPythons(false);
    }
  }, []);

  // Install kernel for a Python environment
  const installKernelForPython = useCallback(async (pythonPath: string) => {
    try {
      setIsInstallingKernel(pythonPath);
      const result = await kernelService.installKernel(pythonPath);

      // Refresh the environments list to show the new kernel
      await loadPythonEnvironments(true);

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
  }, [loadPythonEnvironments]);

  useEffect(() => {
    const initKernels = async () => {
      try {
        // Just load available kernels on startup, don't start one yet
        // Kernel will be started when a file is loaded
        const kernels = await kernelService.getAvailableKernels();
        setAvailableKernels(kernels);

        // Get saved kernel preference
        const settings = getSettings();
        const preferredKernel = settings.lastKernel || 'python3';
        const kernelExists = kernels.some(k => k.name === preferredKernel);
        setCurrentKernel(kernelExists ? preferredKernel : (kernels[0]?.name || 'python3'));

        // Load Python environments in background (uses cache)
        loadPythonEnvironments(false);
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
      const settings = getSettings();
      getNotebookAvatar(currentFileId, {
        useAI: settings.useAIAvatars ?? false,
        // AI generation function would go here if implemented
      }).then(avatarUrl => {
        updateFavicon(avatarUrl);
      });
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
          cellElement.focus();
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

    resetHistory(content);

    // Set UI state immediately - don't block on history loading
    setCurrentFileId(id);
    saveActiveFileId(id);
    setActiveCellId(content.length > 0 ? content[0].id : null);
    setIsLoadingFile(false);

    // Load persisted history and session state in background (non-blocking)
    Promise.all([
      loadNotebookHistory(id),
      loadNotebookSession(id)
    ])
      .then(([savedHistory, savedSession]) => {
        if (savedHistory.length > 0) {
          loadHistory(savedHistory);
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
        }
      })
      .catch(() => {
        // Silently ignore history/session load failures
      });

    const meta = files.find(f => f.id === id);
    if (meta) setCurrentFileMetadata(meta);
    // Note: No need to scroll to top - Virtuoso resets when key={currentFileId} changes

    // Use kernel from notebook file if available, otherwise use current kernel preference
    // Also verify the kernel exists in available kernels
    let kernelToUse = notebookKernel || currentKernel;
    const kernelExists = availableKernels.some(k => k.name === kernelToUse);
    if (!kernelExists && availableKernels.length > 0) {
      // Fall back to first available kernel if the specified one doesn't exist
      kernelToUse = availableKernels[0].name;
    }

    // Update current kernel state to reflect what we're actually using
    if (kernelToUse !== currentKernel) {
      setCurrentKernel(kernelToUse);
    }

    // Get or create kernel for this file (one notebook = one kernel)
    try {
      setKernelStatus('starting');
      const sessionId = await kernelService.getOrCreateKernelForFile(id, kernelToUse);
      setKernelSessionId(sessionId);
      setIsKernelReady(true);
      setKernelStatus('idle');
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

  // --- KERNEL OPERATIONS ---

  const switchKernel = async (kernelName: string) => {
    setIsKernelMenuOpen(false);
    setKernelStatus('starting');
    setIsKernelReady(false);

    try {
      // Use getOrCreateKernelForFile which handles kernel switching on the backend
      // (it will stop the old kernel if kernel type differs)
      if (currentFileId) {
        const newSessionId = await kernelService.getOrCreateKernelForFile(currentFileId, kernelName);
        setKernelSessionId(newSessionId);
      } else {
        // No file open, just start a standalone kernel
        if (kernelSessionId) {
          await kernelService.stopKernel(kernelSessionId);
        }
        const newSessionId = await kernelService.startKernel(kernelName);
        setKernelSessionId(newSessionId);
      }
      setCurrentKernel(kernelName);
      setIsKernelReady(true);
      setKernelStatus('idle');
      saveSettings({ lastKernel: kernelName });
    } catch (error) {
      console.error('Failed to switch kernel:', error);
      setKernelStatus('disconnected');
    }
  };

  const restartKernel = async () => {
    setIsKernelMenuOpen(false);
    setKernelStatus('starting');

    try {
      if (kernelSessionId) {
        await kernelService.restartKernel(kernelSessionId);
      }
      setKernelStatus('idle');
      // Reset execution counter but preserve outputs
      setCells(prev => prev.map(c => ({ ...c, executionCount: undefined })));
      setKernelExecutionCount(0);
      // Log kernel restart for history
      logOperation({ type: 'restartKernel' });
    } catch (error) {
      console.error('Failed to restart kernel:', error);
      setKernelStatus('disconnected');
    }
  };

  const interruptKernel = async () => {
    try {
      if (kernelSessionId) {
        await kernelService.interruptKernel(kernelSessionId);
      }
      setExecutionQueue([]);
      setIsProcessingQueue(false);
      setCells(prev => prev.map(c => ({ ...c, isExecuting: false })));
      // Log kernel interrupt for history
      logOperation({ type: 'interruptKernel' });
    } catch (error) {
      console.error('Failed to interrupt kernel:', error);
    }
  };

  // --- CELL OPERATIONS ---

  const addCell = (type: CellType = 'code', content: string = '', afterIndex?: number, noScroll?: boolean | 'cell' | 'editor') => {
    // Keyframe: flush active cell before insert
    flushActiveCell();

    const currentCells = cellsRef.current;
    const existingIds = new Set(currentCells.map(c => c.id));
    let newId = crypto.randomUUID();
    while (existingIds.has(newId)) {
      newId = crypto.randomUUID();
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

  const queueExecution = (id: string) => {
    // Keyframe: flush active cell before execution
    flushActiveCell();

    setExecutionQueue(prev => [...prev, id]);
    // Log cell run for history
    // Note: content is NOT stored here - it's reconstructed from edit history + snapshot
    const cellIndex = cells.findIndex(c => c.id === id);
    if (cellIndex >= 0) {
      logOperation({ type: 'runCell', cellId: id, cellIndex });
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
  const navigateToCell = useCallback((cellIndex: number, cellId: string) => {
    setActiveCellId(cellId);
    scrollToCell(cellIndex);
  }, [scrollToCell]);

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
                content: `\n⚠️ Output limit reached (${totalOutputLines.toLocaleString()} lines). Additional output not displayed.`
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
        // Truncate output to keep history file size reasonable
        const fullOutput = collectedOutputs.join('\n');
        const truncatedOutput = fullOutput.length > 2000
          ? fullOutput.slice(0, 2000) + '...[truncated]'
          : fullOutput;

        logOperation({
          type: 'executionComplete',
          cellId,
          cellIndex,
          durationMs,
          success: !hasError,
          output: truncatedOutput || undefined
        });

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
          if (Notification.permission === 'granted') {
            const minutes = Math.floor(elapsedSeconds / 60);
            const seconds = Math.floor(elapsedSeconds % 60);
            const timeStr = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;

            new Notification('Nebula Notebook', {
              body: `Execution completed in ${timeStr}`,
              icon: '/favicon.svg',
              tag: 'execution-complete', // Prevents duplicate notifications
            });
          } else if (Notification.permission === 'default') {
            // Request permission for future notifications
            Notification.requestPermission();
          }
        }
      }

      executionStartTimeRef.current = null;
    }

    prevQueueLengthRef.current = currentLength;
  }, [executionQueue.length]);

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

  return (
    <div className="flex min-h-screen bg-slate-50 relative overflow-hidden">

      {/* File Browser Sidebar */}
      <FileBrowser
        files={files}
        currentFileId={currentFileId}
        onSelect={loadFile}
        onRefresh={refreshFileList}
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
      />

      {/* Main Content */}
      <div className={`flex-1 flex flex-col h-screen transition-all duration-300 ${isFileBrowserOpen ? 'lg:ml-72' : ''} ${isChatOpen ? 'lg:mr-80' : ''}`}>

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
                    <h1 className="text-lg font-bold text-slate-800 flex items-center gap-2 truncate max-w-[150px] sm:max-w-md">
                      {isRenamingNotebook ? (
                        <input
                          type="text"
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={finishRenameNotebook}
                          onKeyDown={handleRenameKeyDown}
                          className="text-lg font-bold bg-white border border-blue-400 rounded px-2 py-0.5 focus:outline-none focus:ring-2 focus:ring-blue-500 max-w-[200px]"
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
                               <div className="text-xs font-semibold text-slate-900">Active Kernel</div>
                               <div className="text-[10px] text-slate-500">{getKernelDisplayName()} ({kernelStatus})</div>
                             </div>
                             <button
                               onClick={(e) => { e.stopPropagation(); loadPythonEnvironments(true); }}
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
                              onClick={interruptKernel}
                              disabled={kernelStatus !== 'busy'}
                              className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              <Square className="w-3 h-3" /> Interrupt
                            </button>
                            <button
                              onClick={restartKernel}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <RotateCw className="w-3 h-3" /> Restart Kernel
                            </button>
                            <button
                              onClick={() => { setIsKernelMenuOpen(false); setIsKernelManagerOpen(true); }}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <Cpu className="w-3 h-3" /> Manage All Kernels
                            </button>
                          </div>

                          <div className="overflow-y-auto flex-1">
                            {/* Registered Kernels */}
                            <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50">
                              Jupyter Kernels
                            </div>
                            {availableKernels.map(kernel => (
                              <button
                                key={kernel.name}
                                onClick={() => switchKernel(kernel.name)}
                                className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 ${
                                  kernel.name === currentKernel ? 'bg-blue-50 text-blue-700' : 'text-slate-700'
                                }`}
                              >
                                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${kernel.name === currentKernel ? 'bg-blue-500' : 'bg-green-500'}`}></span>
                                <span className="truncate flex-1">{kernel.display_name}</span>
                                <span className="text-[10px] text-slate-400">{kernel.language}</span>
                              </button>
                            ))}

                            {/* Discovered Python Environments */}
                            {pythonEnvironments.length > 0 && (
                              <>
                                <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 mt-1 flex items-center justify-between">
                                  <span>Python Environments ({pythonEnvironments.length})</span>
                                  {isDiscoveringPythons && <Loader2 className="w-3 h-3 animate-spin" />}
                                </div>
                                {pythonEnvironments.map(env => {
                                  // Check if this env is already a registered kernel
                                  const isRegistered = availableKernels.some(k =>
                                    k.path?.includes(env.path.replace('/bin/python', '')) ||
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
                                        <div className="text-[10px] text-slate-400 truncate">{env.path}</div>
                                      </div>
                                      {isRegistered ? (
                                        <span className="text-[10px] text-green-600 flex-shrink-0">Registered</span>
                                      ) : (
                                        <button
                                          onClick={(e) => { e.stopPropagation(); installKernelForPython(env.path); }}
                                          disabled={isInstallingKernel === env.path}
                                          className={`flex items-center gap-1 px-2 py-1 text-[10px] rounded transition-colors flex-shrink-0 ${
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

                      {/* Save Status Indicator */}
                      <span className="flex items-center gap-1 text-xs">
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
                                className="absolute top-full right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-xl z-50 min-w-[200px] py-1"
                                onMouseLeave={() => setIsExecutionQueueOpen(false)}
                              >
                                {/* Header */}
                                <div className="px-3 py-2 border-b border-slate-100">
                                  <div className="text-xs font-semibold text-slate-900">Execution Queue</div>
                                  <div className="text-[10px] text-slate-500">{executionQueue.length} cell{executionQueue.length > 1 ? 's' : ''} queued</div>
                                </div>
                                
                                {/* Queue Items */}
                                <div className="max-h-[300px] overflow-y-auto">
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
                    logOperation({ type: 'runAllCells', cellCount: cells.filter(c => c.type === 'code').length });
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

        {/* Virtuoso Scrollable Area */}
        <div className="flex-1 h-full pt-3">
            {/* Force remount when file changes to recalculate cell heights */}
            <VirtualCellList
              key={currentFileId || 'empty'}
              cells={cells}
              virtuosoRef={virtuosoRef}
              className="h-full"
              onRangeChange={handleRangeChange}
              renderCell={(cell, idx) => (
                  <CellComponent
                  key={cell.id}
                  cell={cell}
                  index={idx}
                  isActive={activeCellId === cell.id}
                  isHighlighted={highlightedCellIds.has(cell.id)}
                  allCells={cells}
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
                />
              )}
            />
        </div>

        <div className="absolute bottom-8 left-1/2 -translate-x-1/2 flex gap-4 bg-white p-2 rounded-full shadow-lg border border-slate-200 z-20">
            <button
              onClick={() => handleAddCell('code')}
              className="flex items-center gap-2 px-4 py-2 bg-blue-50 text-blue-600 rounded-full hover:bg-blue-100 font-medium transition-colors"
            >
              <Plus className="w-4 h-4" /> Code
            </button>
            <button
              onClick={() => handleAddCell('markdown')}
              className="flex items-center gap-2 px-4 py-2 bg-slate-50 text-slate-600 rounded-full hover:bg-slate-100 font-medium transition-colors"
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
        onRefresh={refreshFileList}
      />

      {/* Kernel Manager Modal */}
      <KernelManager
        isOpen={isKernelManagerOpen}
        onClose={() => setIsKernelManagerOpen(false)}
        currentSessionId={kernelSessionId}
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
