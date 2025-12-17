/**
 * Tests for NotebookEditor component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NotebookEditor } from '../NotebookEditor';
import { NotebookState, Cell } from '../../types';

// Mock the services
vi.mock('../../services/kernelService', () => ({
  kernelService: {
    getPythonEnvironments: vi.fn().mockResolvedValue({ kernelspecs: [], environments: [] }),
    executeCode: vi.fn(),
    stopKernel: vi.fn(),
    startKernel: vi.fn(),
    restartKernel: vi.fn(),
    interruptKernel: vi.fn(),
  }
}));

vi.mock('../../services/fileService', () => ({
  saveFileContent: vi.fn().mockResolvedValue(undefined),
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

describe('NotebookEditor', () => {
  const mockCell: Cell = {
    id: 'test-cell-1',
    type: 'code',
    content: 'print("hello")',
    outputs: [],
    isExecuting: false
  };

  const mockState: NotebookState = {
    tabId: 'tab-1',
    fileId: '/path/to/notebook.ipynb',
    cells: [mockCell],
    activeCellId: 'test-cell-1',
    kernelSessionId: 'session-1',
    kernelStatus: 'idle',
    kernelName: 'python3',
    executionQueue: []
  };

  const mockProps = {
    state: mockState,
    onStateChange: vi.fn(),
    onMarkClean: vi.fn(),
    isFileBrowserOpen: false,
    setIsFileBrowserOpen: vi.fn(),
    isChatOpen: false,
    setIsChatOpen: vi.fn(),
    setIsSettingsOpen: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders without crashing', () => {
    render(<NotebookEditor {...mockProps} />);
    // Should render the notebook name
    expect(screen.getByText('notebook')).toBeInTheDocument();
  });

  it('renders toolbar buttons', () => {
    render(<NotebookEditor {...mockProps} />);
    expect(screen.getByText('Run All')).toBeInTheDocument();
    expect(screen.getByText('Copilot')).toBeInTheDocument();
  });
});
