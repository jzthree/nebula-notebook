/**
 * TerminalInstance - xterm.js wrapper component for a single terminal
 */

import React, { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import {
  connectTerminal,
  TerminalServerMessage,
} from '../services/terminalService';

interface TerminalInstanceProps {
  terminalId: string;
  isActive: boolean;
  onExit?: (code: number) => void;
}

export const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  terminalId,
  isActive,
  onExit,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isInitializedRef = useRef(false);
  const isActiveRef = useRef(isActive);

  // Keep isActiveRef in sync
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // Initialize terminal
  useEffect(() => {
    if (!containerRef.current || isInitializedRef.current) return;

    // Create terminal instance with light theme matching notebook
    const terminal = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'bar',
      theme: {
        background: '#f8fafc', // slate-50
        foreground: '#1e293b', // slate-800
        cursor: '#1e293b',
        cursorAccent: '#f8fafc',
        selectionBackground: '#dbeafe', // blue-100
        black: '#1e293b',
        red: '#dc2626', // red-600
        green: '#16a34a', // green-600
        yellow: '#ca8a04', // yellow-600
        blue: '#2563eb', // blue-600
        magenta: '#9333ea', // purple-600
        cyan: '#0891b2', // cyan-600
        white: '#f1f5f9', // slate-100
        brightBlack: '#64748b', // slate-500
        brightRed: '#ef4444',
        brightGreen: '#22c55e',
        brightYellow: '#eab308',
        brightBlue: '#3b82f6',
        brightMagenta: '#a855f7',
        brightCyan: '#06b6d4',
        brightWhite: '#ffffff',
      },
    });

    // Add addons
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(new WebLinksAddon());

    // Open terminal in container
    terminal.open(containerRef.current);

    // Initial fit
    setTimeout(() => {
      fitAddon.fit();
    }, 0);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    isInitializedRef.current = true;

    // Connect WebSocket
    const ws = connectTerminal(terminalId);
    wsRef.current = ws;

    ws.onopen = () => {
      // Send initial size
      const dimensions = fitAddon.proposeDimensions();
      if (dimensions) {
        ws.send(JSON.stringify({
          type: 'resize',
          cols: dimensions.cols,
          rows: dimensions.rows,
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const message: TerminalServerMessage = JSON.parse(event.data);

        switch (message.type) {
          case 'output':
          case 'replay':
            terminal.write(message.data);
            break;

          case 'exit':
            terminal.write(`\r\n\x1b[90m[Process exited with code ${message.code}]\x1b[0m\r\n`);
            onExit?.(message.code);
            break;

          case 'error':
            terminal.write(`\r\n\x1b[31m[Error: ${message.message}]\x1b[0m\r\n`);
            break;
        }
      } catch (error) {
        console.error('[Terminal] Failed to parse message:', error);
      }
    };

    ws.onerror = (error) => {
      console.error('[Terminal] WebSocket error:', error);
      terminal.write('\r\n\x1b[31m[Connection error]\x1b[0m\r\n');
    };

    ws.onclose = () => {
      terminal.write('\r\n\x1b[90m[Disconnected]\x1b[0m\r\n');
    };

    // Handle terminal input - only send if this terminal is active and focused
    terminal.onData((data) => {
      // Check both the active state and that the terminal actually has focus
      const hasFocus = containerRef.current?.contains(document.activeElement);
      if (isActiveRef.current && hasFocus && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Cleanup
    return () => {
      ws.close();
      terminal.dispose();
      isInitializedRef.current = false;
    };
  }, [terminalId, onExit]);

  // Handle resize
  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !wsRef.current) return;

    fitAddonRef.current.fit();
    const dimensions = fitAddonRef.current.proposeDimensions();

    if (dimensions && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'resize',
        cols: dimensions.cols,
        rows: dimensions.rows,
      }));
    }
  }, []);

  // Resize on visibility change
  useEffect(() => {
    if (isActive) {
      // Small delay to ensure container is visible
      const timer = setTimeout(handleResize, 50);
      return () => clearTimeout(timer);
    }
  }, [isActive, handleResize]);

  // Resize on window resize
  useEffect(() => {
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [handleResize]);

  // Focus/blur terminal based on active state
  useEffect(() => {
    if (terminalRef.current) {
      if (isActive) {
        // Small delay to ensure DOM is ready
        setTimeout(() => {
          terminalRef.current?.focus();
        }, 10);
      } else {
        // Blur when becoming inactive to prevent stealing input
        terminalRef.current.blur();
      }
    }
  }, [isActive]);

  // Expose resize method for parent
  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      (container as any).__terminalResize = handleResize;
    }
  }, [handleResize]);

  return (
    <div
      ref={containerRef}
      className={`h-full w-full ${isActive ? '' : 'hidden'}`}
      style={{ padding: '4px 8px' }}
    />
  );
};
