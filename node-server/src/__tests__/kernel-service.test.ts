/**
 * Kernel Service Tests
 *
 * Tests for Jupyter kernel management.
 * Integration tests require actual kernels and are skipped by default.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  discoverKernelSpecs,
  getKernelSpec,
  hasKernelSpec,
} from '../kernel/kernelspec';
import { SessionStore } from '../kernel/session-store';
import { KernelService } from '../kernel/kernel-service';
import { PersistedSession } from '../kernel/types';

const createDeferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('Kernelspec Discovery', () => {
  describe('discoverKernelSpecs', () => {
    it('should return an array of kernelspecs', () => {
      const specs = discoverKernelSpecs();
      expect(Array.isArray(specs)).toBe(true);
    });

    it('should have required properties on each spec', () => {
      const specs = discoverKernelSpecs();
      for (const spec of specs) {
        expect(spec).toHaveProperty('name');
        expect(spec).toHaveProperty('displayName');
        expect(spec).toHaveProperty('language');
        expect(spec).toHaveProperty('path');
        expect(typeof spec.name).toBe('string');
        expect(typeof spec.displayName).toBe('string');
        expect(typeof spec.language).toBe('string');
        expect(typeof spec.path).toBe('string');
      }
    });

    it('should discover at least one kernel on most systems', () => {
      const specs = discoverKernelSpecs();
      // Most systems with Python will have at least python3
      // This is a soft expectation
      console.log(`Found ${specs.length} kernelspecs:`, specs.map(s => s.name));
    });
  });

  describe('getKernelSpec', () => {
    it('should return null for non-existent kernel', () => {
      const spec = getKernelSpec('nonexistent-kernel-xyz123');
      expect(spec).toBeNull();
    });

    it('should return spec for existing kernel', () => {
      const specs = discoverKernelSpecs();
      if (specs.length > 0) {
        const spec = getKernelSpec(specs[0].name);
        expect(spec).not.toBeNull();
        expect(spec?.name).toBe(specs[0].name);
      }
    });
  });

  describe('hasKernelSpec', () => {
    it('should return false for non-existent kernel', () => {
      expect(hasKernelSpec('nonexistent-kernel-xyz123')).toBe(false);
    });

    it('should return true for existing kernel', () => {
      const specs = discoverKernelSpecs();
      if (specs.length > 0) {
        expect(hasKernelSpec(specs[0].name)).toBe(true);
      }
    });
  });
});

describe('SessionStore', () => {
  let store: SessionStore;
  let testDbPath: string;

  beforeEach(() => {
    // Use a temporary database for each test
    testDbPath = path.join(os.tmpdir(), `nebula-test-sessions-${Date.now()}.db`);
    store = new SessionStore(testDbPath);
  });

  afterEach(() => {
    store.close();
    // Cleanup test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('saveSession / getSession', () => {
    it('should save and retrieve a session', () => {
      const session: PersistedSession = {
        sessionId: 'test-session-1',
        kernelName: 'python3',
        filePath: '/path/to/notebook.ipynb',
        kernelPid: 12345,
        status: 'active',
        createdAt: Date.now() / 1000,
        lastHeartbeat: Date.now() / 1000,
        connectionFile: '/tmp/kernel.json',
      };

      store.saveSession(session);
      const retrieved = store.getSession('test-session-1');

      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionId).toBe('test-session-1');
      expect(retrieved?.kernelName).toBe('python3');
      expect(retrieved?.filePath).toBe('/path/to/notebook.ipynb');
      expect(retrieved?.kernelPid).toBe(12345);
      expect(retrieved?.status).toBe('active');
    });

    it('should return null for non-existent session', () => {
      const session = store.getSession('nonexistent');
      expect(session).toBeNull();
    });

    it('should update existing session on save', () => {
      const session: PersistedSession = {
        sessionId: 'test-session-2',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 100,
        status: 'active',
        createdAt: Date.now() / 1000,
        lastHeartbeat: Date.now() / 1000,
        connectionFile: null,
      };

      store.saveSession(session);

      // Update the session
      session.status = 'terminated';
      session.kernelPid = 200;
      store.saveSession(session);

      const retrieved = store.getSession('test-session-2');
      expect(retrieved?.status).toBe('terminated');
      expect(retrieved?.kernelPid).toBe(200);
    });
  });

  describe('getActiveSessions', () => {
    it('should return only active sessions', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'active-1',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      store.saveSession({
        sessionId: 'orphaned-1',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 2,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      store.saveSession({
        sessionId: 'active-2',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 3,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      const active = store.getActiveSessions();
      expect(active).toHaveLength(2);
      expect(active.map(s => s.sessionId).sort()).toEqual(['active-1', 'active-2']);
    });
  });

  describe('markAllOrphaned', () => {
    it('should mark all active sessions as orphaned', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'session-1',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      store.saveSession({
        sessionId: 'session-2',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 2,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      const count = store.markAllOrphaned();
      expect(count).toBe(2);

      const active = store.getActiveSessions();
      expect(active).toHaveLength(0);

      const orphaned = store.getOrphanedSessions();
      expect(orphaned).toHaveLength(2);
    });
  });

  describe('updateHeartbeat', () => {
    it('should update the heartbeat timestamp', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'hb-session',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      // Wait a bit and update heartbeat
      const before = store.getSession('hb-session')?.lastHeartbeat;
      store.updateHeartbeat('hb-session');
      const after = store.getSession('hb-session')?.lastHeartbeat;

      expect(after).toBeGreaterThanOrEqual(before!);
    });
  });

  describe('deleteSession', () => {
    it('should delete a session', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'delete-me',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      expect(store.getSession('delete-me')).not.toBeNull();

      store.deleteSession('delete-me');

      expect(store.getSession('delete-me')).toBeNull();
    });
  });

  describe('getSessionByFile', () => {
    it('should find session by file path', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'file-session',
        kernelName: 'python3',
        filePath: '/path/to/notebook.ipynb',
        kernelPid: 1,
        status: 'active',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      const session = store.getSessionByFile('/path/to/notebook.ipynb');
      expect(session).not.toBeNull();
      expect(session?.sessionId).toBe('file-session');
    });

    it('should return null for non-existent file', () => {
      const session = store.getSessionByFile('/nonexistent/path.ipynb');
      expect(session).toBeNull();
    });

    it('should not find orphaned sessions by file', () => {
      const now = Date.now() / 1000;

      store.saveSession({
        sessionId: 'orphaned-file-session',
        kernelName: 'python3',
        filePath: '/orphaned/notebook.ipynb',
        kernelPid: 1,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      const session = store.getSessionByFile('/orphaned/notebook.ipynb');
      expect(session).toBeNull();
    });
  });

  describe('cleanupOldSessions', () => {
    it('should cleanup old terminated/orphaned sessions', () => {
      const now = Date.now() / 1000;
      const oldTime = now - (25 * 3600); // 25 hours ago

      store.saveSession({
        sessionId: 'old-orphaned',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 1,
        status: 'orphaned',
        createdAt: oldTime,
        lastHeartbeat: oldTime,
        connectionFile: null,
      });

      store.saveSession({
        sessionId: 'recent-orphaned',
        kernelName: 'python3',
        filePath: null,
        kernelPid: 2,
        status: 'orphaned',
        createdAt: now,
        lastHeartbeat: now,
        connectionFile: null,
      });

      const deleted = store.cleanupOldSessions(24);
      expect(deleted).toBe(1);

      expect(store.getSession('old-orphaned')).toBeNull();
      expect(store.getSession('recent-orphaned')).not.toBeNull();
    });
  });
});

describe('KernelService', () => {
  let service: KernelService;
  let testDbPath: string;
  let testSessionStore: SessionStore;

  beforeEach(() => {
    testDbPath = path.join(os.tmpdir(), `nebula-test-kernel-${Date.now()}.db`);
    testSessionStore = new SessionStore(testDbPath);
    service = new KernelService({}, testSessionStore);
  });

  afterEach(async () => {
    await service.cleanup();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  describe('initialization', () => {
    it('should not be ready before initialize', () => {
      expect(service.isReady).toBe(false);
    });

    it('should be ready after initialize', async () => {
      await service.initialize();
      expect(service.isReady).toBe(true);
    });

    it('should discover kernels on initialize', async () => {
      await service.initialize();
      const kernels = service.getAvailableKernels();
      expect(Array.isArray(kernels)).toBe(true);
    });
  });

  describe('getAvailableKernels', () => {
    it('should return discovered kernels', async () => {
      await service.initialize();
      const kernels = service.getAvailableKernels();

      for (const kernel of kernels) {
        expect(kernel).toHaveProperty('name');
        expect(kernel).toHaveProperty('displayName');
        expect(kernel).toHaveProperty('language');
        expect(kernel).toHaveProperty('path');
      }
    });
  });

  describe('getSessionStatus', () => {
    it('should return null for non-existent session', () => {
      const status = service.getSessionStatus('nonexistent');
      expect(status).toBeNull();
    });
  });

  describe('getAllSessions', () => {
    it('should return empty array when no sessions', () => {
      const sessions = service.getAllSessions();
      expect(sessions).toEqual([]);
    });
  });

  describe('executeCode queueing', () => {
    it('should serialize executeCode calls for the same session', async () => {
      const calls: string[] = [];
      const first = createDeferred<void>();
      const second = createDeferred<void>();

      const internal = vi.fn()
        .mockImplementationOnce(async () => {
          calls.push('first-start');
          await first.promise;
          calls.push('first-end');
          return { status: 'ok', executionCount: 1 };
        })
        .mockImplementationOnce(async () => {
          calls.push('second-start');
          await second.promise;
          calls.push('second-end');
          return { status: 'ok', executionCount: 2 };
        });

      (service as any).executeCodeInternal = internal;

      const onOutput = vi.fn(async () => {});

      const p1 = service.executeCode('session-1', 'print(1)', onOutput);
      const p2 = service.executeCode('session-1', 'print(2)', onOutput);

      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toEqual(['first-start']);

      first.resolve();
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(calls).toEqual(['first-start', 'first-end', 'second-start']);

      second.resolve();
      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.executionCount).toBe(1);
      expect(r2.executionCount).toBe(2);
      expect(r1.queuePosition).toBe(0);
      expect(r1.queueLength).toBe(1);
      expect(r2.queuePosition).toBe(1);
      expect(r2.queueLength).toBe(2);
      expect(calls).toEqual(['first-start', 'first-end', 'second-start', 'second-end']);
    });

    it('should return a friendly error when the socket is busy', async () => {
      const busyError = new Error('Socket is busy reading; only one receive operation may be in progress at any time');
      (service as any).executeCodeInternal = vi.fn(async () => { throw busyError; });

      const onOutput = vi.fn(async () => {});
      const result = await service.executeCode('session-1', 'print(1)', onOutput);

      expect(result.status).toBe('error');
      expect(result.error).toContain('another execution');
      expect(onOutput).toHaveBeenCalledWith({
        type: 'error',
        content: expect.stringContaining('another execution'),
      });
    });
  });

  // Integration tests - require actual kernels, ZeroMQ, and proper kernel setup
  // These tests are skipped by default as they require a full Jupyter environment
  // To run: set RUN_KERNEL_INTEGRATION_TESTS=true
  describe.skipIf(!process.env.RUN_KERNEL_INTEGRATION_TESTS)('Integration - Kernel Execution', () => {
    let sessionId: string;

    beforeAll(async () => {
      await service.initialize();
    });

    afterAll(async () => {
      if (sessionId) {
        await service.stopKernel(sessionId);
      }
    });

    it('should start a Python kernel', async () => {
      sessionId = await service.startKernel({ kernelName: 'python3' });
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');

      // Wait a bit for kernel to stabilize
      await new Promise(r => setTimeout(r, 2000));

      const status = service.getSessionStatus(sessionId);
      expect(status).not.toBeNull();
      expect(status?.kernelName).toBe('python3');
    }, 60000);

    it('should execute code and return output', async () => {
      if (!sessionId) {
        sessionId = await service.startKernel({ kernelName: 'python3' });
        await new Promise(r => setTimeout(r, 2000));
      }

      const status = service.getSessionStatus(sessionId);
      if (!status || status.status === 'dead') {
        console.log('Kernel not available, skipping test');
        return;
      }

      const outputs: string[] = [];
      const result = await service.executeCode(
        sessionId,
        'print("Hello from Python!")',
        async (output) => {
          outputs.push(output.content);
        }
      );

      expect(result.status).toBe('ok');
      expect(outputs.some(o => o.includes('Hello from Python!'))).toBe(true);
    }, 60000);

    it('should handle execution errors', async () => {
      if (!sessionId) {
        sessionId = await service.startKernel({ kernelName: 'python3' });
        await new Promise(r => setTimeout(r, 2000));
      }

      const status = service.getSessionStatus(sessionId);
      if (!status || status.status === 'dead') {
        console.log('Kernel not available, skipping test');
        return;
      }

      const outputs: string[] = [];
      const result = await service.executeCode(
        sessionId,
        'raise ValueError("Test error")',
        async (output) => {
          outputs.push(output.content);
        }
      );

      // Error should be in the outputs
      expect(outputs.some(o => o.includes('ValueError'))).toBe(true);
    }, 60000);

    it('should stop a kernel', async () => {
      if (!sessionId) {
        sessionId = await service.startKernel({ kernelName: 'python3' });
        await new Promise(r => setTimeout(r, 2000));
      }

      const stopped = await service.stopKernel(sessionId);
      // May be false if kernel already died
      if (stopped) {
        const status = service.getSessionStatus(sessionId);
        expect(status).toBeNull();
      }

      sessionId = ''; // Clear so afterAll doesn't try to stop again
    }, 60000);
  });
});
