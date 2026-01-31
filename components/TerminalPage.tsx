/**
 * TerminalPage - Standalone full-screen terminal
 *
 * Accessed via URL: /?terminal=name
 * Creates persistent terminals that survive page refreshes.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Terminal, AlertCircle } from 'lucide-react';
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
    // Terminal exited, try to recreate it
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
    <div className="h-screen w-screen flex flex-col bg-[#1e1e1e]">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 bg-[#2d2d2d] border-b border-[#404040]">
        <div className="flex items-center gap-2 text-sm font-medium text-slate-300">
          <Terminal className="w-4 h-4" />
          <span>{terminalName}</span>
        </div>
        <div className="text-xs text-slate-500">
          {terminal ? `PID: ${terminal.pid}` : 'Connecting...'}
        </div>
      </div>

      {/* Terminal Content */}
      <div className="flex-1 relative">
        {serverAvailable === false && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e]">
            <div className="text-center text-slate-400">
              <AlertCircle className="w-12 h-12 mx-auto mb-3 text-amber-500" />
              <p className="text-lg font-medium">Terminal server not available</p>
              <p className="text-sm mt-2 text-slate-500">
                Make sure the Nebula server is running
              </p>
            </div>
          </div>
        )}

        {isLoading && serverAvailable !== false && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e]">
            <div className="text-center text-slate-400">
              <Terminal className="w-12 h-12 mx-auto mb-3 animate-pulse" />
              <p className="text-lg">Connecting to terminal...</p>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-[#1e1e1e]">
            <div className="text-center text-slate-400">
              <AlertCircle className="w-12 h-12 mx-auto mb-3 text-red-500" />
              <p className="text-lg font-medium">Error</p>
              <p className="text-sm mt-2 text-slate-500">{error}</p>
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
