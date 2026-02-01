/**
 * Client Registration
 *
 * Handles auto-registration with a main server when this server
 * is started as a client/peer in a cluster.
 */

import { serverRegistry } from './server-registry';
import { getResourceService } from '../resources/resource-service';
import * as os from 'os';

interface RegistrationConfig {
  mainServerUrl: string;
  localHost: string;
  localPort: number;
  serverName?: string;
  secret?: string;
}

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds
const REGISTRATION_RETRY_MS = 10_000; // 10 seconds retry on failure

class ClientRegistration {
  private config: RegistrationConfig | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private registrationRetryTimeout: NodeJS.Timeout | null = null;
  private registered: boolean = false;
  private serverId: string | null = null;

  /**
   * Initialize client registration from environment variables
   */
  initFromEnv(localPort: number): void {
    const mainServerUrl = process.env.NEBULA_MAIN_SERVER;
    if (!mainServerUrl) {
      console.log('[ClientRegistration] No NEBULA_MAIN_SERVER set, running as standalone');
      return;
    }

    const localHost = process.env.NEBULA_HOST || os.hostname();
    const serverName = process.env.NEBULA_SERVER_NAME || localHost;
    const secret = process.env.NEBULA_CLUSTER_SECRET;

    this.config = {
      mainServerUrl: mainServerUrl.replace(/\/$/, ''), // Remove trailing slash
      localHost,
      localPort,
      serverName,
      secret,
    };

    // Set local server ID
    const serverId = `${localHost}:${localPort}`;
    serverRegistry.setLocalServerId(serverId);

    console.log(`[ClientRegistration] Will register with main server: ${mainServerUrl}`);
    console.log(`[ClientRegistration] Local server ID: ${serverId}`);

    // Start registration
    this.register();
  }

  /**
   * Register with the main server
   */
  private async register(): Promise<void> {
    if (!this.config) return;

    try {
      const response = await fetch(`${this.config.mainServerUrl}/api/servers/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          host: this.config.localHost,
          port: this.config.localPort,
          name: this.config.serverName,
          secret: this.config.secret,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({ error: 'Unknown error' })) as { error?: string };
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const result = await response.json() as { serverId: string };
      this.serverId = result.serverId;
      this.registered = true;

      console.log(`[ClientRegistration] Successfully registered as ${this.serverId}`);

      // Start heartbeat
      this.startHeartbeat();

    } catch (error) {
      console.error(`[ClientRegistration] Registration failed:`, error);
      console.log(`[ClientRegistration] Retrying in ${REGISTRATION_RETRY_MS / 1000}s...`);

      // Retry registration
      this.registrationRetryTimeout = setTimeout(() => {
        this.register();
      }, REGISTRATION_RETRY_MS);
    }
  }

  /**
   * Start heartbeat interval
   */
  private startHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
    }

    this.heartbeatInterval = setInterval(async () => {
      await this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Send heartbeat to main server
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.config || !this.serverId) return;

    try {
      // Get resources (cached, never blocks)
      const resourceService = getResourceService();
      const resources = resourceService.getResources();

      const response = await fetch(
        `${this.config.mainServerUrl}/api/servers/${encodeURIComponent(this.serverId)}/heartbeat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ resources }),
        }
      );

      if (!response.ok) {
        // If server not found, try to re-register
        if (response.status === 404) {
          console.log('[ClientRegistration] Server not found on main, re-registering...');
          this.registered = false;
          this.register();
        }
      }
    } catch (error) {
      console.error('[ClientRegistration] Heartbeat failed:', error);
    }
  }

  /**
   * Unregister from main server (called on shutdown)
   */
  async shutdown(): Promise<void> {
    // Clear intervals
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.registrationRetryTimeout) {
      clearTimeout(this.registrationRetryTimeout);
      this.registrationRetryTimeout = null;
    }

    // Unregister from main server
    if (this.config && this.serverId && this.registered) {
      try {
        await fetch(
          `${this.config.mainServerUrl}/api/servers/${encodeURIComponent(this.serverId)}`,
          {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ secret: this.config.secret }),
          }
        );
        console.log('[ClientRegistration] Unregistered from main server');
      } catch (error) {
        console.error('[ClientRegistration] Failed to unregister:', error);
      }
    }
  }

  /**
   * Check if we're running as a client (registered with main server)
   */
  isClient(): boolean {
    return this.config !== null;
  }

  /**
   * Get main server URL (if we're a client)
   */
  getMainServerUrl(): string | null {
    return this.config?.mainServerUrl || null;
  }
}

// Global singleton
export const clientRegistration = new ClientRegistration();
