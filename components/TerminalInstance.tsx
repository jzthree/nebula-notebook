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

    // Create terminal instance
    const terminal = new Terminal({
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      cursorStyle: 'block',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#000000',
        red: '#cd3131',
        green: '#0dbc79',
        yellow: '#e5e510',
        blue: '#2472c8',
        magenta: '#bc3fbc',
        cyan: '#11a8cd',
        white: '#e5e5e5',
        brightBlack: '#666666',
        brightRed: '#f14c4c',
        brightGreen: '#23d18b',
        brightYellow: '#f5f543',
        brightBlue: '#3b8eea',
        brightMagenta: '#d670d6',
        brightCyan: '#29b8db',
        brightWhite: '#e5e5e5',
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

    // Handle terminal input - only send if this terminal is active
    terminal.onData((data) => {
      if (isActiveRef.current && ws.readyState === WebSocket.OPEN) {
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

  // Focus terminal when active
  useEffect(() => {
    if (isActive && terminalRef.current) {
      terminalRef.current.focus();
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
