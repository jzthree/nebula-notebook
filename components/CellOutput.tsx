import React, { useState, useRef, useCallback, useEffect } from 'react';
import { CellOutput as ICellOutput } from '../types';
import { ChevronDown, ChevronRight, GripHorizontal } from 'lucide-react';

interface Props {
  outputs: ICellOutput[];
}

const OutputItem: React.FC<{ output: ICellOutput }> = ({ output }) => {
  switch (output.type) {
    case 'stdout':
      return <div className="font-mono text-sm text-slate-700 whitespace-pre-wrap mb-1">{output.content}</div>;
    case 'stderr':
      return <div className="font-mono text-sm text-red-600 bg-red-50 p-2 rounded mb-1 whitespace-pre-wrap">{output.content}</div>;
    case 'error':
      return (
        <div className="font-mono text-sm text-red-700 bg-red-100 border-l-4 border-red-500 p-2 mb-2 rounded-r overflow-x-auto">
          <strong>Error:</strong> {output.content}
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
      return <div dangerouslySetInnerHTML={{ __html: output.content }} className="my-2" />;
    default:
      return null;
  }
};

const MIN_HEIGHT = 50;
const DEFAULT_COLLAPSED_HEIGHT = 200;
const MAX_HEIGHT = 600;

export const CellOutput: React.FC<Props> = ({ outputs }) => {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const [collapsedHeight, setCollapsedHeight] = useState(DEFAULT_COLLAPSED_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Check if output is tall enough to warrant collapse option
  const [showCollapseOption, setShowCollapseOption] = useState(false);

  useEffect(() => {
    if (contentRef.current) {
      const contentHeight = contentRef.current.scrollHeight;
      setShowCollapseOption(contentHeight > DEFAULT_COLLAPSED_HEIGHT);
    }
  }, [outputs]);

  // Handle resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = collapsedHeight;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = moveEvent.clientY - startY;
      const newHeight = Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, startHeight + deltaY));
      setCollapsedHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [collapsedHeight]);

  if (outputs.length === 0) return null;

  return (
    <div
      ref={containerRef}
      className="relative border-t border-slate-100 rounded-b-lg bg-white"
    >
      {/* Left gutter - clickable to collapse/expand */}
      {showCollapseOption && (
        <div
          className="absolute left-0 top-0 bottom-0 w-6 flex items-start pt-3 justify-center cursor-pointer hover:bg-slate-100 transition-colors z-10 border-r border-slate-100"
          onClick={() => setIsCollapsed(!isCollapsed)}
          title={isCollapsed ? "Expand output" : "Collapse output"}
        >
          {isCollapsed ? (
            <ChevronRight className="w-4 h-4 text-slate-400" />
          ) : (
            <ChevronDown className="w-4 h-4 text-slate-400" />
          )}
        </div>
      )}

      {/* Output content */}
      <div
        ref={contentRef}
        className={`p-4 transition-all ${showCollapseOption ? 'pl-8' : ''}`}
        style={isCollapsed ? {
          maxHeight: collapsedHeight,
          overflowY: 'auto',
          overflowX: 'hidden'
        } : undefined}
      >
        {outputs.map((out) => (
          <OutputItem key={out.id} output={out} />
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
