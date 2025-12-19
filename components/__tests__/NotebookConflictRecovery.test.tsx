/**
 * Integration tests for Notebook conflict detection and crash recovery
 *
 * These tests verify the actual behavior of conflict/recovery flows,
 * mocking only the backend APIs (not the hooks).
 *
 * Purpose: Ensure refactoring from inline logic to hooks preserves behavior.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { act } from 'react';
import { Cell } from '../../types';

// Create localStorage mock before imports
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
});

// Mock kernel service
vi.mock('../../services/kernelService', () => ({
  kernelService: {
    getAvailableKernels: vi.fn().mockResolvedValue([
      { name: 'python3', display_name: 'Python 3', language: 'python' },
    ]),
    getPythonEnvironments: vi.fn().mockResolvedValue({
      kernelspecs: [{ name: 'python3', display_name: 'Python 3', language: 'python' }],
      environments: [],
    }),
    startKernel: vi.fn().mockResolvedValue('test-session-id'),
    getOrCreateKernelForFile: vi.fn().mockResolvedValue('test-session-id'),
    stopKernel: vi.fn().mockResolvedValue(true),
    restartKernel: vi.fn().mockResolvedValue(true),
    interruptKernel: vi.fn().mockResolvedValue(true),
    executeCode: vi.fn().mockResolvedValue({ status: 'ok', execution_count: 1 }),
    installKernel: vi.fn().mockResolvedValue({ kernel_name: 'python3' }),
  },
}));

// Mock file service - this is where we control mtime behavior
const mockGetFileMtime = vi.fn();
const mockGetFileContentWithMtime = vi.fn();
const mockSaveFileContentWithMtime = vi.fn();

vi.mock('../../services/fileService', () => ({
  getFiles: vi.fn().mockResolvedValue([]),
  getNotebookData: vi.fn().mockResolvedValue({
    cells: [
      { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
    ],
    kernelspec: 'python3',
    mtime: 1000,
  }),
  getFileContentWithMtime: (...args: any[]) => mockGetFileContentWithMtime(...args),
  saveNotebookCells: vi.fn().mockResolvedValue({ success: true, mtime: 1001 }),
  saveFileContentWithMtime: (...args: any[]) => mockSaveFileContentWithMtime(...args),
  getFileMtime: (...args: any[]) => mockGetFileMtime(...args),
  getActiveFileId: vi.fn().mockReturnValue('/test/notebook.ipynb'),
  saveActiveFileId: vi.fn(),
  updateNotebookMetadata: vi.fn().mockResolvedValue(undefined),
  renameFile: vi.fn().mockResolvedValue(undefined),
  loadNotebookHistory: vi.fn().mockResolvedValue([]),
  saveNotebookHistory: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/llmService', () => ({
  getSettings: vi.fn().mockReturnValue({
    llmProvider: 'anthropic',
    llmModel: 'claude-sonnet-4-5-20250929',
    lastKernel: 'python3',
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

// Mock react-virtuoso
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

// Mock Cell component
vi.mock('../Cell', () => ({
  Cell: ({ cell, index, isActive, onClick }: any) => (
    <div
      data-testid={`cell-${cell.id}`}
      data-cell-id={cell.id}
      data-active={isActive}
      onClick={() => onClick(cell.id)}
    >
      <span data-testid={`cell-index-${index}`}>#{index + 1}</span>
      <div data-testid={`cell-content-${cell.id}`}>{cell.content}</div>
    </div>
  ),
}));

// Mock AIChatSidebar
vi.mock('../AIChatSidebar', () => ({
  AIChatSidebar: () => <div data-testid="ai-chat-sidebar">Mock AI Sidebar</div>,
}));

// Mock FileBrowser
vi.mock('../FileBrowser', () => ({
  FileBrowser: () => <div data-testid="file-browser">Mock File Browser</div>,
}));

// Mock other components
vi.mock('../SettingsModal', () => ({ SettingsModal: () => null }));
vi.mock('../KernelManager', () => ({ KernelManager: () => null }));
vi.mock('../NotebookSearch', () => ({ NotebookSearch: () => null }));
vi.mock('../NotebookBreadcrumb', () => ({ NotebookBreadcrumb: () => null }));

// Import after mocks
import { Notebook } from '../Notebook';
import { NotificationProvider } from '../NotificationSystem';

const renderNotebook = () => {
  return render(
    <NotificationProvider>
      <Notebook />
    </NotificationProvider>
  );
};

describe('Notebook conflict and recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorageMock.clear();

    // Default: no conflict (remote mtime matches what we loaded)
    mockGetFileMtime.mockResolvedValue({ path: '/test/notebook.ipynb', mtime: 1000 });
    mockGetFileContentWithMtime.mockResolvedValue({
      cells: [
        { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
      ],
      kernelspec: 'python3',
      mtime: 1000,
    });
    mockSaveFileContentWithMtime.mockResolvedValue({ success: true, mtime: 1001 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('crash recovery banner', () => {
    it('shows recovery banner when backup exists and differs from loaded content', async () => {
      // Setup: Create a backup in localStorage with different content
      const backupCells: Cell[] = [
        { id: 'cell-1', type: 'code', content: 'x = BACKUP_CONTENT', outputs: [], isExecuting: false },
      ];
      localStorageMock.setItem(
        'nebula-backup-/test/notebook.ipynb',
        JSON.stringify(backupCells)
      );
      localStorageMock.setItem(
        'nebula-backup-timestamp-/test/notebook.ipynb',
        (Date.now() - 5000).toString() // 5 seconds ago (fresh backup)
      );

      // File content is different from backup
      mockGetFileContentWithMtime.mockResolvedValue({
        cells: [
          { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
        ],
        kernelspec: 'python3',
        mtime: 1000,
      });

      renderNotebook();

      // Wait for notebook to load and recovery banner to appear
      await waitFor(() => {
        expect(screen.getByText('Unsaved changes recovered')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Verify recovery buttons are present
      expect(screen.getByText('Restore Changes')).toBeInTheDocument();
      expect(screen.getByText('Discard')).toBeInTheDocument();
    });

    it('does NOT show recovery banner when backup matches loaded content', async () => {
      // Setup: Backup content matches loaded content
      const cells: Cell[] = [
        { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
      ];
      localStorageMock.setItem(
        'nebula-backup-/test/notebook.ipynb',
        JSON.stringify(cells)
      );
      localStorageMock.setItem(
        'nebula-backup-timestamp-/test/notebook.ipynb',
        (Date.now() - 5000).toString()
      );

      mockGetFileContentWithMtime.mockResolvedValue({
        cells: cells,
        kernelspec: 'python3',
        mtime: 1000,
      });

      renderNotebook();

      // Wait for notebook to load
      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Small delay to ensure all effects have run
      await new Promise(resolve => setTimeout(resolve, 100));

      expect(screen.queryByText('Unsaved changes recovered')).not.toBeInTheDocument();
    });

    it('does NOT show recovery banner when backup is stale (>1 hour old)', async () => {
      // Setup: Old backup (2 hours ago)
      const backupCells: Cell[] = [
        { id: 'cell-1', type: 'code', content: 'x = OLD_BACKUP', outputs: [], isExecuting: false },
      ];
      localStorageMock.setItem(
        'nebula-backup-/test/notebook.ipynb',
        JSON.stringify(backupCells)
      );
      localStorageMock.setItem(
        'nebula-backup-timestamp-/test/notebook.ipynb',
        (Date.now() - 2 * 60 * 60 * 1000).toString() // 2 hours ago
      );

      renderNotebook();

      // Wait for notebook to load
      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      await new Promise(resolve => setTimeout(resolve, 100));

      expect(screen.queryByText('Unsaved changes recovered')).not.toBeInTheDocument();
    });

    it('clicking Restore Changes restores backup cells and hides banner', async () => {
      // Setup backup
      const backupCells: Cell[] = [
        { id: 'cell-1', type: 'code', content: 'x = RESTORED_CONTENT', outputs: [], isExecuting: false },
      ];
      localStorageMock.setItem(
        'nebula-backup-/test/notebook.ipynb',
        JSON.stringify(backupCells)
      );
      localStorageMock.setItem(
        'nebula-backup-timestamp-/test/notebook.ipynb',
        (Date.now() - 5000).toString()
      );

      renderNotebook();

      // Wait for recovery banner
      await waitFor(() => {
        expect(screen.getByText('Restore Changes')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Click restore
      await act(async () => {
        fireEvent.click(screen.getByText('Restore Changes'));
      });

      // Banner should be hidden
      await waitFor(() => {
        expect(screen.queryByText('Unsaved changes recovered')).not.toBeInTheDocument();
      });

      // Backup should be cleared
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('nebula-backup-/test/notebook.ipynb');
    });

    it('clicking Discard clears backup and hides banner', async () => {
      // Setup backup
      const backupCells: Cell[] = [
        { id: 'cell-1', type: 'code', content: 'x = DISCARDED', outputs: [], isExecuting: false },
      ];
      localStorageMock.setItem(
        'nebula-backup-/test/notebook.ipynb',
        JSON.stringify(backupCells)
      );
      localStorageMock.setItem(
        'nebula-backup-timestamp-/test/notebook.ipynb',
        (Date.now() - 5000).toString()
      );

      renderNotebook();

      // Wait for recovery banner
      await waitFor(() => {
        expect(screen.getByText('Discard')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Click discard
      await act(async () => {
        fireEvent.click(screen.getByText('Discard'));
      });

      // Banner should be hidden
      await waitFor(() => {
        expect(screen.queryByText('Unsaved changes recovered')).not.toBeInTheDocument();
      });

      // Backup should be cleared
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('nebula-backup-/test/notebook.ipynb');
    });
  });

  describe('conflict detection dialog', () => {
    it('shows conflict dialog when remote file is newer during save', async () => {
      renderNotebook();

      // Wait for notebook to load
      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Setup: Remote file is now newer (simulating external edit)
      mockGetFileMtime.mockResolvedValue({ path: '/test/notebook.ipynb', mtime: 2000 });

      // Trigger manual save with Ctrl+S
      await act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      });

      // Wait for conflict dialog to appear
      await waitFor(
        () => {
          expect(screen.getByText('Notebook Changed on Server')).toBeInTheDocument();
        },
        { timeout: 10000 }
      );

      // Verify dialog buttons
      expect(screen.getByText('Keep My Changes')).toBeInTheDocument();
      expect(screen.getByText('Load Server Version')).toBeInTheDocument();
    });

    it('Keep My Changes saves local version and closes dialog', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Setup conflict
      mockGetFileMtime.mockResolvedValue({ path: '/test/notebook.ipynb', mtime: 2000 });

      // Trigger save
      await act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      });

      // Wait for dialog
      await waitFor(
        () => {
          expect(screen.getByText('Keep My Changes')).toBeInTheDocument();
        },
        { timeout: 10000 }
      );

      // Click Keep My Changes
      await act(async () => {
        fireEvent.click(screen.getByText('Keep My Changes'));
      });

      // Dialog should close
      await waitFor(() => {
        expect(screen.queryByText('Notebook Changed on Server')).not.toBeInTheDocument();
      });

      // Save should have been called
      expect(mockSaveFileContentWithMtime).toHaveBeenCalled();
    });

    it('Load Server Version reloads content and closes dialog', async () => {
      const remoteCells: Cell[] = [
        { id: 'cell-1', type: 'code', content: 'REMOTE_CONTENT', outputs: [], isExecuting: false },
      ];

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Setup conflict
      mockGetFileMtime.mockResolvedValue({ path: '/test/notebook.ipynb', mtime: 2000 });
      mockGetFileContentWithMtime.mockResolvedValue({
        cells: remoteCells,
        kernelspec: 'python3',
        mtime: 2000,
      });

      // Trigger save
      await act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      });

      // Wait for dialog
      await waitFor(
        () => {
          expect(screen.getByText('Load Server Version')).toBeInTheDocument();
        },
        { timeout: 10000 }
      );

      // Click Load Server Version
      await act(async () => {
        fireEvent.click(screen.getByText('Load Server Version'));
      });

      // Dialog should close
      await waitFor(() => {
        expect(screen.queryByText('Notebook Changed on Server')).not.toBeInTheDocument();
      });

      // Content should be fetched
      expect(mockGetFileContentWithMtime).toHaveBeenCalled();
    });

    it('no conflict dialog when remote mtime matches local', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Remote mtime matches (no conflict)
      mockGetFileMtime.mockResolvedValue({ path: '/test/notebook.ipynb', mtime: 1000 });

      // Trigger save
      await act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      });

      // Wait a bit for any potential dialog
      await new Promise(resolve => setTimeout(resolve, 200));

      // No conflict dialog should appear
      expect(screen.queryByText('Notebook Changed on Server')).not.toBeInTheDocument();

      // Save should proceed
      expect(mockSaveFileContentWithMtime).toHaveBeenCalled();
    });

    it('network error during mtime check fails open (no conflict)', async () => {
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Simulate network error
      mockGetFileMtime.mockRejectedValue(new Error('Network error'));

      // Trigger save
      await act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      });

      // Wait a bit
      await new Promise(resolve => setTimeout(resolve, 200));

      // No conflict dialog (fail open)
      expect(screen.queryByText('Notebook Changed on Server')).not.toBeInTheDocument();

      // Save should proceed despite mtime check failure
      expect(mockSaveFileContentWithMtime).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('edge cases', () => {
    it('handles rapid save attempts during conflict', async () => {
      renderNotebook();

      await waitFor(() => {
        expect(screen.getByTestId('virtual-cell-list')).toBeInTheDocument();
      }, { timeout: 10000 });

      // Setup conflict
      mockGetFileMtime.mockResolvedValue({ path: '/test/notebook.ipynb', mtime: 2000 });

      // Trigger multiple rapid saves
      await act(async () => {
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
        fireEvent.keyDown(document, { key: 's', ctrlKey: true });
      });

      // Should only show one dialog
      await waitFor(
        () => {
          expect(screen.getByText('Notebook Changed on Server')).toBeInTheDocument();
        },
        { timeout: 10000 }
      );

      // Only one dialog should be present
      const dialogs = screen.queryAllByText('Notebook Changed on Server');
      expect(dialogs.length).toBe(1);
    });
  });
});
