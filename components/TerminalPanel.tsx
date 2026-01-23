/**
 * TerminalPanel - Single terminal per notebook
 *
 * Terminal is created lazily when first opened and closed when notebook changes.
 * This is better suited for agentic use where each notebook has its own terminal context.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Terminal,
  X,
  Maximize2,
  Minimize2,
  AlertCircle,
} from 'lucide-react';
import { TerminalInstance } from './TerminalInstance';
import {
  createTerminal,
  closeTerminal,
  checkTerminalServer,
  TerminalInfo,
} from '../services/terminalService';

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
  notebookPath?: string | null; // Current notebook path for cwd
  defaultHeight?: number;
}

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  isOpen,
  onClose,
  notebookPath,
  defaultHeight = DEFAULT_HEIGHT,
}) => {
  const [height, setHeight] = useState(defaultHeight);
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isMaximized, setIsMaximized] = useState(false);

  const panelRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const currentNotebookRef = useRef<string | null>(null);

  // Close terminal when notebook changes
  useEffect(() => {
    const prevNotebook = currentNotebookRef.current;
    currentNotebookRef.current = notebookPath ?? null;

    // If notebook changed and we have a terminal, close it
    if (prevNotebook && prevNotebook !== notebookPath && terminal) {
      closeTerminal(terminal.id).catch(console.error);
      setTerminal(null);
    }
  }, [notebookPath, terminal]);

  // Check server availability when panel opens
  useEffect(() => {
    if (!isOpen) return;

    const checkServer = async () => {
      const available = await checkTerminalServer();
      setServerAvailable(available);
    };

    checkServer();
  }, [isOpen]);

  // Create terminal when panel opens and no terminal exists
  useEffect(() => {
    if (!isOpen || !serverAvailable || terminal || isLoading) return;

    const createNewTerminal = async () => {
      setIsLoading(true);
      try {
        // Get cwd from notebook path (parent directory)
        let cwd: string | undefined;
        if (notebookPath) {
          const lastSlash = notebookPath.lastIndexOf('/');
          if (lastSlash > 0) {
            cwd = notebookPath.substring(0, lastSlash);
          }
        }

        const newTerminal = await createTerminal({ cwd });
        setTerminal(newTerminal);
      } catch (error) {
        console.error('[TerminalPanel] Failed to create terminal:', error);
      } finally {
        setIsLoading(false);
      }
    };

    createNewTerminal();
  }, [isOpen, serverAvailable, terminal, isLoading, notebookPath]);

  // Handle terminal exit
  const handleTerminalExit = useCallback((_code: number) => {
    // Terminal exited, clear it so a new one can be created if panel reopens
    setTerminal(null);
  }, []);

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;

      // Trigger resize on terminal instance
      if (panelRef.current) {
        const container = panelRef.current.querySelector('[data-terminal-container]');
        if (container && (container as any).__terminalResize) {
          (container as any).__terminalResize();
        }
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

  // Trigger resize when maximized changes
  useEffect(() => {
    if (panelRef.current) {
      const timer = setTimeout(() => {
        const container = panelRef.current?.querySelector('[data-terminal-container]');
        if (container && (container as any).__terminalResize) {
          (container as any).__terminalResize();
        }
      }, 250);
      return () => clearTimeout(timer);
    }
  }, [isMaximized]);

  if (!isOpen) return null;

  const panelHeight = isMaximized ? '80vh' : `${height}px`;

  // Get notebook name for display
  const notebookName = notebookPath
    ? notebookPath.split('/').pop()?.replace('.ipynb', '') || 'Terminal'
    : 'Terminal';

  return (
    <div
      ref={panelRef}
      className="flex-none border-t border-slate-300 bg-white flex flex-col transition-all duration-200"
      style={{ height: panelHeight }}
    >
      {/* Resize Handle - at top edge for bottom panels */}
      {!isMaximized && (
        <div
          className={`h-1.5 cursor-ns-resize transition-colors group relative ${
            isResizing ? 'bg-blue-500' : 'hover:bg-blue-400'
          }`}
          onMouseDown={handleResizeStart}
        >
          {/* Visual indicator on hover */}
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 bg-slate-300 group-hover:bg-blue-400 transition-colors" />
        </div>
      )}

      {/* Compact Header */}
      <div className="flex items-center justify-between px-2 py-0.5 bg-slate-800 text-slate-300">
        <div className="flex items-center gap-1.5 text-xs font-medium">
          <Terminal className="w-3 h-3 text-slate-400" />
          <span className="text-slate-300">{notebookName}</span>
        </div>

        {/* Controls */}
        <div className="flex items-center">
          <button
            onClick={() => setIsMaximized(!isMaximized)}
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors"
            title={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <Minimize2 className="w-3 h-3" />
            ) : (
              <Maximize2 className="w-3 h-3" />
            )}
          </button>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-200 hover:bg-slate-700 rounded transition-colors"
            title="Close Panel"
          >
            <X className="w-3 h-3" />
          </button>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 min-h-0 relative bg-slate-900">
        {serverAvailable === false && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
              <p className="text-sm font-medium">Terminal server not available</p>
              <p className="text-xs mt-1">
                Run <code className="bg-slate-200 px-1.5 py-0.5 rounded">npm run terminal</code> to start
              </p>
            </div>
          </div>
        )}

        {serverAvailable && !terminal && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <Terminal className="w-8 h-8 mx-auto mb-2" />
              <p className="text-sm">Creating terminal...</p>
            </div>
          </div>
        )}

        {terminal && (
          <div data-terminal-container className="absolute inset-0">
            <TerminalInstance
              terminalId={terminal.id}
              isActive={true}
              onExit={handleTerminalExit}
            />
          </div>
        )}
      </div>
    </div>
  );
};
