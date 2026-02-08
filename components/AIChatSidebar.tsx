import React, { useState, useRef, useEffect, memo, useCallback } from 'react';
import { Bot, X, Send, Plus, CornerDownLeft, Pencil, Trash2, ChevronDown, Settings2 } from 'lucide-react';
import { Cell } from '../types';
import {
  chatWithNotebook,
  getSettings,
  saveSettings,
  getAvailableProviders,
  LLMProvider,
  LLMConfig,
  ChatMessage
} from '../services/llmService';
import { diffLines } from '../utils/simpleDiff';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  getCells: () => Cell[];
  fileId: string | null;  // Current notebook file ID for per-notebook chat
  onInsertCode: (code: string, targetIndex?: number) => void;
  onEditCell: (index: number, code: string) => void;
  onDeleteCell: (index: number) => void;
}

const CHAT_STORAGE_PREFIX = 'nebula-chat-';

// Get chat history for a specific notebook
const getChatHistory = (fileId: string): ChatMessage[] => {
  try {
    const stored = localStorage.getItem(CHAT_STORAGE_PREFIX + fileId);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.warn('Failed to load chat history:', e);
  }
  return [{ role: 'assistant', content: 'Hello! I am Nebula AI. I can generate code, edit cells, or manage your notebook. Try "Edit cell 1 to print hello" or "Delete cell 2".' }];
};

// Save chat history for a specific notebook
const saveChatHistory = (fileId: string | null, messages: ChatMessage[]) => {
  try {
    if (!fileId) return;
    localStorage.setItem(CHAT_STORAGE_PREFIX + fileId, JSON.stringify(messages));
  } catch (e) {
    console.warn('Failed to save chat history:', e);
  }
};

// Helper to apply a search/replace patch
const applyPatch = (original: string, patchCode: string): string | null => {
  const match = patchCode.match(/<<<<\s*\n([\s\S]*?)\n====\s*\n([\s\S]*?)\n>>>>/);

  if (!match) return null;

  const searchBlock = match[1];
  const replaceBlock = match[2];

  if (original.includes(searchBlock)) {
    return original.replace(searchBlock, replaceBlock);
  }

  if (original.includes(searchBlock.trim())) {
    return original.replace(searchBlock.trim(), replaceBlock.trim());
  }

  return null;
};

