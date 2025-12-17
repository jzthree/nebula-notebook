/**
 * NotebookContainer - Main container component for multi-notebook tab management
 *
 * Manages:
 * - Tab lifecycle (create, switch, close)
 * - Per-notebook state storage
 * - Kernel session management per notebook
 * - Sidebar state (file browser, chat, settings)
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Tab, NotebookState, Cell } from '../types';
import { TabBar } from './TabBar';
import { FileBrowser } from './FileBrowser';
import { SettingsModal } from './SettingsModal';
import { NotebookEditor } from './NotebookEditor';
import { kernelService } from '../services/kernelService';
import { getFileContent, getFiles, saveActiveFileId } from '../services/fileService';
import { FolderOpen } from 'lucide-react';

/** Default cell content for new/empty notebooks */
const INITIAL_CELL: Cell = {
  id: 'init-cell',
  type: 'code',
  content: '# Welcome to Nebula Notebook\nprint("Hello, World!")',
  outputs: [],
  isExecuting: false
};

export const NotebookContainer: React.FC = () => {
  // Tab management
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Per-notebook state storage
  const notebookStates = useRef<Map<string, NotebookState>>(new Map());

  // Force re-render counter (needed because ref updates don't trigger re-renders)
  const [stateVersion, setStateVersion] = useState(0);

  // Sidebar state (shared across all tabs)
  const [isFileBrowserOpen, setIsFileBrowserOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [files, setFiles] = useState<any[]>([]);

  // Get current notebook state
  const currentState = activeTabId ? notebookStates.current.get(activeTabId) : null;

  /**
   * Refreshes the file list from the server
   * Called on mount and after file operations
   */
  const refreshFileList = useCallback(async () => {
    const updatedFiles = await getFiles();
    setFiles(updatedFiles);
  }, []);

  // Initialize file list
  useEffect(() => {
    refreshFileList();
  }, [refreshFileList]);

  /**
   * Opens a notebook from the file browser
   * - If already open, switches to that tab
   * - Otherwise creates a new tab, loads content, and starts a kernel
   * @param fileId - Path to the notebook file
   */
  const openNotebook = useCallback(async (fileId: string) => {
    // Check if already open
    const existingTab = tabs.find(t => t.fileId === fileId);
    if (existingTab) {
      setActiveTabId(existingTab.id);
      return;
    }

    // Create new tab
    const tabId = crypto.randomUUID();
    const fileName = fileId.split('/').pop()?.replace('.ipynb', '') || 'Untitled';

    const newTab: Tab = {
      id: tabId,
      fileId,
      title: fileName,
      isDirty: false,
      isLoading: true
    };

    setTabs(prev => [...prev, newTab]);
    setActiveTabId(tabId);

    try {
      // Load notebook content
      const cells = await getFileContent(fileId);

      // Start kernel with notebook's directory as cwd
      const cwd = fileId.substring(0, fileId.lastIndexOf('/'));
      const sessionId = await kernelService.startKernel('python3', cwd);

      // Initialize notebook state
      notebookStates.current.set(tabId, {
        tabId,
        fileId,
        cells: cells || [INITIAL_CELL],
        activeCellId: cells?.[0]?.id || INITIAL_CELL.id,
        kernelSessionId: sessionId,
        kernelStatus: 'idle',
        kernelName: 'python3',
        executionQueue: []
      });

      // Mark loading complete and force re-render
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, isLoading: false } : t
      ));
      setStateVersion(v => v + 1);

      // Save as active file
      saveActiveFileId(fileId);
    } catch (error) {
      console.error('Failed to open notebook:', error);
      // Remove failed tab
      setTabs(prev => prev.filter(t => t.id !== tabId));
      if (activeTabId === tabId) {
        setActiveTabId(tabs.length > 0 ? tabs[0].id : null);
      }
    }
  }, [tabs, activeTabId]);

  /**
   * Closes a tab and cleans up its resources
   * - Prompts for confirmation if there are unsaved changes
   * - Stops the kernel session
   * - Removes the notebook state
   * - Selects adjacent tab if closing active tab
   * @param tabId - ID of the tab to close
   */
  const closeTab = useCallback(async (tabId: string) => {
    const state = notebookStates.current.get(tabId);
    const tab = tabs.find(t => t.id === tabId);

    // Check for unsaved changes
    if (tab?.isDirty) {
      if (!confirm('Unsaved changes will be lost. Close anyway?')) {
        return;
      }
    }

    // Stop the kernel for this notebook
    if (state?.kernelSessionId) {
      try {
        await kernelService.stopKernel(state.kernelSessionId);
      } catch (e) {
        console.error('Failed to stop kernel:', e);
      }
    }

    // Remove state
    notebookStates.current.delete(tabId);

    // Update tabs
    const newTabs = tabs.filter(t => t.id !== tabId);
    setTabs(newTabs);

    // Select adjacent tab if closing active
    if (activeTabId === tabId && newTabs.length > 0) {
      const closedIndex = tabs.findIndex(t => t.id === tabId);
      const newIndex = Math.min(closedIndex, newTabs.length - 1);
      setActiveTabId(newTabs[newIndex].id);
    } else if (newTabs.length === 0) {
      setActiveTabId(null);
    }
  }, [tabs, activeTabId]);

  /**
   * Updates notebook state for a specific tab
   * Called by NotebookEditor when cells change, kernel status updates, etc.
   * @param tabId - ID of the tab to update
   * @param updates - Partial state updates to apply
   */
  const updateNotebookState = useCallback((tabId: string, updates: Partial<NotebookState>) => {
    const current = notebookStates.current.get(tabId);
    if (current) {
      notebookStates.current.set(tabId, { ...current, ...updates });
      // Force re-render for state updates that affect rendering
      if (updates.kernelStatus || updates.kernelSessionId) {
        setStateVersion(v => v + 1);
      }
    }

    // Update dirty flag in tab if cells changed
    if (updates.cells) {
      setTabs(prev => prev.map(t =>
        t.id === tabId ? { ...t, isDirty: true } : t
      ));
    }
  }, []);

  /**
   * Marks a tab as clean (no unsaved changes)
   * Called after successful save operations
   * @param tabId - ID of the tab to mark clean
   */
  const markClean = useCallback((tabId: string) => {
    setTabs(prev => prev.map(t =>
      t.id === tabId ? { ...t, isDirty: false } : t
    ));
  }, []);

  // Handle new tab button
  const handleNewTab = useCallback(() => {
    setIsFileBrowserOpen(true);
  }, []);

  // Memoized callbacks for NotebookEditor to prevent infinite loops
  const handleStateChange = useCallback((updates: Partial<NotebookState>) => {
    if (activeTabId) {
      updateNotebookState(activeTabId, updates);
    }
  }, [activeTabId, updateNotebookState]);

  const handleMarkClean = useCallback(() => {
    if (activeTabId) {
      markClean(activeTabId);
    }
  }, [activeTabId, markClean]);

  return (
    <div className="flex min-h-screen bg-slate-50 relative overflow-hidden">
      {/* File Browser Sidebar */}
      <FileBrowser
        files={files}
        currentFileId={currentState?.fileId || null}
        onSelect={openNotebook}
        onRefresh={refreshFileList}
        isOpen={isFileBrowserOpen}
        onClose={() => setIsFileBrowserOpen(false)}
      />

      {/* Main Content */}
      <div className={`flex-1 flex flex-col h-screen transition-all duration-300 ${isFileBrowserOpen ? 'lg:ml-72' : ''} ${isChatOpen ? 'lg:mr-80' : ''}`}>
        {/* Tab Bar */}
        <TabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onSelectTab={setActiveTabId}
          onCloseTab={closeTab}
          onNewTab={handleNewTab}
        />

        {/* Notebook Editor or Empty State */}
        {currentState ? (
          <NotebookEditor
            key={activeTabId}
            state={currentState}
            onStateChange={handleStateChange}
            onMarkClean={handleMarkClean}
            isFileBrowserOpen={isFileBrowserOpen}
            setIsFileBrowserOpen={setIsFileBrowserOpen}
            isChatOpen={isChatOpen}
            setIsChatOpen={setIsChatOpen}
            setIsSettingsOpen={setIsSettingsOpen}
          />
        ) : (
          <EmptyState onOpenFile={() => setIsFileBrowserOpen(true)} />
        )}
      </div>


      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        onRefresh={refreshFileList}
      />
    </div>
  );
};

// Empty state when no notebooks are open
const EmptyState: React.FC<{ onOpenFile: () => void }> = ({ onOpenFile }) => (
  <div className="flex-1 flex flex-col items-center justify-center text-slate-500">
    <FolderOpen className="w-16 h-16 mb-4 text-slate-300" />
    <h2 className="text-xl font-semibold mb-2">No notebook open</h2>
    <p className="text-sm mb-4">Open a notebook from the file browser to get started</p>
    <button
      onClick={onOpenFile}
      className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors"
    >
      Open File Browser
    </button>
  </div>
);
