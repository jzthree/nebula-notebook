/**
 * TerminalPanel - Bottom panel container with tabs for multiple terminals
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Terminal,
  Plus,
  X,
  Minus,
  Maximize2,
  Minimize2,
  GripHorizontal,
  AlertCircle,
  Trash2,
} from 'lucide-react';
import { TerminalInstance } from './TerminalInstance';
import {
  createTerminal,
  listTerminals,
  closeTerminal,
  checkTerminalServer,
  TerminalInfo,
} from '../services/terminalService';

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
  defaultHeight?: number;
}

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  isOpen,
  onClose,
  defaultHeight = DEFAULT_HEIGHT,
}) => {
  const [height, setHeight] = useState(defaultHeight);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [activeTerminalId, setActiveTerminalId] = useState<string | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Check server availability and load existing terminals on mount
  useEffect(() => {
    if (!isOpen) return;

    const init = async () => {
      const available = await checkTerminalServer();

      if (available) {
        try {
          const existingTerminals = await listTerminals();
          setTerminals(existingTerminals);

          // Set active terminal to first one if exists
          if (existingTerminals.length > 0 && !activeTerminalId) {
            setActiveTerminalId(existingTerminals[0].id);
          }
        } catch (error) {
          console.error('[TerminalPanel] Failed to list terminals:', error);
        }
      }

      // Set serverAvailable AFTER loading terminals to prevent race condition
      setServerAvailable(available);
    };

    init();
  }, [isOpen]);

  // Create a new terminal
  const handleCreateTerminal = useCallback(async () => {
    if (!serverAvailable) return;

    setIsLoading(true);
    try {
      const terminal = await createTerminal();
      setTerminals((prev) => [...prev, terminal]);
      setActiveTerminalId(terminal.id);
    } catch (error) {
      console.error('[TerminalPanel] Failed to create terminal:', error);
    } finally {
      setIsLoading(false);
    }
  }, [serverAvailable]);

  // Close a terminal
  const handleCloseTerminal = useCallback(async (id: string, e?: React.MouseEvent) => {
    e?.stopPropagation();

    try {
      await closeTerminal(id);
      setTerminals((prev) => prev.filter((t) => t.id !== id));

      // If closing active terminal, switch to another
      if (activeTerminalId === id) {
        setTerminals((prev) => {
          const remaining = prev.filter((t) => t.id !== id);
          if (remaining.length > 0) {
            setActiveTerminalId(remaining[remaining.length - 1].id);
          } else {
            setActiveTerminalId(null);
          }
          return remaining;
        });
      }
    } catch (error) {
      console.error('[TerminalPanel] Failed to close terminal:', error);
    }
  }, [activeTerminalId]);

  // Handle terminal exit
  const handleTerminalExit = useCallback((terminalId: string, _code: number) => {
    // Remove from list after a short delay
    setTimeout(() => {
      setTerminals((prev) => prev.filter((t) => t.id !== terminalId));
      if (activeTerminalId === terminalId) {
        setTerminals((prev) => {
          if (prev.length > 0) {
            setActiveTerminalId(prev[prev.length - 1].id);
          } else {
            setActiveTerminalId(null);
          }
          return prev;
        });
      }
    }, 2000);
  }, [activeTerminalId]);

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Resize from top, so moving up increases height
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;

      // Trigger resize on all terminal instances
      if (panelRef.current) {
        const containers = panelRef.current.querySelectorAll('[data-terminal-container]');
        containers.forEach((container: any) => {
          if (container.__terminalResize) {
            container.__terminalResize();
          }
        });
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    resizeCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [height]);

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      if (resizeCleanupRef.current) {
        resizeCleanupRef.current();
      }
    };
  }, []);

  // Auto-create terminal if none exist when panel opens
  useEffect(() => {
    if (isOpen && serverAvailable && terminals.length === 0 && !isLoading) {
      handleCreateTerminal();
    }
  }, [isOpen, serverAvailable, terminals.length, isLoading, handleCreateTerminal]);

  if (!isOpen) return null;

  const panelHeight = isMaximized ? '80vh' : `${height}px`;

  return (
    <div
      ref={panelRef}
      className="flex-none border-t border-slate-800 bg-[#0d1117] flex flex-col transition-all duration-200"
      style={{ height: panelHeight }}
    >
      {/* Resize Handle */}
      {!isMaximized && (
        <div
          className={`h-1.5 cursor-ns-resize flex items-center justify-center transition-colors ${
            isResizing ? 'bg-blue-500' : 'bg-slate-800 hover:bg-slate-700'
          }`}
          onMouseDown={handleResizeStart}
        >
          <GripHorizontal className="w-4 h-4 text-slate-600" />
        </div>
      )}

      {/* Tab Bar */}
      <div className="flex items-center bg-slate-950/50 border-b border-slate-800">
        {/* Tabs */}
        <div className="flex-1 flex overflow-x-auto">
          {terminals.map((terminal, index) => (
            <div
              key={terminal.id}
              onClick={() => setActiveTerminalId(terminal.id)}
              className={`
                group flex items-center gap-2 px-3 py-2 text-xs font-medium cursor-pointer
                border-r border-slate-800 min-w-[120px] max-w-[200px] select-none transition-colors
                ${activeTerminalId === terminal.id
                  ? 'bg-[#0d1117] text-blue-400 border-t-2 border-t-blue-500'
                  : 'bg-slate-950 text-slate-500 hover:bg-[#0d1117] border-t-2 border-t-transparent'
                }
              `}
            >
              <Terminal className="w-3 h-3" />
              <span className="truncate flex-1">Terminal {index + 1}</span>
              {terminals.length > 1 && (
                <button
                  onClick={(e) => handleCloseTerminal(terminal.id, e)}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-slate-800 hover:text-red-500 transition-opacity"
                >
                  <X className="w-3 h-3" />
                </button>
              )}
            </div>
          ))}

          {/* Add Terminal Button */}
          <button
            onClick={handleCreateTerminal}
            disabled={!serverAvailable || isLoading}
            className="px-3 text-slate-500 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-50"
            title="New Terminal"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {/* Panel Controls */}
        <div className="flex items-center gap-1 px-2">
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1.5 text-slate-500 hover:text-white hover:bg-slate-800 rounded transition-colors"
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-500 hover:text-white hover:bg-slate-800 rounded transition-colors"
            title="Close Panel"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 min-h-0 relative bg-[#0d1117]">
        {serverAvailable === false && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-slate-400">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
              <p className="text-sm font-medium">Terminal server not available</p>
              <p className="text-xs mt-1">
                Run <code className="bg-slate-800 px-1.5 py-0.5 rounded">npm run terminal</code> to start
              </p>
            </div>
          </div>
        )}

        {serverAvailable && terminals.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-slate-400">
              <Terminal className="w-8 h-8 mx-auto mb-2" />
              <p className="text-sm">Creating terminal...</p>
            </div>
          </div>
        )}

        {terminals.map((terminal) => (
          <div
            key={terminal.id}
            data-terminal-container
            className={`absolute inset-0 ${
              activeTerminalId === terminal.id ? '' : 'invisible'
            }`}
          >
            <TerminalInstance
              terminalId={terminal.id}
              isActive={activeTerminalId === terminal.id}
              onExit={(code) => handleTerminalExit(terminal.id, code)}
            />
          </div>
        ))}
      </div>
    </div>
  );
};