const AIChatSidebarComponent: React.FC<Props> = ({ isOpen, onClose, getCells, fileId, onInsertCode, onEditCell, onDeleteCell }) => {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [providers, setProviders] = useState<Record<string, string[]>>({});
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastFileIdRef = useRef<string | null>(null);
  const cellsRef = useRef<Cell[]>([]);

  // LLM Settings
  const [currentProvider, setCurrentProvider] = useState<LLMProvider>('anthropic');
  const [currentModel, setCurrentModel] = useState<string>('claude-sonnet-4-5-20250929');

  // Load/save chat history when notebook changes
  useEffect(() => {
    // Save previous notebook's chat history
    if (lastFileIdRef.current && lastFileIdRef.current !== fileId) {
      saveChatHistory(lastFileIdRef.current, messages);
    }

    // Load new notebook's chat history
    if (fileId) {
      const history = getChatHistory(fileId);
      setMessages(history);
    } else {
      setMessages([{ role: 'assistant', content: 'Hello! I am Nebula AI. Open a notebook to start chatting.' }]);
    }

    lastFileIdRef.current = fileId;
  }, [fileId]);

  // Save chat history when messages change
  useEffect(() => {
    if (fileId && messages.length > 0) {
      saveChatHistory(fileId, messages);
    }
  }, [messages, fileId]);

  useEffect(() => {
    // Load settings
    const settings = getSettings();
    setCurrentProvider(settings.llmProvider);
    setCurrentModel(settings.llmModel);

    // Load available providers
    loadProviders();
  }, []);

  const loadProviders = async () => {
    try {
      const response = await getAvailableProviders();
      setProviders(response?.providers ?? {});
    } catch (error) {
      console.error('Failed to load providers:', error);
      // Fallback
      setProviders({
        google: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        openai: ['gpt-4o', 'gpt-4o-mini'],
        anthropic: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514']
      });
    }
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  useEffect(() => {
    if (isOpen) {
      cellsRef.current = getCells();
    }
  }, [isOpen, getCells]);

  const normalizeModels = useCallback((value: unknown): string[] => (
    Array.isArray(value) ? value : []
  ), []);

  const getDefaultModel = useCallback((provider: LLMProvider): string => {
    const models = normalizeModels(providers?.[provider]);
    return models[0] || '';
  }, [providers, normalizeModels]);

  const handleProviderChange = (provider: LLMProvider) => {
    const defaultModel = getDefaultModel(provider);
    setCurrentProvider(provider);
    setCurrentModel(defaultModel);
    saveSettings({ llmProvider: provider, llmModel: defaultModel });
  };

  const handleModelChange = (model: string) => {
    setCurrentModel(model);
    saveSettings({ llmModel: model });
  };

  useEffect(() => {
    if (!currentModel) {
      setCurrentModel(getDefaultModel(currentProvider));
    }
  }, [currentModel, currentProvider, getDefaultModel]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsLoading(true);

    try {
      const config: LLMConfig = {
        provider: currentProvider,
        model: currentModel
      };
      const response = await chatWithNotebook(userMsg, messages, getCells(), config);
      setMessages(prev => [...prev, { role: 'assistant', content: response }]);
    } catch (e) {
      console.error('Chat error:', e);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, I encountered an error connecting to the AI.' }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const extractSuggestion = (code: string) => {
    const editMatch = code.match(/#\s*Edit Cell\s+(\d+)/i);
    if (editMatch && editMatch[1]) {
      return { type: 'edit' as const, index: parseInt(editMatch[1], 10) - 1 };
    }

    const patchMatch = code.match(/#\s*Patch Cell\s+(\d+)/i);
    if (patchMatch && patchMatch[1]) {
      return { type: 'patch' as const, index: parseInt(patchMatch[1], 10) - 1 };
    }

    const insertMatch = code.match(/#\s*Insert after Cell\s+(\d+)/i);
    if (insertMatch && insertMatch[1]) {
      return { type: 'insert' as const, index: parseInt(insertMatch[1], 10) - 1 };
    }

    return { type: 'insert' as const, index: undefined };
  };

  const renderDiffView = (oldCode: string, newCode: string) => {
    const diff = diffLines(oldCode, newCode);
    return (
      <div className="bg-slate-900 rounded font-mono text-xs overflow-x-auto my-2 border border-slate-700 max-h-64 scrollbar-thin">
        {diff.map((part, i) => (
          <div
            key={i}
            className={`whitespace-pre px-2 py-0.5 w-full flex ${
              part.type === 'insert' ? 'bg-green-900/30 text-green-300' :
              part.type === 'delete' ? 'bg-red-900/30 text-red-300 opacity-60' :
              'text-slate-500'
            }`}
          >
            <span className="w-4 inline-block select-none opacity-50">
              {part.type === 'insert' ? '+' : part.type === 'delete' ? '-' : ' '}
            </span>
            <span>{part.value}</span>
          </div>
        ))}
      </div>
    );
  };

  const renderMessage = (msg: ChatMessage) => {
    if (msg.role === 'user') {
      return <div className="bg-slate-800 text-white p-3 rounded-lg rounded-tr-none text-sm whitespace-pre-wrap">{msg.content}</div>;
    }

    const parts = msg.content.split(/(```python[\s\S]*?```)/g);

    return (
      <div className="bg-purple-50 border border-purple-100 text-slate-800 p-3 rounded-lg rounded-tl-none text-sm space-y-2">
        {parts.map((part, i) => {
          if (part.startsWith('```python')) {
            const rawCode = part.replace(/^```python\n/, '').replace(/\n```$/, '');
            const suggestion = extractSuggestion(rawCode);

            let cleanCode = rawCode;
            let patchedContent: string | null = null;
            let isPatchFailed = false;

            const cells = cellsRef.current;

            if (suggestion.type === 'edit') {
              cleanCode = rawCode.replace(/#\s*Edit Cell\s+\d+\n?/, '');
            } else if (suggestion.type === 'patch') {
              const cell = cells[suggestion.index!];
              if (cell) {
                const patchBody = rawCode.replace(/#\s*Patch Cell\s+\d+\n?/, '');
                patchedContent = applyPatch(cell.content, patchBody);
                if (!patchedContent) isPatchFailed = true;
              }
            }

            const targetCellExists = suggestion.index !== undefined && cells[suggestion.index] !== undefined;

            return (
              <div key={i} className="relative group">
                {(suggestion.type === 'edit' && targetCellExists) ? (
                  renderDiffView(cells[suggestion.index!].content, cleanCode)
                ) : (suggestion.type === 'patch' && targetCellExists) ? (
                  isPatchFailed ? (
                    <div className="bg-amber-50 text-amber-800 p-2 text-xs border border-amber-200 rounded">
                      <strong>Patch Failed:</strong> Could not find the exact code block to replace in Cell #{suggestion.index! + 1}.
                      <pre className="mt-1 text-[0.625rem] bg-white p-1 overflow-x-auto">{rawCode}</pre>
                    </div>
                  ) : (
                    renderDiffView(cells[suggestion.index!].content, patchedContent!)
                  )
                ) : (
                  <div className="bg-slate-900 text-slate-50 p-3 rounded font-mono text-xs overflow-x-auto my-2">
                    <pre>{cleanCode}</pre>
                  </div>
                )}

                {suggestion.type === 'edit' ? (
                  <button
                    onClick={() => onEditCell(suggestion.index!, cleanCode)}
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white text-blue-600 text-xs px-2 py-1 rounded shadow-sm font-bold flex items-center gap-1 hover:bg-blue-50 border border-blue-200"
                    title={`Replace content of Cell #${suggestion.index! + 1}`}
                  >
                    <Pencil className="w-3 h-3" /> Apply Edit
                  </button>
                ) : suggestion.type === 'patch' ? (
                  !isPatchFailed && <button
                    onClick={() => onEditCell(suggestion.index!, patchedContent!)}
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white text-blue-600 text-xs px-2 py-1 rounded shadow-sm font-bold flex items-center gap-1 hover:bg-blue-50 border border-blue-200"
                    title={`Apply Patch to Cell #${suggestion.index! + 1}`}
                  >
                    <Pencil className="w-3 h-3" /> Apply Patch
                  </button>
                ) : (
                  <button
                    onClick={() => onInsertCode(cleanCode, suggestion.index)}
                    className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity bg-white text-purple-700 text-xs px-2 py-1 rounded shadow-sm font-bold flex items-center gap-1 hover:bg-purple-100 border border-purple-200"
                    title={suggestion.index !== undefined ? `Insert after Cell #${suggestion.index + 1}` : "Insert at active cell"}
                  >
                    {suggestion.index !== undefined ? (
                      <>
                        <CornerDownLeft className="w-3 h-3" />
                        After #{suggestion.index + 1}
                      </>
                    ) : (
                      <>
                        <Plus className="w-3 h-3" /> Insert
                      </>
                    )}
                  </button>
                )}
              </div>
            );
          }

          const deleteParts = part.split(/\[DELETE CELL\s+(\d+)\]/g);

          if (deleteParts.length > 1) {
            return (
              <div key={i}>
                {deleteParts.map((subPart, j) => {
                  if (/^\d+$/.test(subPart)) {
                    const idx = parseInt(subPart, 10) - 1;
                    return (
                      <button
                        key={j}
                        onClick={() => onDeleteCell(idx)}
                        className="inline-flex items-center gap-1 bg-red-100 text-red-700 px-2 py-1 rounded text-xs font-bold hover:bg-red-200 mx-1 my-1"
                      >
                        <Trash2 className="w-3 h-3" /> Delete Cell #{idx + 1}
                      </button>
                    );
                  }
                  return <span key={j} dangerouslySetInnerHTML={{ __html: subPart.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />;
                })}
              </div>
            );
          }

          return <div key={i} className="whitespace-pre-wrap" dangerouslySetInnerHTML={{ __html: part.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>') }} />;
        })}
      </div>
    );
  };

  const getProviderLabel = (provider: string) => {
    switch (provider) {
      case 'google': return 'Google';
      case 'openai': return 'OpenAI';
      case 'anthropic': return 'Anthropic';
      default: return provider;
    }
  };

  const availableModels = normalizeModels(providers?.[currentProvider]);

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 bg-black/20 z-30 lg:hidden" onClick={onClose} />
      )}
      <div className={`
        fixed top-0 right-0 h-full w-80 sm:w-96 bg-white border-l border-slate-200 shadow-2xl z-40 transform transition-transform duration-300 ease-in-out flex flex-col
        ${isOpen ? 'translate-x-0' : 'translate-x-full'}
      `}>
        <div className="p-4 border-b border-slate-100 flex justify-between items-center bg-purple-50/50">
          <h2 className="font-semibold text-slate-800 flex items-center gap-2">
            <Bot className="w-5 h-5 text-purple-600" />
            Nebula Copilot
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-1 hover:bg-slate-200 rounded transition-colors ${showSettings ? 'bg-slate-200' : ''}`}
              title="Model settings"
            >
              <Settings2 className="w-4 h-4 text-slate-500" />
            </button>
            <button onClick={onClose} className="p-1 hover:bg-slate-200 rounded">
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Model Settings */}
        {showSettings && (
          <div className="p-3 border-b border-slate-200 bg-slate-50 space-y-3">
            <div>
              <label className="text-xs font-medium text-slate-600 mb-1 block">Provider</label>
              <div className="flex gap-1">
                {(['google', 'openai', 'anthropic'] as LLMProvider[]).map(provider => {
                  const isAvailable = Object.keys(providers).includes(provider);
                  return (
                    <button
                      key={provider}
                      onClick={() => isAvailable && handleProviderChange(provider)}
                      disabled={!isAvailable}
                      className={`flex-1 px-2 py-1.5 text-xs font-medium rounded transition-all ${
                        currentProvider === provider
                          ? 'bg-purple-600 text-white'
                          : isAvailable
                            ? 'bg-white text-slate-600 hover:bg-slate-100 border border-slate-200'
                            : 'bg-slate-100 text-slate-400 cursor-not-allowed'
                      }`}
                    >
                      {getProviderLabel(provider)}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-slate-600 mb-1 block">Model</label>
              <select
                value={currentModel}
                onChange={(e) => handleModelChange(e.target.value)}
                className="w-full px-2 py-1.5 text-xs border border-slate-200 rounded bg-white focus:outline-none focus:ring-1 focus:ring-purple-500"
              >
                {availableModels.map(model => (
                  <option key={model} value={model}>{model}</option>
                ))}
              </select>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-4" ref={scrollRef}>
          {messages.map((msg, idx) => (
            <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className="max-w-[90%]">
                {renderMessage(msg)}
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="flex justify-start animate-pulse">
              <div className="bg-purple-50 p-3 rounded-lg rounded-tl-none text-xs text-purple-400">
                Thinking...
              </div>
            </div>
          )}
        </div>

        <div className="p-4 border-t border-slate-100 bg-white">
          <div className="relative">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about your data..."
              className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-3 pr-10 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500 resize-none h-12 max-h-32"
            />
            <button
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
              className="absolute right-2 top-2 p-1.5 text-purple-600 hover:bg-purple-100 rounded-md disabled:opacity-50 transition-colors"
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
          <div className="text-[0.625rem] text-center text-slate-400 mt-2">
            Using {getProviderLabel(currentProvider)} • {currentModel}
          </div>
        </div>
      </div>
    </>
  );
};

export const AIChatSidebar = memo(AIChatSidebarComponent);
