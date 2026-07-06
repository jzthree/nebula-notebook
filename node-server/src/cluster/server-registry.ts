/**
 * Server Registry
 *
 * Manages registration of peer servers in a Nebula cluster.
 * Peer servers can register with a main server to enable
 * cross-server kernel access.
 */

import type { ServerResources } from '../resources/resource-service';
import { readClusterSecret } from './cluster-secret';

export interface PeerServer {
  id: string;           // Unique server ID (usually hostname:port)
  host: string;         // Hostname or IP
  port: number;         // Port number
  name?: string;        // Optional display name
  url: string;          // Full URL (http://host:port)
  registeredAt: number; // Registration timestamp
  lastHeartbeat: number; // Last heartbeat timestamp
  status: 'online' | 'offline' | 'unknown';
  kernelspecs?: string[]; // Available kernels (cached)
  resources?: ServerResources; // System resources (RAM, GPU)
  allocationToken?: string; // Scheduler allocation token (correlates a job to its allocation)
  allocationId?: string;    // Scheduler allocation id (set by the allocation service)
}

export interface RegisterRequest {
  host: string;
  port: number;
  name?: string;
  secret?: string;
  resources?: ServerResources;
  allocationToken?: string;
}

const HEARTBEAT_TIMEOUT_MS = 90_000;  // 90s (3 missed heartbeats at 30s interval) -> mark offline
const OFFLINE_REAP_MS = 180_000;      // 3 min without a heartbeat -> remove from the list entirely
const CLEANUP_INTERVAL_MS = 30_000;   // Check for stale servers every 30s

class ServerRegistry {
  private servers: Map<string, PeerServer> = new Map();
  private clusterSecret: string | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private localServerId: string = 'local';

  constructor() {
    // Load initial cluster secret from environment or disk
    this.clusterSecret = process.env.NEBULA_CLUSTER_SECRET || readClusterSecret() || null;

    // Start cleanup interval
    this.startCleanupInterval();
  }

  /**
   * Set the local server's ID (called on startup)
   */
  setLocalServerId(id: string): void {
    this.localServerId = id;
  }

  /**
   * Get the local server's ID
   */
  getLocalServerId(): string {
    return this.localServerId;
  }

  /**
   * Validate registration secret
   */
  private getClusterSecret(): string | null {
    const envSecret = process.env.NEBULA_CLUSTER_SECRET;
    // If the env var is explicitly set (even to an empty string), treat it as the
    // source of truth. This allows users/tests to intentionally disable a disk secret
    // without relying on filesystem state.
    if (envSecret !== undefined) {
      this.clusterSecret = envSecret || null;
      return this.clusterSecret;
    }

    // Disk secret is cached defensively: if the file can't be read, don't clear an
    // existing secret to avoid accidentally dropping auth due to transient errors.
    const diskSecret = readClusterSecret() || null;
    if (diskSecret && diskSecret !== this.clusterSecret) {
      this.clusterSecret = diskSecret;
    }
    return this.clusterSecret;
  }

  private validateSecret(providedSecret?: string): boolean {
    const clusterSecret = this.getClusterSecret();
    // If no cluster secret configured, allow all registrations (dev mode)
    if (!clusterSecret) {
      return true;
    }
    return providedSecret === clusterSecret;
  }

  /**
   * Generate server ID from host and port
   */
  private generateServerId(host: string, port: number): string {
    return `${host}:${port}`;
  }

