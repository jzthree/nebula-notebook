/**
 * NotebookEditor - Per-notebook editing component
 *
 * Receives state from NotebookContainer and handles:
 * - Cell rendering and editing
 * - Execution queue processing
 * - Autosave integration
 * - Header with kernel selector
 */
import React, { useEffect, useCallback, useRef, useState } from 'react';
import { Cell as CellComponent } from './Cell';
import { Cell, CellType, NotebookState } from '../types';
import { kernelService, KernelSpec, PythonEnvironment } from '../services/kernelService';
import { getSettings, saveSettings } from '../services/llmService';
import {
  Plus, Play, Trash, Save, Menu, ChevronDown, RotateCw,
  Undo2, Redo2, Settings, Square, Sparkles,
  Loader2, Check, AlertCircle, RefreshCw, Download, Cloud
} from 'lucide-react';
import { VirtuosoHandle } from 'react-virtuoso';
import { saveFileContent, updateNotebookMetadata } from '../services/fileService';
import { VirtualCellList } from './VirtualCellList';
import { AIChatSidebar } from './AIChatSidebar';
import { useUndoRedo } from '../hooks/useUndoRedo';
import { useAutosave, formatLastSaved } from '../hooks/useAutosave';

interface NotebookEditorProps {
  state: NotebookState;
  onStateChange: (updates: Partial<NotebookState>) => void;
  onMarkClean: () => void;
  isFileBrowserOpen: boolean;
  setIsFileBrowserOpen: (open: boolean) => void;
  isChatOpen: boolean;
  setIsChatOpen: (open: boolean) => void;
  setIsSettingsOpen: (open: boolean) => void;
}

