/**
 * Terminal Service - Client for the terminal server
 *
 * Connects to the Node.js terminal server via /api/terminals endpoints.
 */
import { authService } from './authService';

// Terminal API is now part of the main API server
const TERMINAL_API_PREFIX = '/api';

// WebSocket URL uses the same host as the page
function getTerminalWsUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

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
  return (await getTerminalServerInfo()).available;
}

/**
 * Terminal server health + context: repo_root is the Nebula repo location on
 * the server, used to show a path-qualified MCP setup command.
 */
export async function getTerminalServerInfo(): Promise<{ available: boolean; repoRoot: string | null; hostname: string | null; port: number | null }> {
  try {
    const response = await fetch(`${TERMINAL_API_PREFIX}/terminals/health`);
    if (!response.ok) return { available: false, repoRoot: null, hostname: null, port: null };
    const data = await response.json().catch(() => ({}));
    return {
      available: true,
      repoRoot: typeof data.repo_root === 'string' ? data.repo_root : null,
      hostname: typeof data.hostname === 'string' ? data.hostname : null,
      port: typeof data.port === 'number' ? data.port : null,
    };
  } catch {
    return { available: false, repoRoot: null, hostname: null, port: null };
  }
}

/**
 * Is the user's reverse SSH channel (remote-agent mode) currently connected
 * on the server host? Probes 127.0.0.1:<port> server-side.
 */
export interface ReverseTunnelStatus {
  up: boolean;               // TCP listener accepted on the server host
  ssh: boolean | null;       // SSH banner seen (false = port up but no sshd — Remote Login off); null = unknown, treat as OK
}

export async function checkReverseTunnel(port: number): Promise<ReverseTunnelStatus> {
  try {
    const response = await fetch(`${TERMINAL_API_PREFIX}/terminals/reverse-check?port=${port}`);
    if (!response.ok) return { up: false, ssh: null };
    const data = await response.json().catch(() => ({}));
    return { up: data.up === true, ssh: typeof data.ssh === 'boolean' ? data.ssh : null };
  } catch {
    return { up: false, ssh: null };
  }
}

/**
 * Create a new terminal session
 */
export async function createTerminal(options?: CreateTerminalOptions): Promise<TerminalInfo> {
  const response = await fetch(`${TERMINAL_API_PREFIX}/terminals`, {
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
  const response = await fetch(`${TERMINAL_API_PREFIX}/terminals`);

  if (!response.ok) {
    throw new Error('Failed to list terminals');
  }

  return response.json();
}

/**
 * Get terminal info by ID
 */
export async function getTerminal(id: string): Promise<TerminalInfo | null> {
  const response = await fetch(`${TERMINAL_API_PREFIX}/terminals/${id}`);

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
  const response = await fetch(`${TERMINAL_API_PREFIX}/terminals/${id}`, {
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
  const response = await fetch(`${TERMINAL_API_PREFIX}/terminals/${id}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  });

  if (!response.ok) {
    throw new Error('Failed to resize terminal');
  }
}

/**
 * Get or create a named terminal (persistent terminals accessible by URL)
 */
export async function getOrCreateNamedTerminal(
  name: string,
  options?: CreateTerminalOptions
): Promise<TerminalInfo> {
  const response = await fetch(`${TERMINAL_API_PREFIX}/terminals/named/${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options || {}),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || 'Failed to get/create named terminal');
  }

  return response.json();
}

/**
 * Connect to a terminal via WebSocket
 */
export function connectTerminal(id: string): WebSocket {
  const baseUrl = `${getTerminalWsUrl()}/ws?id=${id}`;
  const wsUrl = authService.getAuthenticatedWebSocketUrl(baseUrl);
  return new WebSocket(wsUrl);
}

/**
 * Terminal WebSocket message types
 */
export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export type TerminalServerMessage =
  | { type: 'output'; data: string }
  // cols/rows = the pty's current size; render the replay at that size so
  // wraps land where they were produced.
  | { type: 'replay'; data: string; cols?: number; rows?: number }
  | { type: 'exit'; code: number }
  | { type: 'error'; message: string }
  | { type: 'inactive' }  // Another tab took over this terminal
  | { type: 'active' };   // This tab is now the active one
