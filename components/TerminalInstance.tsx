/**
 * TerminalInstance - xterm.js wrapper component for a single terminal
 */

import React, { useEffect, useRef, useCallback, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import {
  connectTerminal,
  TerminalServerMessage,
} from '../services/terminalService';
import { agentTerminalService } from '../services/agentTerminalService';

// Floor for accepting a fit: a hidden or not-yet-laid-out container yields
// absurd dimensions (a few cols), and resizing the pty to those garbles the
// shell's prompt reflow permanently into the scrollback buffer.
const MIN_FIT_COLS = 20;
const MIN_FIT_ROWS = 4;

interface TerminalInstanceProps {
  terminalId: string;
  isActive: boolean;
  onExit?: (code: number) => void;
  onInactive?: () => void;  // Called when another tab takes over
}

export const TerminalInstance: React.FC<TerminalInstanceProps> = ({
  terminalId,
  isActive,
  onExit,
  onInactive,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const isInitializedRef = useRef(false);
  const isActiveRef = useRef(isActive);
  // Last size we told the server, to drop no-op resizes. On (re)connect several
  // resize triggers fire (onopen, visibility, panel layout, window) with the
  // SAME dimensions; each one SIGWINCHes the pty and makes a full-screen TUI
  // (Claude/Codex) repaint, and that burst of redraws saturates the main-thread
  // VT parser — which is what stalls keystrokes for seconds after a refresh.
  const lastSentSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  // Connection status for the overlay badge: 'connecting' until the first server
  // message arrives, 'reconnecting' after a live drop. Clears the "feels hung"
  // blank screen on a fresh page load / reconnect.
  const [status, setStatus] = useState<'connecting' | 'ready' | 'reconnecting'>('connecting');

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
      // Scroll feel: default is 1 line per wheel notch (sluggish). Bump the
      // wheel step for scrollback, and give a deeper buffer to scroll through.
      // (Inside a TUI that grabs the mouse, wheel events go to the app instead;
      // Shift+scroll bypasses it to this local scrollback.)
      scrollback: 5000,
      scrollSensitivity: 3,
      fastScrollSensitivity: 8,
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
    // Clipboard: handle OSC 52 so TUIs (e.g. Claude Code) that copy on selection
    // reach the browser clipboard, and paste flows back in.
    terminal.loadAddon(new ClipboardAddon());

    // Open terminal in container
    terminal.open(containerRef.current);

    // GPU renderer — must load AFTER open(). The default DOM renderer saturates
    // the main thread under heavy output (build logs, agent redraws), which
    // stalls keystroke handling until the burst drains; WebGL moves rendering
    // off that hot path. Fall back to the DOM renderer if the GPU context is
    // lost or WebGL is unavailable.
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => { try { webgl.dispose(); } catch { /* already gone */ } });
      terminal.loadAddon(webgl);
    } catch { /* no WebGL — keep the DOM renderer */ }

    // Initial fit (skipped while the container is hidden or mid-layout — a
    // bogus tiny fit would garble the pty)
    setTimeout(() => {
      const d = fitAddon.proposeDimensions();
      if (d && d.cols >= MIN_FIT_COLS && d.rows >= MIN_FIT_ROWS) fitAddon.fit();
    }, 0);

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;
    isInitializedRef.current = true;

    let isUnmounting = false;  // Track if component is unmounting to suppress errors
    let processExited = false; // PTY gone — reconnecting would be pointless
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let isReconnect = false;   // Next replay follows a live reconnect → reset screen first

    const openSocket = () => {
      const ws = connectTerminal(terminalId);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isUnmounting) return;
        reconnectAttempt = 0;
        // Send initial size (deduped; floor-guarded against bogus tiny fits)
        const dimensions = fitAddon.proposeDimensions();
        const last = lastSentSizeRef.current;
        if (dimensions && dimensions.cols >= MIN_FIT_COLS && dimensions.rows >= MIN_FIT_ROWS &&
            (!last || last.cols !== dimensions.cols || last.rows !== dimensions.rows)) {
          lastSentSizeRef.current = { cols: dimensions.cols, rows: dimensions.rows };
          ws.send(JSON.stringify({
            type: 'resize',
            cols: dimensions.cols,
            rows: dimensions.rows,
          }));
        }
        // Expose a programmatic input path (used to inject agent prompts).
        // Distinct from terminal.onData, which is gated on user focus.
        agentTerminalService.registerSender(terminalId, (data: string) => {
          if (ws.readyState !== WebSocket.OPEN) return false;
          ws.send(JSON.stringify({ type: 'input', data }));
          return true;
        });
      };

      ws.onmessage = (event) => {
        if (isUnmounting) return;
        setStatus('ready'); // any server message means we're connected and receiving
        try {
          const message: TerminalServerMessage = JSON.parse(event.data);

          switch (message.type) {
            case 'replay':
              // After a live reconnect the screen already holds the old
              // content plus the "[Reconnecting…]" line; the replay buffer
              // re-sends it all, so start from a clean screen like a fresh
              // page load would.
              if (isReconnect) {
                isReconnect = false;
                terminal.reset();
              }
              // Render the replay at the PTY'S size: the buffered bytes were
              // produced for that width, and drawing them at the local
              // container's width garbles every wrap and prompt redraw.
              if (message.cols && message.rows &&
                  (terminal.cols !== message.cols || terminal.rows !== message.rows)) {
                terminal.resize(message.cols, message.rows);
                lastSentSizeRef.current = { cols: message.cols, rows: message.rows };
              }
              terminal.write(message.data, () => {
                // Replay parsed — now adopt the real container size in ONE
                // clean resize (deduped + floor-guarded in handleResize).
                handleResize();
              });
              break;

            case 'output':
              terminal.write(message.data);
              // Let the agent service verify a just-launched agent actually
              // started (watches for "command not found" etc.).
              agentTerminalService.observeOutput(terminalId, message.data);
              break;

            case 'exit':
              processExited = true;
              terminal.write(`\r\n\x1b[90m[Process exited with code ${message.code}]\x1b[0m\r\n`);
              agentTerminalService.unregisterSender(terminalId);
              onExit?.(message.code);
              break;

            case 'error':
              terminal.write(`\r\n\x1b[31m[Error: ${message.message}]\x1b[0m\r\n`);
              break;

            case 'inactive':
              terminal.write('\r\n\x1b[33m[Another tab is now controlling this terminal]\x1b[0m\r\n');
              onInactive?.();
              break;

            case 'active':
              // This tab is now active, nothing special to do
              break;
          }
        } catch (error) {
          console.error('[Terminal] Failed to parse message:', error);
        }
      };

      ws.onerror = (error) => {
        // Suppress errors during unmount (e.g., "closed before established")
        if (isUnmounting) return;
        console.error('[Terminal] WebSocket error:', error);
      };

      ws.onclose = (event) => {
        agentTerminalService.unregisterSender(terminalId);
        if (isUnmounting || processExited) return;
        // 4004 = server says this terminal id no longer exists (e.g. the
        // server restarted and PTYs died with it) — retrying can't help.
        if (event.code === 4004 || event.code === 4000) {
          terminal.write('\r\n\x1b[90m[Terminal session no longer exists — close and reopen the terminal]\x1b[0m\r\n');
          return;
        }
        // The PTY survives server-side (output is buffered) — reconnect with
        // backoff until the tab closes or the process exits. Announce only the
        // first drop to avoid spamming the scrollback on repeated attempts.
        setStatus('reconnecting');
        if (reconnectAttempt === 0) {
          terminal.write('\r\n\x1b[90m[Disconnected — reconnecting…]\x1b[0m\r\n');
        }
        isReconnect = true;
        const delay = Math.min(500 * 2 ** reconnectAttempt, 5000);
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(openSocket, delay);
      };
    };

    openSocket();

    // A dropped connection is usually a laptop sleep, tunnel blip, or tab
    // backgrounding — all of which resolve the moment the network or tab is
    // back. Rather than waiting out the exponential backoff (which feels
    // "stuck"), reconnect immediately on those signals and reset the backoff.
    const reconnectNow = () => {
      if (isUnmounting || processExited) return;
      const sock = wsRef.current;
      if (sock && (sock.readyState === WebSocket.OPEN || sock.readyState === WebSocket.CONNECTING)) return;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      reconnectAttempt = 0; // network is back — retry now and reset the backoff
      openSocket();
    };
    const onOnline = () => reconnectNow();
    const onVisible = () => { if (document.visibilityState === 'visible') reconnectNow(); };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);

    // Handle terminal input - only send if this terminal is active and focused
    terminal.onData((data) => {
      // Check both the active state and that the terminal actually has focus
      const ws = wsRef.current;
      const hasFocus = containerRef.current?.contains(document.activeElement);
      if (isActiveRef.current && hasFocus && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'input', data }));
      }
    });

    // Cleanup
    return () => {
      isUnmounting = true;  // Suppress error/close handlers
      if (reconnectTimer) clearTimeout(reconnectTimer);
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      agentTerminalService.unregisterSender(terminalId);
      const ws = wsRef.current;
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
      terminal.dispose();
      isInitializedRef.current = false;
    };
  }, [terminalId, onExit]);

  // Handle resize
  const handleResize = useCallback(() => {
    if (!fitAddonRef.current || !wsRef.current) return;

    // Propose BEFORE fitting: a hidden/mid-layout container yields bogus tiny
    // dimensions, and fitting to them garbles the local buffer and (if sent)
    // permanently garbles the pty's scrollback via the shell's prompt reflow.
    const dimensions = fitAddonRef.current.proposeDimensions();
    if (!dimensions || dimensions.cols < MIN_FIT_COLS || dimensions.rows < MIN_FIT_ROWS) return;
    fitAddonRef.current.fit();

    const last = lastSentSizeRef.current;
    const changed = !last || last.cols !== dimensions.cols || last.rows !== dimensions.rows;
    if (changed && wsRef.current.readyState === WebSocket.OPEN) {
      lastSentSizeRef.current = { cols: dimensions.cols, rows: dimensions.rows };
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
      const dtc = container.closest('[data-terminal-container]');
      if (dtc) {
        (dtc as any).__terminalResize = handleResize;
      }
    }
  }, [handleResize]);

  return (
    <div className={`relative h-full w-full ${isActive ? '' : 'hidden'}`}>
      <div
        ref={containerRef}
        className="h-full w-full"
        style={{ padding: '4px 8px' }}
      />
      {/* Pill only for the INITIAL connect, when the screen is blank. During a
          reconnect the last screen content stays visible and the terminal
          already shows an inline "[Disconnected — reconnecting…]" line —
          floating a spinner over real content would only hide information. */}
      {status === 'connecting' && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 pointer-events-none z-10">
          <div className="flex items-center gap-1.5 rounded-full bg-slate-800/90 text-slate-100 text-xs px-2.5 py-1 shadow-sm">
            <span className="inline-block w-3 h-3 border-2 border-slate-400 border-t-transparent rounded-full animate-spin" />
            Connecting…
          </div>
        </div>
      )}
    </div>
  );
};
