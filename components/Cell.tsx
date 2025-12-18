import React, { useState, useRef, useEffect } from 'react';
import { Cell as ICell, CellType } from '../types';
import { CellOutput } from './CellOutput';
import { Play, Trash2, ArrowUp, ArrowDown, Bot, Loader2, FileText, Code as CodeIcon, Sparkles } from 'lucide-react';
import { generateCellContent, fixCellError, getSettings } from '../services/llmService';

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
}

export const Cell: React.FC<Props> = ({
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
}) => {
  const [isAiOpen, setIsAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState('');
  const [isAiGenerating, setIsAiGenerating] = useState(false);
  const [isFixing, setIsFixing] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [cell.content]);

  // Auto-focus textarea when cell becomes active
  useEffect(() => {
    if (isActive && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isActive]);

  const handleAiGenerate = async () => {
    if (!aiPrompt.trim()) return;
    setIsAiGenerating(true);
    try {
      const settings = getSettings();
      const config = { provider: settings.llmProvider, model: settings.llmModel };
      const newContent = await generateCellContent(aiPrompt, allCells, cell.id, config);
      onUpdate(cell.id, newContent);
      setIsAiOpen(false);
      setAiPrompt('');
    } catch (e) {
      alert('Failed to generate AI content. See console.');
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
      const fixedCode = await fixCellError(cell.content, errorOutput.content, allCells, config);
      onUpdate(cell.id, fixedCode);
    } catch (e) {
      console.error(e);
      alert('Could not fix code automatically.');
    } finally {
      setIsFixing(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      // Shift+Enter: run and advance to next cell
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        onRunAndAdvance(cell.id);
      }
      // Ctrl/Cmd+Enter: run current cell only
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey) {
        e.preventDefault();
        onRun(cell.id);
      }
    }
  };

  const hasError = cell.outputs.some(o => o.type === 'error');

  return (
    <div
      onClick={() => onClick(cell.id)}
      className={`group relative mb-3 rounded-lg border bg-white shadow-sm transition-all hover:shadow-md min-h-[220px]
        ${hasError ? 'border-red-200' : isActive ? 'border-blue-400 ring-1 ring-blue-100' : 'border-slate-200 hover:border-slate-300'}
      `}
    >
      
      {/* Sidebar / Gutter */}
      <div className="absolute left-0 top-0 bottom-0 w-12 bg-slate-50 border-r border-slate-100 rounded-l-lg flex flex-col items-center py-2 gap-2 opacity-100 lg:opacity-50 lg:group-hover:opacity-100 transition-opacity">
        <div className="text-[10px] font-mono font-bold text-slate-400 mb-1 flex flex-col items-center">
            <span>#{index + 1}</span>
            {cell.executionCount !== undefined && <span className="text-green-600">[{cell.executionCount}]</span>}
        </div>
        
        <button onClick={(e) => { e.stopPropagation(); onRun(cell.id); }} className="p-1.5 text-slate-500 hover:text-green-600 hover:bg-green-50 rounded" title="Run Cell (Shift+Enter or Ctrl+Enter)">
          {cell.isExecuting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
        </button>
        
        <button onClick={(e) => { e.stopPropagation(); setIsAiOpen(!isAiOpen); }} className={`p-1.5 rounded transition-colors ${isAiOpen ? 'text-purple-600 bg-purple-50' : 'text-slate-500 hover:text-purple-600 hover:bg-purple-50'}`} title="AI Assistant">
          <Bot className="w-4 h-4" />
        </button>

        <div className="flex-grow" />
        
        <div className="flex flex-col gap-1 mb-2">
            <button onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'up'); }} className="p-1 text-slate-400 hover:text-slate-700" title="Move Up"><ArrowUp className="w-3 h-3" /></button>
            <button onClick={(e) => { e.stopPropagation(); onMove(cell.id, 'down'); }} className="p-1 text-slate-400 hover:text-slate-700" title="Move Down"><ArrowDown className="w-3 h-3" /></button>
            <button onClick={(e) => { e.stopPropagation(); onDelete(cell.id); }} className="p-1 text-slate-400 hover:text-red-600" title="Delete Cell"><Trash2 className="w-3 h-3" /></button>
        </div>
      </div>

      <div className="ml-12">
        {/* AI Prompt Input */}
        {isAiOpen && (
          <div className="p-3 bg-purple-50 border-b border-purple-100 flex gap-2 items-center animate-in slide-in-from-top-2">
            <Bot className="w-5 h-5 text-purple-600" />
            <input 
              type="text" 
              value={aiPrompt}
              onChange={(e) => setAiPrompt(e.target.value)}
              placeholder="Ask AI to write code, debug, or explain..." 
              className="flex-grow bg-white border-purple-200 border rounded px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
              onKeyDown={(e) => e.key === 'Enter' && handleAiGenerate()}
              onClick={(e) => e.stopPropagation()}
            />
            <button 
              onClick={(e) => { e.stopPropagation(); handleAiGenerate(); }}
              disabled={isAiGenerating}
              className="px-3 py-1.5 bg-purple-600 text-white text-xs font-bold rounded hover:bg-purple-700 disabled:opacity-50"
            >
              {isAiGenerating ? 'Thinking...' : 'Generate'}
            </button>
          </div>
        )}

        {/* Toolbar */}
        <div className="flex items-center justify-between px-2 py-1 bg-slate-50 border-b border-slate-100 rounded-tr-lg">
          <div className="flex-1">
             {hasError && (
               <button 
                 onClick={(e) => { e.stopPropagation(); handleAiFix(); }}
                 disabled={isFixing}
                 className="flex items-center gap-1 text-xs px-2 py-0.5 bg-red-100 text-red-700 rounded hover:bg-red-200 transition-colors animate-in fade-in"
               >
                 <Sparkles className="w-3 h-3" />
                 {isFixing ? 'Fixing...' : 'Fix with AI'}
               </button>
             )}
          </div>
          <div className="flex gap-2">
            <button 
              onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'code'); }}
              className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${cell.type === 'code' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <CodeIcon className="w-3 h-3" /> Code
            </button>
            <button 
              onClick={(e) => { e.stopPropagation(); onChangeType(cell.id, 'markdown'); }}
              className={`text-xs px-2 py-1 rounded flex items-center gap-1 ${cell.type === 'markdown' ? 'bg-white shadow-sm text-slate-800 font-medium' : 'text-slate-500 hover:text-slate-800'}`}
            >
              <FileText className="w-3 h-3" /> Markdown
            </button>
          </div>
        </div>

        {/* Editor Area */}
        <div className="p-0">
          <textarea
            ref={textareaRef}
            value={cell.content}
            onChange={(e) => onUpdate(cell.id, e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={cell.type === 'code' ? 'print("Hello World")' : '## Markdown Title'}
            className={`w-full min-h-[4rem] p-4 bg-transparent outline-none resize-none font-mono text-sm leading-6 ${cell.type === 'code' ? 'text-slate-800' : 'text-slate-600 font-sans'}`}
            spellCheck={false}
          />
        </div>

        {/* Output Area */}
        {(cell.outputs.length > 0 || cell.isExecuting) && (
           <CellOutput outputs={cell.outputs} />
        )}
      </div>
    </div>
  );
};