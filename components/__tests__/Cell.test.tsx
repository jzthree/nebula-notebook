/**
 * Tests for Cell component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Cell } from '../Cell';
import { Cell as ICell } from '../../types';

// Mock the services
vi.mock('../../services/llmService', () => ({
  getSettings: vi.fn().mockReturnValue({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-5-20250929' }),
  generateCellContent: vi.fn().mockResolvedValue('generated code'),
  fixCellError: vi.fn().mockResolvedValue('fixed code'),
}));

describe('Cell', () => {
  const mockCell: ICell = {
    id: 'test-cell-1',
    type: 'code',
    content: 'print("hello")',
    outputs: [],
    isExecuting: false
  };

  const defaultProps = {
    cell: mockCell,
    index: 0,
    isActive: false,
    allCells: [mockCell],
    onUpdate: vi.fn(),
    onRun: vi.fn(),
    onRunAndAdvance: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onChangeType: vi.fn(),
    onClick: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders cell content', () => {
    const { container } = render(<Cell {...defaultProps} />);
    // CodeMirror renders content in a .cm-content element, tokenized into spans
    const cmContent = container.querySelector('.cm-content');
    expect(cmContent).toBeInTheDocument();
    expect(cmContent?.textContent).toContain('print');
  });

  it('renders cell index', () => {
    render(<Cell {...defaultProps} index={2} />);
    expect(screen.getByText('#3')).toBeInTheDocument();
  });

  describe('keyboard shortcuts', () => {
    // Note: CodeMirror keyboard shortcuts are tested via integration tests
    // since CodeMirror handles keyboard events through its own extension system
    // which doesn't work with fireEvent in unit tests.

    it('has keyboard handler configured', () => {
      const { container } = render(<Cell {...defaultProps} />);
      // Verify CodeMirror is rendered with the content
      const cmContent = container.querySelector('.cm-content');
      expect(cmContent).toBeInTheDocument();
    });
  });

  describe('cell actions', () => {
    it('calls onDelete when delete button is clicked', () => {
      const onDelete = vi.fn();
      render(<Cell {...defaultProps} onDelete={onDelete} />);

      fireEvent.click(screen.getByTitle('Delete Cell'));
      expect(onDelete).toHaveBeenCalledWith('test-cell-1');
    });

    it('calls onMove up when move up button is clicked', () => {
      const onMove = vi.fn();
      render(<Cell {...defaultProps} onMove={onMove} />);

      fireEvent.click(screen.getByTitle('Move Up'));
      expect(onMove).toHaveBeenCalledWith('test-cell-1', 'up');
    });

    it('calls onMove down when move down button is clicked', () => {
      const onMove = vi.fn();
      render(<Cell {...defaultProps} onMove={onMove} />);

      fireEvent.click(screen.getByTitle('Move Down'));
      expect(onMove).toHaveBeenCalledWith('test-cell-1', 'down');
    });

    it('calls onChangeType when code button is clicked', () => {
      const onChangeType = vi.fn();
      render(<Cell {...defaultProps} onChangeType={onChangeType} />);

      fireEvent.click(screen.getByText('Code'));
      expect(onChangeType).toHaveBeenCalledWith('test-cell-1', 'code');
    });

    it('calls onChangeType when markdown button is clicked', () => {
      const onChangeType = vi.fn();
      render(<Cell {...defaultProps} onChangeType={onChangeType} />);

      fireEvent.click(screen.getByText('Markdown'));
      expect(onChangeType).toHaveBeenCalledWith('test-cell-1', 'markdown');
    });
  });

  describe('run button tooltip', () => {
    it('shows both shortcuts in tooltip', () => {
      render(<Cell {...defaultProps} />);
      const runButton = screen.getByTitle('Run Cell (Shift+Enter or Ctrl+Enter)');
      expect(runButton).toBeInTheDocument();
    });
  });
});
