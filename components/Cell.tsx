import React, { useState, useCallback, memo, useRef, useEffect } from 'react';
import { Cell as ICell, CellType } from '../types';
import { CellOutput } from './CellOutput';
import { CodeEditor } from './CodeEditor';
import { Play, Trash2, ArrowUp, ArrowDown, Bot, Loader2, FileText, Code as CodeIcon, Sparkles, Plus } from 'lucide-react';
import { generateCellContent, fixCellError, getSettings } from '../services/llmService';
import { useNotification } from './NotificationSystem';
import { IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';

interface SearchHighlight {
  query: string;
  caseSensitive: boolean;
  currentMatch?: { cellId: string; startIndex: number; endIndex: number } | null;
}

interface Props {
  cell: ICell;
  index: number;
  isActive: boolean;
  allCells: ICell[];
  onUpdate: (id: string, content: string) => void;
  onRun: (id: string) => void;
  onRunAndAdvance: (id: string) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onChangeType: (id: string, type: CellType) => void;
  onClick: (id: string) => void;
  onAddCell: (afterIndex: number) => void;
  onSave?: () => void;
  searchHighlight?: SearchHighlight | null;
  queuePosition?: number; // Position in execution queue (-1 or undefined = not queued)
  indentConfig?: IndentationConfig; // Detected indentation configuration
}

const CellComponent: React.FC<Props> = ({
  cell,
  index,
  isActive,
  allCells,
  onUpdate,
  onRun,
  onRunAndAdvance,
  onDelete,
  onMove,
  onChangeType,
  onClick,
  onAddCell,
  onSave,
  searchHighlight,
  queuePosition,
  indentConfig = DEFAULT_INDENTATION,
}) => {
  const { toast } = useNotification();
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isFixing, setIsFixing] = useState(false);

  // Use refs for callbacks to avoid recreating handleEditorKeyDown on every render
  // This prevents CodeMirror extensions from being recreated on every keystroke
  const allCellsRef = useRef(allCells);
  const onRunRef = useRef(onRun);
  const onRunAndAdvanceRef = useRef(onRunAndAdvance);
  const onSaveRef = useRef(onSave);

  useEffect(() => {
    allCellsRef.current = allCells;
    onRunRef.current = onRun;
    onRunAndAdvanceRef.current = onRunAndAdvance;
    onSaveRef.current = onSave;
  });

  // Handle keyboard shortcuts in the editor - uses refs so callback is stable
  const handleEditorKeyDown = useCallback((event: KeyboardEvent): boolean => {
    // Cmd/Ctrl+S: Save
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault();
      onSaveRef.current?.();
      return true;
    }

    // Shift+Enter: run and advance to next cell
    if (event.key === 'Enter' && event.shiftKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      onRunAndAdvanceRef.current(cell.id);
      return true;
    }

    // Ctrl/Cmd+Enter: run current cell only
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) {
      event.preventDefault();
      onRunRef.current(cell.id);
      return true;
    }

    return false; // Let CodeMirror handle other keys
  }, [cell.id]); // Only depends on cell.id now

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setIsAiGenerating(true);
    try {
      const settings = getSettings();
      const config = { provider: settings.llmProvider, model: settings.llmModel };
      const newContent = await generateCellContent(aiPrompt, allCellsRef.current, cell.id, config);
      onUpdate(cell.id, newContent);
      setIsAiOpen(false);
      setAiPrompt('');
    } catch (e) {
      toast('Failed to generate AI content. Check console for details.', 'error');
    } finally {
      setIsAiGenerating(false);
    }
  };

  const handleAiFix = async () => {
    const errorOutput = cell.outputs.find(o => o.type === 'error' || o.type === 'stderr');
    if (!errorOutput) return;

    setIsFixing(true);
    try {
      const settings = getSettings();
      const config = { provider: settings.llmProvider, model: settings.llmModel };
      const fixedCode = await fixCellError(cell.content, errorOutput.content, allCellsRef.current, config);
      onUpdate(cell.id, fixedCode);
    } catch (e) {
      console.error(e);
      toast('Could not fix code automatically.', 'error');
    } finally {
      setIsFixing(false);
    }
  };

  const hasError = cell.outputs.some(o => o.type === 'error');

  return (
    <div
      onClick={() => onClick(cell.id)}
      className={`group relative mb-2 rounded-lg border bg-white shadow-sm transition-all hover:shadow-md
        ${hasError ? 'border-red-200' : isActive ? 'border-blue-400 ring-1 ring-blue-100' : 'border-slate-200 hover:border-slate-300'}
      `}
    >
      {/* Top Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-slate-50 border-b border-slate-100 rounded-t-lg">
        {/* Left: Cell info, Run button, and action buttons */}
        <div className="flex items-center gap-0.5">
          <span className="text-[10px] font-mono font-bold text-slate-400 min-w-[24px]">
            #{index + 1}
          </span>
          {cell.executionCount !== undefined && (
            <span className="text-[10px] font-mono text-green-600">[{cell.executionCount}]</span>
          )}
          {queuePosition !== undefined && queuePosition >= 0 && !cell.isExecuting && (
            <span className="text-[10px] font-mono text-amber-600 animate-pulse" title={`Queued at position ${queuePosition + 1}`}>
              [*]
            </span>
          )}

          <button
            onClick={(e) => { e.stopPropagation(); onRun(cell.id); }}
            className="p-1 text-slate-500 hover:text-green-600 hover:bg-green-50 rounded"
            title="Run Cell (Shift+Enter or Ctrl+Enter)"
          >
            {cell.isExecuting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          </button>

          {/* Action buttons after Run */}
          <button
            onClick={(e) => { e.stopPropagation(); setIsAiOpen(!isAiOpen); }}
            className={`p-1 rounded transition-colors ${isAiOpen ? 'text-purple-600 bg-purple-50' : 'text-slate-400 hover:text-purple-600 hover:bg-purple-50'}`}
            title="AI Assistant"
          >
            <Bot className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'up'); }}
            className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            title="Move Up"
          >
            <ArrowUp className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'down'); }}
            className="p-1 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            title="Move Down"
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onDelete(cell.id); }}
            className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            title="Delete Cell"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onAddCell(index); }}
            className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded opacity-0 group-hover:opacity-100 transition-opacity"
            title="Add Cell Below"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Center: Error fix button */}
        <div className="flex-1 flex justify-center">
          {hasError && (
            <button
              onClick={(e) => { e.stopPropagation(); handleAiFix(); }}
              disabled={isFixing}
              className="flex items-center gap-1 text-[10px] px-2 py-0.5 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors"
            >
              <Sparkles className="w-3 h-3" />
              {isFixing ? 'Fixing...' : 'Fix with AI'}
            </button>
          )}
        </div>

        {/* Right: Cell type toggle */}
        <div className="flex gap-0.5">
          <button
            onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'code'); }}
            className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${cell.type === 'code' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <CodeIcon className="w-3 h-3" /> Code
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'markdown'); }}
            className={`text-[10px] px-1.5 py-0.5 rounded flex items-center gap-0.5 ${cell.type === 'markdown' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-400 hover:text-slate-600'}`}
          >
            <FileText className="w-3 h-3" /> Text
          </button>
        </div>
      </div>

      {/* AI Prompt Input */}
      {isAiOpen && (
        <div className="px-3 py-2 bg-purple-50 border-b border-purple-100 flex gap-2 items-center">
          <Bot className="w-4 h-4 text-purple-600 flex-shrink-0" />
          <input
            type="text"
            value={aiPrompt}
            onChange={(e) => setAiPrompt(e.target.value)}
            placeholder="Ask AI to write code, debug, or explain..."
            className="flex-grow bg-white border-purple-200 border rounded px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
            onKeyDown={(e) => e.key === 'Enter' && handleAiGenerate()}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={(e) => { e.stopPropagation(); handleAiGenerate(); }}
            disabled={isAiGenerating}
            className="px-2 py-1 bg-purple-600 text-white text-xs font-medium rounded hover:bg-purple-700 disabled:opacity-50"
          >
            {isAiGenerating ? 'Thinking...' : 'Generate'}
          </button>
        </div>
      )}

      {/* Editor Area */}
      <div onClick={(e) => { e.stopPropagation(); onClick(cell.id); }}>
        <CodeEditor
          value={cell.content}
          onChange={(value) => onUpdate(cell.id, value)}
          language={cell.type === 'code' ? 'python' : 'markdown'}
          onKeyDown={handleEditorKeyDown}
          placeholder={cell.type === 'code' ? 'print("Hello World")' : '## Markdown Title'}
          searchHighlight={searchHighlight}
          cellId={cell.id}
          shouldFocus={isActive}
          indentConfig={indentConfig}
        />
      </div>

      {/* Output Area */}
      {(cell.outputs.length > 0 || cell.isExecuting) && (
         <CellOutput outputs={cell.outputs} />
      )}
    </div>
  );
};

// Memoize Cell to prevent re-renders when only allCells changes
// Only compare props that affect rendering - NOT callback functions.
// Callbacks change frequently due to useUndoRedo's pushState dependency on present,
// but cells only need to re-render when their actual data changes.
export const Cell = memo(CellComponent, (prevProps, nextProps) => {
  // Return true if props are equal (skip re-render)
  // Only check: cell data, index, active state, search highlighting, queue position, and indent config
  // Don't check callbacks - they change on every parent render but
  // don't affect what the cell displays
  return (
    prevProps.cell === nextProps.cell &&
    prevProps.index === nextProps.index &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.searchHighlight === nextProps.searchHighlight &&
    prevProps.queuePosition === nextProps.queuePosition &&
    prevProps.indentConfig === nextProps.indentConfig
  );
});