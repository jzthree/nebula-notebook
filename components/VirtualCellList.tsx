import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Cell } from '../types';
import { estimateCellHeight } from '../utils/virtualCellMetrics';

// ─── Public handle exposed via virtuosoRef ───────────────────────────────────
export interface CellListHandle {
  scrollToIndex: (options: {
    index: number;
    align?: 'start' | 'center' | 'end';
    behavior?: ScrollBehavior;
    offset?: number;
  }) => void;
}

interface Props {
  cells: Cell[];
  renderCell: (cell: Cell, index: number) => React.ReactNode;
  virtuosoRef?: React.RefObject<CellListHandle | null>;
  className?: string;
  onRangeChange?: (range: { startIndex: number; endIndex: number }) => void;
  renderKey?: string | number;
}

/**
 * Lightweight virtual list that replaces react-virtuoso.
 *
 * Key design difference: scroll tracking uses a **passive** listener with
 * `requestAnimationFrame` → `setState`.  This means React mounts/unmounts
 * cells **asynchronously** in a normal render pass.  react-virtuoso instead
 * called `flushSync()` inside the scroll handler, forcing a synchronous
 * React commit on every scroll event and blocking the main thread for
 * hundreds of ms (~4 000 ms total in a representative trace).
 *
 * Rendered cells also get `content-visibility: auto` so the browser can
 * skip layout/paint for cells that are mounted but outside the viewport
 * (within the overscan zone).
 */

// ─── Height cache (global, persists across re-renders) ──────────────────────
const heightCache = new Map<string, number>();

function getCellHeight(cell: Cell): number {
  return heightCache.get(cell.id) ?? estimateCellHeight(cell);
}

// Pixels of overscan above and below the viewport.
const OVERSCAN_PX = 3000;

// Minimum ms between height-triggered re-renders. Prevents cascade:
// mount → measure → rerender → mount new → measure → rerender …
const HEIGHT_DEBOUNCE_MS = 150;

