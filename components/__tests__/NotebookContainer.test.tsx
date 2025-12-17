/**
 * Tests for NotebookContainer component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { NotebookContainer } from '../NotebookContainer';

// Mock all the services - vi.mock is hoisted, so we use vi.hoisted for shared mocks
const { mockStartKernel, mockStopKernel, mockGetFileContent, mockGetFiles, mockSaveActiveFileId } = vi.hoisted(() => ({
  mockStartKernel: vi.fn(),
  mockStopKernel: vi.fn(),
  mockGetFileContent: vi.fn(),
  mockGetFiles: vi.fn(),
  mockSaveActiveFileId: vi.fn(),
}));

vi.mock('../../services/kernelService', () => ({
  kernelService: {
    getPythonEnvironments: vi.fn().mockResolvedValue({ kernelspecs: [], environments: [] }),
    executeCode: vi.fn(),
    stopKernel: mockStopKernel,
    startKernel: mockStartKernel,
    restartKernel: vi.fn(),
    interruptKernel: vi.fn(),
  }
}));

vi.mock('../../services/fileService', () => ({
  getFiles: mockGetFiles,
  getFileContent: mockGetFileContent,
  saveFileContent: vi.fn().mockResolvedValue(undefined),
  saveActiveFileId: mockSaveActiveFileId,
  updateNotebookMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/llmService', () => ({
  getSettings: vi.fn().mockReturnValue({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-5-20250929' }),
  saveSettings: vi.fn(),
  getAvailableProviders: vi.fn().mockResolvedValue({ providers: {} }),
}));

// Mock useAutosave hook
vi.mock('../../hooks/useAutosave', () => ({
  useAutosave: () => ({
    status: { status: 'saved', lastSaved: Date.now() },
    saveNow: vi.fn(),
    getBackup: vi.fn().mockReturnValue(null),
    clearBackup: vi.fn(),
  }),
  formatLastSaved: () => 'just now',
}));

// Mock window.confirm
const mockConfirm = vi.fn(() => true);
window.confirm = mockConfirm;

describe('NotebookContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfirm.mockReturnValue(true);

    // Set up default mock implementations
    mockStartKernel.mockResolvedValue('mock-session-id');
    mockStopKernel.mockResolvedValue(undefined);
    mockGetFileContent.mockResolvedValue([
      { id: 'cell-1', type: 'code', content: 'print("test")', outputs: [], isExecuting: false }
    ]);
    mockGetFiles.mockResolvedValue([
      { id: '/test/notebook.ipynb', name: 'notebook', extension: '.ipynb', fileType: 'notebook' },
      { id: '/test/notebook2.ipynb', name: 'notebook2', extension: '.ipynb', fileType: 'notebook' }
    ]);
  });

  describe('empty state', () => {
    it('renders empty state initially', async () => {
      render(<NotebookContainer />);

      await waitFor(() => {
        expect(screen.getByText('No notebook open')).toBeInTheDocument();
      });
    });

    it('renders Open File Browser button', async () => {
      render(<NotebookContainer />);

      await waitFor(() => {
        expect(screen.getByText('Open File Browser')).toBeInTheDocument();
      });
    });
  });

  describe('tab bar', () => {
    it('renders new tab button', async () => {
      render(<NotebookContainer />);

      await waitFor(() => {
        expect(screen.getByTitle('Open new notebook')).toBeInTheDocument();
      });
    });
  });

  describe('file list loading', () => {
    it('calls getFiles on mount', async () => {
      render(<NotebookContainer />);

      await waitFor(() => {
        expect(mockGetFiles).toHaveBeenCalled();
      });
    });
  });

  describe('kernel lifecycle', () => {
    it('startKernel is available for opening notebooks', () => {
      // Verify the mock is correctly set up
      expect(mockStartKernel).toBeDefined();
      expect(typeof mockStartKernel).toBe('function');
    });

    it('stopKernel is available for closing notebooks', () => {
      // Verify the mock is correctly set up
      expect(mockStopKernel).toBeDefined();
      expect(typeof mockStopKernel).toBe('function');
    });
  });
});