  /**
   * Register a peer server
   */
  register(request: RegisterRequest): { success: boolean; serverId?: string; error?: string } {
    // Validate secret
    if (!this.validateSecret(request.secret)) {
      return { success: false, error: 'Invalid cluster secret' };
    }

    const serverId = this.generateServerId(request.host, request.port);
    const now = Date.now();

    // Check if already registered
    const existing = this.servers.get(serverId);
    if (existing) {
      // Update existing registration
      existing.lastHeartbeat = now;
      existing.status = 'online';
      existing.name = request.name || existing.name;
      if (request.resources) {
        existing.resources = request.resources;
      }
      if (request.allocationToken) {
        existing.allocationToken = request.allocationToken;
      }
      console.log(`[ServerRegistry] Updated registration for ${serverId}`);
      return { success: true, serverId };
    }

    // New registration
    const server: PeerServer = {
      id: serverId,
      host: request.host,
      port: request.port,
      name: request.name,
      url: `http://${request.host}:${request.port}`,
      registeredAt: now,
      lastHeartbeat: now,
      status: 'online',
      resources: request.resources,
      allocationToken: request.allocationToken,
    };

    this.servers.set(serverId, server);
    console.log(`[ServerRegistry] Registered new server: ${serverId} (${request.name || 'unnamed'})`);

    return { success: true, serverId };
  }

  /**
   * Unregister a peer server
   */
  unregister(serverId: string): boolean {
    const removed = this.servers.delete(serverId);
    if (removed) {
      console.log(`[ServerRegistry] Unregistered server: ${serverId}`);
    }
    return removed;
  }

  /**
   * Record heartbeat from a peer server
   */
  heartbeat(serverId: string, resources?: ServerResources): boolean {
    const server = this.servers.get(serverId);
    if (!server) {
      return false;
    }
    server.lastHeartbeat = Date.now();
    server.status = 'online';
    if (resources) {
      server.resources = resources;
    }
    return true;
  }

  /**
   * Get a specific peer server
   */
  getServer(serverId: string): PeerServer | undefined {
    return this.servers.get(serverId);
  }

  /**
   * Get all registered peer servers
   */
  getAllServers(): PeerServer[] {
    return Array.from(this.servers.values());
  }

  /**
   * Find a registered server by its scheduler allocation token.
   * Used by the allocation service to correlate a job's registration.
   */
  getServerByAllocationToken(token: string): PeerServer | undefined {
    if (!token) return undefined;
    for (const server of this.servers.values()) {
      if (server.allocationToken === token) return server;
    }
    return undefined;
  }

  /**
   * Get all online peer servers
   */
  getOnlineServers(): PeerServer[] {
    return this.getAllServers().filter(s => s.status === 'online');
  }

  /**
   * Check server health and update status
   */
  private checkServerHealth(): void {
    const now = Date.now();
    for (const [id, server] of this.servers) {
      const stale = now - server.lastHeartbeat;
      // Reap long-gone servers so dead compute allocations / peers don't linger
      // in the list forever. A recovered server just re-registers and reappears.
      if (stale > OFFLINE_REAP_MS) {
        this.servers.delete(id);
        console.log(`[ServerRegistry] Server ${id} removed (offline for ${Math.round(stale / 1000)}s)`);
        continue;
      }
      if (stale > HEARTBEAT_TIMEOUT_MS && server.status === 'online') {
        console.log(`[ServerRegistry] Server ${server.id} marked offline (heartbeat timeout)`);
        server.status = 'offline';
      }
    }
  }

  /**
   * Start the cleanup interval
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cleanupInterval = setInterval(() => {
      this.checkServerHealth();
    }, CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop the cleanup interval (for shutdown)
   */
  shutdown(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Get cluster info for API response
   */
  getClusterInfo(localResources?: ServerResources): {
    localServerId: string;
    peerCount: number;
    onlineCount: number;
    servers: Array<{
      id: string;
      name?: string;
      url: string;
      status: string;
      isLocal: boolean;
      resources?: ServerResources;
    }>;
  } {
    const servers = this.getAllServers().map(s => ({
      id: s.id,
      name: s.name,
      url: s.url,
      status: s.status,
      isLocal: false,
      resources: s.resources,
    }));

    // Add local server at the beginning
    servers.unshift({
      id: this.localServerId,
      name: 'Local',
      url: '', // Local doesn't need URL
      status: 'online',
      isLocal: true,
      resources: localResources,
    });

    return {
      localServerId: this.localServerId,
      peerCount: this.servers.size,
      onlineCount: this.getOnlineServers().length,
      servers,
    };
  }
}

// Global singleton
export const serverRegistry = new ServerRegistry();
