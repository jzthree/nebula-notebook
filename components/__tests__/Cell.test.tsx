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
    render(<Cell {...defaultProps} />);
    expect(screen.getByDisplayValue('print("hello")')).toBeInTheDocument();
  });

  it('renders cell index', () => {
    render(<Cell {...defaultProps} index={2} />);
    expect(screen.getByText('#3')).toBeInTheDocument();
  });

  describe('keyboard shortcuts', () => {
    it('calls onRunAndAdvance on Shift+Enter', () => {
      const onRunAndAdvance = vi.fn();
      render(<Cell {...defaultProps} onRunAndAdvance={onRunAndAdvance} />);

      const textarea = screen.getByDisplayValue('print("hello")');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      expect(onRunAndAdvance).toHaveBeenCalledWith('test-cell-1');
    });

    it('calls onRun on Ctrl+Enter', () => {
      const onRun = vi.fn();
      render(<Cell {...defaultProps} onRun={onRun} />);

      const textarea = screen.getByDisplayValue('print("hello")');
      fireEvent.keyDown(textarea, { key: 'Enter', ctrlKey: true });

      expect(onRun).toHaveBeenCalledWith('test-cell-1');
    });

    it('calls onRun on Cmd+Enter (Mac)', () => {
      const onRun = vi.fn();
      render(<Cell {...defaultProps} onRun={onRun} />);

      const textarea = screen.getByDisplayValue('print("hello")');
      fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });

      expect(onRun).toHaveBeenCalledWith('test-cell-1');
    });

    it('does not call onRun or onRunAndAdvance on plain Enter', () => {
      const onRun = vi.fn();
      const onRunAndAdvance = vi.fn();
      render(<Cell {...defaultProps} onRun={onRun} onRunAndAdvance={onRunAndAdvance} />);

      const textarea = screen.getByDisplayValue('print("hello")');
      fireEvent.keyDown(textarea, { key: 'Enter' });

      expect(onRun).not.toHaveBeenCalled();
      expect(onRunAndAdvance).not.toHaveBeenCalled();
    });

    it('does not call onRunAndAdvance on Ctrl+Shift+Enter', () => {
      const onRunAndAdvance = vi.fn();
      const onRun = vi.fn();
      render(<Cell {...defaultProps} onRunAndAdvance={onRunAndAdvance} onRun={onRun} />);

      const textarea = screen.getByDisplayValue('print("hello")');
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true, ctrlKey: true });

      // Neither should be called when both modifiers are pressed
      expect(onRunAndAdvance).not.toHaveBeenCalled();
      expect(onRun).not.toHaveBeenCalled();
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
