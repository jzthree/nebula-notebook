
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Cell as CellComponent } from './Cell';
import { Cell, CellType, NotebookMetadata } from '../types';
import { kernelService, KernelSpec, PythonEnvironment } from '../services/kernelService';
import { getSettings, saveSettings } from '../services/llmService';
import { Plus, Play, Save, Menu, ChevronDown, RotateCw, Power, Sparkles, Undo2, Redo2, Settings, Square, Cloud, CloudOff, Loader2, Check, AlertCircle, RefreshCw, Download, Cpu } from 'lucide-react';
import { VirtuosoHandle } from 'react-virtuoso';
import {
  getFiles,
  getNotebookData,
  saveNotebookCells,
  getFileContentWithMtime,
  saveFileContentWithMtime,
  getFileMtime,
  getActiveFileId,
  saveActiveFileId,
  updateNotebookMetadata,
  renameFile,
  loadNotebookHistory,
  saveNotebookHistory
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
  const [lastKnownMtime, setLastKnownMtime] = useState<number | null>(null);
  const [conflictDialog, setConflictDialog] = useState<{
    show: boolean;
    remoteMtime: number;
    onKeepLocal: () => void;
    onLoadRemote: () => void;
  } | null>(null);
  const [pendingSave, setPendingSave] = useState(false);
  const [isOnline, setIsOnline] = useState(navigator.onLine);

  // Kernel State
  const [isKernelMenuOpen, setIsKernelMenuOpen] = useState(false);
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
    saveCheckpoint,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory,
    getFullHistory,
    loadHistory,
    logOperation,
    updateContentAI
  } = useUndoRedo([]);  // Start with empty cells

  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [indentConfig, setIndentConfig] = useState<IndentationConfig>(DEFAULT_INDENTATION);

  // Clipboard for cut/copy/paste cells
  const [cellClipboard, setCellClipboard] = useState<{ cell: Cell; isCut: boolean } | null>(null);

  // Virtuoso Handle for programmatic scrolling
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Debounced scroll to handle height changes during execution
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const pendingScrollRef = useRef<{ index: number; attempts: number } | null>(null);

  // Smart scroll that debounces rapid requests and retries on height changes
  const scrollToCellDebounced = useCallback((index: number, delay: number = 50) => {
    // Cancel any pending scroll
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }

    // Track this scroll request
    pendingScrollRef.current = { index, attempts: 0 };

    const performScroll = () => {
      if (!pendingScrollRef.current || pendingScrollRef.current.index !== index) {
        return; // Another scroll was requested, abort this one
      }

      virtuosoRef.current?.scrollToIndex({
        index,
        align: 'start',
        behavior: 'smooth',
        offset: -80
      });

      // After initial scroll, do one more adjustment after heights settle
      if (pendingScrollRef.current.attempts === 0) {
        pendingScrollRef.current.attempts = 1;
        scrollTimeoutRef.current = setTimeout(() => {
          if (pendingScrollRef.current?.index === index) {
            virtuosoRef.current?.scrollToIndex({
              index,
              align: 'start',
              behavior: 'auto', // Instant adjustment, no jarring smooth scroll
              offset: -80
            });
            pendingScrollRef.current = null;
          }
        }, 150); // Wait for output clearing to complete
      }
    };

    scrollTimeoutRef.current = setTimeout(performScroll, delay);
  }, []);

  // Cleanup scroll timeout on unmount
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // Ref for saveNow to avoid stale closures in keyboard handler
  const saveNowRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Autosave hook with conflict detection
  const performSaveToFile = useCallback(async (fileId: string, cellsToSave: Cell[]) => {
    try {
      // Check remote mtime before saving (if we have a baseline)
      if (lastKnownMtime !== null) {
        try {
          const remoteMtimeData = await getFileMtime(fileId);
          if (remoteMtimeData.mtime > lastKnownMtime) {
            // Remote file changed while we were editing - conflict!
            return new Promise<void>((resolve, reject) => {
              setConflictDialog({
                show: true,
                remoteMtime: remoteMtimeData.mtime,
                onKeepLocal: async () => {
                  setConflictDialog(null);
                  // Force save local version (with kernel name for persistence)
                  const result = await saveFileContentWithMtime(fileId, cellsToSave, currentKernel);
                  if (result) {
                    setLastKnownMtime(result.mtime);
                    await updateNotebookMetadata(fileId, {});
                    const history = getFullHistory();
                    if (history.length > 0) {
                      saveNotebookHistory(fileId, history).catch(() => {});
                    }
                  }
                  resolve();
                },
                onLoadRemote: async () => {
                  setConflictDialog(null);
                  // Reload from server
                  const content = await getFileContentWithMtime(fileId);
                  if (content) {
                    resetHistory(content.cells);
                    setLastKnownMtime(content.mtime);
                  }
                  resolve();
                }
              });
            });
          }
        } catch (mtimeError) {
          // Can't check mtime (network issue?) - proceed with save attempt
          console.warn('Could not check remote mtime:', mtimeError);
        }
      }

      // Perform the save (with kernel name for persistence)
      const result = await saveFileContentWithMtime(fileId, cellsToSave, currentKernel);
      if (result) {
        setLastKnownMtime(result.mtime);
        setPendingSave(false);
      }
      await updateNotebookMetadata(fileId, {});

      // Save history in background (non-blocking)
      const history = getFullHistory();
      if (history.length > 0) {
        saveNotebookHistory(fileId, history).catch(() => {});
      }
    } catch (error) {
      // Network error - mark as pending and will retry when online
      console.warn('Save failed, will retry:', error);
      setPendingSave(true);
      throw error; // Re-throw so autosave knows it failed
    }
  }, [getFullHistory, lastKnownMtime, resetHistory, currentKernel]);

  const { status: autosaveStatus, saveNow } = useAutosave({
    fileId: currentFileId,
    cells,
    onSave: performSaveToFile,
    enabled: true,
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

      try {
        // Check if file was modified on server while disconnected
        const { mtime: currentMtime } = await getFileMtime(currentFileId);

        if (lastKnownMtime && currentMtime > lastKnownMtime) {
          // File was modified on server - show conflict dialog
          console.log('File modified on server during disconnect, showing conflict dialog');
          setConflictDialog({
            show: true,
            remoteMtime: currentMtime,
            onKeepLocal: async () => {
              // Force save our local version
              await saveNow();
              setLastKnownMtime(currentMtime);
              setConflictDialog(null);
            },
            onLoadRemote: async () => {
              // Reload from server
              const result = await getFileContentWithMtime(currentFileId);
              if (result) {
                resetHistory(result.cells);
                setLastKnownMtime(result.mtime);
              }
              setConflictDialog(null);
            },
          });
        } else {
          // No conflict - autosave current state
          console.log('No file conflict, autosaving...');
          await saveNow();
        }
      } catch (error) {
        console.error('Error checking file after reconnect:', error);
        // Still try to save
        saveNow().catch(() => {});
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
  }, [currentFileId, kernelSessionId, lastKnownMtime, saveNow, resetHistory]);

  // Execution State
  const [isKernelReady, setIsKernelReady] = useState(false);
  const [executionQueue, setExecutionQueue] = useState<string[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [kernelExecutionCount, setKernelExecutionCount] = useState(0); // Global execution counter
  const executionStartTimeRef = useRef<number | null>(null); // Track when queue execution started


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

  // Ref for tracking 'dd' vim-style delete
  const lastKeyRef = useRef<{ key: string; time: number } | null>(null);
  const deleteCellRef = useRef<((id: string) => void) | null>(null);
  const runAndAdvanceRef = useRef<((id: string) => void) | null>(null);
  const queueExecutionRef = useRef<((id: string) => void) | null>(null);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

      // Ctrl+S: Save (works everywhere)
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        saveNowRef.current();
        return;
      }

      // Ctrl+F: Search (works everywhere)
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault();
        setIsSearchOpen(true);
        return;
      }

      // Ctrl+Z / Ctrl+Shift+Z are handled by CodeMirror for per-cell undo/redo
      // Notebook-level undo/redo is available via toolbar buttons

      // Shift+Enter and Ctrl+Enter are handled by Cell.tsx when in editor
      // Only handle here when in command mode (not focused in an input/editor)
      if (!isInput) {
        // Shift+Enter: Run active cell and advance
        if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          if (activeCellId) {
            runAndAdvanceRef.current?.(activeCellId);
          }
          return;
        }

        // Ctrl/Cmd+Enter: Run active cell
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey) {
          e.preventDefault();
          if (activeCellId) {
            queueExecutionRef.current?.(activeCellId);
          }
          return;
        }
      }

      // The following shortcuts only work when not in an input field
      if (isInput) return;

      // Arrow key navigation between cells
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const currentIndex = activeCellId
          ? cells.findIndex(c => c.id === activeCellId)
          : -1;

        if (e.key === 'ArrowUp' && currentIndex > 0) {
          setActiveCellId(cells[currentIndex - 1].id);
        } else if (e.key === 'ArrowDown' && currentIndex < cells.length - 1) {
          setActiveCellId(cells[currentIndex + 1].id);
        } else if (currentIndex === -1 && cells.length > 0) {
          // No cell selected, select first or last based on direction
          setActiveCellId(e.key === 'ArrowDown' ? cells[0].id : cells[cells.length - 1].id);
        }
        return;
      }

      // Vim-style 'dd' to delete cell
      if (e.key === 'd') {
        const now = Date.now();
        if (lastKeyRef.current?.key === 'd' && now - lastKeyRef.current.time < 500) {
          // Double 'd' pressed within 500ms - delete active cell
          if (activeCellId && deleteCellRef.current) {
            e.preventDefault();
            deleteCellRef.current(activeCellId);
          }
          lastKeyRef.current = null;
        } else {
          lastKeyRef.current = { key: 'd', time: now };
        }
        return;
      }

      // Reset 'd' tracking on any other key
      lastKeyRef.current = null;

      // Jupyter-style shortcuts (command mode only - not in input fields)
      const currentIndex = activeCellId ? cells.findIndex(c => c.id === activeCellId) : -1;

      // A - Insert cell above
      if (e.key === 'a') {
        e.preventDefault();
        const idx = currentIndex !== -1 ? currentIndex : 0;
        addCell('code', '', idx, 'above');
        return;
      }

      // B - Insert cell below
      if (e.key === 'b') {
        e.preventDefault();
        const idx = currentIndex !== -1 ? currentIndex : cells.length - 1;
        addCell('code', '', idx, 'below');
        return;
      }

      // M - Convert cell to Markdown
      if (e.key === 'm' && activeCellId) {
        e.preventDefault();
        changeCellType(activeCellId, 'markdown');
        return;
      }

      // Y - Convert cell to Code
      if (e.key === 'y' && activeCellId) {
        e.preventDefault();
        changeCellType(activeCellId, 'code');
        return;
      }

      // X - Cut cell
      if (e.key === 'x' && activeCellId && deleteCellRef.current) {
        e.preventDefault();
        const cellToCut = cells.find(c => c.id === activeCellId);
        if (cellToCut) {
          setCellClipboard({ cell: { ...cellToCut }, isCut: true });
          deleteCellRef.current(activeCellId);
        }
        return;
      }

      // C - Copy cell
      if (e.key === 'c' && activeCellId) {
        e.preventDefault();
        const cellToCopy = cells.find(c => c.id === activeCellId);
        if (cellToCopy) {
          setCellClipboard({ cell: { ...cellToCopy }, isCut: false });
        }
        return;
      }

      // V - Paste cell below, Shift+V - Paste cell above
      if (e.key === 'v' && cellClipboard) {
        e.preventDefault();
        const position = e.shiftKey ? 'above' : 'below';
        const idx = currentIndex !== -1 ? currentIndex : cells.length - 1;
        addCell(cellClipboard.cell.type, cellClipboard.cell.content, idx, position);
        // Clear clipboard if it was a cut operation
        if (cellClipboard.isCut) {
          setCellClipboard(null);
        }
        return;
      }

      // Enter - Focus active cell editor (enter edit mode)
      if (e.key === 'Enter' && activeCellId) {
        e.preventDefault();
        // Find and focus the CodeMirror editor for the active cell
        const cellElement = document.querySelector(`[data-cell-id="${activeCellId}"] .cm-content`);
        if (cellElement instanceof HTMLElement) {
          cellElement.focus();
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, cells, activeCellId, cellClipboard]);

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
      saveNow(); // Save current file before switching
    }

    // Detect indentation from loaded cells
    const detectedIndent = detectIndentationFromCells(content);
    setIndentConfig(detectedIndent);

    resetHistory(content);

    // Set UI state immediately - don't block on history loading
    setCurrentFileId(id);
    saveActiveFileId(id);
    setActiveCellId(content.length > 0 ? content[0].id : null);
    setIsLoadingFile(false);

    // Load persisted history in background (non-blocking)
    loadNotebookHistory(id)
      .then(savedHistory => {
        if (savedHistory.length > 0) {
          loadHistory(savedHistory);
        }
      })
      .catch(() => {
        // Silently ignore history load failures
      });

    const meta = files.find(f => f.id === id);
    if (meta) setCurrentFileMetadata(meta);

    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollTo({ top: 0 });
    });

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
    await saveNow();
    await refreshFileList();
  }, [saveNow]);

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
      // Clear all cell outputs and reset execution counter
      setCells(prev => prev.map(c => ({ ...c, outputs: [], executionCount: undefined })));
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

  const addCell = (type: CellType = 'code', content: string = '', afterIndex?: number, noScroll?: boolean) => {
    const newCell: Cell = {
      id: crypto.randomUUID(),
      type,
      content,
      outputs: [],
      isExecuting: false
    };

    // Calculate insertion index
    const insertIndex = (afterIndex !== undefined && afterIndex >= 0 && afterIndex < cells.length)
      ? afterIndex + 1
      : cells.length;

    undoableInsertCell(insertIndex, newCell);
    setActiveCellId(newCell.id);

    // Only scroll if not explicitly disabled (e.g., toolbar plus button shouldn't scroll)
    if (!noScroll) {
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: insertIndex,
          align: 'start',
          behavior: 'smooth',
          offset: -80
        });
      });
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
  const handleUpdateCell = useCallback((id: string, content: string) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, content } : c));
  }, [setCells]);

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
    changeType(id, type);
  };

  const deleteCell = (id: string) => {
    const idx = cells.findIndex(c => c.id === id);
    if (idx === -1) return;

    if (cells.length > 1) {
      // Determine which cell to select after deletion
      const nextIdx = idx < cells.length - 1 ? idx : idx - 1;
      const nextCellId = cells[nextIdx === idx ? idx + 1 : nextIdx]?.id;

      undoableDeleteCell(idx);

      // Select the next cell but don't scroll - this keeps the cursor
      // in the same position, naturally landing on the delete button
      // of the next cell for rapid deletion
      if (nextCellId) {
        setActiveCellId(nextCellId);
      }
    } else {
      // Can't delete last cell, just clear it
      updateContent(id, '');
    }
  };
  // Update ref for keyboard shortcut handler
  deleteCellRef.current = deleteCell;

  const moveCell = (id: string, direction: 'up' | 'down') => {
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
    saveCheckpoint();
    setExecutionQueue(prev => [...prev, id]);
    // Log cell run for history
    // Note: content is NOT stored here - it's reconstructed from edit history + snapshot
    const cellIndex = cells.findIndex(c => c.id === id);
    if (cellIndex >= 0) {
      logOperation({ type: 'runCell', cellId: id, cellIndex });
    }
  };

  const runAndAdvance = (id: string) => {
    queueExecution(id);
    const currentIndex = cells.findIndex(c => c.id === id);
    if (currentIndex < cells.length - 1) {
      // Move to next cell and scroll to it
      // Use debounced scroll to handle height changes when outputs are cleared/regenerated
      const nextIndex = currentIndex + 1;
      setActiveCellId(cells[nextIndex].id);
      scrollToCellDebounced(nextIndex);
    } else {
      // Create new cell at the end (addCell already handles scrolling via setActiveCellId)
      addCell('code', '', currentIndex);
    }
  };

  // Update refs for keyboard shortcut handler
  runAndAdvanceRef.current = runAndAdvance;
  queueExecutionRef.current = queueExecution;

  // Navigate to a specific cell (used by search)
  const navigateToCell = useCallback((cellIndex: number, cellId: string) => {
    setActiveCellId(cellId);
    virtuosoRef.current?.scrollToIndex({
      index: cellIndex,
      align: 'start',    // Start alignment ensures code editor (at top of cell) is visible
      behavior: 'smooth',
      offset: -80        // Small offset so cell isn't flush with top (accounts for header)
    });
  }, []);

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

      if (cell && cell.type === 'code') {
        const cellStartTime = Date.now();
        let hasError = false;
        const collectedOutputs: string[] = []; // Track outputs for history

        setCells(prev => prev.map(c => c.id === cellId ? { ...c, isExecuting: true, outputs: [] } : c));

        try {
          await kernelService.executeCode(kernelSessionId, cell.content, (output) => {
            if (output.type === 'error') {
              hasError = true;
            }
            // Collect text outputs for history (skip images/html)
            if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'error') {
              collectedOutputs.push(output.content);
            }
            setCells(prev => prev.map(c => {
              if (c.id !== cellId) return c;
              return { ...c, outputs: [...c.outputs, output] };
            }));
          });
        } catch (error) {
          console.error('Execution error:', error);
          hasError = true;
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
            executionCount: newCount
          } : c));
          return newCount;
        });
      } else {
        // Non-code cell or cell not found, just mark as done
        setCells(prev => prev.map(c => c.id === cellId ? { ...c, isExecuting: false } : c));
      }

      setExecutionQueue(prev => prev.slice(1));
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
                  onClick={conflictDialog.onKeepLocal}
                  className="w-full px-4 py-2.5 text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 rounded-lg transition-colors"
                >
                  Keep My Changes
                  <span className="block text-xs font-normal text-blue-200 mt-0.5">
                    Overwrite server version with your local edits
                  </span>
                </button>
                <button
                  onClick={conflictDialog.onLoadRemote}
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

                          <div className="border-t border-slate-100 mt-1 pt-1">
                            <button
                              onClick={restartKernel}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <RotateCw className="w-3 h-3" /> Restart Kernel
                            </button>
                            {kernelStatus === 'busy' && (
                              <button
                                onClick={interruptKernel}
                                className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2"
                              >
                                <Square className="w-3 h-3" /> Interrupt
                              </button>
                            )}
                            <button
                              onClick={() => { setIsKernelMenuOpen(false); setIsKernelManagerOpen(true); }}
                              className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 flex items-center gap-2"
                            >
                              <Cpu className="w-3 h-3" /> Manage All Kernels
                            </button>
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
                        {autosaveStatus.status === 'unsaved' && !pendingSave && (
                          <span className="flex items-center gap-1 text-amber-600" title="Unsaved changes">
                            <Cloud className="w-3 h-3" />
                            <span className="text-slate-400">Unsaved</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'error' && !pendingSave && (
                          <span className="flex items-center gap-1 text-red-600" title="Save failed">
                            <AlertCircle className="w-3 h-3" />
                            <span>Save failed</span>
                          </span>
                        )}
                      </span>

                      {/* Execution Indicator - subtle shortcut to jump to running cell */}
                      {executionQueue.length > 0 && (() => {
                        const executingCellId = executionQueue[0];
                        const executingCellIndex = cells.findIndex(c => c.id === executingCellId);
                        const queueLength = executionQueue.length;
                        return (
                          <button
                            onClick={() => {
                              if (executingCellIndex >= 0) {
                                setActiveCellId(executingCellId);
                                virtuosoRef.current?.scrollToIndex({
                                  index: executingCellIndex,
                                  align: 'start',
                                  behavior: 'smooth',
                                  offset: -80
                                });
                              }
                            }}
                            className="flex items-center gap-1 px-1.5 py-0.5 text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
                            title={`Jump to cell ${executingCellIndex + 1}${queueLength > 1 ? ` (${queueLength - 1} more queued)` : ''}`}
                          >
                            <Loader2 className="w-3 h-3 animate-spin text-amber-500" />
                            <span className="tabular-nums">[{executingCellIndex + 1}]</span>
                            {queueLength > 1 && (
                              <span className="text-gray-400">+{queueLength - 1}</span>
                            )}
                          </button>
                        );
                      })()}
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
                      title="Notebook Undo (cell insert/delete/move)"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={redo}
                      disabled={!canRedo}
                      className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
                      title="Notebook Redo (cell insert/delete/move)"
                    >
                      <Redo2 className="w-4 h-4" />
                    </button>
                  </div>

                  <button
                    onClick={() => setIsSettingsOpen(true)}
                    className="btn-secondary hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                  <button onClick={saveCurrentNotebook} className="btn-secondary hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-slate-200 text-slate-600 text-xs font-medium transition-colors">
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
              renderCell={(cell, idx) => (
                  <CellComponent
                  key={cell.id}
                  cell={cell}
                  index={idx}
                  isActive={activeCellId === cell.id}
                  allCells={cells}
                  onUpdate={handleUpdateCell}
                  onAIUpdate={handleAIUpdateCell}
                  onRun={queueExecution}
                  onRunAndAdvance={runAndAdvance}
                  onDelete={deleteCell}
                  onMove={moveCell}
                  onChangeType={changeCellType}
                  onClick={setActiveCellId}
                  onAddCell={(afterIndex) => addCell('code', '', afterIndex, true)}
                  onSave={saveNow}
                  searchHighlight={searchQuery}
                  queuePosition={executionQueue.indexOf(cell.id)}
                  indentConfig={indentConfig}
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
    </div>
  );
};
