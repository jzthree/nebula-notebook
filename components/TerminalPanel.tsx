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
  GripHorizontal,
  AlertCircle,
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

  const panelRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  // Check server availability and load existing terminals on mount
  useEffect(() => {
    if (!isOpen) return;

    const init = async () => {
      const available = await checkTerminalServer();
      setServerAvailable(available);

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

  return (
    <div
      ref={panelRef}
      className="flex-none border-t border-slate-200 bg-slate-900 flex flex-col"
      style={{ height: `${height}px` }}
    >
      {/* Resize Handle */}
      <div
        className={`h-2 cursor-ns-resize flex items-center justify-center transition-colors ${
          isResizing ? 'bg-blue-500' : 'bg-slate-700 hover:bg-slate-600'
        }`}
        onMouseDown={handleResizeStart}
      >
        <GripHorizontal className="w-4 h-4 text-slate-400" />
      </div>

      {/* Tab Bar */}
      <div className="flex items-center justify-between px-2 py-1 bg-slate-800 border-b border-slate-700">
        <div className="flex items-center gap-1 overflow-x-auto">
          {terminals.map((terminal, index) => (
            <button
              key={terminal.id}
              onClick={() => setActiveTerminalId(terminal.id)}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded transition-colors ${
                activeTerminalId === terminal.id
                  ? 'bg-slate-900 text-white'
                  : 'text-slate-400 hover:text-white hover:bg-slate-700'
              }`}
            >
              <Terminal className="w-3 h-3" />
              <span>Terminal {index + 1}</span>
              <button
                onClick={(e) => handleCloseTerminal(terminal.id, e)}
                className="ml-1 p-0.5 rounded hover:bg-slate-600"
              >
                <X className="w-3 h-3" />
              </button>
            </button>
          ))}

          {/* Add Terminal Button */}
          <button
            onClick={handleCreateTerminal}
            disabled={!serverAvailable || isLoading}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors disabled:opacity-50"
            title="New Terminal"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {/* Panel Controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => setHeight(height === MIN_HEIGHT ? DEFAULT_HEIGHT : MIN_HEIGHT)}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            title={height === MIN_HEIGHT ? 'Expand' : 'Minimize'}
          >
            {height === MIN_HEIGHT ? (
              <Maximize2 className="w-4 h-4" />
            ) : (
              <Minus className="w-4 h-4" />
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white hover:bg-slate-700 rounded transition-colors"
            title="Close Panel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 min-h-0 relative">
        {serverAvailable === false && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
            <div className="text-center text-slate-400">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
              <p className="text-sm font-medium">Terminal server not available</p>
              <p className="text-xs mt-1">
                Run <code className="bg-slate-800 px-1 py-0.5 rounded">npm run terminal</code> to start
              </p>
            </div>
          </div>
        )}

        {serverAvailable && terminals.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-900">
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
