
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Cell as CellComponent } from './Cell';
import { Cell, CellType, NotebookMetadata } from '../types';
import { kernelService, KernelSpec, PythonEnvironment } from '../services/kernelService';
import { getSettings, saveSettings } from '../services/llmService';
import { Plus, Play, Trash, Save, Menu, ChevronDown, RotateCw, Power, Sparkles, Undo2, Redo2, Settings, Square, Cloud, CloudOff, Loader2, Check, AlertCircle, RefreshCw, Download, Cpu } from 'lucide-react';
import { VirtuosoHandle } from 'react-virtuoso';
import {
  getFiles,
  getFileContent,
  saveFileContent,
  getActiveFileId,
  saveActiveFileId,
  updateNotebookMetadata,
  renameFile
} from '../services/fileService';
import { FileBrowser } from './FileBrowser';
import { AIChatSidebar } from './AIChatSidebar';
import { VirtualCellList } from './VirtualCellList';
import { useUndoRedo } from '../hooks/useUndoRedo';
import { SettingsModal } from './SettingsModal';
import { KernelManager } from './KernelManager';
import { NotebookSearch } from './NotebookSearch';
import { useAutosave, formatLastSaved } from '../hooks/useAutosave';
import { useNotification } from './NotificationSystem';
import { detectIndentationFromCells, IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';
import { getNotebookAvatar, updateFavicon, resetFavicon } from '../utils/notebookAvatar';

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

// Default cell for reset
const INITIAL_CELL: Cell = {
  id: crypto.randomUUID(),
  type: 'code',
  content: '',
  outputs: [],
  isExecuting: false,
};

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
    currentMatch?: { cellId: string; startIndex: number; endIndex: number } | null;
  } | null>(null);

  // Notebook rename state
  const [isRenamingNotebook, setIsRenamingNotebook] = useState(false);
  const [renameValue, setRenameValue] = useState('');

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
    resetHistory
  } = useUndoRedo([]);  // Start with empty cells

  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [showRecoveryBanner, setShowRecoveryBanner] = useState(false);
  const [recoveryData, setRecoveryData] = useState<{ cells: Cell[]; timestamp: number } | null>(null);
  const [indentConfig, setIndentConfig] = useState<IndentationConfig>(DEFAULT_INDENTATION);

  // Virtuoso Handle for programmatic scrolling
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Ref for saveNow to avoid stale closures in keyboard handler
  const saveNowRef = useRef<() => Promise<void>>(() => Promise.resolve());

  // Autosave hook
  const performSaveToFile = useCallback(async (fileId: string, cellsToSave: Cell[]) => {
    await saveFileContent(fileId, cellsToSave);
    await updateNotebookMetadata(fileId, {});
  }, []);

  const { status: autosaveStatus, saveNow, getBackup, clearBackup } = useAutosave({
    fileId: currentFileId,
    cells,
    onSave: performSaveToFile,
    enabled: true,
  });

  // Keep saveNow ref updated synchronously (not in useEffect which runs after render)
  saveNowRef.current = saveNow;

  // Execution State
  const [isKernelReady, setIsKernelReady] = useState(false);
  const [executionQueue, setExecutionQueue] = useState<string[]>([]);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);
  const [kernelExecutionCount, setKernelExecutionCount] = useState(0); // Global execution counter

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

      // Undo/Redo work even in input fields with modifier keys
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
        return;
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
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, cells, activeCellId]);

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

  const loadFileAsync = async (id: string, content: Cell[]) => {
    if (currentFileId && currentFileId !== id) {
      saveNow(); // Save current file before switching
    }

    // Detect indentation from loaded cells
    const detectedIndent = detectIndentationFromCells(content);
    setIndentConfig(detectedIndent);

    // Check for crash recovery
    const backup = getBackup(id);
    if (backup) {
      const backupAge = Date.now() - backup.timestamp;
      const oneHour = 60 * 60 * 1000;

      // If backup is less than 1 hour old and different from loaded content
      if (backupAge < oneHour) {
        const backupContent = JSON.stringify(backup.cells.map(c => ({ id: c.id, type: c.type, content: c.content })));
        const loadedContent = JSON.stringify(content.map(c => ({ id: c.id, type: c.type, content: c.content })));

        if (backupContent !== loadedContent) {
          setRecoveryData(backup);
          setShowRecoveryBanner(true);
        }
      } else {
        // Clear old backups
        clearBackup(id);
      }
    }

    resetHistory(content);
    setCurrentFileId(id);
    saveActiveFileId(id);
    setActiveCellId(content.length > 0 ? content[0].id : null);
    setIsLoadingFile(false);

    const meta = files.find(f => f.id === id);
    if (meta) setCurrentFileMetadata(meta);

    requestAnimationFrame(() => {
      virtuosoRef.current?.scrollTo({ top: 0 });
    });

    // Get or create kernel for this file (one notebook = one kernel)
    try {
      setKernelStatus('starting');
      const sessionId = await kernelService.getOrCreateKernelForFile(id, currentKernel);
      setKernelSessionId(sessionId);
      setIsKernelReady(true);
      setKernelStatus('idle');
    } catch (error) {
      console.error('Failed to get/create kernel for file:', error);
      setKernelStatus('disconnected');
    }
  };

  // Handle recovery actions
  const handleRecoverChanges = () => {
    if (recoveryData && currentFileId) {
      resetHistory(recoveryData.cells);
      clearBackup(currentFileId);
    }
    setShowRecoveryBanner(false);
    setRecoveryData(null);
  };

  const handleDiscardRecovery = () => {
    if (currentFileId) {
      clearBackup(currentFileId);
    }
    setShowRecoveryBanner(false);
    setRecoveryData(null);
  };

  const loadFile = async (id: string) => {
    try {
      const content = await getFileContent(id);
      if (content) {
        loadFileAsync(id, content);
      } else {
        // File doesn't exist or is empty
        setIsLoadingFile(false);
        setCurrentFileId(null);
        saveActiveFileId('');
      }
    } catch (error) {
      console.error('Failed to load file:', error);
      setIsLoadingFile(false);
      setCurrentFileId(null);
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
      // Stop current kernel
      if (kernelSessionId) {
        await kernelService.stopKernel(kernelSessionId);
      }

      // Start new kernel with notebook's directory as cwd
      const cwd = currentFileId ? currentFileId.substring(0, currentFileId.lastIndexOf('/')) : undefined;
      const newSessionId = await kernelService.startKernel(kernelName, cwd);
      setKernelSessionId(newSessionId);
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

  // Force update with undo tracking - for AI edits, etc.
  const forceUpdateCell = (id: string, content: string) => {
    updateContent(id, content);
  };

  const handleEditCell = (index: number, newContent: string) => {
    if (index >= 0 && index < cells.length) {
      forceUpdateCell(cells[index].id, newContent);
    }
  };

  const handleDeleteCellByIndex = async (index: number) => {
    if (index >= 0 && index < cells.length) {
      const confirmed = await confirm({
        title: 'Delete Cell',
        message: `Are you sure you want to delete Cell #${index + 1}?`,
        confirmLabel: 'Delete',
        variant: 'danger',
      });
      if (confirmed) {
        deleteCell(cells[index].id);
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
      forceUpdateCell(id, '');
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
  };

  const runAndAdvance = (id: string) => {
    queueExecution(id);
    const currentIndex = cells.findIndex(c => c.id === id);
    if (currentIndex < cells.length - 1) {
      // Move to next cell and scroll to it
      const nextIndex = currentIndex + 1;
      setActiveCellId(cells[nextIndex].id);
      requestAnimationFrame(() => {
        virtuosoRef.current?.scrollToIndex({
          index: nextIndex,
          align: 'start',
          behavior: 'smooth',
          offset: -80
        });
      });
    } else {
      // Create new cell at the end (addCell already handles scrolling via setActiveCellId)
      addCell('code', '', currentIndex);
    }
  };

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
    currentMatch: { cellId: string; startIndex: number; endIndex: number } | null
  ) => {
    setSearchQuery(query ? { query, caseSensitive, currentMatch } : null);
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
  const handleReplaceAllInCell = useCallback((cellId: string, query: string, replacement: string, caseSensitive: boolean) => {
    const cell = cells.find(c => c.id === cellId);
    if (!cell) return;

    let newContent: string;
    if (caseSensitive) {
      newContent = cell.content.split(query).join(replacement);
    } else {
      // Case-insensitive replace
      const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      newContent = cell.content.replace(regex, replacement);
    }

    if (newContent !== cell.content) {
      updateContent(cellId, newContent);
    }
  }, [cells, updateContent]);

  // Replace all matches in the entire notebook
  const handleReplaceAllInNotebook = useCallback((query: string, replacement: string, caseSensitive: boolean) => {
    saveCheckpoint(); // Save undo state before bulk replace

    const regex = caseSensitive
      ? new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
      : new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');

    setCells(prev => prev.map(cell => {
      const newContent = cell.content.replace(regex, replacement);
      return newContent !== cell.content ? { ...cell, content: newContent } : cell;
    }));
  }, [saveCheckpoint, setCells]);

  const handleReset = async () => {
    const confirmed = await confirm({
      title: 'Reset Notebook',
      message: 'This will clear all cells in this notebook. This action cannot be undone.',
      confirmLabel: 'Reset',
      variant: 'danger',
    });
    if (confirmed) {
      const newCell: Cell = {
        id: crypto.randomUUID(),
        type: 'code',
        content: '',
        outputs: [],
        isExecuting: false,
      };
      // Reset clears history - not undoable (user confirmed)
      resetHistory([newCell]);
      setActiveCellId(newCell.id);
    }
  };

  // Execution Processor
  useEffect(() => {
    if (isProcessingQueue || executionQueue.length === 0 || !isKernelReady || !kernelSessionId) return;

    const processNext = async () => {
      setIsProcessingQueue(true);
      setKernelStatus('busy');
      const cellId = executionQueue[0];
      const cell = cells.find(c => c.id === cellId);

      if (cell && cell.type === 'code') {
        setCells(prev => prev.map(c => c.id === cellId ? { ...c, isExecuting: true, outputs: [] } : c));

        try {
          await kernelService.executeCode(kernelSessionId, cell.content, (output) => {
            setCells(prev => prev.map(c => {
              if (c.id !== cellId) return c;
              return { ...c, outputs: [...c.outputs, output] };
            }));
          });
        } catch (error) {
          console.error('Execution error:', error);
        }

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
  }, [executionQueue, isProcessingQueue, isKernelReady, kernelSessionId, cells, setCells]);

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

        {/* Recovery Banner */}
        {showRecoveryBanner && recoveryData && (
          <div className="flex-none bg-amber-50 border-b border-amber-200 px-4 py-3 z-30">
            <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <AlertCircle className="w-5 h-5 text-amber-600 flex-shrink-0" />
                <div>
                  <p className="text-sm font-medium text-amber-800">
                    Unsaved changes recovered
                  </p>
                  <p className="text-xs text-amber-600">
                    Found unsaved changes from {formatLastSaved(recoveryData.timestamp)}. Would you like to restore them?
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={handleDiscardRecovery}
                  className="px-3 py-1.5 text-xs font-medium text-amber-700 hover:bg-amber-100 rounded transition-colors"
                >
                  Discard
                </button>
                <button
                  onClick={handleRecoverChanges}
                  className="px-3 py-1.5 text-xs font-medium bg-amber-600 text-white hover:bg-amber-700 rounded transition-colors"
                >
                  Restore Changes
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
                        {autosaveStatus.status === 'saving' && (
                          <span className="flex items-center gap-1 text-blue-600">
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Saving...</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'saved' && (
                          <span className="flex items-center gap-1 text-green-600" title={autosaveStatus.lastSaved ? `Last saved ${formatLastSaved(autosaveStatus.lastSaved)}` : ''}>
                            <Check className="w-3 h-3" />
                            <span className="text-slate-400">{formatLastSaved(autosaveStatus.lastSaved)}</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'unsaved' && (
                          <span className="flex items-center gap-1 text-amber-600" title="Unsaved changes">
                            <Cloud className="w-3 h-3" />
                            <span className="text-slate-400">Unsaved</span>
                          </span>
                        )}
                        {autosaveStatus.status === 'error' && (
                          <span className="flex items-center gap-1 text-red-600" title="Save failed">
                            <AlertCircle className="w-3 h-3" />
                            <span>Save failed</span>
                          </span>
                        )}
                      </span>

                      {/* Execution Indicator - shows currently executing cell */}
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
                            className="flex items-center gap-1.5 px-2 py-1 text-xs bg-amber-100 text-amber-700 rounded-md hover:bg-amber-200 transition-colors"
                            title={`Click to jump to executing cell${queueLength > 1 ? ` (${queueLength - 1} more queued)` : ''}`}
                          >
                            <Loader2 className="w-3 h-3 animate-spin" />
                            <span>Running #{executingCellIndex + 1}</span>
                            {queueLength > 1 && (
                              <span className="text-amber-600">+{queueLength - 1}</span>
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
                      title="Global Undo (Ctrl+Z)"
                    >
                      <Undo2 className="w-4 h-4" />
                    </button>
                    <button
                      onClick={redo}
                      disabled={!canRedo}
                      className="p-1.5 text-slate-500 hover:text-slate-800 hover:bg-slate-200 rounded disabled:opacity-30 transition-colors"
                      title="Global Redo (Ctrl+Shift+Z)"
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
                  <button onClick={handleReset} className="btn-secondary hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-md hover:bg-red-50 text-red-600 text-xs font-medium transition-colors">
                      <Trash className="w-4 h-4" /> Reset
                  </button>
                  <button onClick={() => cells.forEach(c => queueExecution(c.id))} className="btn-primary flex items-center gap-2 bg-slate-900 text-white px-3 py-1.5 rounded-md hover:bg-slate-700 text-xs font-medium transition-colors shadow-sm">
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
      />
    </div>
  );
};
