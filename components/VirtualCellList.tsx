import React, { useState, useEffect, useRef, useMemo, startTransition } from 'react';
import { Cell } from '../types';

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
 * Renders all cells with CSS `content-visibility: auto` and progressive
 * batching.
 *
 * Why not a JS-based virtual list?
 * - react-virtuoso used `flushSync()` on every scroll event, blocking the
 *   main thread for ~4 000 ms in a representative trace.
 * - Our custom virtual list (mount/unmount on scroll) caused unbounded
 *   browser memory growth: decoded media buffers from `<audio>` and `<img>`
 *   elements are not freed when DOM elements are removed.
 *
 * With content-visibility the browser natively skips layout & paint for
 * off-screen cells. All cells stay mounted (no media buffer leak), and
 * scroll is pure compositor work — zero JavaScript.
 *
 * Progressive batching renders cells in groups of BATCH_SIZE per frame so
 * the page stays responsive during initial load of large notebooks.
 */

const BATCH_SIZE = 10;

export const VirtualCellList: React.FC<Props> = ({
  cells,
  renderCell,
  virtuosoRef,
  className,
  onRangeChange,
  renderKey,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const onRangeChangeRef = useRef(onRangeChange);
  onRangeChangeRef.current = onRangeChange;

  // ── Progressive rendering ────────────────────────────────────────────────
  const [renderedCount, setRenderedCount] = useState(
    Math.min(cells.length, BATCH_SIZE),
  );
  const renderedCountRef = useRef(renderedCount);
  renderedCountRef.current = renderedCount;

  // Reset when cells array changes (new notebook loaded)
  useEffect(() => {
    setRenderedCount(Math.min(cells.length, BATCH_SIZE));
  }, [cells]);

  // Pause batching while the user is scrolling so scroll gets full frame budget.
  const isScrollingRef = useRef(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      isScrollingRef.current = true;
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
      scrollTimerRef.current = setTimeout(() => { isScrollingRef.current = false; }, 200);
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  // Render next batch using requestIdleCallback (or setTimeout fallback).
  // Skips frames while the user is actively scrolling.
  useEffect(() => {
    if (renderedCount >= cells.length) return;
    const schedule = () => {
      if (isScrollingRef.current) {
        // User is scrolling — wait and retry
        const timer = setTimeout(schedule, 100);
        return () => clearTimeout(timer);
      }
      // startTransition lets React yield between cell renders so the
      // browser stays responsive during progressive loading.
      if (typeof requestIdleCallback !== 'undefined') {
        const id = requestIdleCallback(() => {
          startTransition(() => {
            setRenderedCount((prev) => Math.min(prev + BATCH_SIZE, cells.length));
          });
        });
        return () => cancelIdleCallback(id);
      }
      const timer = setTimeout(() => {
        startTransition(() => {
          setRenderedCount((prev) => Math.min(prev + BATCH_SIZE, cells.length));
        });
      }, 0);
      return () => clearTimeout(timer);
    };
    const cleanup = schedule();
    return cleanup;
  }, [renderedCount, cells.length]);

  // ── scrollToIndex ────────────────────────────────────────────────────────
  useEffect(() => {
    if (!virtuosoRef) return;

    const handle: CellListHandle = {
      scrollToIndex({ index, align = 'start', behavior = 'auto', offset = 0 }) {
        const container = containerRef.current;
        if (!container) return;

        // If the target cell hasn't been progressively rendered yet,
        // force-render up to it so we can scroll to it.
        if (index >= renderedCountRef.current) {
          setRenderedCount(Math.min(index + BATCH_SIZE, cells.length));
        }

        // The cell may need a frame to mount after setRenderedCount
        const doScroll = () => {
          const cellEl = container.querySelector<HTMLElement>(
            `[data-cell-index="${index}"]`,
          );
          if (!cellEl) return;

          // Use scrollIntoView instead of getBoundingClientRect + scrollTo.
          // getBoundingClientRect forces the browser to synchronously layout
          // ALL content-visibility-skipped cells before the target, which can
          // take seconds for large notebooks.
          const block = align === 'center' ? 'center' : align === 'end' ? 'end' : 'start';
          cellEl.scrollIntoView({ block, behavior });

          if (offset !== 0) {
            requestAnimationFrame(() => {
              container.scrollBy({ top: offset, behavior: 'auto' });
            });
          }
        };

        // If cell is already in DOM, scroll immediately. Otherwise wait a frame.
        if (container.querySelector(`[data-cell-index="${index}"]`)) {
          doScroll();
        } else {
          requestAnimationFrame(doScroll);
        }
      },
    };

    (virtuosoRef as React.MutableRefObject<CellListHandle | null>).current =
      handle;

    return () => {
      (virtuosoRef as React.MutableRefObject<CellListHandle | null>).current =
        null;
    };
  }, [virtuosoRef]);

  // ── Track visible range via IntersectionObserver ─────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const visibleSet = new Set<number>();

    const observer = new IntersectionObserver(
      (entries) => {
        let changed = false;
        for (const entry of entries) {
          const idx = Number((entry.target as HTMLElement).dataset.cellIndex);
          if (Number.isNaN(idx)) continue;
          if (entry.isIntersecting) {
            if (!visibleSet.has(idx)) { visibleSet.add(idx); changed = true; }
          } else {
            if (visibleSet.has(idx)) { visibleSet.delete(idx); changed = true; }
          }
        }
        if (changed && visibleSet.size > 0 && onRangeChangeRef.current) {
          let min = Infinity, max = -Infinity;
          for (const v of visibleSet) {
            if (v < min) min = v;
            if (v > max) max = v;
          }
          onRangeChangeRef.current({ startIndex: min, endIndex: max });
        }
      },
      { root: container, rootMargin: '200px 0px' },
    );

    container
      .querySelectorAll<HTMLElement>('[data-cell-index]')
      .forEach((el) => observer.observe(el));

    // Auto-observe newly rendered cells
    const mutation = new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof HTMLElement && node.dataset.cellIndex) {
            observer.observe(node);
          }
        }
      }
    });
    mutation.observe(container.querySelector('.max-w-5xl') || container, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
      mutation.disconnect();
    };
  }, []);

  // ── Stable renderCell ref ────────────────────────────────────────────────
  const renderCellRef = useRef(renderCell);
  renderCellRef.current = renderCell;

  const isLoading = renderedCount < cells.length;
  const progress = cells.length > 0 ? Math.round((renderedCount / cells.length) * 100) : 100;

  const cellList = cells.slice(0, renderedCount).map((cell, index) => (
    <div
      key={cell.id}
      data-cell-id={cell.id}
      data-cell-index={index}
      style={{
        contentVisibility: 'auto',
        containIntrinsicSize: 'auto 200px',
        contain: 'layout style paint',
      }}
    >
      {renderCellRef.current(cell, index)}
    </div>
  ));

  return (
    <div ref={containerRef} className={`${className || ''} overflow-y-auto`}>
      {/* Progress bar — shown at bottom of viewport while cells render progressively */}
      {isLoading && (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-30 bg-white/95 backdrop-blur shadow-lg rounded-full px-4 py-2 flex items-center gap-3 border border-slate-200">
          <div className="w-40 h-1.5 bg-slate-100 rounded-full overflow-hidden">
            <div
              className="h-full bg-blue-500 rounded-full transition-all duration-150"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="text-xs text-slate-500 tabular-nums whitespace-nowrap">
            Rendering cells {renderedCount} / {cells.length}
          </span>
        </div>
      )}
      <div className="max-w-5xl mx-auto px-4">
        {cellList}
        {/* Spacer for not-yet-rendered cells so scrollbar is roughly correct */}
        {isLoading && (
          <div style={{ height: (cells.length - renderedCount) * 200 }} aria-hidden />
        )}
        <div className="h-32" />
      </div>
    </div>
  );
};
