/**
 * PTY Manager - Manages terminal sessions using node-pty
 */

import * as pty from '@homebridge/node-pty-prebuilt-multiarch';
import { v4 as uuidv4 } from 'uuid';
import {
  TerminalInfo,
  OUTPUT_BUFFER_MAX_SIZE,
  OUTPUT_BUFFER_TRIM_SIZE
} from './types';

interface TerminalSession {
  id: string;
  pty: pty.IPty;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  created: number;
  lastActivity: number;
  outputBuffer: string;
  onData: ((data: string) => void) | null;
  onExit: ((code: number) => void) | null;
}

export class PtyManager {
  private sessions: Map<string, TerminalSession> = new Map();

  /**
   * Get the default shell for the current platform
   */
  private getDefaultShell(): string {
    if (process.platform === 'win32') {
      return process.env.COMSPEC || 'cmd.exe';
    }
    return process.env.SHELL || '/bin/bash';
  }

  /**
   * Create a new terminal session
   */
  create(options?: {
    cwd?: string;
    shell?: string;
    cols?: number;
    rows?: number;
  }): TerminalInfo {
    const id = uuidv4();
    const shell = options?.shell || this.getDefaultShell();
    const cwd = options?.cwd || process.env.HOME || process.cwd();
    const cols = options?.cols || 80;
    const rows = options?.rows || 24;

    // Spawn PTY process
    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      } as { [key: string]: string },
    });

    const session: TerminalSession = {
      id,
      pty: ptyProcess,
      cwd,
      shell,
      cols,
      rows,
      created: Date.now(),
      lastActivity: Date.now(),
      outputBuffer: '',
      onData: null,
      onExit: null,
    };

    // Handle PTY output
    ptyProcess.onData((data: string) => {
      session.lastActivity = Date.now();

      // Append to output buffer for reconnection
      session.outputBuffer += data;

      // Trim buffer if too large
      if (session.outputBuffer.length > OUTPUT_BUFFER_MAX_SIZE) {
        session.outputBuffer = session.outputBuffer.slice(-OUTPUT_BUFFER_TRIM_SIZE);
      }

      // Forward to listener if connected
      if (session.onData) {
        session.onData(data);
      }
    });

    // Handle PTY exit
    ptyProcess.onExit(({ exitCode }) => {
      if (session.onExit) {
        session.onExit(exitCode);
      }
      this.sessions.delete(id);
    });

    this.sessions.set(id, session);

    return this.getInfo(session);
  }

  /**
   * Get terminal info from session
   */
  private getInfo(session: TerminalSession): TerminalInfo {
    return {
      id: session.id,
      pid: session.pty.pid,
      cwd: session.cwd,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      created: session.created,
      lastActivity: session.lastActivity,
    };
  }

  /**
   * Get a terminal session by ID
   */
  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  /**
   * Get terminal info by ID
   */
  getTerminalInfo(id: string): TerminalInfo | undefined {
    const session = this.sessions.get(id);
    return session ? this.getInfo(session) : undefined;
  }

  /**
   * List all active terminals
   */
  list(): TerminalInfo[] {
    return Array.from(this.sessions.values()).map((s) => this.getInfo(s));
  }

  /**
   * Write data to a terminal
   */
  write(id: string, data: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.pty.write(data);
    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Resize a terminal
   */
  resize(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.pty.resize(cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.lastActivity = Date.now();
    return true;
  }

  /**
   * Kill a terminal session
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.pty.kill();
    this.sessions.delete(id);
    return true;
  }

  /**
   * Set data listener for a terminal (for WebSocket connection)
   */
  setOnData(id: string, callback: ((data: string) => void) | null): void {
    const session = this.sessions.get(id);
    if (session) {
      session.onData = callback;
    }
  }

  /**
   * Set exit listener for a terminal
   */
  setOnExit(id: string, callback: ((code: number) => void) | null): void {
    const session = this.sessions.get(id);
    if (session) {
      session.onExit = callback;
    }
  }

  /**
   * Get buffered output for reconnection
   */
  getOutputBuffer(id: string): string {
    const session = this.sessions.get(id);
    return session?.outputBuffer || '';
  }

  /**
   * Kill all terminal sessions (for cleanup)
   */
  killAll(): void {
    for (const [id] of this.sessions) {
      this.kill(id);
    }
  }
}

// Singleton instance
export const ptyManager = new PtyManager();
