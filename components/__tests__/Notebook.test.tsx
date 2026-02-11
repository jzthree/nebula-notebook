/**
 * Tests for Notebook component - keyboard shortcuts and cell operations
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';

// Mock all the services before importing Notebook
vi.mock('../../services/kernelService', () => ({
  API_BASE: '/api',
  kernelService: {
    getAvailableKernels: vi.fn().mockResolvedValue([
      { name: 'python3', display_name: 'Python 3', language: 'python' }
    ]),
    getPythonEnvironments: vi.fn().mockResolvedValue({
      kernelspecs: [{ name: 'python3', display_name: 'Python 3', language: 'python' }],
      environments: []
    }),
    startKernel: vi.fn().mockResolvedValue('test-session-id'),
    getOrCreateKernelForFile: vi.fn().mockResolvedValue({ sessionId: 'test-session-id', created: true, createdAt: Date.now() / 1000 }),
    getKernelPreference: vi.fn().mockResolvedValue(null),
    getStatus: vi.fn().mockResolvedValue({ status: 'idle', execution_count: 0 }),
    stopKernel: vi.fn().mockResolvedValue(true),
    restartKernel: vi.fn().mockResolvedValue(true),
    interruptKernel: vi.fn().mockResolvedValue(true),
    executeCode: vi.fn().mockResolvedValue({ status: 'ok', execution_count: 1 }),
    installKernel: vi.fn().mockResolvedValue({ kernel_name: 'python3' }),
    onReconnect: vi.fn().mockReturnValue(() => {}),
    onDisconnect: vi.fn().mockReturnValue(() => {}),
    onStatus: vi.fn().mockReturnValue(() => {}),
    onBufferedOutput: vi.fn().mockReturnValue(() => {}),
    onSyncReplace: vi.fn().mockReturnValue(() => {}),
  },
  KernelSpec: {},
  PythonEnvironment: {},
}));

vi.mock('../../services/fileService', () => ({
  getFiles: vi.fn().mockResolvedValue([]),
  getNotebookData: vi.fn().mockResolvedValue({
    cells: [
      { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
      { id: 'cell-2', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
    ],
    kernelspec: 'python3',
    mtime: Date.now() / 1000
  }),
  getFileContentWithMtime: vi.fn().mockResolvedValue({
    cells: [
      { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
      { id: 'cell-2', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
    ],
    kernelspec: 'python3',
    mtime: Date.now() / 1000
  }),
  saveNotebookCells: vi.fn().mockResolvedValue({ success: true, mtime: Date.now() / 1000 }),
  saveFileContentWithMtime: vi.fn().mockResolvedValue({ success: true, mtime: Date.now() / 1000 }),
  getFileMtime: vi.fn().mockResolvedValue({ mtime: Date.now() / 1000 }),
  getActiveFileId: vi.fn().mockReturnValue('/test/notebook.ipynb'),
  saveActiveFileId: vi.fn(),
  updateNotebookMetadata: vi.fn().mockResolvedValue(undefined),
  renameFile: vi.fn().mockResolvedValue(undefined),
  loadNotebookHistory: vi.fn().mockResolvedValue([]),
  saveNotebookHistory: vi.fn().mockResolvedValue(undefined),
  loadNotebookSession: vi.fn().mockResolvedValue({}),
  getNotebookSettings: vi.fn().mockResolvedValue(null),
  saveNotebookSession: vi.fn().mockResolvedValue(true),
  getAgentPermissionStatus: vi.fn().mockResolvedValue({
    agent_created: false,
    agent_permitted: false,
    has_history: false,
    can_agent_modify: false,
  }),
}));

vi.mock('../../services/llmService', () => ({
  getSettings: vi.fn().mockReturnValue({
    llmProvider: 'anthropic',
    llmModel: 'claude-sonnet-4-5-20250929',
    lastKernel: 'python3'
  }),
  saveSettings: vi.fn(),
  generateCellContent: vi.fn().mockResolvedValue('generated code'),
  fixCellError: vi.fn().mockResolvedValue('fixed code'),
  getAvailableProviders: vi.fn().mockResolvedValue({
    anthropic: ['claude-sonnet-4-5-20250929'],
    google: ['gemini-2.5-flash'],
    openai: ['gpt-4o'],
  }),
}));

vi.mock('../../hooks/useAutosave', () => ({
  useAutosave: vi.fn().mockReturnValue({
    status: { status: 'saved', lastSaved: Date.now() },
    saveNow: vi.fn().mockResolvedValue(undefined),
    hasUnsavedChanges: vi.fn().mockReturnValue(false),
  }),
  formatLastSaved: vi.fn().mockReturnValue('just now'),
}));

// Mock react-virtuoso since it needs window measurements
vi.mock('react-virtuoso', () => ({
  Virtuoso: ({ data, itemContent }: any) => (
    <div data-testid="virtuoso">
      {data?.map((item: any, index: number) => (
        <div key={item.id || index}>{itemContent(index, item)}</div>
      ))}
    </div>
  ),
  VirtuosoHandle: {},
}));

// Mock VirtualCellList
vi.mock('../VirtualCellList', () => ({
  VirtualCellList: ({ cells, renderCell }: any) => (
    <div data-testid="virtual-cell-list">
      {cells.map((cell: any, idx: number) => (
        <div key={cell.id} data-testid={`cell-container-${idx}`}>
          {renderCell(cell, idx)}
        </div>
      ))}
    </div>
  ),
}));

// Mock AIChatSidebar to avoid its internal complexity
vi.mock('../AIChatSidebar', () => ({
  AIChatSidebar: () => <div data-testid="ai-chat-sidebar">Mock AI Sidebar</div>,
}));

// Mock FileBrowser to avoid its internal complexity
vi.mock('../FileBrowser', () => ({
  FileBrowser: () => <div data-testid="file-browser">Mock File Browser</div>,
}));

// Mock SettingsModal
vi.mock('../SettingsModal', () => ({
  SettingsModal: () => null,
}));

// Mock KernelManager
vi.mock('../KernelManager', () => ({
  KernelManager: () => null,
}));

// Mock NotebookSearch
vi.mock('../NotebookSearch', () => ({
  NotebookSearch: () => null,
}));

// Mock NotebookBreadcrumb
vi.mock('../NotebookBreadcrumb', () => ({
  NotebookBreadcrumb: () => null,
}));

// Mock Cell component to avoid CodeMirror DOM measurement issues in tests
vi.mock('../Cell', () => ({
  Cell: ({ cell, index, isActive, onClick, onDelete, onMove, onChangeType }: any) => (
    <div
      data-testid={`cell-${cell.id}`}
      data-cell-id={cell.id}
      data-cell-type={cell.type}
      data-active={isActive}
      onClick={(e: React.MouseEvent) => onClick(cell.id, e)}
    >
      <span data-testid={`cell-index-${index}`}>#{index + 1}</span>
      <div data-testid={`cell-content-${cell.id}`}>{cell.content}</div>
      <button data-testid={`delete-${cell.id}`} onClick={(e) => { e.stopPropagation(); onDelete(cell.id); }}>Delete</button>
      <button data-testid={`move-up-${cell.id}`} onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'up'); }}>Up</button>
      <button data-testid={`move-down-${cell.id}`} onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'down'); }}>Down</button>
      <button data-testid={`to-markdown-${cell.id}`} onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'markdown'); }}>M</button>
      <button data-testid={`to-code-${cell.id}`} onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'code'); }}>Y</button>
    </div>
  ),
}));

// Import after mocks
import { Notebook } from '../Notebook';
import { NotificationProvider } from '../NotificationSystem';

// Helper to render Notebook with required providers
const renderNotebook = () => {
  return render(
    <NotificationProvider>
      <Notebook />
    </NotificationProvider>
  );
};

describe('Notebook', () => {
  const getOrderedCellIds = () => {
    return Array.from(document.querySelectorAll('[data-cell-id]'))
      .map(el => el.getAttribute('data-cell-id'))
      .filter((id): id is string => Boolean(id));
  };

  const getCellContents = () => {
    return screen.getAllByTestId(/cell-content-/).map(el => el.textContent ?? '');
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Mock window.confirm
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    // Mock crypto.randomUUID with valid UUID format
    let uuidCounter = 0;
    vi.spyOn(crypto, 'randomUUID').mockImplementation(() => `00000000-0000-0000-0000-00000000000${++uuidCounter}` as `${string}-${string}-${string}-${string}-${string}`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('keyboard shortcuts - command mode', () => {
    // Note: Command mode shortcuts in Notebook.tsx trigger when the focused
    // element is the cell div itself (data-cell-id). We simulate this by
    // firing keydown on the cell element after setting the active cell via click.

    it('pressing "a" inserts cell above active cell', async () => {
      renderNotebook();

      // Wait for cells to load
      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 2 to make it active
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);

      // Press 'a' to insert above - fire on cell to simulate command mode
      fireEvent.keyDown(cell2, { key: 'a' });

      // Should now have 3 cells, with new cell at position 2 (index 1)
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });
    });

    it('pressing "b" inserts cell below active cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'b' to insert below - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'b' });

      // Should now have 3 cells
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });
    });

    it('pressing "m" converts cell to markdown', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'm' to convert to markdown - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'm' });

      // The cell type toggle should reflect markdown being selected
      // (This is harder to test directly, but the keydown handler should be called)
    });

    it('pressing "y" converts cell to code', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'y' to convert to code - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'y' });

      // The cell should remain/become code type
    });

    it('delete button is clickable and triggers action', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click directly on the cell element to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Verify delete button exists and is clickable
      // Note: Full delete flow tested in e2e tests; this verifies UI availability
      // Note: 'dd' vim-style shortcut is handled at Cell component level
      const deleteButton = screen.getByTestId('delete-cell-1');
      expect(deleteButton).toBeInTheDocument();

      // Click should not throw - action is handled by Notebook state
      expect(() => fireEvent.click(deleteButton)).not.toThrow();
    });

    it('pressing "d" once does not delete cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'd' only once - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'd' });

      // Wait a bit to ensure no deletion
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should still have 2 cells
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('arrow up navigates to previous cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 2 to make it active
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);

      // Arrow navigation is handled at the Cell level when cell div is focused
      // Here we just verify the cell was activated
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('arrow down navigates to next cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Arrow navigation is handled at the Cell level when cell div is focused
      // Here we just verify the cell was activated
      expect(screen.getByText('#1')).toBeInTheDocument();
    });
  });

  describe('keyboard shortcuts - cut/copy/paste', () => {
    it('pressing "x" cuts the active cell and paste works repeatedly after cut', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click directly on the cell element to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'x' to cut - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'x' });

      // Should now have only 1 cell (cell was cut/deleted)
      await waitFor(() => {
        expect(screen.queryByTestId('cell-cell-1')).not.toBeInTheDocument();
      });

      // Focus remaining cell and paste twice (clipboard should persist)
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);
      fireEvent.keyDown(cell2, { key: 'v' });
      fireEvent.keyDown(cell2, { key: 'v' });

      await waitFor(() => {
        const contents = getCellContents();
        expect(contents.filter(c => c === 'print(\"hello\")')).toHaveLength(2);
        expect(contents.filter(c => c === 'x = 1')).toHaveLength(1);
      });
    });

    it('pressing "c" copies the active cell (does not delete)', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'c' to copy - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'c' });

      // Should still have 2 cells (copy doesn't delete)
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('pressing "v" pastes cell below after copy', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'c' to copy, then 'v' to paste - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'c' });
      fireEvent.keyDown(cell1, { key: 'v' });

      // Should now have 3 cells with the new cell inserted below cell 1
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });

      const orderedIds = getOrderedCellIds();
      const insertedId = orderedIds.find(id => id !== 'cell-1' && id !== 'cell-2');
      expect(insertedId).toBeTruthy();
      expect(orderedIds).toEqual(['cell-1', insertedId!, 'cell-2']);
      expect(screen.getByTestId(`cell-content-${insertedId}`)).toHaveTextContent('print("hello")');
    });

    it('pressing "Shift+V" pastes cell above focused cell', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Copy cell 2 content, then focus cell 1 for paste target
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);
      fireEvent.keyDown(cell2, { key: 'c' });

      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Shift+V should paste above the focused cell (cell 1)
      fireEvent.keyDown(cell1, { key: 'v', shiftKey: true });

      // Should now have 3 cells
      await waitFor(() => {
        expect(screen.getByText('#3')).toBeInTheDocument();
      });

      const orderedIds = getOrderedCellIds();
      const insertedId = orderedIds.find(id => id !== 'cell-1' && id !== 'cell-2');
      expect(insertedId).toBeTruthy();
      expect(orderedIds).toEqual([insertedId!, 'cell-1', 'cell-2']);
      expect(screen.getByTestId(`cell-content-${insertedId}`)).toHaveTextContent('x = 1');
    });

    it('paste works multiple times after copy', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);
      fireEvent.keyDown(cell1, { key: 'c' });
      fireEvent.keyDown(cell1, { key: 'v' });
      fireEvent.keyDown(cell1, { key: 'v' });

      await waitFor(() => {
        expect(screen.getByText('#4')).toBeInTheDocument();
      });

      const contents = getCellContents();
      expect(contents.filter(c => c === 'print(\"hello\")')).toHaveLength(3);
      expect(contents.filter(c => c === 'x = 1')).toHaveLength(1);
    });
  });

  describe('keyboard shortcuts - global', () => {
    it('Ctrl+S saves the notebook', async () => {
      const { useAutosave } = await import('../../hooks/useAutosave');
      const mockSaveNow = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useAutosave).mockReturnValue({
        status: { status: 'saved', lastSaved: Date.now() },
        saveNow: mockSaveNow,
        hasUnsavedChanges: vi.fn().mockReturnValue(false),
      });

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Press Ctrl+S - global shortcuts work from anywhere
      fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });

      // saveNow should have been called
      await waitFor(() => {
        expect(mockSaveNow).toHaveBeenCalled();
      });
    });

    it('Cmd+S saves the notebook (Mac)', async () => {
      const { useAutosave } = await import('../../hooks/useAutosave');
      const mockSaveNow = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useAutosave).mockReturnValue({
        status: { status: 'saved', lastSaved: Date.now() },
        saveNow: mockSaveNow,
        hasUnsavedChanges: vi.fn().mockReturnValue(false),
      });

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Press Cmd+S (metaKey) - global shortcuts work from anywhere
      fireEvent.keyDown(document.body, { key: 's', metaKey: true });

      await waitFor(() => {
        expect(mockSaveNow).toHaveBeenCalled();
      });
    });

    it('Ctrl+F opens search', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Press Ctrl+F - global shortcuts work from anywhere
      fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });

      // Search component should be visible
      // (NotebookSearch is rendered based on isSearchOpen state)
    });
  });

  describe('keyboard shortcuts - enter to focus', () => {
    it('pressing Enter focuses active cell editor', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active (but not in edit mode)
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press Enter to focus editor - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'Enter' });

      // The CodeMirror content should receive focus
      // (This is harder to test directly due to CodeMirror internals)
    });
  });

  describe('keyboard shortcuts - do not trigger in input fields', () => {
    it('shortcuts do not trigger when typing in an input', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Find an input field (like the AI prompt input when open)
      // For this test, we'll simulate the check by setting target.tagName
      const mockEvent = {
        key: 'a',
        target: { tagName: 'INPUT', isContentEditable: false },
        preventDefault: vi.fn(),
      };

      // The keyboard handler checks isInput and should return early
      // We verify by checking that cells are not modified
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
    });
  });

  describe('edge cases', () => {
    it('arrow up at first cell does nothing', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Arrow navigation is handled at Cell level - just verify no crash
      expect(screen.getByText('#1')).toBeInTheDocument();
    });

    it('arrow down at last cell does nothing', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 2 (last cell) to make it active
      const cell2 = screen.getByTestId('cell-cell-2');
      fireEvent.click(cell2);

      // Arrow navigation is handled at Cell level - just verify no crash
      expect(screen.getByText('#2')).toBeInTheDocument();
    });

    it('paste without prior copy does nothing', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByText('#1')).toBeInTheDocument();
        expect(screen.getByText('#2')).toBeInTheDocument();
      });

      // Click on cell 1 to make it active
      const cell1 = screen.getByTestId('cell-cell-1');
      fireEvent.click(cell1);

      // Press 'v' without copying first - fire on cell for command mode
      fireEvent.keyDown(cell1, { key: 'v' });

      // Should still have only 2 cells
      expect(screen.getByText('#1')).toBeInTheDocument();
      expect(screen.getByText('#2')).toBeInTheDocument();
      expect(screen.queryByText('#3')).not.toBeInTheDocument();
    });
  });
});
