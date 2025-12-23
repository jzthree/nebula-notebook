import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import { CellOutput as ICellOutput } from '../types';
import { ChevronDown, ChevronRight, GripHorizontal, WrapText, ArrowRightLeft } from 'lucide-react';

// Display limits to prevent UI freeze from huge outputs
// Note: Full data is preserved in state for saving - only display is truncated
const MAX_DISPLAY_LINES = 10000;
const MAX_DISPLAY_CHARS = 100000000; // 100MB - generous for images

interface Props {
  outputs: ICellOutput[];
  executionMs?: number; // Execution time in milliseconds
  scrolled?: boolean; // Jupyter standard: true = collapsed with max-height, false/undefined = expanded
  onScrolledChange?: (scrolled: boolean) => void; // Called when user toggles collapse/expand
  scrolledHeight?: number; // Persisted height of output area in scroll mode
  onScrolledHeightChange?: (height: number) => void; // Called when user resizes the output area
}

// Format execution time compactly
const formatExecutionTime = (ms: number): string => {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  const seconds = ms / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainingSeconds}s`;
};

// Collapse multiple consecutive blank lines into one
const compactOutput = (text: string): string => {
  return text.replace(/\n{3,}/g, '\n\n').trim();
};

const OutputItem: React.FC<{ output: ICellOutput; wrapText: boolean }> = ({ output, wrapText }) => {
  const textClass = wrapText ? 'whitespace-pre-wrap break-words' : 'whitespace-pre overflow-x-auto';

  switch (output.type) {
    case 'stdout':
      return <div className={`font-mono text-sm text-slate-700 mb-1 ${textClass}`}>{output.content}</div>;
    case 'stderr':
      return <div className={`font-mono text-sm text-red-600 bg-red-50 p-2 rounded mb-1 ${textClass}`}>{compactOutput(output.content)}</div>;
    case 'error':
      return (
        <div className={`font-mono text-sm text-red-700 bg-red-100 border-l-4 border-red-500 p-2 mb-2 rounded-r ${textClass}`}>
          {compactOutput(output.content)}
        </div>
      );
    case 'image':
      return (
        <div className="my-4 flex justify-start">
          <img
            src={`data:image/png;base64,${output.content}`}
            alt="Plot Output"
            className="max-w-full h-auto bg-white rounded shadow-sm border border-slate-200"
          />
        </div>
      );
    case 'html':
      return <div dangerouslySetInnerHTML={{ __html: output.content }} className="my-2 overflow-x-auto" />;
    default:
      return null;
  }
};

const MIN_HEIGHT = 50;
const DEFAULT_COLLAPSED_HEIGHT = 200;
const MAX_HEIGHT = 600;

export const CellOutput: React.FC<Props> = ({ outputs, executionMs, scrolled, onScrolledChange, scrolledHeight, onScrolledHeightChange }) => {
  // scrolled prop controls collapse state (Jupyter standard: true = collapsed with scrollbar)
  // Use prop if provided, otherwise default to false (expanded)
  const isCollapsed = scrolled === true;
  // Use persisted height if available, otherwise use default
  const [collapsedHeight, setCollapsedHeight] = useState(scrolledHeight ?? DEFAULT_COLLAPSED_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  // wrapText is local state for horizontal scroll vs text wrap (not persisted)
  const [wrapText, setWrapText] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Track if this is the initial render to avoid resetting collapse state
  const initialRenderRef = useRef(true);

  // Store resize cleanup function for unmount
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      resizeCleanupRef.current?.();
    };
  }, []);

  // Sync local collapsed height with prop when it changes (e.g., from undo/redo)
  useEffect(() => {
    if (scrolledHeight !== undefined) {
      setCollapsedHeight(scrolledHeight);
    }
  }, [scrolledHeight]);

  // Truncate outputs for display only - full data preserved in parent state for saving
  const displayOutputs = useMemo(() => {
    // Quick check - count total lines and chars
    let totalLines = 0;
    let totalChars = 0;
    for (const output of outputs) {
      if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'error') {
        totalLines += (output.content?.match(/\n/g) || []).length + 1;
      }
      totalChars += output.content?.length || 0;
    }

    // No truncation needed if under limits
    if (totalLines <= MAX_DISPLAY_LINES && totalChars <= MAX_DISPLAY_CHARS) {
      return outputs;
    }

    // Need to truncate - count lines as we go
    const truncated: ICellOutput[] = [];
    let linesShown = 0;
    let charsShown = 0;

    for (const output of outputs) {
      const outputSize = output.content?.length || 0;
      let outputLines = 0;
      if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'error') {
        outputLines = (output.content?.match(/\n/g) || []).length + 1;
      }

      // Check if adding this would exceed limits
      if (linesShown + outputLines > MAX_DISPLAY_LINES || charsShown + outputSize > MAX_DISPLAY_CHARS) {
        // For text outputs, show partial content up to the limit
        if (output.type === 'stdout' || output.type === 'stderr' || output.type === 'error') {
          const remainingLines = MAX_DISPLAY_LINES - linesShown;
          if (remainingLines > 0 && output.content) {
            // Split into lines and take what we can fit
            const lines = output.content.split('\n');
            const truncatedLines = lines.slice(0, remainingLines);
            truncated.push({
              ...output,
              id: `${output.id}-truncated`,
              content: truncatedLines.join('\n')
            });
            linesShown += truncatedLines.length;
          }
        }
        // For images/html, include if size is ok
        else if (output.type === 'image' || output.type === 'html') {
          if (charsShown + outputSize <= MAX_DISPLAY_CHARS) {
            truncated.push(output);
            charsShown += outputSize;
          }
        }
        break;
      }

      truncated.push(output);
      linesShown += outputLines;
      charsShown += outputSize;
    }

    // Add truncation warning
    truncated.push({
      id: `display-truncated-${Date.now()}`,
      type: 'stderr',
      content: `\n⚠️ Output limit reached (${linesShown.toLocaleString()} lines). Additional output not displayed.`
    });

    return truncated;
  }, [outputs]);

  // Check if output is tall enough to warrant collapse option
  const [showCollapseOption, setShowCollapseOption] = useState(false);

  // Use useLayoutEffect to measure before paint, avoiding flicker
  useLayoutEffect(() => {
    if (contentRef.current) {
      const contentHeight = contentRef.current.scrollHeight;
      const shouldShow = contentHeight > DEFAULT_COLLAPSED_HEIGHT;

      // Only update if changed to avoid unnecessary re-renders
      if (shouldShow !== showCollapseOption) {
        setShowCollapseOption(shouldShow);
      }

      // On initial render with tall content, don't auto-collapse
      // User explicitly toggles collapse state
      if (initialRenderRef.current) {
        initialRenderRef.current = false;
      }
    }
  }, [outputs, showCollapseOption]);

  // Handle collapse toggle
  // Calls onScrolledChange to persist the collapsed state (Jupyter standard)
  const handleCollapseToggle = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent bubbling to cell container (avoids scroll jumps)

    const newCollapsed = !isCollapsed;
    onScrolledChange?.(newCollapsed);
    // Note: Don't call onVisibilityChange here - Virtuoso handles scroll position
    // during height changes. Triggering scroll during state transition causes jumps.
  }, [isCollapsed, onScrolledChange]);

  // Handle resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = collapsedHeight;
    let finalHeight = startHeight;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      finalHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + deltaY));
      setCollapsedHeight(finalHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;
      // Persist the final height if it changed
      if (finalHeight !== startHeight) {
        onScrolledHeightChange?.(finalHeight);
      }
    };

    // Store cleanup for unmount
    resizeCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [collapsedHeight, onScrolledHeightChange]);

  // Show minimal output area with just execution time if no outputs
  if (outputs.length === 0) {
    if (executionMs === undefined) return null;
    return (
      <div className="relative border-t border-slate-100 rounded-b-lg bg-white h-8">
        <span className="absolute top-1.5 right-2 text-xs text-slate-400 tabular-nums" title="Execution time">
          {formatExecutionTime(executionMs)}
        </span>
      </div>
    );
  }

  // Check if any output has long lines that might benefit from scroll toggle
  const hasTextOutput = displayOutputs.some(o => o.type === 'stdout' || o.type === 'stderr' || o.type === 'error');

  return (
    <div
      ref={containerRef}
      className="relative border-t border-slate-100 rounded-b-lg bg-white"
    >
      {/* Left gutter - clickable to collapse/expand */}
      {showCollapseOption && (
        <div
          className="absolute left-0 top-0 bottom-0 w-6 flex items-start pt-3 justify-center cursor-pointer hover:bg-slate-100 transition-colors z-10 border-r border-slate-100"
          onClick={handleCollapseToggle}
          title={isCollapsed ? "Expand output" : "Collapse output"}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </div>
      )}

      {/* Top right controls: execution time and wrap toggle */}
      <div className="absolute top-1 right-2 flex items-center gap-2 z-10">
        {/* Execution time indicator */}
        {executionMs !== undefined && (
          <span className="text-xs text-slate-400 tabular-nums" title="Execution time">
            {formatExecutionTime(executionMs)}
          </span>
        )}
        {/* Wrap/scroll toggle button - local state only */}
        {hasTextOutput && (
          <button
            className="p-1 rounded hover:bg-slate-100 transition-colors"
            onClick={() => setWrapText(!wrapText)}
            title={wrapText ? "Switch to horizontal scroll" : "Switch to text wrap"}
          >
            {wrapText ? (
              <ArrowRightLeft className="w-4 h-4 text-slate-400" />
            ) : (
              <WrapText className="w-4 h-4 text-slate-400" />
            )}
          </button>
        )}
      </div>

      {/* Output content */}
      <div
        ref={contentRef}
        className={`p-4 transition-all ${showCollapseOption ? 'pl-8' : ''} ${hasTextOutput ? 'pr-8' : ''}`}
        style={isCollapsed ? {
          maxHeight: collapsedHeight,
          overflowY: 'auto',
          overflowX: wrapText ? 'hidden' : 'auto'
        } : {
          overflowX: wrapText ? 'hidden' : 'auto'
        }}
      >
        {displayOutputs.map((out) => (
          <OutputItem key={out.id} output={out} wrapText={wrapText} />
        ))}
      </div>

      {/* Resize handle - only show when collapsed */}
      {isCollapsed && (
        <div
          className={`absolute bottom-0 left-0 right-0 h-3 flex items-center justify-center cursor-ns-resize bg-slate-50 hover:bg-slate-100 border-t border-slate-200 transition-colors ${isResizing ? 'bg-blue-100' : ''}`}
          onMouseDown={handleResizeStart}
        >
          <GripHorizontal className="w-4 h-4 text-slate-400" />
        </div>
      )}

      {/* Collapsed indicator */}
      {isCollapsed && (
        <div className="absolute bottom-3 right-2 text-xs text-slate-400 bg-white px-1 rounded">
          Scroll for more
        </div>
      )}
    </div>
  );
};