export const VirtualCellList: React.FC<Props> = ({
  cells,
  renderCell,
  virtuosoRef,
  className,
  onRangeChange,
  renderKey,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // ── Scroll position (updated async via RAF) ───────────────────────────────
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(800);

  // ── Height measurement version counter ────────────────────────────────────
  const [heightVersion, setHeightVersion] = useState(0);
  const heightVersionRef = useRef(0);

  // Stable ref for onRangeChange
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;

  // ── Cumulative offsets ────────────────────────────────────────────────────
  const offsets = useMemo(() => {
    const result = new Float64Array(cells.length);
    let cumulative = 0;
    for (let i = 0; i < cells.length; i++) {
      result[i] = cumulative;
      cumulative += getCellHeight(cells[i]);
    }
    return result;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, heightVersion]);

  const totalHeight = useMemo(() => {
    if (cells.length === 0) return 0;
    const last = cells.length - 1;
    return offsets[last] + getCellHeight(cells[last]);
  }, [cells, offsets]);

  // ── Visible range (binary search) ────────────────────────────────────────
  const startIdx = useMemo(() => {
    if (cells.length === 0) return 0;
    const target = Math.max(0, scrollTop - OVERSCAN_PX);
    let lo = 0;
    let hi = cells.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid] + getCellHeight(cells[mid]) <= target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, offsets, scrollTop]);

  const endIdx = useMemo(() => {
    const target = scrollTop + viewportHeight + OVERSCAN_PX;
    let end = startIdx;
    while (end < cells.length && offsets[end] < target) {
      end++;
    }
    return end;
  }, [cells, offsets, startIdx, scrollTop, viewportHeight]);

  // ── Passive scroll listener (RAF-batched, never blocks scroll) ────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        setScrollTop(container.scrollTop);
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });

    // Track viewport resize
    const ro = new ResizeObserver(() => {
      setViewportHeight(container.clientHeight);
    });
    ro.observe(container);

    // Initial values
    setScrollTop(container.scrollTop);
    setViewportHeight(container.clientHeight);

    return () => {
      container.removeEventListener('scroll', onScroll);
      ro.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, []);

  // ── Single stable ResizeObserver for cell measurement ─────────────────────
  // Created once on mount. Individual cells are observed/unobserved via
  // MutationObserver on the list container — this avoids re-creating the
  // ResizeObserver when the visible range changes (which was causing an
  // infinite measure → rerender → measure cascade).
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const resizeObserver = new ResizeObserver((entries) => {
      let anyChanged = false;
      for (const entry of entries) {
        const el = entry.target as HTMLElement;
        const cellId = el.dataset.cellId;
        if (!cellId) continue;
        const h = Math.round(
          entry.borderBoxSize?.[0]?.blockSize ?? el.offsetHeight,
        );
        if (h > 0) {
          const prev = heightCache.get(cellId);
          if (prev === undefined || Math.abs(prev - h) > 2) {
            heightCache.set(cellId, h);
            anyChanged = true;
          }
        }
      }
      if (anyChanged) {
        // Debounce: batch rapid height changes (e.g. many cells mounting at
        // once after scroll) into a single state update. Without this, the
        // cycle measure→rerender→mount→measure can run away and freeze the tab.
        if (debounceTimer !== null) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          heightVersionRef.current++;
          setHeightVersion(heightVersionRef.current);
        }, HEIGHT_DEBOUNCE_MS);
      }
    });

    // Observe all current cell wrappers
    list
      .querySelectorAll<HTMLElement>('[data-cell-id]')
      .forEach((el) => resizeObserver.observe(el));

    // Use MutationObserver to auto-observe newly added cell wrappers
    // (when the visible range shifts and new cells mount).
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement && node.dataset.cellId) {
            resizeObserver.observe(node);
          }
        }
        // No need to unobserve removed nodes — ResizeObserver does that
        // automatically when elements are removed from the DOM.
      }
    });
    mutationObserver.observe(list, { childList: true });

    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (debounceTimer !== null) clearTimeout(debounceTimer);
    };
  }, []); // ← stable: created once, never re-created

  // ── Report visible range to parent ────────────────────────────────────────
  useEffect(() => {
    if (endIdx > startIdx && onRangeChangeRef.current) {
      onRangeChangeRef.current({
        startIndex: startIdx,
        endIndex: endIdx - 1,
      });
    }
  }, [startIdx, endIdx]);

  // ── scrollToIndex (works for any cell, even unmounted, via offsets) ───────
  const cellsRef = useRef(cells);
  cellsRef.current = cells;
  const offsetsRef = useRef(offsets);
  offsetsRef.current = offsets;

  useEffect(() => {
    if (!virtuosoRef) return;

    const handle: CellListHandle = {
      scrollToIndex({ index, align = 'start', behavior = 'auto', offset = 0 }) {
        const container = containerRef.current;
        const currentCells = cellsRef.current;
        const currentOffsets = offsetsRef.current;
        if (!container || index < 0 || index >= currentCells.length) return;

        const cellTop = currentOffsets[index];
        const cellHeight = getCellHeight(currentCells[index]);
        const vh = container.clientHeight;

        let target: number;
        switch (align) {
          case 'center':
            target = cellTop - vh / 2 + cellHeight / 2;
            break;
          case 'end':
            target = cellTop - vh + cellHeight;
            break;
          default:
            target = cellTop;
        }

        container.scrollTo({ top: target + offset, behavior });
      },
    };

    (virtuosoRef as React.MutableRefObject<CellListHandle | null>).current =
      handle;

    return () => {
      (virtuosoRef as React.MutableRefObject<CellListHandle | null>).current =
        null;
    };
  }, [virtuosoRef]);

  // ── Render ────────────────────────────────────────────────────────────────
  const topPadding = offsets[startIdx] ?? 0;
  const lastIdx = endIdx - 1;
  const bottomStart =
    lastIdx >= 0 ? offsets[lastIdx] + getCellHeight(cells[lastIdx]) : 0;
  const bottomPadding = Math.max(0, totalHeight - bottomStart);

  // Stable renderCell ref to avoid re-creating the map callback
  const renderCellRef = useRef(renderCell);
  renderCellRef.current = renderCell;

  return (
    <div ref={containerRef} className={`${className || ''} overflow-y-auto`}>
      <div className="max-w-5xl mx-auto px-4">
        {/* Top spacer — represents cells above the rendered window */}
        {topPadding > 0 && <div style={{ height: topPadding }} aria-hidden />}

        {/* Rendered cells */}
        <div ref={listRef}>
          {cells.slice(startIdx, endIdx).map((cell, i) => (
            <div
              key={cell.id}
              data-cell-id={cell.id}
              data-cell-index={startIdx + i}
              style={{
                contentVisibility: 'auto',
                containIntrinsicSize: `auto ${getCellHeight(cell)}px`,
              }}
            >
              {renderCellRef.current(cell, startIdx + i)}
            </div>
          ))}
        </div>

        {/* Bottom spacer — represents cells below the rendered window */}
        {bottomPadding > 0 && (
          <div style={{ height: bottomPadding }} aria-hidden />
        )}

        {/* Footer padding */}
        <div className="h-32" />
      </div>
    </div>
  );
};
