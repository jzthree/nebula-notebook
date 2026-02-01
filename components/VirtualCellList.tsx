import React, { forwardRef, useCallback, useState, useEffect, useRef, useMemo } from 'react';
import { Cell } from '../types';
import { Virtuoso, VirtuosoHandle, ListRange } from 'react-virtuoso';
import { computeDefaultCellHeight } from '../utils/virtualCellMetrics';

// Cache measured cell heights globally to persist across re-renders
// Key: cell ID, Value: measured height in pixels
const cellHeightCache = new Map<string, number>();

// ⚠️ MEMORY MANAGEMENT: Clean up stale entries periodically
// This prevents memory leaks when cells are deleted
function cleanupCacheForCells(currentCellIds: Set<string>): void {
  for (const cachedId of cellHeightCache.keys()) {
    if (!currentCellIds.has(cachedId)) {
      cellHeightCache.delete(cachedId);
    }
  }
}

interface Props {
  cells: Cell[];
  renderCell: (cell: Cell, index: number) => React.ReactNode;
  virtuosoRef?: React.RefObject<VirtuosoHandle>;
  className?: string;
  onRangeChange?: (range: ListRange) => void;
  renderKey?: string | number;
}

// Custom Scroller to ensure layout matches previous design (Max width centered)
const ListContainer = forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>((props, ref) => (
  <div
    {...props}
    ref={ref}
    className="max-w-5xl mx-auto px-4"
  />
));

// Footer component to add bottom padding so last cell isn't cut off
const Footer = () => <div className="h-32" />;

export const VirtualCellList: React.FC<Props> = ({ cells, renderCell, virtuosoRef, className, onRangeChange, renderKey }) => {
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

  // Keep cells ref for height estimation
  const cellsRef = useRef(cells);
  cellsRef.current = cells;

  // ⚠️ MEMORY LEAK FIX: Clean up stale cache entries when cells are deleted
  // Avoid O(N) work on every keystroke by only running when cell count changes.
  const prevCellCountRef = useRef(cells.length);
  useEffect(() => {
    const prevCount = prevCellCountRef.current;
    prevCellCountRef.current = cells.length;

    const cacheTooLarge = cellHeightCache.size > cells.length + 10;
    const cellsRemoved = cells.length < prevCount;
    if (!cacheTooLarge && !cellsRemoved) {
      return;
    }

    const currentCellIds = new Set<string>(cellsRef.current.map(c => c.id));
    cleanupCacheForCells(currentCellIds);
  }, [cells.length]);

  useEffect(() => {
    const updateExtension = () => {
      // Extend by 1x window height - enough for smooth scrolling without excess memory
      setViewportExtension(window.innerHeight);
    };
    window.addEventListener('resize', updateExtension);
    return () => window.removeEventListener('resize', updateExtension);
  }, []);

  // Calculate smart default height based on cells content
  // This reduces scroll jumps when scrolling up to unmeasured cells.
  // ⚠️ PERFORMANCE: Only recompute when cell count changes (not on every keystroke).
  const defaultHeight = useMemo(() => {
    return computeDefaultCellHeight(cellsRef.current, cellHeightCache);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells.length, renderKey]);

  // Cache measured heights when Virtuoso measures items
  const itemSize = useCallback((el: HTMLElement) => {
    // Virtuoso's wrapper contains our div with data-cell-id as first child
    const wrapper = el.firstElementChild as HTMLElement | null;
    const cellId = wrapper?.getAttribute('data-cell-id') || el.getAttribute('data-cell-id');
    const height = el.getBoundingClientRect().height;

    if (cellId && height > 0) {
      cellHeightCache.set(cellId, height);
    }
    return height;
  }, []);

  // Wrapper that adds data-cell-id for height tracking.
  // renderKey forces a re-render when settings affect rendering (e.g., line numbers).
  const wrappedRenderCell = useCallback((cell: Cell, index: number) => {
    return (
      <div data-cell-id={cell.id} data-render-key={renderKey ?? 0}>
        {renderCellRef.current(cell, index)}
      </div>
    );
  }, [renderKey]);

  const itemContent = useCallback((index: number, cell: Cell) => wrappedRenderCell(cell, index), [wrappedRenderCell]);

  return (
    <Virtuoso
      key={renderKey} // Force full re-render when settings like line numbers change
      ref={virtuosoRef}
      className={className}
      data={cells}
      useWindowScroll={false}
      totalCount={cells.length}
      itemContent={itemContent}
      // Use stable cell IDs as keys to prevent scroll jumps when cells update
      computeItemKey={(index, cell) => cell.id}
      // Dynamic default height based on average cell size in this notebook
      // Reduces scroll jumps when scrolling up to unmeasured cells
      defaultItemHeight={defaultHeight}
      // Extend viewport by 1x window height in each direction
      // Balance between smooth scrolling and memory usage (too large = too many mounted cells)
      increaseViewportBy={{ top: viewportExtension, bottom: viewportExtension }}
      // Ensure at least 3 items rendered above/below viewport
      // This helps with tall cells where pixel-based overscan is insufficient
      minOverscanItemCount={3}
      components={{
        List: ListContainer,
        Footer
      }}
      followOutput={false}
      alignToBottom={false}
      rangeChanged={onRangeChange}
      // itemSize measures AFTER render (caches actual heights)
      itemSize={itemSize}
    />
  );
};
