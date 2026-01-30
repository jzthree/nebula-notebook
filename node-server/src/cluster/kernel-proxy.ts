/**
 * Kernel Proxy
 *
 * Handles proxying kernel operations to peer servers in a cluster.
 * When a kernel is started on a remote server, this module manages
 * the communication between the client and the remote kernel.
 */

import { WebSocket } from 'ws';
import { serverRegistry, PeerServer } from './server-registry';

// Track proxied kernel sessions: sessionId -> { serverId, remoteSessionId, ws }
interface ProxiedSession {
  serverId: string;        // Which server owns this kernel
  remoteSessionId: string; // Session ID on the remote server
  remoteWs?: WebSocket;    // WebSocket connection to remote server
  localWs?: WebSocket;     // Client's WebSocket
}

const proxiedSessions: Map<string, ProxiedSession> = new Map();

/**
 * Create a composite session ID that encodes the server
 */
export function createProxiedSessionId(serverId: string, remoteSessionId: string): string {
  return `${serverId}::${remoteSessionId}`;
}

/**
 * Parse a composite session ID
 */
export function parseSessionId(sessionId: string): { isProxied: boolean; serverId?: string; remoteSessionId?: string } {
  if (sessionId.includes('::')) {
    const [serverId, remoteSessionId] = sessionId.split('::', 2);
    return { isProxied: true, serverId, remoteSessionId };
  }
  return { isProxied: false };
}

/**
 * Check if a session ID is for a proxied (remote) kernel
 */
export function isProxiedSession(sessionId: string): boolean {
  return sessionId.includes('::');
}

/**
 * Get the server for a session
 */
export function getSessionServer(sessionId: string): PeerServer | null {
  const { isProxied, serverId } = parseSessionId(sessionId);
  if (!isProxied || !serverId) return null;
  return serverRegistry.getServer(serverId) || null;
}

/**
 * Start a kernel on a remote server
 */
export async function startRemoteKernel(
  serverId: string,
  kernelName: string,
  filePath?: string
): Promise<{ sessionId: string }> {
  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  if (server.status !== 'online') {
    throw new Error(`Server is offline: ${serverId}`);
  }

  // Call the remote server's kernel start endpoint
  const endpoint = filePath
    ? `${server.url}/api/kernels/for-file`
    : `${server.url}/api/kernels/start`;

  const body = filePath
    ? { file_path: filePath, kernel_name: kernelName }
    : { kernel_name: kernelName };

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || `Failed to start kernel on ${serverId}`);
  }

  const result = await response.json() as { session_id: string };
  const remoteSessionId = result.session_id;

  // Create composite session ID
  const proxySessionId = createProxiedSessionId(serverId, remoteSessionId);

  // Track the proxied session
  proxiedSessions.set(proxySessionId, {
    serverId,
    remoteSessionId,
  });

  console.log(`[KernelProxy] Started kernel on ${serverId}, session: ${proxySessionId}`);

  return { sessionId: proxySessionId };
}

/**
 * Interrupt a kernel on a remote server
 */
export async function interruptRemoteKernel(sessionId: string): Promise<void> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/${remoteSessionId}/interrupt`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to interrupt kernel');
  }
}

/**
 * Restart a kernel on a remote server
 */
export async function restartRemoteKernel(sessionId: string): Promise<void> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/${remoteSessionId}/restart`, {
    method: 'POST',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to restart kernel');
  }
}

/**
 * Get status of a kernel on a remote server
 */
export async function getRemoteKernelStatus(sessionId: string): Promise<{
  status: string;
  execution_count?: number;
  memory_mb?: number;
}> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/${remoteSessionId}/status`);

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to get kernel status');
  }

  return response.json() as Promise<{ status: string; execution_count?: number; memory_mb?: number }>;
}

/**
 * Shutdown a kernel on a remote server
 */
export async function shutdownRemoteKernel(sessionId: string): Promise<void> {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    throw new Error('Invalid proxied session ID');
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    throw new Error(`Server not found: ${serverId}`);
  }

  const response = await fetch(`${server.url}/api/kernels/${remoteSessionId}`, {
    method: 'DELETE',
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: 'Unknown error' })) as { detail?: string };
    throw new Error(error.detail || 'Failed to shutdown kernel');
  }

  // Clean up proxied session
  proxiedSessions.delete(sessionId);
}

/**
 * Create a WebSocket proxy to a remote kernel
 */
export function createWebSocketProxy(
  sessionId: string,
  clientWs: WebSocket
): WebSocket | null {
  const { serverId, remoteSessionId } = parseSessionId(sessionId);
  if (!serverId || !remoteSessionId) {
    return null;
  }

  const server = serverRegistry.getServer(serverId);
  if (!server) {
    console.error(`[KernelProxy] Server not found for WebSocket proxy: ${serverId}`);
    return null;
  }

  // Create WebSocket URL for remote server
  const wsUrl = server.url.replace(/^http/, 'ws') + `/api/kernels/${remoteSessionId}/ws`;

  console.log(`[KernelProxy] Creating WebSocket proxy to ${wsUrl}`);

  const remoteWs = new WebSocket(wsUrl);

  // Forward messages from remote to client
  remoteWs.on('message', (data) => {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(data);
    }
  });

  // Forward messages from client to remote
  clientWs.on('message', (data) => {
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.send(data);
    }
  });

  // Handle remote close
  remoteWs.on('close', () => {
    console.log(`[KernelProxy] Remote WebSocket closed for ${sessionId}`);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.close();
    }
  });

  // Handle client close
  clientWs.on('close', () => {
    console.log(`[KernelProxy] Client WebSocket closed for ${sessionId}`);
    if (remoteWs.readyState === WebSocket.OPEN) {
      remoteWs.close();
    }
  });

  // Handle errors
  remoteWs.on('error', (err) => {
    console.error(`[KernelProxy] Remote WebSocket error for ${sessionId}:`, err);
  });

  // Track the proxy
  const session = proxiedSessions.get(sessionId);
  if (session) {
    session.remoteWs = remoteWs;
    session.localWs = clientWs;
  }

  return remoteWs;
}

/**
 * Get all proxied sessions
 */
export function getProxiedSessions(): Map<string, ProxiedSession> {
  return proxiedSessions;
}

/**
 * Cleanup all proxied sessions
 */
export function cleanupProxiedSessions(): void {
  for (const [sessionId, session] of proxiedSessions.entries()) {
    if (session.remoteWs) {
      session.remoteWs.close();
    }
    if (session.localWs) {
      session.localWs.close();
    }
    proxiedSessions.delete(sessionId);
  }
}
