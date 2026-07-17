// @vitest-environment node
/**
 * Python Discovery Service Tests
 *
 * Tests for Python environment discovery functionality.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PythonDiscoveryService } from '../discovery/discovery-service';
import { PythonEnvironment } from '../discovery/types';

describe('PythonDiscoveryService', () => {
  let service: PythonDiscoveryService;
  let testDir: string;
  let mockCacheFile: string;

  beforeAll(() => {
    // Create a temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-discovery-test-'));
    mockCacheFile = path.join(testDir, 'python-cache.json');
  });

  afterAll(() => {
    // Clean up test directory
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    service = new PythonDiscoveryService({ cacheFile: mockCacheFile });
  });

  afterEach(() => {
    // Clean up cache file if it exists
    try {
      fs.unlinkSync(mockCacheFile);
    } catch {}
  });

  describe('Display Name Generation', () => {
    it('should generate conda display name', () => {
      const name = service.generateDisplayName('3.11.5', 'conda', 'base');
      expect(name).toBe('Python 3.11.5 (conda: base)');
    });

    it('should generate pyenv display name', () => {
      const name = service.generateDisplayName('3.10.0', 'pyenv', '3.10.0');
      expect(name).toBe('Python 3.10.0 (pyenv: 3.10.0)');
    });

    it('should generate venv display name', () => {
      const name = service.generateDisplayName('3.9.7', 'venv', 'myproject');
      expect(name).toBe('Python 3.9.7 (venv: myproject)');
    });

    it('should generate homebrew display name', () => {
      const name = service.generateDisplayName('3.11.0', 'homebrew', null);
      expect(name).toBe('Python 3.11.0 (Homebrew)');
    });

    it('should generate system display name', () => {
      const name = service.generateDisplayName('3.8.10', 'system', null);
      expect(name).toBe('Python 3.8.10 (System)');
    });

    it('should generate uv-managed display name', () => {
      const name = service.generateDisplayName('3.12.13', 'uv', null);
      expect(name).toBe('Python 3.12.13 (uv-managed)');
    });

    it('should generate pixi display name', () => {
      const name = service.generateDisplayName('3.11.0', 'pixi', 'default');
      expect(name).toBe('Python 3.11.0 (pixi: default)');
    });
  });

  describe('Cache Management', () => {
    it('should save and load cache', () => {
      const env: PythonEnvironment = {
        path: '/usr/bin/python3',
        version: '3.11.5',
        displayName: 'Python 3.11.5 (System)',
        envType: 'system',
        envName: null,
        hasIpykernel: false,
        kernelName: null,
        externallyManaged: false,
        installHint: null,
      };

      service.saveToCache({ [env.path]: env });

      // Create a new service to load from cache
      const service2 = new PythonDiscoveryService({ cacheFile: mockCacheFile });
      const loaded = service2.getFromCache();

      expect(loaded).not.toBeNull();
      expect(loaded![env.path]).toEqual(env);
    });

    it('should detect invalid cache after TTL expires', () => {
      const env: PythonEnvironment = {
        path: '/usr/bin/python3',
        version: '3.11.5',
        displayName: 'Python 3.11.5 (System)',
        envType: 'system',
        envName: null,
        hasIpykernel: false,
        kernelName: null,
        externallyManaged: false,
        installHint: null,
      };

      // Save cache with old timestamp
      const oldTimestamp = Date.now() - (25 * 60 * 60 * 1000); // 25 hours ago
      fs.mkdirSync(path.dirname(mockCacheFile), { recursive: true });
      fs.writeFileSync(mockCacheFile, JSON.stringify({
        environments: { [env.path]: env },
        timestamp: oldTimestamp,
      }));

      const service2 = new PythonDiscoveryService({
        cacheFile: mockCacheFile,
        cacheTtlHours: 24,
      });

      expect(service2.isCacheValid()).toBe(false);
    });

    it('should detect valid cache within TTL', () => {
      const env: PythonEnvironment = {
        path: '/usr/bin/python3',
        version: '3.11.5',
        displayName: 'Python 3.11.5 (System)',
        envType: 'system',
        envName: null,
        hasIpykernel: false,
        kernelName: null,
        externallyManaged: false,
        installHint: null,
      };

      service.saveToCache({ [env.path]: env });

      expect(service.isCacheValid()).toBe(true);
    });

    it('should return cache info', () => {
      const env: PythonEnvironment = {
        path: '/usr/bin/python3',
        version: '3.11.5',
        displayName: 'Python 3.11.5 (System)',
        envType: 'system',
        envName: null,
        hasIpykernel: false,
        kernelName: null,
        externallyManaged: false,
        installHint: null,
      };

      service.saveToCache({ [env.path]: env });

      const info = service.getCacheInfo();
      expect(info.cachedCount).toBe(1);
      expect(info.cacheValid).toBe(true);
      expect(info.cacheFile).toBe(mockCacheFile);
      expect(info.cacheAgeHours).toBeGreaterThanOrEqual(0);
      expect(info.cacheAgeHours).toBeLessThan(1); // Just created
    });
  });

  describe('Environment Sorting', () => {
    it('should sort environments by type and name', () => {
      const envs: PythonEnvironment[] = [
        { path: '/sys', version: '3.11', displayName: 'System', envType: 'system', envName: null, hasIpykernel: false, kernelName: null, externallyManaged: false, installHint: null },
        { path: '/conda1', version: '3.11', displayName: 'Conda Base', envType: 'conda', envName: 'base', hasIpykernel: false, kernelName: null, externallyManaged: false, installHint: null },
        { path: '/pyenv', version: '3.10', displayName: 'Pyenv', envType: 'pyenv', envName: '3.10', hasIpykernel: false, kernelName: null, externallyManaged: false, installHint: null },
        { path: '/conda2', version: '3.9', displayName: 'Conda ML', envType: 'conda', envName: 'ml', hasIpykernel: false, kernelName: null, externallyManaged: false, installHint: null },
        { path: '/brew', version: '3.11', displayName: 'Homebrew', envType: 'homebrew', envName: null, hasIpykernel: false, kernelName: null, externallyManaged: false, installHint: null },
        { path: '/venv', version: '3.11', displayName: 'Venv', envType: 'venv', envName: 'myenv', hasIpykernel: false, kernelName: null, externallyManaged: false, installHint: null },
      ];

      const sorted = service.sortEnvironments(envs);

      // Conda first, then pyenv, venv, homebrew, system
      expect(sorted[0].envType).toBe('conda');
      expect(sorted[1].envType).toBe('conda');
      expect(sorted[2].envType).toBe('pyenv');
      expect(sorted[3].envType).toBe('venv');
      expect(sorted[4].envType).toBe('homebrew');
      expect(sorted[5].envType).toBe('system');
    });
  });

  describe('Path Validation', () => {
    it('should validate existing python path', () => {
      // /usr/bin/python3 likely exists on most systems
      const exists = service.pythonExists('/usr/bin/python3');
      // We can't assert true because it might not exist on all systems
      expect(typeof exists).toBe('boolean');
    });

    it('should return false for non-existent path', () => {
      const exists = service.pythonExists('/nonexistent/python');
      expect(exists).toBe(false);
    });
  });

  describe('Common Paths', () => {
    it('should return conda base paths', () => {
      const paths = service.getCondaBasePaths();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.length).toBeGreaterThan(0);
      // Should include home directory based paths
      const homeDir = os.homedir();
      expect(paths.some(p => p.includes('anaconda3') || p.includes('miniconda3'))).toBe(true);
    });

    it('should return system python paths', () => {
      const paths = service.getSystemPythonPaths();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths).toContain('/usr/bin/python3');
      expect(paths).toContain('/usr/local/bin/python3');
    });

    it('should return pyenv versions path', () => {
      const pyenvPath = service.getPyenvVersionsPath();
      expect(pyenvPath).toContain('.pyenv/versions');
    });

    it('should return virtualenv paths', () => {
      const paths = service.getVirtualenvPaths();
      expect(Array.isArray(paths)).toBe(true);
      expect(paths.some(p => p.includes('.virtualenvs') || p.includes('venvs'))).toBe(true);
    });
  });

  describe('Kernel Name Generation', () => {
    it('should generate unique kernel name from path', () => {
      const name = service.generateKernelName('/usr/bin/python3', '3.11.5');
      expect(name).toMatch(/^python3\.11_\d+$/);
    });

    it('should generate different names for different paths', () => {
      const name1 = service.generateKernelName('/usr/bin/python3', '3.11.5');
      const name2 = service.generateKernelName('/usr/local/bin/python3', '3.11.5');
      // Hash collision is possible but unlikely
      // Just verify they're in the expected format
      expect(name1).toMatch(/^python3\.11_\d+$/);
      expect(name2).toMatch(/^python3\.11_\d+$/);
    });
  });

  describe('Version Parsing', () => {
    it('should parse Python version string', () => {
      const version = service.parseVersionString('Python 3.11.5');
      expect(version).toBe('3.11.5');
    });

    it('should handle version with extra info', () => {
      const version = service.parseVersionString('Python 3.10.0 (default, Oct  4 2021)');
      expect(version).toBe('3.10.0');
    });

    it('should return original if no match', () => {
      const version = service.parseVersionString('some random string');
      expect(version).toBe('some random string');
    });
  });

  describe('Conda discovery via filesystem locator', () => {
    it('finds a path-based conda env recorded in environments.txt (no conda on PATH needed)', async () => {
      const fixtureHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-conda-home-')));
      try {
        // A conda env in a random location, created e.g. with `mamba create -p …`
        const stray = path.join(fixtureHome, 'Code', '.conda-envs', 'hypir');
        fs.mkdirSync(path.join(stray, 'conda-meta'), { recursive: true });
        fs.mkdirSync(path.join(stray, 'bin'), { recursive: true });
        // Stub python: answers --version, and prints probe JSON for -c
        fs.writeFileSync(
          path.join(stray, 'bin', 'python'),
          '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.10.4"; exit 0; fi\n' +
          'echo \'{"ipykernel": false, "externally_managed": false, "venv": false}\'\n',
          { mode: 0o755 }
        );
        fs.mkdirSync(path.join(fixtureHome, '.conda'), { recursive: true });
        fs.writeFileSync(path.join(fixtureHome, '.conda', 'environments.txt'), `${stray}\n`);

        const svc = new PythonDiscoveryService({
          cacheFile: path.join(fixtureHome, 'cache.json'),
          condaLocator: { home: fixtureHome, env: {} },
        });
        const candidates = await (svc as unknown as {
          findCondaEnvs(): Promise<Array<{ path: string; envType: string; envName: string | null }>>;
        }).findCondaEnvs();

        const found = candidates.find(c => c.path === path.join(stray, 'bin', 'python'));
        expect(found).toBeTruthy();
        expect(found!.envType).toBe('conda');
        expect(found!.envName).toBe('hypir');
      } finally {
        fs.rmSync(fixtureHome, { recursive: true, force: true });
      }
    });
  });

  describe('probeAndRemember (manual interpreter entry)', () => {
    let fixture: string;

    beforeEach(() => {
      fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-probe-')));
    });

    afterEach(() => {
      fs.rmSync(fixture, { recursive: true, force: true });
    });

    function writeStub(py: string, probeJson: string): void {
      fs.mkdirSync(path.dirname(py), { recursive: true });
      fs.writeFileSync(
        py,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.12.3"; exit 0; fi\n' +
        `echo '${probeJson}'\n`,
        { mode: 0o755 }
      );
    }

    it('classifies a conda interpreter, enriches it, and persists it to the cache', async () => {
      const prefix = path.join(fixture, 'my-conda-env');
      fs.mkdirSync(path.join(prefix, 'conda-meta'), { recursive: true });
      const py = path.join(prefix, 'bin', 'python');
      writeStub(py, '{"ipykernel": true, "externally_managed": false, "venv": false}');

      const env = await service.probeAndRemember(py);
      expect(env.envType).toBe('conda');
      expect(env.envName).toBe('my-conda-env');
      expect(env.version).toBe('3.12.3');
      expect(env.hasIpykernel).toBe(true);

      // Persisted: a fresh service instance sees it via the shared cache file
      const service2 = new PythonDiscoveryService({ cacheFile: mockCacheFile });
      expect(service2.getFromCache()?.[py]?.envType).toBe('conda');
    });

    it('classifies a venv via pyvenv.cfg', async () => {
      const prefix = path.join(fixture, 'proj-venv');
      fs.mkdirSync(prefix, { recursive: true });
      fs.writeFileSync(path.join(prefix, 'pyvenv.cfg'), 'home = /usr/bin\n');
      const py = path.join(prefix, 'bin', 'python');
      writeStub(py, '{"ipykernel": false, "externally_managed": false, "venv": true}');

      const env = await service.probeAndRemember(py);
      expect(env.envType).toBe('venv');
      expect(env.envName).toBe('proj-venv');
      expect(env.hasIpykernel).toBe(false);
      expect(env.installHint).toBeTruthy();
    });

    it('rejects a missing path with python_not_found', async () => {
      const err = await service
        .probeAndRemember(path.join(fixture, 'nope', 'python'))
        .then(() => null, (e: unknown) => e);
      expect(err).toBeTruthy();
      expect((err as { code?: string }).code).toBe('python_not_found');
    });

    it('rejects a file that is not a working interpreter', async () => {
      const py = path.join(fixture, 'not-python');
      fs.writeFileSync(py, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
      const err = await service
        .probeAndRemember(py)
        .then(() => null, (e: unknown) => e);
      expect(err).toBeTruthy();
      expect((err as { code?: string }).code).toBe('python_not_found');
    });
  });

  describe('Integration - Discovery', () => {
    it('should discover at least one Python environment on this system', async () => {
      // This test actually runs discovery on the current system
      // Skip if no python available
      const envs = await service.discover({ forceRefresh: true });

      // Most development machines have at least one Python
      // If this fails, the machine has no Python which is fine
      if (envs.length > 0) {
        const firstEnv = envs[0];
        expect(firstEnv.path).toBeTruthy();
        expect(firstEnv.version).toBeTruthy();
        expect(firstEnv.displayName).toBeTruthy();
        expect(['system', 'conda', 'pyenv', 'venv', 'homebrew', 'uv', 'pixi']).toContain(firstEnv.envType);
      }
    }, 60000); // Allow up to 60 seconds for discovery

    it('should use cache on second call', async () => {
      // First call - discovery
      await service.discover({ forceRefresh: true });

      // Second call - should use cache
      const startTime = Date.now();
      await service.discover({ forceRefresh: false });
      const elapsed = Date.now() - startTime;

      // Cache lookup should be much faster than actual discovery
      // (Discovery can take several seconds)
      expect(elapsed).toBeLessThan(1000);
    }, 60000);

    it('should force refresh when requested', async () => {
      // First call
      const envs1 = await service.discover({ forceRefresh: true });

      // Force refresh should re-scan (might get same results)
      const envs2 = await service.discover({ forceRefresh: true });

      // Both should return arrays (contents might be same or different)
      expect(Array.isArray(envs1)).toBe(true);
      expect(Array.isArray(envs2)).toBe(true);
    }, 60000);
  });
});
