/**
 * Tests for NotebookContainer component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { NotebookContainer } from '../NotebookContainer';

// Mock all the services
vi.mock('../../services/kernelService', () => ({
  kernelService: {
    getPythonEnvironments: vi.fn().mockResolvedValue({ kernelspecs: [], environments: [] }),
    executeCode: vi.fn(),
    stopKernel: vi.fn().mockResolvedValue(undefined),
    startKernel: vi.fn().mockResolvedValue('mock-session-id'),
    restartKernel: vi.fn(),
    interruptKernel: vi.fn(),
  }
}));

vi.mock('../../services/fileService', () => ({
  getFiles: vi.fn().mockResolvedValue([
    { id: '/test/notebook.ipynb', name: 'notebook', extension: '.ipynb', fileType: 'notebook' }
  ]),
  getFileContent: vi.fn().mockResolvedValue([
    { id: 'cell-1', type: 'code', content: 'print("test")', outputs: [], isExecuting: false }
  ]),
  saveFileContent: vi.fn().mockResolvedValue(undefined),
  saveActiveFileId: vi.fn(),
  updateNotebookMetadata: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/llmService', () => ({
  getSettings: vi.fn().mockReturnValue({}),
  saveSettings: vi.fn(),
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

describe('NotebookContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
