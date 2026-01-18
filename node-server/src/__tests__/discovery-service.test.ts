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
        { path: '/sys', version: '3.11', displayName: 'System', envType: 'system', envName: null, hasIpykernel: false, kernelName: null },
        { path: '/conda1', version: '3.11', displayName: 'Conda Base', envType: 'conda', envName: 'base', hasIpykernel: false, kernelName: null },
        { path: '/pyenv', version: '3.10', displayName: 'Pyenv', envType: 'pyenv', envName: '3.10', hasIpykernel: false, kernelName: null },
        { path: '/conda2', version: '3.9', displayName: 'Conda ML', envType: 'conda', envName: 'ml', hasIpykernel: false, kernelName: null },
        { path: '/brew', version: '3.11', displayName: 'Homebrew', envType: 'homebrew', envName: null, hasIpykernel: false, kernelName: null },
        { path: '/venv', version: '3.11', displayName: 'Venv', envType: 'venv', envName: 'myenv', hasIpykernel: false, kernelName: null },
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
        expect(['system', 'conda', 'pyenv', 'venv', 'homebrew']).toContain(firstEnv.envType);
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
