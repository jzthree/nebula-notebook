/**
 * Resource Service
 *
 * Handles fetching system resource information (RAM, GPU)
 * from the local server.
 */

import { API_BASE } from './kernelService';
import { authService } from './authService';
import type { ServerResources } from './clusterService';

export type { ServerResources, RAMInfo, GPUInfo, GPUDevice } from './clusterService';

/**
 * Get local server resources (cached, never blocks)
 */
export async function getResources(): Promise<ServerResources> {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/resources`, { headers });

  if (!response.ok) {
    throw new Error(`Failed to get resources: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Force refresh resources (use sparingly)
 */
export async function refreshResources(): Promise<ServerResources> {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/resources/refresh`, {
    method: 'POST',
    headers,
  });

  if (!response.ok) {
    throw new Error(`Failed to refresh resources: ${response.statusText}`);
  }

  return response.json();
}

/**
 * Format memory size for display
 */
export function formatMemory(gb: number): string {
  if (gb >= 1) {
    return `${gb.toFixed(1)} GB`;
  }
  return `${(gb * 1024).toFixed(0)} MB`;
}

/**
 * Format memory usage as percentage
 */
export function formatMemoryPercent(used: number, total: number): string {
  if (total === 0) return '0%';
  return `${((used / total) * 100).toFixed(0)}%`;
}

/**
 * Get color class based on memory usage percentage
 */
export function getMemoryColor(used: number, total: number): 'normal' | 'warning' | 'critical' {
  if (total === 0) return 'normal';
  const percent = (used / total) * 100;
  if (percent >= 90) return 'critical';
  if (percent >= 75) return 'warning';
  return 'normal';
}