export const NotebookEditor: React.FC<NotebookEditorProps> = ({
  state,
  onStateChange,
  onMarkClean,
  isFileBrowserOpen,
  setIsFileBrowserOpen,
  isChatOpen,
  setIsChatOpen,
  setIsSettingsOpen
}) => {
  // Kernel State
  const [isKernelMenuOpen, setIsKernelMenuOpen] = useState(false);
  const [availableKernels, setAvailableKernels] = useState<KernelSpec[]>([]);
  const [pythonEnvironments, setPythonEnvironments] = useState<PythonEnvironment[]>([]);
  const [isDiscoveringPythons, setIsDiscoveringPythons] = useState(false);
  const [isInstallingKernel, setIsInstallingKernel] = useState<string | null>(null);

  // Undo/Redo & State Management
  const {
    cells,
    setCells,
    pushState,
    saveCheckpoint,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory
  } = useUndoRedo(state.cells);

  // Recovery state
  const [showRecoveryBanner, setShowRecoveryBanner] = useState(false);
  const [recoveryData, setRecoveryData] = useState<{ cells: Cell[]; timestamp: number } | null>(null);

  // Track 'd' key press for vim-style 'dd' delete
  const lastKeyRef = useRef<{ key: string; time: number } | null>(null);

  // Ref for deleteCell to avoid circular dependency in useEffect
  const deleteCellRef = useRef<(id: string) => void>(() => {});

  // Virtuoso Handle for programmatic scrolling
  const virtuosoRef = useRef<VirtuosoHandle>(null);

  // Execution state
  const [executionQueue, setExecutionQueue] = useState<string[]>(state.executionQueue || []);
  const [isProcessingQueue, setIsProcessingQueue] = useState(false);

  // Autosave hook
  const performSaveToFile = useCallback(async (fileId: string, cellsToSave: Cell[]) => {
    await saveFileContent(fileId, cellsToSave);
    await updateNotebookMetadata(fileId, {});
  }, []);

  const { status: autosaveStatus, saveNow, getBackup, clearBackup } = useAutosave({
    fileId: state.fileId,
    cells,
    onSave: performSaveToFile,
    enabled: true,
  });

  // When autosave succeeds, mark tab as clean
  useEffect(() => {
    if (autosaveStatus.status === 'saved') {
      onMarkClean();
    }
  }, [autosaveStatus.status, onMarkClean]);

  // Load available kernels
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
      await loadPythonEnvironments(true);

      if (result.kernel_name) {
        await switchKernel(result.kernel_name);
      }
    } catch (error) {
      console.error('Failed to install kernel:', error);
      alert(`Failed to install kernel: ${error}`);
    } finally {
      setIsInstallingKernel(null);
    }
  }, [loadPythonEnvironments]);

  // Initialize kernels list on mount
  useEffect(() => {
    loadPythonEnvironments(false);
  }, [loadPythonEnvironments]);

  // Check for crash recovery on mount
  useEffect(() => {
    const backup = getBackup(state.fileId);
    if (backup) {
      const backupAge = Date.now() - backup.timestamp;
      const oneHour = 60 * 60 * 1000;

      if (backupAge < oneHour) {
        const backupContent = JSON.stringify(backup.cells.map(c => ({ id: c.id, type: c.type, content: c.content })));
        const loadedContent = JSON.stringify(state.cells.map(c => ({ id: c.id, type: c.type, content: c.content })));

        if (backupContent !== loadedContent) {
          setRecoveryData(backup);
          setShowRecoveryBanner(true);
        }
      } else {
        clearBackup(state.fileId);
      }
    }
  }, [state.fileId]);

  // Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

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
        const currentIndex = state.activeCellId
          ? cells.findIndex(c => c.id === state.activeCellId)
          : -1;

        if (e.key === 'ArrowUp' && currentIndex > 0) {
          onStateChange({ activeCellId: cells[currentIndex - 1].id });
        } else if (e.key === 'ArrowDown' && currentIndex < cells.length - 1) {
          onStateChange({ activeCellId: cells[currentIndex + 1].id });
        } else if (currentIndex === -1 && cells.length > 0) {
          // No cell selected, select first or last based on direction
          onStateChange({ activeCellId: e.key === 'ArrowDown' ? cells[0].id : cells[cells.length - 1].id });
        }
        return;
      }

      // Vim-style 'dd' to delete cell
      if (e.key === 'd') {
        const now = Date.now();
        if (lastKeyRef.current?.key === 'd' && now - lastKeyRef.current.time < 500) {
          // Double 'd' pressed within 500ms - delete active cell
          if (state.activeCellId) {
            e.preventDefault();
            deleteCellRef.current(state.activeCellId);
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
  }, [undo, redo, cells, state.activeCellId, onStateChange]);

  // Handle recovery actions
  const handleRecoverChanges = () => {
    if (recoveryData) {
      resetHistory(recoveryData.cells);
      clearBackup(state.fileId);
    }
    setShowRecoveryBanner(false);
    setRecoveryData(null);
  };

  const handleDiscardRecovery = () => {
    clearBackup(state.fileId);
    setShowRecoveryBanner(false);
    setRecoveryData(null);
  };

  const saveCurrentNotebook = useCallback(async () => {
    await saveNow();
  }, [saveNow]);

  // --- KERNEL OPERATIONS ---

  const switchKernel = async (kernelName: string) => {
    if (!state.kernelSessionId) return;

    setIsKernelMenuOpen(false);
    onStateChange({ kernelStatus: 'starting' });

    try {
      // Stop current kernel
      await kernelService.stopKernel(state.kernelSessionId);

      // Start new kernel with same cwd
      const cwd = state.fileId.substring(0, state.fileId.lastIndexOf('/'));
      const newSessionId = await kernelService.startKernel(kernelName, cwd);

      onStateChange({
        kernelSessionId: newSessionId,
        kernelName: kernelName,
        kernelStatus: 'idle'
      });

      saveSettings({ lastKernel: kernelName });
    } catch (error) {
      console.error('Failed to switch kernel:', error);
      onStateChange({ kernelStatus: 'disconnected' });
    }
  };

  const restartKernel = async () => {
    if (!state.kernelSessionId) return;

    setIsKernelMenuOpen(false);
    onStateChange({ kernelStatus: 'starting' });

    try {
      await kernelService.restartKernel(state.kernelSessionId);
      onStateChange({ kernelStatus: 'idle' });
      // Clear all cell outputs
      setCells(prev => prev.map(c => ({ ...c, outputs: [], executionCount: undefined })));
    } catch (error) {
      console.error('Failed to restart kernel:', error);
      onStateChange({ kernelStatus: 'disconnected' });
    }
  };

  const interruptKernel = async () => {
    if (!state.kernelSessionId) return;

    try {
      await kernelService.interruptKernel(state.kernelSessionId);
      setExecutionQueue([]);
      setIsProcessingQueue(false);
      setCells(prev => prev.map(c => ({ ...c, isExecuting: false })));
    } catch (error) {
      console.error('Failed to interrupt kernel:', error);
    }
  };

  // --- CELL OPERATIONS ---

  const addCell = (type: CellType = 'code', content: string = '', afterIndex?: number) => {
    const newCell: Cell = {
      id: crypto.randomUUID(),
      type,
      content,
      outputs: [],
      isExecuting: false
    };

    const newCells = [...cells];
    if (afterIndex !== undefined && afterIndex >= 0 && afterIndex < cells.length) {
      newCells.splice(afterIndex + 1, 0, newCell);
    } else {
      newCells.push(newCell);
    }

    pushState(newCells);
    onStateChange({ activeCellId: newCell.id });
  };

  const handleAddCell = (type: CellType) => {
    const index = state.activeCellId ? cells.findIndex(c => c.id === state.activeCellId) : -1;
    if (index !== -1) {
      addCell(type, '', index);
    } else {
      addCell(type);
    }
  };

  const handleUpdateCell = (id: string, content: string) => {
    setCells(prev => prev.map(c => c.id === id ? { ...c, content } : c));
  };

  const forceUpdateCell = useCallback((id: string, content: string) => {
    const newCells = cells.map(c => c.id === id ? { ...c, content } : c);
    pushState(newCells);
  }, [cells, pushState]);

  const changeCellType = (id: string, type: CellType) => {
    const newCells = cells.map(c => c.id === id ? { ...c, type } : c);
    pushState(newCells);
  };

  const deleteCell = useCallback((id: string) => {
    if (cells.length > 1) {
      const newCells = cells.filter(c => c.id !== id);
      pushState(newCells);
    } else {
      forceUpdateCell(id, '');
    }
  }, [cells, pushState, forceUpdateCell]);

  // Keep ref updated for keyboard shortcut handler
  useEffect(() => {
    deleteCellRef.current = deleteCell;
  }, [deleteCell]);

  const moveCell = (id: string, direction: 'up' | 'down') => {
    const idx = cells.findIndex(c => c.id === id);
    if (idx === -1) return;
    if (direction === 'up' && idx === 0) return;
    if (direction === 'down' && idx === cells.length - 1) return;

    const newCells = [...cells];
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    [newCells[idx], newCells[targetIdx]] = [newCells[targetIdx], newCells[idx]];

    pushState(newCells);
  };

  const queueExecution = (id: string) => {
    saveCheckpoint();
    setExecutionQueue(prev => [...prev, id]);
  };

  const runAndAdvance = (id: string) => {
    queueExecution(id);
    const currentIndex = cells.findIndex(c => c.id === id);
    if (currentIndex < cells.length - 1) {
      // Move to next cell
      onStateChange({ activeCellId: cells[currentIndex + 1].id });
    } else {
      // Create new cell at the end
      addCell('code', '', currentIndex);
    }
  };

  const handleReset = () => {
    if (confirm("Resetting will clear all cells in this notebook. Continue?")) {
      const initialCell: Cell = {
        id: 'init-cell',
        type: 'code',
        content: '# Welcome to Nebula Notebook\nprint("Hello, World!")',
        outputs: [],
        isExecuting: false
      };
      pushState([initialCell]);
      onStateChange({ activeCellId: initialCell.id });
    }
  };

  // Execution Processor - uses explicit session ID
  useEffect(() => {
    if (isProcessingQueue || executionQueue.length === 0 || !state.kernelSessionId) return;
    if (state.kernelStatus === 'disconnected' || state.kernelStatus === 'starting') return;

    const processNext = async () => {
      setIsProcessingQueue(true);
      onStateChange({ kernelStatus: 'busy' });

      const cellId = executionQueue[0];
      const cell = cells.find(c => c.id === cellId);

      if (cell && cell.type === 'code') {
        setCells(prev => prev.map(c => c.id === cellId ? { ...c, isExecuting: true, outputs: [] } : c));

        try {
          // Use explicit session ID for execution
          await kernelService.executeCode(state.kernelSessionId!, cell.content, (output) => {
            setCells(prev => prev.map(c => {
              if (c.id !== cellId) return c;
              return { ...c, outputs: [...c.outputs, output] };
            }));
          });
        } catch (error) {
          console.error('Execution error:', error);
        }

        setCells(prev => prev.map(c => c.id === cellId ? {
          ...c,
          isExecuting: false,
          executionCount: (c.executionCount || 0) + 1
        } : c));
      }

      setExecutionQueue(prev => prev.slice(1));
      setIsProcessingQueue(false);
      onStateChange({ kernelStatus: 'idle' });
    };

    processNext();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [executionQueue, isProcessingQueue, state.kernelSessionId, state.kernelStatus]);

  const getKernelDisplayName = () => {
    const kernel = availableKernels.find(k => k.name === state.kernelName);
    return kernel?.display_name || state.kernelName;
  };

  const getStatusColor = () => {
    switch (state.kernelStatus) {
      case 'idle': return 'bg-green-500';
      case 'busy': return 'bg-amber-500 animate-pulse';
      case 'starting': return 'bg-blue-500 animate-pulse';
      default: return 'bg-red-500';
    }
  };

  const fileName = state.fileId.split('/').pop()?.replace('.ipynb', '') || 'Untitled';

  return (
    <>
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
                {fileName}
                <span className="text-xs font-normal text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">
                  .ipynb
                </span>
                {/* Save Status Indicator */}
                <span className="flex items-center gap-1 text-xs font-normal ml-1">
                  {autosaveStatus.status === 'saving' && (
                    <span className="flex items-center gap-1 text-blue-600">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span className="hidden sm:inline">Saving...</span>
                    </span>
                  )}
                  {autosaveStatus.status === 'saved' && (
                    <span className="flex items-center gap-1 text-green-600" title={autosaveStatus.lastSaved ? `Last saved ${formatLastSaved(autosaveStatus.lastSaved)}` : ''}>
                      <Check className="w-3 h-3" />
                      <span className="hidden sm:inline text-slate-400">{formatLastSaved(autosaveStatus.lastSaved)}</span>
                    </span>
                  )}
                  {autosaveStatus.status === 'unsaved' && (
                    <span className="flex items-center gap-1 text-amber-600" title="Unsaved changes">
                      <Cloud className="w-3 h-3" />
                    </span>
                  )}
                  {autosaveStatus.status === 'error' && (
                    <span className="flex items-center gap-1 text-red-600" title="Save failed">
                      <AlertCircle className="w-3 h-3" />
                      <span className="hidden sm:inline">Save failed</span>
                    </span>
                  )}
                </span>
              </h1>

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
                        <div className="text-[10px] text-slate-500">{getKernelDisplayName()} ({state.kernelStatus})</div>
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
                            kernel.name === state.kernelName ? 'bg-blue-50 text-blue-700' : 'text-slate-700'
                          }`}
                        >
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${kernel.name === state.kernelName ? 'bg-blue-500' : 'bg-green-500'}`}></span>
                          <span className="truncate flex-1">{kernel.display_name}</span>
                          <span className="text-[10px] text-slate-400">{kernel.language}</span>
                        </button>
                      ))}

                      {/* Discovered Python Environments */}
                      {pythonEnvironments.length > 0 && (
                        <>
                          <div className="px-3 py-1.5 text-[10px] font-semibold text-slate-500 uppercase tracking-wide bg-slate-50 mt-1 flex items-center justify-between">
                            <span>Python Environments</span>
                            {isDiscoveringPythons && <Loader2 className="w-3 h-3 animate-spin" />}
                          </div>
                          {pythonEnvironments.filter(env => !env.has_ipykernel).map(env => (
                            <div
                              key={env.path}
                              className="w-full text-left px-3 py-2 text-xs hover:bg-slate-50 flex items-center gap-2 text-slate-600"
                            >
                              <span className="w-2 h-2 rounded-full flex-shrink-0 bg-slate-300"></span>
                              <div className="flex-1 min-w-0">
                                <div className="truncate">{env.display_name}</div>
                                <div className="text-[10px] text-slate-400 truncate">{env.path}</div>
                              </div>
                              <button
                                onClick={(e) => { e.stopPropagation(); installKernelForPython(env.path); }}
                                disabled={isInstallingKernel === env.path}
                                className="flex items-center gap-1 px-2 py-1 text-[10px] bg-blue-50 text-blue-600 rounded hover:bg-blue-100 transition-colors flex-shrink-0"
                                title="Install ipykernel and register"
                              >
                                {isInstallingKernel === env.path ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <Download className="w-3 h-3" />
                                )}
                                <span>{isInstallingKernel === env.path ? 'Installing...' : 'Install'}</span>
                              </button>
                            </div>
                          ))}
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
                      {state.kernelStatus === 'busy' && (
                        <button
                          onClick={interruptKernel}
                          className="w-full text-left px-3 py-2 text-xs text-red-600 hover:bg-red-50 flex items-center gap-2"
                        >
                          <Square className="w-3 h-3" /> Interrupt
                        </button>
                      )}
                    </div>
                  </div>
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
      <div className="flex-1 h-full">
        <VirtualCellList
          cells={cells}
          virtuosoRef={virtuosoRef}
          className="h-full"
          renderCell={(cell, idx) => (
            <CellComponent
              key={cell.id}
              cell={cell}
              index={idx}
              isActive={state.activeCellId === cell.id}
              allCells={cells}
              onUpdate={handleUpdateCell}
              onRun={queueExecution}
              onRunAndAdvance={runAndAdvance}
              onDelete={deleteCell}
              onMove={moveCell}
              onChangeType={changeCellType}
              onClick={(id) => onStateChange({ activeCellId: id })}
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

      {/* AI Chat Sidebar - per-notebook instance */}
      <AIChatSidebar
        isOpen={isChatOpen}
        onClose={() => setIsChatOpen(false)}
        cells={cells}
        onInsertCode={(code, targetIndex) => {
          addCell('code', code, targetIndex);
        }}
        onEditCell={(index, code) => {
          const cell = cells[index];
          if (cell) {
            forceUpdateCell(cell.id, code);
          }
        }}
        onDeleteCell={(index) => {
          const cell = cells[index];
          if (cell) {
            deleteCell(cell.id);
          }
        }}
      />
    </>
  );
};
