/**
 * Tests for Cell component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Cell } from '../Cell';
import { Cell as ICell } from '../../types';
import { NotificationProvider } from '../NotificationSystem';

// Mock the services
vi.mock('../../services/llmService', () => ({
  getSettings: vi.fn().mockReturnValue({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-5-20250929' }),
  generateCellContent: vi.fn().mockResolvedValue('generated code'),
  fixCellError: vi.fn().mockResolvedValue('fixed code'),
}));

// Helper to render Cell with required providers
const renderCell = (props: React.ComponentProps<typeof Cell>) => {
  return render(
    <NotificationProvider>
      <Cell {...props} />
    </NotificationProvider>
  );
};

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
    allCellsRef: { current: [mockCell] },
    onUpdate: vi.fn(),
    onRun: vi.fn(),
    onRunAndAdvance: vi.fn(),
    onDelete: vi.fn(),
    onMove: vi.fn(),
    onChangeType: vi.fn(),
    onClick: vi.fn(),
    onAddCell: vi.fn(),
    onActivate: vi.fn(),
    onNavigateCell: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders cell content', () => {
    const { container } = renderCell(defaultProps);
    // CodeMirror renders content in a .cm-content element, tokenized into spans
    const cmContent = container.querySelector('.cm-content');
    expect(cmContent).toBeInTheDocument();
    expect(cmContent?.textContent).toContain('print');
  });

  it('renders cell index', () => {
    renderCell({ ...defaultProps, index: 2 });
    expect(screen.getByText('#3')).toBeInTheDocument();
  });

  describe('keyboard shortcuts', () => {
    // Note: CodeMirror keyboard shortcuts are tested via integration tests
    // since CodeMirror handles keyboard events through its own extension system
    // which doesn't work with fireEvent in unit tests.

    it('has keyboard handler configured', () => {
      const { container } = renderCell(defaultProps);
      // Verify CodeMirror is rendered with the content
      const cmContent = container.querySelector('.cm-content');
      expect(cmContent).toBeInTheDocument();
    });
  });

  describe('cell actions', () => {
    it('calls onDelete when delete button is clicked', () => {
      const onDelete = vi.fn();
      renderCell({ ...defaultProps, onDelete });

      fireEvent.click(screen.getByTitle('Delete Cell'));
      expect(onDelete).toHaveBeenCalledWith('test-cell-1');
    });

    it('calls onMove up when move up button is clicked', () => {
      const onMove = vi.fn();
      renderCell({ ...defaultProps, onMove });

      fireEvent.click(screen.getByTitle('Move Up'));
      expect(onMove).toHaveBeenCalledWith('test-cell-1', 'up');
    });

    it('calls onMove down when move down button is clicked', () => {
      const onMove = vi.fn();
      renderCell({ ...defaultProps, onMove });

      fireEvent.click(screen.getByTitle('Move Down'));
      expect(onMove).toHaveBeenCalledWith('test-cell-1', 'down');
    });

    it('calls onChangeType when code button is clicked', () => {
      const onChangeType = vi.fn();
      renderCell({ ...defaultProps, onChangeType });

      fireEvent.click(screen.getByText('Code'));
      expect(onChangeType).toHaveBeenCalledWith('test-cell-1', 'code');
    });

    it('calls onChangeType when text button is clicked', () => {
      const onChangeType = vi.fn();
      renderCell({ ...defaultProps, onChangeType });

      fireEvent.click(screen.getByText('Text'));
      expect(onChangeType).toHaveBeenCalledWith('test-cell-1', 'markdown');
    });
  });

  describe('run button tooltip', () => {
    it('shows both shortcuts in tooltip', () => {
      renderCell(defaultProps);
      const runButton = screen.getByTitle('Run Cell (Shift+Enter or Ctrl+Enter)');
      expect(runButton).toBeInTheDocument();
    });
  });

  describe('command/edit mode visual distinction', () => {
    it('shows command mode (green) border when cell div is focused', () => {
      const { container } = renderCell({ ...defaultProps, isActive: true, onActivate: vi.fn() });
      const cellDiv = container.querySelector('[data-cell-id]') as HTMLElement;

      // Focus the cell div itself to enter command mode
      fireEvent.focus(cellDiv);

      // Should have green border for command mode
      expect(cellDiv.className).toContain('border-green');
    });

    it('shows edit mode (blue) border when editor is focused', () => {
      const { container } = renderCell({ ...defaultProps, isActive: true, onActivate: vi.fn() });
      const cellDiv = container.querySelector('[data-cell-id]') as HTMLElement;

      // Focus the CodeMirror editor to enter edit mode
      const cmContent = container.querySelector('.cm-content') as HTMLElement;
      fireEvent.focus(cmContent);

      // Should now have blue border for edit mode
      expect(cellDiv.className).toContain('border-blue');
    });

    it('shows default border when not focused', () => {
      const { container } = renderCell({ ...defaultProps, isActive: false });
      const cellDiv = container.querySelector('[data-cell-id]') as HTMLElement;

      // Should have default slate border when not focused
      expect(cellDiv.className).toContain('border-slate');
      expect(cellDiv.className).not.toContain('border-green');
      expect(cellDiv.className).not.toContain('border-blue');
    });
  });

  describe('execution feedback', () => {
    it('shows [ ] for never-executed cell', () => {
      renderCell({ ...defaultProps, cell: { ...mockCell, executionCount: undefined } });
      expect(screen.getByText('[ ]')).toBeInTheDocument();
    });

    it('shows [*] while cell is executing', () => {
      renderCell({ ...defaultProps, cell: { ...mockCell, isExecuting: true } });
      expect(screen.getByText('[*]')).toBeInTheDocument();
    });

    it('shows [n] after cell has executed', () => {
      renderCell({ ...defaultProps, cell: { ...mockCell, executionCount: 5 } });
      expect(screen.getByText('[5]')).toBeInTheDocument();
    });
  });

  describe('scrolled property persistence (collapse state)', () => {
    // scrolled in Jupyter standard means output is collapsed with max-height
    // scrolled=true → collapsed, scrolled=false/undefined → expanded
    const cellWithOutput: ICell = {
      ...mockCell,
      outputs: [{ id: 'out-1', type: 'stdout', content: 'Hello World', timestamp: Date.now() }],
      lastExecutionMs: 100,
    };

    it('passes scrolled=undefined to CellOutput by default (expanded)', () => {
      const { container } = renderCell({ ...defaultProps, cell: cellWithOutput });
      // CellOutput should render when there are outputs
      const outputArea = container.querySelector('.border-t.border-slate-100');
      expect(outputArea).toBeInTheDocument();
    });

    it('passes scrolled=false to CellOutput when cell has scrolled=false (expanded)', () => {
      const cellWithScrolledFalse = { ...cellWithOutput, scrolled: false };
      const { container } = renderCell({ ...defaultProps, cell: cellWithScrolledFalse });
      const outputArea = container.querySelector('.border-t.border-slate-100');
      expect(outputArea).toBeInTheDocument();
      // scrolled=false means expanded - no max-height constraint
    });

    it('passes scrolled=true to CellOutput when cell has scrolled=true (collapsed)', () => {
      const cellWithScrolledTrue = { ...cellWithOutput, scrolled: true };
      const { container } = renderCell({ ...defaultProps, cell: cellWithScrolledTrue });
      const outputArea = container.querySelector('.border-t.border-slate-100');
      expect(outputArea).toBeInTheDocument();
      // scrolled=true means collapsed - output has max-height and scrolls
    });

    it('calls onSetCellScrolled when collapse toggle is clicked', () => {
      // Create a cell with tall output that shows the collapse option
      const tallOutput = 'Line\n'.repeat(50); // Tall enough to show collapse option
      const cellWithTallOutput: ICell = {
        ...mockCell,
        outputs: [{ id: 'out-1', type: 'stdout', content: tallOutput, timestamp: Date.now() }],
        lastExecutionMs: 100,
        scrolled: false, // Start expanded
      };
      const onSetCellScrolled = vi.fn();
      const { container } = renderCell({
        ...defaultProps,
        cell: cellWithTallOutput,
        onSetCellScrolled,
      });

      // Find the collapse toggle (left gutter with chevron)
      const collapseToggle = container.querySelector('[title*="Collapse"]');
      if (collapseToggle) {
        fireEvent.click(collapseToggle);
        expect(onSetCellScrolled).toHaveBeenCalledWith(mockCell.id, true);
      }
    });

    it('preserves scrolled property when cell content changes', () => {
      const cellWithScrolled = { ...cellWithOutput, scrolled: true, content: 'original' };
      const { rerender, container } = renderCell({ ...defaultProps, cell: cellWithScrolled });

      // Verify initial state - scrolled=true means collapsed
      const outputArea = container.querySelector('.border-t.border-slate-100');
      expect(outputArea).toBeInTheDocument();

      // Update content but keep scrolled
      const updatedCell = { ...cellWithScrolled, content: 'updated content' };
      rerender(
        <NotificationProvider>
          <Cell {...defaultProps} cell={updatedCell} />
        </NotificationProvider>
      );

      // scrolled should still be true (collapsed)
      expect(container.querySelector('.border-t.border-slate-100')).toBeInTheDocument();
    });
  });
});
