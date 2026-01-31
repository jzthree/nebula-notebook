/**
 * TerminalPage - Standalone full-screen terminal
 *
 * Accessed via URL: /?terminal=name
 * Creates persistent terminals that survive page refreshes.
 * Multiple tabs can connect to the same terminal (collaborative).
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Terminal, AlertCircle, ExternalLink } from 'lucide-react';
import { TerminalInstance } from './TerminalInstance';
import {
  getOrCreateNamedTerminal,
  checkTerminalServer,
  TerminalInfo,
} from '../services/terminalService';

interface TerminalPageProps {
  terminalName: string;
}

export const TerminalPage: React.FC<TerminalPageProps> = ({ terminalName }) => {
  const [terminal, setTerminal] = useState<TerminalInfo | null>(null);
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Check server and create/get terminal
  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      setError(null);

      // Check server availability
      const available = await checkTerminalServer();
      setServerAvailable(available);

      if (!available) {
        setIsLoading(false);
        return;
      }

      // Get or create the named terminal
      try {
        const terminalInfo = await getOrCreateNamedTerminal(terminalName);
        setTerminal(terminalInfo);
      } catch (err) {
        console.error('[TerminalPage] Failed to get/create terminal:', err);
        setError(err instanceof Error ? err.message : 'Failed to create terminal');
      } finally {
        setIsLoading(false);
      }
    };

    init();
  }, [terminalName]);

  // Handle terminal exit - recreate it
  const handleTerminalExit = useCallback(async (_code: number) => {
    try {
      const terminalInfo = await getOrCreateNamedTerminal(terminalName);
      setTerminal(terminalInfo);
    } catch (err) {
      console.error('[TerminalPage] Failed to recreate terminal:', err);
      setError('Terminal exited. Refresh to reconnect.');
    }
  }, [terminalName]);

  // Update page title
  useEffect(() => {
    document.title = `Terminal: ${terminalName}`;
    return () => {
      document.title = 'Nebula Notebook';
    };
  }, [terminalName]);

  return (
    <div className="h-screen w-screen flex flex-col bg-slate-50">
      {/* Header - matches notebook style */}
      <div className="flex items-center justify-between px-4 py-2 bg-white border-b border-slate-200 shadow-sm">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-700">
          <Terminal className="w-4 h-4" />
          <span>{terminalName}</span>
        </div>
        <div className="flex items-center gap-3">
          {terminal && (
            <span className="text-xs text-slate-400">
              PID: {terminal.pid}
            </span>
          )}
          <a
            href="/"
            className="text-xs text-slate-500 hover:text-slate-700 flex items-center gap-1"
          >
            <ExternalLink className="w-3 h-3" />
            Notebook
          </a>
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 relative bg-slate-50">
        {serverAvailable === false && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-slate-500">
              <AlertCircle className="w-12 h-12 mx-auto mb-3 text-amber-500" />
              <p className="text-lg font-medium">Terminal server not available</p>
              <p className="text-sm mt-2 text-slate-400">
                Make sure the Nebula server is running
              </p>
            </div>
          </div>
        )}

        {isLoading && serverAvailable !== false && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-slate-500">
              <Terminal className="w-12 h-12 mx-auto mb-3 animate-pulse" />
              <p className="text-lg">Connecting to terminal...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center text-slate-500">
              <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-500" />
              <p className="text-lg font-medium">Error</p>
              <p className="text-sm mt-2 text-slate-400">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-4 px-4 py-2 bg-slate-200 hover:bg-slate-300 rounded text-sm"
              >
                Refresh
              </button>
            </div>
          </div>
        )}

        {terminal && !error && (
          <div className="absolute inset-0">
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
