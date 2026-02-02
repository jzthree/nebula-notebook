/**
 * Python Discovery Service
 *
 * Discovers Python environments on the system (conda, pyenv, venv, system).
 * Node.js port of the Python PythonDiscoveryService.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, execSync } from 'child_process';
import {
  PythonEnvironment,
  PythonEnvType,
  DiscoveryCandidate,
  CacheData,
  CacheInfo,
  InstallKernelResult,
  DEFAULT_CACHE_TTL_HOURS,
  DEFAULT_VERSION_CHECK_TIMEOUT_MS,
  DEFAULT_IPYKERNEL_CHECK_TIMEOUT_MS,
  DEFAULT_CONDA_LIST_TIMEOUT_MS,
  DEFAULT_KERNEL_INSTALL_TIMEOUT_MS,
  DEFAULT_REGISTRATION_TIMEOUT_MS,
} from './types';

export interface DiscoveryServiceOptions {
  cacheFile?: string;
  cacheTtlHours?: number;
  versionCheckTimeoutMs?: number;
  ipykernelCheckTimeoutMs?: number;
  condaListTimeoutMs?: number;
  kernelInstallTimeoutMs?: number;
  registrationTimeoutMs?: number;
}

const DEFAULT_CACHE_FILE = path.join(os.homedir(), '.nebula-notebook', 'python-cache.json');

export class PythonDiscoveryService {
  private cache: Record<string, PythonEnvironment> = {};
  private cacheTimestamp: number = 0;
  private cacheFile: string;
  private cacheTtlHours: number;
  private versionCheckTimeoutMs: number;
  private ipykernelCheckTimeoutMs: number;
  private condaListTimeoutMs: number;
  private kernelInstallTimeoutMs: number;
  private registrationTimeoutMs: number;
  private backgroundRefreshInProgress: boolean = false;

  constructor(options: DiscoveryServiceOptions = {}) {
    this.cacheFile = options.cacheFile || DEFAULT_CACHE_FILE;
    this.cacheTtlHours = options.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS;
    this.versionCheckTimeoutMs = options.versionCheckTimeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;
    this.ipykernelCheckTimeoutMs = options.ipykernelCheckTimeoutMs ?? DEFAULT_IPYKERNEL_CHECK_TIMEOUT_MS;
    this.condaListTimeoutMs = options.condaListTimeoutMs ?? DEFAULT_CONDA_LIST_TIMEOUT_MS;
    this.kernelInstallTimeoutMs = options.kernelInstallTimeoutMs ?? DEFAULT_KERNEL_INSTALL_TIMEOUT_MS;
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;

    this.loadCache();
  }

  /**
   * Load cache from disk
   */
  private loadCache(): void {
    try {
      if (fs.existsSync(this.cacheFile)) {
        const data: CacheData = JSON.parse(fs.readFileSync(this.cacheFile, 'utf-8'));
        this.cache = data.environments || {};
        this.cacheTimestamp = data.timestamp || 0;
      }
    } catch (e) {
      console.warn('Failed to load Python cache:', e);
      this.cache = {};
      this.cacheTimestamp = 0;
    }
  }

  /**
   * Save environments to cache
   */
  saveToCache(environments: Record<string, PythonEnvironment>): void {
    try {
      const dir = path.dirname(this.cacheFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: CacheData = {
        environments,
        timestamp: Date.now(),
      };

      fs.writeFileSync(this.cacheFile, JSON.stringify(data, null, 2), 'utf-8');
      this.cache = environments;
      this.cacheTimestamp = data.timestamp;
    } catch (e) {
      console.warn('Failed to save Python cache:', e);
    }
  }

  /**
   * Get environments from cache (returns null if empty)
   */
  getFromCache(): Record<string, PythonEnvironment> | null {
    if (Object.keys(this.cache).length === 0) {
      return null;
    }
    return this.cache;
  }

  /**
   * Check if cache is still valid
   */
  isCacheValid(): boolean {
    if (Object.keys(this.cache).length === 0) {
      return false;
    }
    const ageHours = (Date.now() - this.cacheTimestamp) / (1000 * 60 * 60);
    return ageHours < this.cacheTtlHours;
  }

  /**
   * Get cache info
   */
  getCacheInfo(): CacheInfo & { refreshing: boolean } {
    return {
      cachedCount: Object.keys(this.cache).length,
      cacheAgeHours: this.cacheTimestamp > 0 ? (Date.now() - this.cacheTimestamp) / (1000 * 60 * 60) : null,
      cacheValid: this.isCacheValid(),
      cacheFile: this.cacheFile,
      refreshing: this.backgroundRefreshInProgress,
    };
  }

  /**
   * Run a command asynchronously with timeout
   */
  private runCommand(command: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let finished = false;

      const timer = timeoutMs > 0 ? setTimeout(() => {
        if (finished) return;
        finished = true;
        child.kill('SIGKILL');
        reject(new Error(`Command timed out after ${timeoutMs}ms`));
      }, timeoutMs) : null;

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });
      child.on('error', (err) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        if (finished) return;
        finished = true;
        if (timer) clearTimeout(timer);
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr || stdout}`));
        }
      });
    });
  }

  /**
   * Generate display name for an environment
   */
  generateDisplayName(version: string, envType: PythonEnvType, envName: string | null): string {
    if (envType === 'conda' && envName) {
      return `Python ${version} (conda: ${envName})`;
    } else if (envType === 'pyenv' && envName) {
      return `Python ${version} (pyenv: ${envName})`;
    } else if (envType === 'venv' && envName) {
      return `Python ${version} (venv: ${envName})`;
    } else if (envType === 'homebrew') {
      return `Python ${version} (Homebrew)`;
    }
    return `Python ${version} (System)`;
  }

  /**
   * Sort environments by type priority and name
   */
  sortEnvironments(envs: PythonEnvironment[]): PythonEnvironment[] {
    const typeOrder: Record<PythonEnvType, number> = {
      conda: 0,
      pyenv: 1,
      venv: 2,
      homebrew: 3,
      system: 4,
    };

    return [...envs].sort((a, b) => {
      const typeA = typeOrder[a.envType] ?? 99;
      const typeB = typeOrder[b.envType] ?? 99;
      if (typeA !== typeB) {
        return typeA - typeB;
      }
      return a.displayName.localeCompare(b.displayName);
    });
  }

  /**
   * Check if a python path exists
   */
  pythonExists(pythonPath: string): boolean {
    return fs.existsSync(pythonPath);
  }

  /**
   * Get common conda base paths to search
   */
  getCondaBasePaths(): string[] {
    const home = os.homedir();
    return [
      path.join(home, 'anaconda3'),
      path.join(home, 'miniconda3'),
      path.join(home, 'miniforge3'),
      path.join(home, 'mambaforge'),
      '/opt/anaconda3',
      '/opt/miniconda3',
      '/opt/homebrew/anaconda3',
      '/usr/local/anaconda3',
      '/usr/local/miniconda3',
    ];
  }

  /**
   * Get common system python paths
   */
  getSystemPythonPaths(): string[] {
    const paths = [
      '/usr/bin/python3',
      '/usr/local/bin/python3',
      '/opt/homebrew/bin/python3', // Apple Silicon Homebrew
      '/usr/local/opt/python/libexec/bin/python', // Intel Homebrew
    ];

    // Add paths from PATH environment
    const envPath = process.env.PATH || '';
    for (const dir of envPath.split(':')) {
      for (const name of ['python3', 'python']) {
        const candidate = path.join(dir, name);
        if (!paths.includes(candidate)) {
          paths.push(candidate);
        }
      }
    }

    return paths;
  }

  /**
   * Get pyenv versions path
   */
  getPyenvVersionsPath(): string {
    return path.join(os.homedir(), '.pyenv', 'versions');
  }

  /**
   * Get common virtualenv paths
   */
  getVirtualenvPaths(): string[] {
    const home = os.homedir();
    return [
      path.join(home, '.virtualenvs'),
      path.join(home, 'venvs'),
      path.join(home, '.venvs'),
    ];
  }

  /**
   * Generate a unique kernel name from path
   */
  generateKernelName(pythonPath: string, version: string): string {
    const versionShort = version.split('.').slice(0, 2).join('.');
    const pathHash = Math.abs(this.hashString(pythonPath)) % 10000;
    return `python${versionShort}_${pathHash}`;
  }

  /**
   * Simple string hash function
   */
  private hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash;
  }

  /**
   * Parse Python version from version string
   */
  parseVersionString(versionOutput: string): string {
    const match = versionOutput.match(/Python (\d+\.\d+\.\d+)/);
    if (match) {
      return match[1];
    }
    // Try without patch version
    const match2 = versionOutput.match(/Python (\d+\.\d+)/);
    if (match2) {
      return match2[1];
    }
    return versionOutput.replace('Python ', '').trim();
  }

  /**
   * Get Python version from executable
   */
  private async getPythonVersion(pythonPath: string): Promise<string | null> {
    try {
      const { stdout, stderr } = await this.runCommand(pythonPath, ['--version'], this.versionCheckTimeoutMs);
      const output = (stdout || stderr).trim();
      return this.parseVersionString(output);
    } catch {
      return null;
    }
  }

  /**
   * Check if ipykernel is installed
   */
  private async checkIpykernel(pythonPath: string): Promise<boolean> {
    try {
      await this.runCommand(pythonPath, ['-c', 'import ipykernel'], this.ipykernelCheckTimeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Find conda environments
   */
  private async findCondaEnvs(): Promise<DiscoveryCandidate[]> {
    const envs: DiscoveryCandidate[] = [];
    const seenPaths = new Set<string>();

    // Possible conda executable paths
    const condaPaths = [
      '/opt/anaconda3/bin/conda',
      '/opt/miniconda3/bin/conda',
      '/opt/homebrew/bin/conda',
      '/opt/homebrew/anaconda3/bin/conda',
      path.join(os.homedir(), 'anaconda3', 'bin', 'conda'),
      path.join(os.homedir(), 'miniconda3', 'bin', 'conda'),
      path.join(os.homedir(), 'miniforge3', 'bin', 'conda'),
      path.join(os.homedir(), 'mambaforge', 'bin', 'conda'),
      '/usr/local/anaconda3/bin/conda',
      '/usr/local/miniconda3/bin/conda',
    ];

    // Try to get envs from conda command
    for (const condaPath of condaPaths) {
      if (!fs.existsSync(condaPath)) continue;

      try {
        const { stdout } = await this.runCommand(condaPath, ['env', 'list', '--json'], this.condaListTimeoutMs);
        const data = JSON.parse(stdout);
        for (const envPath of data.envs || []) {
          const pythonPath = path.join(envPath, 'bin', 'python');
          if (fs.existsSync(pythonPath) && !seenPaths.has(pythonPath)) {
            seenPaths.add(pythonPath);
            const envName = path.basename(envPath);
            const isBase = envPath === data.root_prefix || !envPath.includes('envs');
            envs.push({
              path: pythonPath,
              envType: 'conda',
              envName: isBase ? 'base' : envName,
              base: envPath,
            });
          }
        }
      } catch (e) {
        console.warn(`Error running conda env list: ${e}`);
      }
    }

    // Also scan common conda base directories
    for (const base of this.getCondaBasePaths()) {
      if (!fs.existsSync(base)) continue;

      // Base environment
      const basePython = path.join(base, 'bin', 'python');
      if (fs.existsSync(basePython) && !seenPaths.has(basePython)) {
        seenPaths.add(basePython);
        envs.push({
          path: basePython,
          envType: 'conda',
          envName: 'base',
          base,
        });
      }

      // Sub-environments
      const envsDir = path.join(base, 'envs');
      if (fs.existsSync(envsDir)) {
        try {
          for (const envDir of fs.readdirSync(envsDir)) {
            const envPath = path.join(envsDir, envDir);
            if (!fs.statSync(envPath).isDirectory()) continue;

            const pythonPath = path.join(envPath, 'bin', 'python');
            if (fs.existsSync(pythonPath) && !seenPaths.has(pythonPath)) {
              seenPaths.add(pythonPath);
              envs.push({
                path: pythonPath,
                envType: 'conda',
                envName: envDir,
                base,
              });
            }
          }
        } catch (e) {
          console.warn(`Error scanning conda envs: ${e}`);
        }
      }
    }

    return envs;
  }

  /**
   * Find pyenv Python versions
   */
  private findPyenvVersions(): DiscoveryCandidate[] {
    const envs: DiscoveryCandidate[] = [];
    const pyenvRoot = this.getPyenvVersionsPath();

    if (!fs.existsSync(pyenvRoot)) {
      return envs;
    }

    try {
      for (const versionDir of fs.readdirSync(pyenvRoot)) {
        const versionPath = path.join(pyenvRoot, versionDir);
        if (!fs.statSync(versionPath).isDirectory()) continue;

        const pythonPath = path.join(versionPath, 'bin', 'python');
        if (fs.existsSync(pythonPath)) {
          envs.push({
            path: pythonPath,
            envType: 'pyenv',
            envName: versionDir,
          });
        }
      }
    } catch (e) {
      console.warn(`Error scanning pyenv versions: ${e}`);
    }

    return envs;
  }

  /**
   * Find virtualenvs in common locations
   */
  private findVirtualenvs(): DiscoveryCandidate[] {
    const envs: DiscoveryCandidate[] = [];

    for (const venvDir of this.getVirtualenvPaths()) {
      if (!fs.existsSync(venvDir)) continue;

      try {
        for (const envName of fs.readdirSync(venvDir)) {
          const envPath = path.join(venvDir, envName);
          if (!fs.statSync(envPath).isDirectory()) continue;

          const pythonPath = path.join(envPath, 'bin', 'python');
          if (fs.existsSync(pythonPath)) {
            envs.push({
              path: pythonPath,
              envType: 'venv',
              envName,
            });
          }
        }
      } catch (e) {
        console.warn(`Error scanning virtualenvs: ${e}`);
      }
    }

    return envs;
  }

  /**
   * Find system Python installations
   */
  private findSystemPythons(): DiscoveryCandidate[] {
    const envs: DiscoveryCandidate[] = [];
    const seen = new Set<string>();

    for (const pythonPath of this.getSystemPythonPaths()) {
      if (!fs.existsSync(pythonPath)) continue;

      // Resolve symlinks to avoid duplicates
      try {
        const realPath = fs.realpathSync(pythonPath);
        if (seen.has(realPath)) continue;
        seen.add(realPath);
      } catch {
        continue;
      }

      const envType: PythonEnvType = pythonPath.toLowerCase().includes('homebrew') ||
        pythonPath.includes('/opt/homebrew') ? 'homebrew' : 'system';

      envs.push({
        path: pythonPath,
        envType,
        envName: null,
      });
    }

    return envs;
  }

  /**
   * Enrich a candidate with version and ipykernel info
   */
  private async enrichEnvironment(candidate: DiscoveryCandidate): Promise<PythonEnvironment | null> {
    const version = await this.getPythonVersion(candidate.path);
    if (!version) {
      return null;
    }

    const hasIpykernel = await this.checkIpykernel(candidate.path);
    const displayName = this.generateDisplayName(version, candidate.envType, candidate.envName);

    return {
      path: candidate.path,
      version,
      displayName,
      envType: candidate.envType,
      envName: candidate.envName,
      hasIpykernel,
      kernelName: null,
    };
  }

  /**
   * Perform the actual discovery (internal, always runs full scan)
   */
  private async performDiscovery(): Promise<PythonEnvironment[]> {
    console.log('Discovering Python environments...');

    // Collect all candidates
    const candidates: DiscoveryCandidate[] = [];
    candidates.push(...(await this.findCondaEnvs()));
    candidates.push(...this.findPyenvVersions());
    candidates.push(...this.findVirtualenvs());
    candidates.push(...this.findSystemPythons());

    // Enrich in parallel
    const enrichPromises = candidates.map(c => this.enrichEnvironment(c));
    const results = await Promise.all(enrichPromises);

    const environments = results.filter((e): e is PythonEnvironment => e !== null);

    // Sort and cache
    const sorted = this.sortEnvironments(environments);

    // Save to cache
    const cacheMap: Record<string, PythonEnvironment> = {};
    for (const env of sorted) {
      cacheMap[env.path] = env;
    }
    this.saveToCache(cacheMap);

    console.log(`Discovered ${sorted.length} Python environments`);
    return sorted;
  }

  /**
   * Trigger background refresh (non-blocking)
   */
  private triggerBackgroundRefresh(): void {
    if (this.backgroundRefreshInProgress) {
      return; // Already refreshing
    }

    this.backgroundRefreshInProgress = true;
    console.log('Starting background Python environment refresh...');

    // Run discovery in background, don't await
    this.performDiscovery()
      .then(() => {
        console.log('Background Python environment refresh complete');
      })
      .catch((e) => {
        console.warn('Background Python environment refresh failed:', e);
      })
      .finally(() => {
        this.backgroundRefreshInProgress = false;
      });
  }

  /**
   * Discover all Python environments
   *
   * Uses stale-while-revalidate pattern:
   * - If cache exists (even stale): return immediately, refresh in background if stale
   * - If no cache: block and perform full discovery
   * - If forceRefresh: block and perform full discovery
   */
  async discover(options: { forceRefresh?: boolean } = {}): Promise<PythonEnvironment[]> {
    const { forceRefresh = false } = options;

    // Force refresh: always block and run full discovery
    if (forceRefresh) {
      return this.performDiscovery();
    }

    // Cache valid: return immediately
    if (this.isCacheValid()) {
      return this.sortEnvironments(Object.values(this.cache));
    }

    // Cache exists but stale: return stale cache, refresh in background
    const cachedEnvs = this.getFromCache();
    if (cachedEnvs) {
      this.triggerBackgroundRefresh();
      return this.sortEnvironments(Object.values(cachedEnvs));
    }

    // No cache at all: must block and discover
    return this.performDiscovery();
  }

  /**
   * Check if background refresh is in progress
   */
  isRefreshing(): boolean {
    return this.backgroundRefreshInProgress;
  }

  /**
   * Install ipykernel and register as Jupyter kernel
   */
  async installKernel(pythonPath: string, kernelName?: string): Promise<InstallKernelResult> {
    if (!fs.existsSync(pythonPath)) {
      throw new Error(`Python not found: ${pythonPath}`);
    }

    console.log(`Installing ipykernel for ${pythonPath}...`);

    // Install ipykernel
    try {
      execSync(`"${pythonPath}" -m pip install ipykernel -q`, {
        timeout: this.kernelInstallTimeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new Error(`Failed to install ipykernel: ${e}`);
    }

    // Generate kernel name if not provided
    if (!kernelName) {
      const version = await this.getPythonVersion(pythonPath) || '3';
      kernelName = this.generateKernelName(pythonPath, version);
    }

    // Register kernel
    console.log(`Registering kernel as ${kernelName}...`);
    try {
      execSync(`"${pythonPath}" -m ipykernel install --user --name "${kernelName}"`, {
        timeout: this.registrationTimeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (e) {
      throw new Error(`Failed to register kernel: ${e}`);
    }

    // Update cache entry
    if (this.cache[pythonPath]) {
      this.cache[pythonPath].hasIpykernel = true;
      this.cache[pythonPath].kernelName = kernelName;
      this.saveToCache(this.cache);
    }

    return {
      kernelName,
      pythonPath,
      message: `Successfully registered kernel '${kernelName}'`,
    };
  }
}

// Global instance with default configuration
export const pythonDiscovery = new PythonDiscoveryService();
