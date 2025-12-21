import React, { useState, useCallback, memo, useRef, useEffect } from 'react';
import { Cell as ICell, CellType } from '../types';
import { CellOutput } from './CellOutput';
import { CodeEditor } from './CodeEditor';
import { Play, Trash2, ArrowUp, ArrowDown, Bot, Loader2, FileText, Code as CodeIcon, Sparkles, Plus } from 'lucide-react';
import { generateCellContentStructured, fixCellError, getSettings, CellGenerationResponse } from '../services/llmService';
import { useNotification } from './NotificationSystem';
import { IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';

interface SearchHighlight {
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  currentMatch?: { cellId: string; startIndex: number; endIndex: number } | null;
}

type FocusMode = 'cell' | 'editor';

interface Props {
  cell: ICell;
  index: number;
  isActive: boolean;
  isHighlighted?: boolean; // Visual feedback for undo/redo
  allCells: ICell[];
  onUpdate: (id: string, content: string) => void;
  onAIUpdate?: (id: string, content: string) => void; // For AI edits (tracked in undo history)
  onFlush?: (id: string, content: string) => void; // Flush pending content on blur
  onRun: (id: string) => void;
  onRunAndAdvance: (id: string, focusMode: FocusMode) => void;
  onDelete: (id: string) => void;
  onMove: (id: string, direction: 'up' | 'down') => void;
  onChangeType: (id: string, type: CellType) => void;
  onClick: (id: string, event: React.MouseEvent) => void;
  onActivate: (id: string) => void; // Set as active cell
  onNavigateCell: (direction: 'up' | 'down') => void; // Navigate to adjacent cell (handles virtualization)
  onAddCell: (afterIndex: number) => void;
  onSave?: () => void;
  searchHighlight?: SearchHighlight | null;
  queuePosition?: number; // Position in execution queue (-1 or undefined = not queued)
  indentConfig?: IndentationConfig; // Detected indentation configuration
  requestedFocusMode?: 'cell' | 'editor' | null; // Focus mode requested by Notebook
  onFocusModeApplied?: () => void; // Callback when focus mode has been applied
  isSearchOpen?: boolean; // When true, Escape closes search instead of exiting edit mode
  onCloseSearch?: () => void; // Close search bar
}

const CellComponent: React.FC<Props> = ({
  cell,
  index,
  isActive,
  isHighlighted = false,
  allCells,
  onUpdate,
  onAIUpdate,
  onFlush,
  onRun,
  onRunAndAdvance,
  onDelete,
  onMove,
  onChangeType,
  onClick,
  onActivate,
  onNavigateCell,
  onAddCell,
  onSave,
  searchHighlight,
  queuePosition,
  indentConfig = DEFAULT_INDENTATION,
  requestedFocusMode,
  onFocusModeApplied,
  isSearchOpen = false,
  onCloseSearch,
}) => {
  const { toast } = useNotification();
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  // Focus state: 'editor' = editing code, 'cell' = command mode, 'none' = unfocused
  const [focusState, setFocusState] = useState<'none' | 'cell' | 'editor'>('none');
  const [aiExplanation, setAiExplanation] = useState<string | null>(null);

  // ⚠️ PERFORMANCE CRITICAL: All callbacks passed to CodeEditor MUST be stable.
  // CodeEditor rebuilds extensions when onKeyDown/onFocus/onBlur change.
  // Use refs for any value that changes frequently (cell.content, callbacks).
  // If typing becomes laggy, check if any handler dependency changes per-keystroke.
  const allCellsRef = useRef(allCells);
  const onRunRef = useRef(onRun);
  const onRunAndAdvanceRef = useRef(onRunAndAdvance);
  const onSaveRef = useRef(onSave);
  const onFlushRef = useRef(onFlush);
  const onActivateRef = useRef(onActivate);
  const cellIdRef = useRef(cell.id);
  const cellContentRef = useRef(cell.content);

  useEffect(() => {
    allCellsRef.current = allCells;
    onRunRef.current = onRun;
    onRunAndAdvanceRef.current = onRunAndAdvance;
    onSaveRef.current = onSave;
    onFlushRef.current = onFlush;
    onActivateRef.current = onActivate;
    cellIdRef.current = cell.id;
    cellContentRef.current = cell.content;
  });

  // Ref to cell container for focusing in command mode
  const cellRef = useRef<HTMLDivElement>(null);
  // Track if we should focus cell div after blur (e.g., after Escape)
  const focusCellAfterBlurRef = useRef(false);

  // Apply requested focus mode from Notebook (handles virtualization properly)
  useEffect(() => {
    if (requestedFocusMode === 'editor') {
      // Setting focusState triggers CodeEditor's shouldFocus mechanism
      setFocusState('editor');
      // Clear pendingFocus after a tick to avoid re-render cascade
      // (the focus will happen async via CodeEditor's useEffect)
      setTimeout(() => onFocusModeApplied?.(), 0);
    } else if (requestedFocusMode === 'cell') {
      cellRef.current?.focus();
      // For cell mode, focus is synchronous, so clear immediately
      onFocusModeApplied?.();
    }
  }, [requestedFocusMode, onFocusModeApplied]);

  // Handle focus/blur to track focus state
  const handleEditorFocus = useCallback(() => {
    setFocusState('editor');
    onActivateRef.current(cellIdRef.current);
  }, []);

  const handleEditorBlur = useCallback(() => {
    setFocusState('none');
    // Flush pending content on blur (keyframe for undo history)
    if (onFlushRef.current) {
      onFlushRef.current(cellIdRef.current, cellContentRef.current);
    }
    // Focus cell div if requested (e.g., after Escape key) to enter command mode
    if (focusCellAfterBlurRef.current) {
      focusCellAfterBlurRef.current = false;
      setTimeout(() => cellRef.current?.focus(), 0);
    }
  }, []);

  const handleCellFocus = useCallback((e: React.FocusEvent) => {
    // Only handle if the cell div itself is focused, not a child (like the editor)
    if (e.target === e.currentTarget) {
      setFocusState('cell');
      onActivateRef.current(cellIdRef.current);
    }
  }, []);

  const handleCellBlur = useCallback((e: React.FocusEvent) => {
    // Only handle if focus is leaving the cell div itself
    if (e.target === e.currentTarget) {
      setFocusState('none');
    }
  }, []);

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setIsAiGenerating(true);
    setAiExplanation(null);
    try {
      const settings = getSettings();
      const config = { provider: settings.llmProvider, model: settings.llmModel };
      const result = await generateCellContentStructured(aiPrompt, allCellsRef.current, cell.id, config);

      // Handle different actions
      if (result.action === 'explain_only') {
        // Just show explanation, don't modify code
        setAiExplanation(result.explanation);
      } else if (result.code) {
        // Apply code change
        const newContent = result.action === 'append'
          ? cell.content + '\n' + result.code
          : result.code;
        // Use onAIUpdate for undo tracking, fall back to onUpdate
        (onAIUpdate || onUpdate)(cell.id, newContent);
        // Show explanation if provided
        if (result.explanation) {
          setAiExplanation(result.explanation);
        }
      }

      setIsAiOpen(false);
      setAiPrompt('');
    } catch (e) {
      console.error('AI generation failed:', e);
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
      // Use onAIUpdate for undo tracking, fall back to onUpdate
      (onAIUpdate || onUpdate)(cell.id, fixedCode);
    } catch (e) {
      console.error(e);
      toast('Could not fix code automatically.', 'error');
    } finally {
      setIsFixing(false);
    }
  };

  const hasError = cell.outputs.some(o => o.type === 'error');

  // Border colors based on focus state:
  // - editor (blue): CodeMirror has focus, handles keyboard
  // - cell (green): cell div has focus, cell-level commands
  // - none (slate): unfocused
  const getBorderClass = () => {
    if (hasError) return 'border-red-200';
    if (focusState === 'editor') return 'border-blue-400 ring-1 ring-blue-100';
    if (focusState === 'cell') return 'border-green-500 ring-1 ring-green-100';
    return 'border-slate-200 hover:border-slate-300';
  };

  // Handle topbar click - enter command mode (focus cell div)
  const handleTopbarClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    // Focus the cell div - this will trigger handleCellFocus
    cellRef.current?.focus();
  }, []);

  // Handle keyboard shortcuts when cell div has focus (command mode)
  const handleCellKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Only handle when cell div itself has focus (not bubbled from editor)
    // Without this check, Shift+Enter would execute twice (once from CodeMirror, once from here)
    if (focusState !== 'cell') return;

    // Cmd/Ctrl+Shift+Arrow: move cell position
    if ((e.metaKey || e.ctrlKey) && e.shiftKey) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        onMove(cell.id, 'up');
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        onMove(cell.id, 'down');
        return;
      }
    }

    // Arrow up/down: navigate between cells (handled by Notebook for virtualization)
    if (e.key === 'ArrowUp' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      if (index > 0) {
        onNavigateCell('up');
      }
      return;
    }
    if (e.key === 'ArrowDown' && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
      e.preventDefault();
      const cells = allCellsRef.current;
      if (index < cells.length - 1) {
        onNavigateCell('down');
      }
      return;
    }

    // Enter: focus editor (enter edit mode)
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
      e.preventDefault();
      // Set state to trigger shouldFocus, which will focus the editor
      setFocusState('editor');
      return;
    }

    // Delete/Backspace: delete cell
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onDelete(cell.id);
      return;
    }

    // Shift+Enter: run and advance (stay in cell mode)
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      onRunAndAdvanceRef.current(cell.id, 'cell');
      return;
    }

    // Ctrl/Cmd+Enter: run cell
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onRunRef.current(cell.id);
      return;
    }
  }, [cell.id, index, onMove, onDelete, focusState]);

  return (
    <div
      ref={cellRef}
      data-cell-id={cell.id}
      onClick={(e) => onClick(cell.id, e)}
      onKeyDown={handleCellKeyDown}
      onFocus={handleCellFocus}
      onBlur={handleCellBlur}
      tabIndex={isActive ? 0 : -1}
      className={`group relative mb-2 rounded-lg border bg-white shadow-sm transition-all hover:shadow-md ${getBorderClass()} ${isHighlighted ? 'cell-highlight-animation' : ''} ${focusState === 'cell' ? 'outline-none' : ''}`}
    >
      {/* Top Toolbar - click here to enter command mode */}
      <div
        className="flex items-center gap-1 px-2 py-1 bg-slate-50 border-b border-slate-100 rounded-t-lg cursor-pointer"
        onClick={handleTopbarClick}
      >
        {/* Left: Cell info, Run button, and action buttons */}
        <div className="flex items-center gap-0.5">
          <span className="text-[10px] font-mono font-bold text-slate-400 min-w-[24px]">
            #{index + 1}
          </span>
          {/* Execution feedback: [ ] = never run, [*] = executing/queued, [n] = executed n times */}
          {cell.isExecuting ? (
            <span className="text-[10px] font-mono text-amber-600 animate-pulse" title="Executing...">
              [*]
            </span>
          ) : queuePosition !== undefined && queuePosition >= 0 ? (
            <span className="text-[10px] font-mono text-amber-600 animate-pulse" title={`Queued at position ${queuePosition + 1}`}>
              [*]
            </span>
          ) : cell.executionCount !== undefined ? (
            <span className="text-[10px] font-mono text-green-600">[{cell.executionCount}]</span>
          ) : cell.type === 'code' ? (
            <span className="text-[10px] font-mono text-slate-400" title="Not yet executed">
              [ ]
            </span>
          ) : null}
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

      {/* AI Explanation - shown when AI provides explanatory text */}
      {aiExplanation && (
        <div className="px-3 py-2 bg-purple-50 border-b border-purple-100 flex gap-2 items-start">
          <Sparkles className="w-4 h-4 text-purple-500 flex-shrink-0 mt-0.5" />
          <p className="flex-grow text-sm text-purple-800">{aiExplanation}</p>
          <button
            onClick={(e) => { e.stopPropagation(); setAiExplanation(null); }}
            className="text-purple-400 hover:text-purple-600 flex-shrink-0"
            title="Dismiss"
          >
            <span className="text-lg leading-none">&times;</span>
          </button>
        </div>
      )}

      {/* Editor Area - clicking focuses editor naturally via CodeMirror */}
      <div onClick={(e) => { e.stopPropagation(); onClick(cell.id, e); }}>
        <CodeEditor
          value={cell.content}
          onChange={(value) => onUpdate(cell.id, value)}
          language={cell.type === 'code' ? 'python' : 'markdown'}
          onShiftEnter={() => onRunAndAdvanceRef.current(cell.id, 'editor')}
          onModEnter={() => onRunRef.current(cell.id)}
          onEscape={() => { focusCellAfterBlurRef.current = true; }}
          onSave={() => onSaveRef.current?.()}
          isSearchOpen={isSearchOpen}
          onCloseSearch={onCloseSearch}
          onFocus={handleEditorFocus}
          onBlur={handleEditorBlur}
          placeholder={cell.type === 'code' ? 'print("Hello World")' : '## Markdown Title'}
          searchHighlight={searchHighlight}
          cellId={cell.id}
          shouldFocus={focusState === 'editor'}
          indentConfig={indentConfig}
          allCellsRef={allCellsRef}
        />
      </div>

      {/* Output Area */}
      {(cell.outputs.length > 0 || cell.isExecuting) && (
         <CellOutput outputs={cell.outputs} executionMs={cell.lastExecutionMs} />
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
  // Only check visual state - not callbacks which change frequently
  return (
    prevProps.cell === nextProps.cell &&
    prevProps.index === nextProps.index &&
    prevProps.isActive === nextProps.isActive &&
    prevProps.isHighlighted === nextProps.isHighlighted &&
    prevProps.searchHighlight === nextProps.searchHighlight &&
    prevProps.queuePosition === nextProps.queuePosition &&
    prevProps.indentConfig === nextProps.indentConfig &&
    prevProps.requestedFocusMode === nextProps.requestedFocusMode &&
    prevProps.isSearchOpen === nextProps.isSearchOpen
  );
});