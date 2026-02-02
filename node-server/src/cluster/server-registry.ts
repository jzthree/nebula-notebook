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
}

export interface RegisterRequest {
  host: string;
  port: number;
  name?: string;
  secret?: string;
  resources?: ServerResources;
}

const HEARTBEAT_TIMEOUT_MS = 90_000; // 90 seconds (3 missed heartbeats at 30s interval)
const CLEANUP_INTERVAL_MS = 30_000;  // Check for stale servers every 30s

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
    const secret = process.env.NEBULA_CLUSTER_SECRET || readClusterSecret() || null;
    if (secret && secret !== this.clusterSecret) {
      this.clusterSecret = secret;
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
    for (const server of this.servers.values()) {
      if (now - server.lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        if (server.status === 'online') {
          console.log(`[ServerRegistry] Server ${server.id} marked offline (heartbeat timeout)`);
          server.status = 'offline';
        }
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
