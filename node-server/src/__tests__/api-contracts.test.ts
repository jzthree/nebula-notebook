/**
 * API Contract Tests
 *
 * These tests verify that API responses use snake_case field names
 * to match the Python API format expected by the frontend.
 *
 * The frontend expects snake_case (e.g., display_name, kernel_name)
 * but TypeScript/Node.js naturally uses camelCase internally.
 * These tests ensure the transformation is applied correctly.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';

// Use vi.hoisted to define mock classes that will be available when vi.mock is hoisted
const { MockKernelService, MockPythonDiscoveryService, mockDiscoverKernelSpecs } = vi.hoisted(() => {
  const mockFn = <T>(impl: T) => impl;

  class MockKernelService {
    isReady = true;
    initialize = mockFn(async () => undefined);
    normalizeNotebookPath = mockFn((filePath: string) => filePath);
    getAvailableKernels = mockFn(() => [
      {
        name: 'python3',
        displayName: 'Python 3 (ipykernel)',
        language: 'python',
        path: '/usr/local/share/jupyter/kernels/python3',
      },
      {
        name: 'ir',
        displayName: 'R',
        language: 'R',
        path: '/usr/local/share/jupyter/kernels/ir',
      },
    ]);
    getAllSessions = mockFn(() => [
      {
        id: 'session-123',
        kernelName: 'python3',
        filePath: '/path/to/notebook.ipynb',
        status: 'idle',
        executionCount: 5,
        memoryMb: 128.5,
        pid: 12345,
      },
    ]);
    getSessionStatus = mockFn(() => ({
      id: 'session-123',
      kernelName: 'python3',
      status: 'idle',
    }));
    startKernel = mockFn(async () => 'session-new-123');
    getOrCreateKernel = mockFn(async () => ({ sessionId: 'session-file-123', created: false }));
    saveNotebookKernelPreference = mockFn(() => undefined);
    getNotebookKernelPreference = mockFn(() => null);
    cleanup = mockFn(async () => undefined);
  }

  class MockPythonDiscoveryService {
    discover = mockFn(async () => [
      {
        path: '/usr/bin/python3',
        version: '3.10.0',
        displayName: 'Python 3.10',
        envType: 'system',
        envName: null,
        hasIpykernel: true,
        kernelName: 'python3',
      },
      {
        path: '/home/user/.pyenv/versions/3.11.0/bin/python',
        version: '3.11.0',
        displayName: 'Python 3.11 (pyenv)',
        envType: 'pyenv',
        envName: '3.11.0',
        hasIpykernel: false,
        kernelName: null,
      },
    ]);
    getCacheInfo = mockFn(() => ({
      lastRefresh: Date.now(),
      environmentCount: 2,
    }));
    installKernel = mockFn(async () => ({ success: true }));
  }

  const mockDiscoverKernelSpecs = mockFn(() => [
    {
      name: 'python3',
      displayName: 'Python 3 (ipykernel)',
      language: 'python',
      path: '/usr/local/share/jupyter/kernels/python3',
    },
  ]);

  return { MockKernelService, MockPythonDiscoveryService, mockDiscoverKernelSpecs };
});

// Mock modules with hoisted classes
vi.mock('../kernel/kernel-service', () => ({
  KernelService: MockKernelService,
}));

vi.mock('../kernel/kernelspec', () => ({
  discoverKernelSpecs: mockDiscoverKernelSpecs,
}));

vi.mock('../discovery/discovery-service', () => ({
  PythonDiscoveryService: MockPythonDiscoveryService,
}));

let routesPromise: Promise<{ kernelRoutes: any; pythonRoutes: any }> | null = null;

async function getRoutes(): Promise<{ kernelRoutes: any; pythonRoutes: any }> {
  if (!routesPromise) {
    routesPromise = (async () => {
      // Ensure routes are imported fresh with mocks applied, even if another test file
      // imported these modules earlier in the same worker.
      vi.resetModules();

      const [{ default: kernelRoutes }, { default: pythonRoutes }] = await Promise.all([
        import('../routes/kernel'),
        import('../routes/python'),
      ]);

      return { kernelRoutes, pythonRoutes };
    })();
  }
  return routesPromise;
}

describe('API Contract Tests - Snake Case Response Format', () => {
  let app: Express;

  beforeAll(async () => {
    const { kernelRoutes, pythonRoutes } = await getRoutes();

    app = express();
    app.use(express.json());
    app.use('/api', kernelRoutes);
    app.use('/api', pythonRoutes);
  });

  describe('GET /api/kernels', () => {
    it('should return kernels with snake_case field names', async () => {
      const response = await request(app).get('/api/kernels');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('kernels');
      expect(Array.isArray(response.body.kernels)).toBe(true);

      const kernel = response.body.kernels[0];

      // Verify snake_case fields exist
      expect(kernel).toHaveProperty('name');
      expect(kernel).toHaveProperty('display_name');
      expect(kernel).toHaveProperty('language');
      expect(kernel).toHaveProperty('path');

      // Verify camelCase fields do NOT exist (they should be transformed)
      expect(kernel).not.toHaveProperty('displayName');

      // Verify actual values
      expect(kernel.display_name).toBe('Python 3 (ipykernel)');
    });

    it('should return all discovered kernels', async () => {
      const response = await request(app).get('/api/kernels');

      expect(response.body.kernels).toHaveLength(2);
      expect(response.body.kernels[0].name).toBe('python3');
      expect(response.body.kernels[1].name).toBe('ir');
    });
  });

  describe('GET /api/kernels/sessions', () => {
    it('should return sessions with snake_case field names', async () => {
      const response = await request(app).get('/api/kernels/sessions');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('sessions');
      expect(Array.isArray(response.body.sessions)).toBe(true);

      const session = response.body.sessions[0];

      // Verify snake_case fields exist
      expect(session).toHaveProperty('id');
      expect(session).toHaveProperty('kernel_name');
      expect(session).toHaveProperty('file_path');
      expect(session).toHaveProperty('status');
      expect(session).toHaveProperty('execution_count');
      expect(session).toHaveProperty('memory_mb');
      expect(session).toHaveProperty('pid');

      // Verify camelCase fields do NOT exist
      expect(session).not.toHaveProperty('kernelName');
      expect(session).not.toHaveProperty('filePath');
      expect(session).not.toHaveProperty('executionCount');
      expect(session).not.toHaveProperty('memoryMb');

      // Verify actual values
      expect(session.kernel_name).toBe('python3');
      expect(session.file_path).toBe('/path/to/notebook.ipynb');
      expect(session.execution_count).toBe(5);
      expect(session.memory_mb).toBe(128.5);
    });
  });

  describe('GET /api/python/environments', () => {
    it('should return environments with snake_case field names', async () => {
      const response = await request(app).get('/api/python/environments');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('environments');
      expect(response.body).toHaveProperty('kernelspecs');
      expect(response.body).toHaveProperty('cache_info');

      const env = response.body.environments[0];

      // Verify snake_case fields exist
      expect(env).toHaveProperty('path');
      expect(env).toHaveProperty('version');
      expect(env).toHaveProperty('display_name');
      expect(env).toHaveProperty('env_type');
      expect(env).toHaveProperty('env_name');
      expect(env).toHaveProperty('has_ipykernel');
      expect(env).toHaveProperty('kernel_name');

      // Verify camelCase fields do NOT exist
      expect(env).not.toHaveProperty('displayName');
      expect(env).not.toHaveProperty('envType');
      expect(env).not.toHaveProperty('envName');
      expect(env).not.toHaveProperty('hasIpykernel');
      expect(env).not.toHaveProperty('kernelName');

      // Verify actual values
      expect(env.display_name).toBe('Python 3.10');
      expect(env.env_type).toBe('system');
      expect(env.has_ipykernel).toBe(true);
    });

    it('should return kernelspecs with snake_case field names', async () => {
      const response = await request(app).get('/api/python/environments');

      const kernelspec = response.body.kernelspecs[0];

      // Verify snake_case fields
      expect(kernelspec).toHaveProperty('name');
      expect(kernelspec).toHaveProperty('display_name');
      expect(kernelspec).toHaveProperty('language');
      expect(kernelspec).toHaveProperty('path');

      // Verify camelCase fields do NOT exist
      expect(kernelspec).not.toHaveProperty('displayName');
    });

    it('should return cache_info with snake_case field name', async () => {
      const response = await request(app).get('/api/python/environments');

      // Verify snake_case
      expect(response.body).toHaveProperty('cache_info');

      // Verify camelCase does NOT exist
      expect(response.body).not.toHaveProperty('cacheInfo');
    });
  });

  describe('POST /api/kernels/start response', () => {
    it('should return session_id with snake_case', async () => {
      const response = await request(app)
        .post('/api/kernels/start')
        .send({ kernel_name: 'python3' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('session_id');
      expect(response.body).toHaveProperty('kernel_name');

      // Verify camelCase does NOT exist
      expect(response.body).not.toHaveProperty('sessionId');
      expect(response.body).not.toHaveProperty('kernelName');
    });
  });

  describe('POST /api/kernels/for-file response', () => {
    it('should return response with snake_case field names', async () => {
      const response = await request(app)
        .post('/api/kernels/for-file')
        .send({ file_path: '/path/to/notebook.ipynb', kernel_name: 'python3' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('session_id');
      expect(response.body).toHaveProperty('kernel_name');
      expect(response.body).toHaveProperty('file_path');
      expect(response.body).toHaveProperty('created');

      // Verify camelCase does NOT exist
      expect(response.body).not.toHaveProperty('sessionId');
      expect(response.body).not.toHaveProperty('kernelName');
      expect(response.body).not.toHaveProperty('filePath');
    });
  });

  describe('GET /api/kernels/preference response', () => {
    it('should return response with snake_case field names', async () => {
      const response = await request(app)
        .get('/api/kernels/preference')
        .query({ file_path: '/path/to/notebook.ipynb' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('kernel_name');
      expect(response.body).toHaveProperty('server_id');

      // Verify camelCase does NOT exist
      expect(response.body).not.toHaveProperty('kernelName');
      expect(response.body).not.toHaveProperty('serverId');
    });
  });
});

/**
 * Additional tests for field type validation
 * These ensure the API contract includes correct types
 */
