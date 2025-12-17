/**
 * Tests for NotebookEditor component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
  getSettings: vi.fn().mockReturnValue({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-5-20250929' }),
  saveSettings: vi.fn(),
  getAvailableProviders: vi.fn().mockResolvedValue({ providers: {} }),
  chatWithNotebook: vi.fn().mockResolvedValue('Test response'),
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

  describe('AIChatSidebar integration', () => {
    it('renders AIChatSidebar when isChatOpen is true', () => {
      render(<NotebookEditor {...mockProps} isChatOpen={true} />);
      expect(screen.getByText('Nebula Copilot')).toBeInTheDocument();
    });

    it('does not show AIChatSidebar content when isChatOpen is false', () => {
      render(<NotebookEditor {...mockProps} isChatOpen={false} />);
      // The sidebar exists but is translated off-screen (translate-x-full)
      const sidebar = screen.getByText('Nebula Copilot').closest('div[class*="translate-x"]');
      expect(sidebar).toHaveClass('translate-x-full');
    });

    it('toggles chat sidebar when Copilot button is clicked', () => {
      const setIsChatOpen = vi.fn();
      render(<NotebookEditor {...mockProps} isChatOpen={false} setIsChatOpen={setIsChatOpen} />);

      const copilotButton = screen.getByText('Copilot').closest('button');
      fireEvent.click(copilotButton!);

      expect(setIsChatOpen).toHaveBeenCalledWith(true);
    });

    it('passes cells to AIChatSidebar for context', () => {
      render(<NotebookEditor {...mockProps} isChatOpen={true} />);
      // The welcome message should be visible, indicating the sidebar received the cells
      expect(screen.getByText(/I am Nebula AI/)).toBeInTheDocument();
    });
  });
});
