import React, { forwardRef, useCallback, useState, useEffect, useRef } from 'react';
import { Cell } from '../types';
import { Virtuoso, VirtuosoHandle, ListRange } from 'react-virtuoso';
import { DEFAULT_CELL_HEIGHT_PX } from '../config';

// Cache measured cell heights globally to persist across re-renders
// Key: cell ID, Value: measured height in pixels
const cellHeightCache = new Map<string, number>();

interface Props {
  cells: Cell[];
  renderCell: (cell: Cell, index: number) => React.ReactNode;
  virtuosoRef?: React.RefObject<VirtuosoHandle>;
  className?: string;
  onRangeChange?: (range: ListRange) => void;
}

// Custom Scroller to ensure layout matches previous design (Max width centered)
const ListContainer = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
  <div
    {...props}
    ref={ref}
    className="max-w-5xl mx-auto px-4 pt-4"
  />
));

// Footer component to add bottom padding so last cell isn't cut off
const Footer = () => <div className="h-32" />;

export const VirtualCellList: React.FC<Props> = ({ cells, renderCell, virtuosoRef, className, onRangeChange }) => {
  // Track window height to dynamically size the viewport extension
  // Using 1x window height as a balance between smooth scrolling and memory usage
  // Too large (3x) causes too many cells to stay mounted, increasing lag over time
  const [viewportExtension, setViewportExtension] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight : 1000
  );

  // ⚠️ PERFORMANCE CRITICAL: Use ref for renderCell to keep itemContent stable
  // This prevents Virtuoso from re-calling itemContent for all visible cells
  // when the parent re-renders with a new function reference.
  const renderCellRef = useRef(renderCell);
  renderCellRef.current = renderCell;

  useEffect(() => {
    const updateExtension = () => {
      // Extend by 1x window height - enough for smooth scrolling without excess memory
      setViewportExtension(window.innerHeight);
    };
    window.addEventListener('resize', updateExtension);
    return () => window.removeEventListener('resize', updateExtension);
  }, []);

  // Cache measured heights when Virtuoso measures items
  const itemSize = useCallback((el: HTMLElement) => {
    const cellId = el.getAttribute('data-cell-id');
    if (cellId) {
      const height = el.getBoundingClientRect().height;
      if (height > 0) {
        cellHeightCache.set(cellId, height);
      }
    }
    return el.getBoundingClientRect().height;
  }, []);

  // Wrapper that adds data-cell-id for height tracking
  // Uses ref to avoid recreating when renderCell prop changes
  const wrappedRenderCell = useCallback((cell: Cell, index: number) => {
    return (
      <div data-cell-id={cell.id}>
        {renderCellRef.current(cell, index)}
      </div>
    );
  }, []);

  return (
    <Virtuoso
      ref={virtuosoRef}
      className={className}
      data={cells}
      useWindowScroll={false}
      totalCount={cells.length}
      itemContent={(index, cell) => wrappedRenderCell(cell, index)}
      // Use stable cell IDs as keys to prevent scroll jumps when cells update
      computeItemKey={(index, cell) => cell.id}
      // Default height estimate - used for cells not yet measured
      defaultItemHeight={DEFAULT_CELL_HEIGHT_PX}
      // Extend viewport by 1x window height in each direction
      // Balance between smooth scrolling and memory usage (too large = too many mounted cells)
      increaseViewportBy={{ top: viewportExtension, bottom: viewportExtension }}
      components={{
        List: ListContainer,
        Footer
      }}
      followOutput={false}
      alignToBottom={false}
      rangeChanged={onRangeChange}
      itemSize={itemSize}
    />
  );
};