describe('API Contract Tests - Field Types', () => {
  let app: Express;

  beforeAll(async () => {
    const { kernelRoutes, pythonRoutes } = await getRoutes();

    app = express();
    app.use(express.json());
    app.use('/api', kernelRoutes);
    app.use('/api', pythonRoutes);
  });

  describe('GET /api/kernels', () => {
    it('should have correct field types', async () => {
      const response = await request(app).get('/api/kernels');
      const kernel = response.body.kernels[0];

      expect(typeof kernel.name).toBe('string');
      expect(typeof kernel.display_name).toBe('string');
      expect(typeof kernel.language).toBe('string');
      expect(typeof kernel.path).toBe('string');
    });
  });

  describe('GET /api/kernels/sessions', () => {
    it('should have correct field types', async () => {
      const response = await request(app).get('/api/kernels/sessions');
      const session = response.body.sessions[0];

      expect(typeof session.id).toBe('string');
      expect(typeof session.kernel_name).toBe('string');
      expect(typeof session.file_path).toBe('string');
      expect(typeof session.status).toBe('string');
      expect(typeof session.execution_count).toBe('number');
      expect(typeof session.memory_mb).toBe('number');
      expect(typeof session.pid).toBe('number');
    });
  });

  describe('GET /api/python/environments', () => {
    it('should have correct field types for environments', async () => {
      const response = await request(app).get('/api/python/environments');
      const env = response.body.environments[0];

      expect(typeof env.path).toBe('string');
      expect(typeof env.version).toBe('string');
      expect(typeof env.display_name).toBe('string');
      expect(typeof env.env_type).toBe('string');
      expect(typeof env.has_ipykernel).toBe('boolean');
      // env_name and kernel_name can be null
      expect(env.env_name === null || typeof env.env_name === 'string').toBe(true);
      expect(env.kernel_name === null || typeof env.kernel_name === 'string').toBe(true);
    });
  });
});
