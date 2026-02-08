import React, { useEffect, useState } from 'react';
import { X, Terminal, Trash2, RefreshCw, ExternalLink, Plus, Folder, Clock } from 'lucide-react';
import { createTerminal, closeTerminal, listTerminals, TerminalInfo } from '../services/terminalService';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onTerminalClosed?: (terminalId: string) => void;
}

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function shortId(id: string): string {
  if (id.length <= 18) return id;
  return `${id.slice(0, 8)}…${id.slice(-6)}`;
}

export const TerminalManager: React.FC<Props> = ({ isOpen, onClose, onTerminalClosed }) => {
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [closingId, setClosingId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = async () => {
    setIsLoading(true);
    try {
      const data = await listTerminals();
      // Most-recent activity first
      data.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
      setTerminals(data);
    } catch (err) {
      console.error('[TerminalManager] Failed to load terminals:', err);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!isOpen) return;
    void load();
  }, [isOpen]);

  const handleOpen = (terminalId: string) => {
    window.open(`/?terminal=${encodeURIComponent(terminalId)}`, '_blank');
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const t = await createTerminal();
      // Open in a new tab. TerminalPage will connect by id.
      handleOpen(t.id);
      void load();
    } catch (err) {
      console.error('[TerminalManager] Failed to create terminal:', err);
    } finally {
      setCreating(false);
    }
  };

  const handleCloseTerminal = async (terminalId: string) => {
    setClosingId(terminalId);
    try {
      await closeTerminal(terminalId);
      setTerminals(prev => prev.filter(t => t.id !== terminalId));
      onTerminalClosed?.(terminalId);
    } catch (err) {
      console.error('[TerminalManager] Failed to close terminal:', err);
    } finally {
      setClosingId(null);
    }
  };

  if (!isOpen) return null;

  const now = Date.now();

  return (
    <>
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl z-50 w-full max-w-lg max-h-[80vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Terminal className="w-5 h-5 text-slate-700" />
            Terminal Manager
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleOpen('default')}
              className="px-2.5 py-1.5 text-xs font-medium rounded bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
              title="Open default terminal in a new tab"
            >
              Open Default
            </button>
            <button
              onClick={handleCreate}
              disabled={creating}
              className="p-1.5 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-50"
              title="New terminal"
            >
              <Plus className={`w-4 h-4 ${creating ? 'animate-pulse' : ''}`} />
            </button>
            <button
              onClick={load}
              disabled={isLoading}
              className="p-1.5 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-50"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded">
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-sm">
          <span className="text-slate-600">
            {terminals.length} active terminal{terminals.length !== 1 ? 's' : ''}
          </span>
          <span className="text-xs text-slate-400">
            Click <span className="font-medium">Open</span> to attach in a new tab
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {terminals.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">
              No active terminals
            </div>
          ) : (
            terminals.map(t => (
              <div
                key={t.id}
                className="flex items-center justify-between p-3 rounded-lg mb-2 bg-slate-50 border border-slate-200"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-slate-800 truncate" title={t.id}>
                      {t.id === 'default' ? 'default' : shortId(t.id)}
                    </span>
                    <span className="text-[0.625rem] text-slate-400">PID: {t.pid}</span>
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                    <span className="flex items-center gap-1 min-w-0" title={t.cwd}>
                      <Folder className="w-3 h-3 flex-shrink-0" />
                      <span className="truncate">{t.cwd}</span>
                    </span>
                    <span className="flex items-center gap-1" title="Last activity">
                      <Clock className="w-3 h-3" />
                      {formatAge(Math.max(0, now - t.lastActivity))}
                    </span>
                  </div>
                  <div className="text-[0.625rem] text-slate-400 mt-1 truncate" title={t.shell}>
                    {t.shell}
                  </div>
                </div>

                <div className="ml-2 flex items-center gap-1">
                  <button
                    onClick={() => handleOpen(t.id)}
                    className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-200 rounded transition-colors"
                    title="Open in new tab"
                  >
                    <ExternalLink className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => handleCloseTerminal(t.id)}
                    disabled={closingId === t.id}
                    className="p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                    title="Close terminal"
                  >
                    {closingId === t.id ? (
                      <RefreshCw className="w-4 h-4 animate-spin" />
                    ) : (
                      <Trash2 className="w-4 h-4" />
                    )}
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="p-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-500">
          Terminals persist until closed. Output replay is limited to a small in-memory buffer.
        </div>
      </div>
    </>
  );
};

