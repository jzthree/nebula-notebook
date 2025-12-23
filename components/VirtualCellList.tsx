import React, { forwardRef, useCallback, useState, useEffect } from 'react';
import { Cell } from '../types';
import { Virtuoso, VirtuosoHandle, ListRange } from 'react-virtuoso';

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
  const [viewportExtension, setViewportExtension] = useState(() =>
    typeof window !== 'undefined' ? window.innerHeight * 3 : 3000
  );

  useEffect(() => {
    const updateExtension = () => {
      // Extend by 3x window height to handle cells up to 3 screens tall
      setViewportExtension(window.innerHeight * 3);
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
  const wrappedRenderCell = useCallback((cell: Cell, index: number) => {
    return (
      <div data-cell-id={cell.id}>
        {renderCell(cell, index)}
      </div>
    );
  }, [renderCell]);

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
      defaultItemHeight={150}
      // Extend viewport by 3x window height in each direction
      // This ensures cells are rendered and measured well before becoming visible,
      // preventing scroll jumps from height estimation mismatches
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