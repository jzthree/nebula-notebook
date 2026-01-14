/**
 * Terminal Service - Client for the terminal server
 */

const TERMINAL_SERVER_URL = 'http://localhost:3001';
const TERMINAL_WS_URL = 'ws://localhost:3001';

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

export interface CreateTerminalOptions {
  cwd?: string;
  shell?: string;
  cols?: number;
  rows?: number;
}

/**
 * Check if the terminal server is available
 */
export async function checkTerminalServer(): Promise<boolean> {
  try {
    const response = await fetch(`${TERMINAL_SERVER_URL}/api/health`);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Create a new terminal session
 */
export async function createTerminal(options?: CreateTerminalOptions): Promise<TerminalInfo> {
  const response = await fetch(`${TERMINAL_SERVER_URL}/api/terminals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options || {}),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to create terminal');
  }

  return response.json();
}

/**
 * List all active terminals
 */
export async function listTerminals(): Promise<TerminalInfo[]> {
  const response = await fetch(`${TERMINAL_SERVER_URL}/api/terminals`);

  if (!response.ok) {
    throw new Error('Failed to list terminals');
  }

  return response.json();
}

/**
 * Get terminal info by ID
 */
export async function getTerminal(id: string): Promise<TerminalInfo | null> {
  const response = await fetch(`${TERMINAL_SERVER_URL}/api/terminals/${id}`);

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error('Failed to get terminal');
  }

  return response.json();
}

/**
 * Close a terminal session
 */
export async function closeTerminal(id: string): Promise<void> {
  const response = await fetch(`${TERMINAL_SERVER_URL}/api/terminals/${id}`, {
    method: 'DELETE',
  });

  if (!response.ok && response.status !== 404) {
    throw new Error('Failed to close terminal');
  }
}

/**
 * Resize a terminal
 */
export async function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  const response = await fetch(`${TERMINAL_SERVER_URL}/api/terminals/${id}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  });

  if (!response.ok) {
    throw new Error('Failed to resize terminal');
  }
}

/**
 * Connect to a terminal via WebSocket
 */
export function connectTerminal(id: string): WebSocket {
  return new WebSocket(`${TERMINAL_WS_URL}/ws?id=${id}`);
}

/**
 * Terminal WebSocket message types
 */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: 'output'; data: string }
  | { type: 'replay'; data: string }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string };
