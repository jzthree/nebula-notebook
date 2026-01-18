/**
 * Terminal Server Types
 */

export interface TerminalInfo {
  id: string;
  pid: number;
  cwd: string;
  shell: string;
  cols: number;
  rows: number;
  created: number;
  lastActivity: number;
}

export interface CreateTerminalRequest {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

export interface ResizeTerminalRequest {
  cols: number;
  rows: number;
}

// WebSocket message types
export type ClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type ServerMessage =
  | { type: 'output'; data: string }
  | { type: 'replay'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };

// Output buffer settings
export const OUTPUT_BUFFER_MAX_SIZE = 100000; // ~100KB of scrollback
export const OUTPUT_BUFFER_TRIM_SIZE = 50000; // Trim to ~50KB when exceeded
