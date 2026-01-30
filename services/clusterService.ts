/**
 * Cluster Service
 *
 * Handles communication with the cluster management API
 * for multi-server kernel support.
 */

import { API_BASE } from './kernelService';
import { authService } from './authService';

export interface ClusterServer {
  id: string;
  name: string;
  url: string;
  status: 'online' | 'offline';
  isLocal: boolean;
  registeredAt?: number;
  lastHeartbeat?: number;
}

export interface ClusterInfo {
  localServerId: string;
  servers: ClusterServer[];
}

/**
 * Get list of all servers in the cluster
 */
export async function getClusterInfo(): Promise<ClusterInfo> {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/servers`, { headers });

  if (!response.ok) {
    throw new Error(`Failed to get cluster info: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Get a specific server by ID
 */
export async function getServer(serverId: string): Promise<ClusterServer> {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/servers/${encodeURIComponent(serverId)}`, { headers });

  if (!response.ok) {
    throw new Error(`Failed to get server: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Register a new server with the cluster
 */
export async function registerServer(
  host: string,
  port: number,
  name?: string,
  secret?: string
): Promise<{ registered: boolean; serverId: string }> {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/servers/register`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ host, port, name, secret }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to register server: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Unregister a server from the cluster
 */
export async function unregisterServer(serverId: string, secret?: string): Promise<void> {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/servers/${encodeURIComponent(serverId)}`, {
    method: 'DELETE',
    headers,
    body: JSON.stringify({ secret }),
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `Failed to unregister server: ${response.statusText}`);
  }
}
