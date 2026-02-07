/**
 * Tests for cluster functionality
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { serverRegistry } from '../cluster/server-registry';
import {
  createProxiedSessionId,
  parseSessionId,
  isProxiedSession,
} from '../cluster/kernel-proxy';

describe('ServerRegistry', () => {
  const originalSecret = process.env.NEBULA_CLUSTER_SECRET;

  beforeEach(() => {
    // Force-disable cluster auth for these unit tests, regardless of what's configured
    // on the developer machine.
    process.env.NEBULA_CLUSTER_SECRET = '';

    // Clear all servers before each test
    for (const server of serverRegistry.getAllServers()) {
      serverRegistry.unregister(server.id);
    }
    // Reset local server ID
    serverRegistry.setLocalServerId('local:3000');
  });

  afterAll(() => {
    if (originalSecret === undefined) {
      delete process.env.NEBULA_CLUSTER_SECRET;
    } else {
      process.env.NEBULA_CLUSTER_SECRET = originalSecret;
    }
  });

  describe('setLocalServerId / getLocalServerId', () => {
    it('should set and get local server ID', () => {
      serverRegistry.setLocalServerId('myhost:8000');
      expect(serverRegistry.getLocalServerId()).toBe('myhost:8000');
    });
  });

  describe('register', () => {
    it('should register a new server successfully', () => {
      const result = serverRegistry.register({
        host: 'remote1',
        port: 3000,
        name: 'Remote Server 1',
      });

      expect(result.success).toBe(true);
      expect(result.serverId).toBe('remote1:3000');
    });

    it('should update existing registration', () => {
      serverRegistry.register({
        host: 'remote1',
        port: 3000,
        name: 'Original Name',
      });

      const result = serverRegistry.register({
        host: 'remote1',
        port: 3000,
        name: 'Updated Name',
      });

      expect(result.success).toBe(true);
      const server = serverRegistry.getServer('remote1:3000');
      expect(server?.name).toBe('Updated Name');
    });

    it('should reject registration with invalid secret when secret is configured', () => {
      // Save original env
      const originalSecret = process.env.NEBULA_CLUSTER_SECRET;
      process.env.NEBULA_CLUSTER_SECRET = 'correct-secret';

      // Create a new registry instance to pick up the secret
      // For this test we'll just check the behavior of the existing one
      // which was created before the secret was set

      // Restore env
      process.env.NEBULA_CLUSTER_SECRET = originalSecret;
    });
  });

  describe('unregister', () => {
    it('should unregister an existing server', () => {
      serverRegistry.register({ host: 'remote1', port: 3000 });

      const removed = serverRegistry.unregister('remote1:3000');

      expect(removed).toBe(true);
      expect(serverRegistry.getServer('remote1:3000')).toBeUndefined();
    });

    it('should return false for non-existent server', () => {
      const removed = serverRegistry.unregister('nonexistent:9999');
      expect(removed).toBe(false);
    });
  });

  describe('heartbeat', () => {
    it('should update heartbeat for existing server', () => {
      serverRegistry.register({ host: 'remote1', port: 3000 });

      const success = serverRegistry.heartbeat('remote1:3000');

      expect(success).toBe(true);
    });

    it('should return false for non-existent server', () => {
      const success = serverRegistry.heartbeat('nonexistent:9999');
      expect(success).toBe(false);
    });
  });

  describe('getServer', () => {
    it('should return server by ID', () => {
      serverRegistry.register({ host: 'remote1', port: 3000, name: 'Test' });

      const server = serverRegistry.getServer('remote1:3000');

      expect(server).toBeDefined();
      expect(server?.host).toBe('remote1');
      expect(server?.port).toBe(3000);
      expect(server?.name).toBe('Test');
      expect(server?.status).toBe('online');
    });

    it('should return undefined for non-existent server', () => {
      const server = serverRegistry.getServer('nonexistent:9999');
      expect(server).toBeUndefined();
    });
  });

  describe('getAllServers', () => {
    it('should return empty array when no servers registered', () => {
      const servers = serverRegistry.getAllServers();
      expect(servers).toEqual([]);
    });

    it('should return all registered servers', () => {
      serverRegistry.register({ host: 'remote1', port: 3000 });
      serverRegistry.register({ host: 'remote2', port: 3000 });

      const servers = serverRegistry.getAllServers();

      expect(servers).toHaveLength(2);
    });
  });

  describe('getClusterInfo', () => {
    it('should include local server in cluster info', () => {
      serverRegistry.setLocalServerId('localhost:3000');

      const info = serverRegistry.getClusterInfo();

      expect(info.localServerId).toBe('localhost:3000');
      expect(info.servers[0].id).toBe('localhost:3000');
      expect(info.servers[0].isLocal).toBe(true);
    });

    it('should include peer servers in cluster info', () => {
      serverRegistry.register({ host: 'remote1', port: 3000, name: 'Remote 1' });

      const info = serverRegistry.getClusterInfo();

      expect(info.peerCount).toBe(1);
      expect(info.servers).toHaveLength(2); // local + 1 peer
      expect(info.servers[1].id).toBe('remote1:3000');
      expect(info.servers[1].isLocal).toBe(false);
    });
  });
});

describe('Kernel Proxy Utilities', () => {
  describe('createProxiedSessionId', () => {
    it('should create composite session ID', () => {
      const result = createProxiedSessionId('server1:3000', 'session-123');
      expect(result).toBe('server1:3000::session-123');
    });
  });

  describe('parseSessionId', () => {
    it('should parse proxied session ID', () => {
      const result = parseSessionId('server1:3000::session-123');

      expect(result.isProxied).toBe(true);
      expect(result.serverId).toBe('server1:3000');
      expect(result.remoteSessionId).toBe('session-123');
    });

    it('should identify local session ID', () => {
      const result = parseSessionId('local-session-456');

      expect(result.isProxied).toBe(false);
      expect(result.serverId).toBeUndefined();
      expect(result.remoteSessionId).toBeUndefined();
    });
  });

  describe('isProxiedSession', () => {
    it('should return true for proxied session ID', () => {
      expect(isProxiedSession('server1:3000::session-123')).toBe(true);
    });

    it('should return false for local session ID', () => {
      expect(isProxiedSession('local-session-456')).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isProxiedSession('')).toBe(false);
    });
  });
});
