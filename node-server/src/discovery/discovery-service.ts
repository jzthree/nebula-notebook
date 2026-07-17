/**
 * Python Discovery Service
 *
 * Discovers Python environments on the system (conda, pyenv, venv, system).
 * Node.js port of the Python PythonDiscoveryService.
 */

import * as fs from 'fs';
import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import {
  PythonEnvironment,
  PythonEnvType,
  DiscoveryCandidate,
  CacheData,
  CacheInfo,
  InstallKernelResult,
  KernelProvisionError,
  DEFAULT_CACHE_TTL_HOURS,
  DEFAULT_VERSION_CHECK_TIMEOUT_MS,
  DEFAULT_IPYKERNEL_CHECK_TIMEOUT_MS,
  DEFAULT_KERNEL_INSTALL_TIMEOUT_MS,
  DEFAULT_REGISTRATION_TIMEOUT_MS,
} from './types';
import {
  CondaLocatorContext,
  collectCondaEnvs,
  defaultCondaContext,
  pythonExeForPrefix,
  prefixForPythonExe,
  isCondaEnv,
  findCondaLikeBinaries,
  findExecutableOnPath,
} from './conda-locations';

export interface DiscoveryServiceOptions {
  cacheFile?: string;
  cacheTtlHours?: number;
  versionCheckTimeoutMs?: number;
  ipykernelCheckTimeoutMs?: number;
  kernelInstallTimeoutMs?: number;
  registrationTimeoutMs?: number;
  /** Test seam: override home dir / env vars for the conda locator. */
  condaLocator?: { home?: string; env?: Record<string, string | undefined> };
}

const DEFAULT_CACHE_FILE = path.join(os.homedir(), '.nebula-notebook', 'python-cache.json');

export class PythonDiscoveryService {
  private cache: Record<string, PythonEnvironment> = {};
  private cacheTimestamp: number = 0;
  private cacheFile: string;
  private cacheTtlHours: number;
  private versionCheckTimeoutMs: number;
  private ipykernelCheckTimeoutMs: number;
  private kernelInstallTimeoutMs: number;
  private registrationTimeoutMs: number;
  private condaLocatorOverrides: { home?: string; env?: Record<string, string | undefined> };
  private backgroundRefreshInProgress: boolean = false;

  constructor(options: DiscoveryServiceOptions = {}) {
    this.cacheFile = options.cacheFile || DEFAULT_CACHE_FILE;
    this.cacheTtlHours = options.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS;
    this.versionCheckTimeoutMs = options.versionCheckTimeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;
    this.ipykernelCheckTimeoutMs = options.ipykernelCheckTimeoutMs ?? DEFAULT_IPYKERNEL_CHECK_TIMEOUT_MS;
    this.kernelInstallTimeoutMs = options.kernelInstallTimeoutMs ?? DEFAULT_KERNEL_INSTALL_TIMEOUT_MS;
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? DEFAULT_REGISTRATION_TIMEOUT_MS;
    this.condaLocatorOverrides = options.condaLocator ?? {};

    this.loadCache();
  }

  /** Context for the filesystem conda locator (test seam applied). */
  condaContext(): CondaLocatorContext {
    const ctx = defaultCondaContext();
    if (this.condaLocatorOverrides.home) ctx.home = this.condaLocatorOverrides.home;
    if (this.condaLocatorOverrides.env) ctx.env = this.condaLocatorOverrides.env;
    return ctx;
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
   * Run a command asynchronously with timeout. `onData` receives every
   * stdout/stderr chunk as it arrives (interleaved), for callers that
   * surface live progress (the ipykernel install modal).
   */
  private runCommand(
    command: string,
    args: string[],
    timeoutMs: number,
    onData?: (chunk: string) => void
  ): Promise<{ stdout: string; stderr: string }> {
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
        onData?.(data.toString());
      });
      child.stderr?.on('data', (data) => {
        stderr += data.toString();
        onData?.(data.toString());
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
    } else if (envType === 'pixi') {
      return `Python ${version} (pixi${envName ? `: ${envName}` : ''})`;
    } else if (envType === 'uv') {
      return `Python ${version} (uv-managed)`;
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
      pixi: 3,
      uv: 4,
      homebrew: 5,
      system: 6,
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
   * Async existence check. The discovery scan MUST use this (not existsSync):
   * env dirs often live on network filesystems (GPFS) where each sync stat can
   * take 10-500ms, and the scan runs dozens — enough to freeze the entire
   * event loop for seconds (observed as "terminal dead during autosave").
   */
  private async fsExists(p: string): Promise<boolean> {
    try { await fsp.access(p); return true; } catch { return false; }
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
    return (await this.probeEnvironment(pythonPath)).hasIpykernel;
  }

  /**
   * Probe an interpreter for the two facts that drive kernel provisioning, in a
   * single Python invocation (keeps discovery cheap — one spawn per env):
   *   - whether `ipykernel` is importable
   *   - whether the interpreter is PEP 668 "externally managed" (an
   *     `EXTERNALLY-MANAGED` marker beside the stdlib), which blocks pip installs.
   *
   * Detecting the marker file is capability-based and stable: we ask Python
   * itself rather than fingerprinting tool names by path, so it keeps working as
   * new package managers (uv, pixi, …) appear.
   */
  private async probeEnvironment(pythonPath: string): Promise<{ hasIpykernel: boolean; externallyManaged: boolean; isVenv: boolean }> {
    const script = [
      'import json, os, sys, sysconfig',
      'from importlib.util import find_spec',
      'stdlib = sysconfig.get_path("stdlib") or ""',
      'marker = bool(stdlib) and os.path.exists(os.path.join(stdlib, "EXTERNALLY-MANAGED"))',
      // A virtual environment always allows pip installs — PEP 668 enforcement is
      // skipped inside venvs (pip checks sys.prefix != sys.base_prefix), even when
      // the venv's base interpreter carries the EXTERNALLY-MANAGED marker.
      'in_venv = sys.prefix != sys.base_prefix',
      'em = marker and not in_venv',
      'ik = find_spec("ipykernel") is not None',
      'print(json.dumps({"ipykernel": ik, "externally_managed": em, "venv": in_venv}))',
    ].join('; ');
    try {
      const { stdout } = await this.runCommand(pythonPath, ['-c', script], this.ipykernelCheckTimeoutMs);
      const parsed = JSON.parse(stdout.trim().split('\n').pop() || '{}');
      return {
        hasIpykernel: !!parsed.ipykernel,
        externallyManaged: !!parsed.externally_managed,
        isVenv: !!parsed.venv,
      };
    } catch {
      return { hasIpykernel: false, externallyManaged: false, isVenv: false };
    }
  }

  /**
   * Refine an environment's type using stable path markers that the coarse
   * discovery scans miss. Only used to pick a better label / guidance hint —
   * the safe-vs-unsafe install decision relies on `externallyManaged`, not this.
   *
   * A venv is left as-is: its `bin/python` symlinks to (and `sysconfig` resolves
   * to) its base interpreter, so following the symlink to e.g. a uv-managed build
   * must NOT relabel the venv itself as "uv".
   */
  private classifyEnvType(originalPath: string, realPath: string, current: PythonEnvType, isVenv: boolean): PythonEnvType {
    const o = originalPath.replace(/\\/g, '/');
    const r = realPath.replace(/\\/g, '/');
    if (o.includes('/.pixi/envs/') || r.includes('/.pixi/envs/')) return 'pixi';
    // uv-managed standalone interpreters live under .../uv/python/cpython-* . Only
    // a bare interpreter qualifies — a venv built on one stays a venv.
    if (!isVenv && (r.includes('/uv/python/') || r.includes('/.local/share/uv/'))) return 'uv';
    return current;
  }

  /**
   * Build a copy-pasteable command that makes `ipykernel` available for an env,
   * tailored to the detected ecosystem. After the user runs it (and clicks
   * Refresh), the env shows up with ipykernel and Nebula offers one-click
   * Register — Nebula never installs packages itself.
   *
   * Returns null when ipykernel is already present (nothing to do but Register).
   */
  private buildInstallHint(
    pythonPath: string,
    envType: PythonEnvType,
    envName: string | null,
    hasIpykernel: boolean,
    externallyManaged: boolean
  ): string | null {
    if (hasIpykernel) return null;
    const py = pythonPath.includes(' ') ? `"${pythonPath}"` : pythonPath;

    // Installable in place: not externally managed → use the env's own manager.
    if (!externallyManaged) {
      if (envType === 'conda') {
        // -p <prefix> works for named, base AND path-based (-p created) envs;
        // -n would silently target the wrong env for the path-based ones.
        const prefix = path.basename(path.dirname(pythonPath)) === 'bin'
          ? path.dirname(path.dirname(pythonPath))
          : path.dirname(pythonPath);
        const p = prefix.includes(' ') ? `"${prefix}"` : prefix;
        return `conda install -p ${p} ipykernel -y`;
      }
      if (envType === 'pixi') {
        return `pixi add ipykernel`;
      }
      // venv / pyenv / plain: pip into the interpreter directly.
      return `${py} -m pip install ipykernel`;
    }

    // Externally managed (PEP 668): can't install in place — create an isolated
    // env Nebula will then discover under ~/.venvs.
    if (envType === 'uv') {
      return `uv venv ~/.venvs/nebula && uv pip install --python ~/.venvs/nebula/bin/python ipykernel`;
    }
    return `${py} -m venv ~/.venvs/nebula && ~/.venvs/nebula/bin/python -m pip install ipykernel`;
  }

  /**
   * Public probe for kernel provisioning: does this interpreter have ipykernel,
   * can we install into it, and if not — what should the user run instead?
   * Uses the discovery cache for env-type context (better hints) but always
   * probes the interpreter live, so a just-installed ipykernel is seen
   * immediately even with a stale cache.
   */
  async probeForKernel(pythonPath: string): Promise<{
    hasIpykernel: boolean;
    externallyManaged: boolean;
    installHint: string | null;
  }> {
    const { hasIpykernel, externallyManaged } = await this.probeEnvironment(pythonPath);
    const cached = this.cache[pythonPath];
    const installHint = this.buildInstallHint(
      pythonPath,
      cached?.envType ?? 'system',
      cached?.envName ?? null,
      hasIpykernel,
      externallyManaged
    );
    return { hasIpykernel, externallyManaged, installHint };
  }

  /**
   * Find conda environments — pure filesystem forensics (see conda-locations.ts).
   * conda/mamba are never executed: envs come from ~/.conda/environments.txt,
   * .condarc envs_dirs, well-known roots, the CONDA_ and MAMBA_ env vars, and
   * roots derived from conda-like binaries found on PATH.
   */
  private async findCondaEnvs(): Promise<DiscoveryCandidate[]> {
    const ctx = this.condaContext();
    const envs: DiscoveryCandidate[] = [];
    const seenPaths = new Set<string>();

    for (const loc of await collectCondaEnvs(ctx)) {
      const pythonPath = pythonExeForPrefix(loc.prefix, ctx.platform);
      if (seenPaths.has(pythonPath)) continue;
      // An env can legitimately lack python (e.g. `conda create` without it) —
      // nothing to offer as a kernel, skip.
      if (!(await this.fsExists(pythonPath))) continue;
      seenPaths.add(pythonPath);
      envs.push({
        path: pythonPath,
        envType: 'conda',
        envName: loc.envName,
        base: loc.base ?? loc.prefix,
      });
    }

    return envs;
  }

  /**
   * Find pyenv Python versions
   */
  private async findPyenvVersions(): Promise<DiscoveryCandidate[]> {
    const envs: DiscoveryCandidate[] = [];
    const pyenvRoot = this.getPyenvVersionsPath();

    try {
      const entries = await fsp.readdir(pyenvRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
        const pythonPath = path.join(pyenvRoot, entry.name, 'bin', 'python');
        if (await this.fsExists(pythonPath)) {
          envs.push({
            path: pythonPath,
            envType: 'pyenv',
            envName: entry.name,
          });
        }
      }
    } catch {
      // pyenv root missing/unreadable — nothing to scan
    }

    return envs;
  }

  /**
   * Find virtualenvs in common locations
   */
  private async findVirtualenvs(): Promise<DiscoveryCandidate[]> {
    const envs: DiscoveryCandidate[] = [];

    for (const venvDir of this.getVirtualenvPaths()) {
      try {
        const entries = await fsp.readdir(venvDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
          const pythonPath = path.join(venvDir, entry.name, 'bin', 'python');
          if (await this.fsExists(pythonPath)) {
            envs.push({
              path: pythonPath,
              envType: 'venv',
              envName: entry.name,
            });
          }
        }
      } catch {
        // venv dir missing/unreadable — nothing to scan
      }
    }

    return envs;
  }

  /**
   * Find system Python installations
   */
  private async findSystemPythons(): Promise<DiscoveryCandidate[]> {
    const envs: DiscoveryCandidate[] = [];
    const seen = new Set<string>();

    for (const pythonPath of this.getSystemPythonPaths()) {
      // Resolve symlinks to avoid duplicates (also serves as the existence check)
      let realPath: string;
      try {
        realPath = await fsp.realpath(pythonPath);
      } catch {
        continue;
      }
      if (seen.has(realPath)) continue;
      seen.add(realPath);

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

    const { hasIpykernel, externallyManaged, isVenv } = await this.probeEnvironment(candidate.path);

    // Refine the type via stable path markers (uv/pixi) that the coarse scans
    // can't distinguish; resolve symlinks first (e.g. ~/.local/bin/python3 → uv).
    let realPath = candidate.path;
    try { realPath = await fsp.realpath(candidate.path); } catch { /* keep original */ }
    const envType = this.classifyEnvType(candidate.path, realPath, candidate.envType, isVenv);

    const displayName = this.generateDisplayName(version, envType, candidate.envName);
    const installHint = this.buildInstallHint(
      candidate.path, envType, candidate.envName, hasIpykernel, externallyManaged
    );

    return {
      path: candidate.path,
      version,
      displayName,
      envType,
      envName: candidate.envName,
      hasIpykernel,
      kernelName: null,
      externallyManaged,
      installHint,
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
    candidates.push(...(await this.findPyenvVersions()));
    candidates.push(...(await this.findVirtualenvs()));
    candidates.push(...(await this.findSystemPythons()));

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
   * Register a Python environment as a Jupyter kernel.
   *
   * Policy (capability-based, see ADR in the kernel onboarding flow):
   *   - If `ipykernel` is already importable → just register the kernelspec.
   *     This is the safe, universal path and works for every ecosystem.
   *   - If `ipykernel` is missing and the interpreter is PEP 668 externally
   *     managed → refuse, with a `needs_ipykernel`/`externally_managed` code so
   *     the UI shows guidance instead of a raw pip traceback. Nebula does not
   *     install into managed interpreters.
   *   - If `ipykernel` is missing but the interpreter is writable (a plain venv,
   *     conda env, …) → install it, then register. This keeps the API usable for
   *     deliberate callers (MCP, scripts); the UI funnels everything through the
   *     register-only path.
   */
  async installKernel(pythonPath: string, kernelName?: string): Promise<InstallKernelResult> {
    if (!(await this.fsExists(pythonPath))) {
      throw new KernelProvisionError(`Python not found: ${pythonPath}`, 'python_not_found');
    }

    const { hasIpykernel, externallyManaged } = await this.probeEnvironment(pythonPath);

    if (!hasIpykernel) {
      if (externallyManaged) {
        const version = await this.getPythonVersion(pythonPath);
        const hint = this.buildInstallHint(pythonPath, 'system', null, false, true);
        throw new KernelProvisionError(
          `This Python (${version || pythonPath}) is externally managed (PEP 668) and ipykernel is not installed, ` +
          `so Nebula can't install it here. Set up ipykernel in an isolated environment, then Register it.`,
          'externally_managed',
          hint || undefined
        );
      }
      // Writable env without ipykernel: install it (safe — not externally managed).
      // Async spawn (NOT execSync): a pip install can run 30s+, and execSync
      // would freeze the whole server for that long.
      console.log(`Installing ipykernel for ${pythonPath}...`);
      try {
        await this.runCommand(pythonPath, ['-m', 'pip', 'install', 'ipykernel', '-q'], this.kernelInstallTimeoutMs);
      } catch (e) {
        const detail = this.errorOutput(e);
        // A late-detected PEP 668 (marker absent but pip still refused): treat as managed.
        if (this.isExternallyManagedError(detail)) {
          const hint = this.buildInstallHint(pythonPath, 'system', null, false, true);
          throw new KernelProvisionError(
            `This Python blocks package installation (PEP 668). Set up ipykernel in an isolated environment, then Register it.`,
            'externally_managed',
            hint || undefined
          );
        }
        throw new KernelProvisionError(`Failed to install ipykernel: ${detail || e}`, 'install_failed');
      }
    }

    // Generate kernel name if not provided
    if (!kernelName) {
      const version = await this.getPythonVersion(pythonPath) || '3';
      kernelName = this.generateKernelName(pythonPath, version);
    }

    // Register kernel (async spawn — see pip install above)
    console.log(`Registering kernel as ${kernelName}...`);
    try {
      await this.runCommand(pythonPath, ['-m', 'ipykernel', 'install', '--user', '--name', kernelName], this.registrationTimeoutMs);
    } catch (e) {
      throw new KernelProvisionError(`Failed to register kernel: ${this.errorOutput(e) || e}`, 'register_failed');
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

  /**
   * Probe a manually-entered interpreter path, classify it (conda-meta →
   * conda, pyvenv.cfg → venv, else system + the usual uv/pixi refinement),
   * and persist it into the discovery cache so it shows up in the picker from
   * now on. VSCode's "Enter interpreter path…" equivalent.
   */
  async probeAndRemember(pythonPath: string): Promise<PythonEnvironment> {
    if (!(await this.fsExists(pythonPath))) {
      throw new KernelProvisionError(`Python not found: ${pythonPath}`, 'python_not_found');
    }

    const prefix = prefixForPythonExe(pythonPath);
    let envType: PythonEnvType = 'system';
    let envName: string | null = null;
    if (await isCondaEnv(prefix)) {
      envType = 'conda';
      envName = path.basename(prefix);
    } else if (await this.fsExists(path.join(prefix, 'pyvenv.cfg'))) {
      envType = 'venv';
      envName = path.basename(prefix);
    }

    const env = await this.enrichEnvironment({ path: pythonPath, envType, envName });
    if (!env) {
      throw new KernelProvisionError(
        `${pythonPath} did not respond to --version — not a working Python interpreter`,
        'python_not_found'
      );
    }

    this.cache[pythonPath] = env;
    this.saveToCache(this.cache);
    return env;
  }

  /**
   * Pick ONE installer for ipykernel, up front (VSCode's shape — no fallback
   * chain at run time, so failures are attributable and honest):
   *   1. conda env → a conda-like binary (conda/mamba/micromamba; PATH first,
   *      then known roots) with `-p <prefix>` — correct for named, base and
   *      path-based envs alike.
   *   2. uv on PATH → `uv pip install --python <exe>` — works on ANY env,
   *      including conda envs without a conda binary and envs without pip.
   *   3. the env's own pip.
   */
  async planIpykernelInstall(pythonPath: string): Promise<{ kind: 'conda' | 'uv' | 'pip'; argv: string[] }> {
    const ctx = this.condaContext();
    const prefix = prefixForPythonExe(pythonPath);
    if (await isCondaEnv(prefix)) {
      const bins = await findCondaLikeBinaries(ctx);
      if (bins.length > 0) {
        return { kind: 'conda', argv: [bins[0], 'install', '-p', prefix, 'ipykernel', '-y'] };
      }
    }
    const uv = await findExecutableOnPath('uv', ctx);
    if (uv) {
      return { kind: 'uv', argv: [uv, 'pip', 'install', '--python', pythonPath, 'ipykernel'] };
    }
    return { kind: 'pip', argv: [pythonPath, '-m', 'pip', 'install', 'ipykernel'] };
  }

  /**
   * Install ipykernel into an environment with the planned installer, then
   * VERIFY it actually became importable. Refuses PEP 668 externally-managed
   * interpreters up front (with guidance). Failure carries the installer's
   * output — no silent fallback to a different installer.
   */
  async installIpykernel(
    pythonPath: string,
    onOutput?: (chunk: string) => void
  ): Promise<{ installer: 'none' | 'conda' | 'uv' | 'pip'; message: string }> {
    if (!(await this.fsExists(pythonPath))) {
      throw new KernelProvisionError(`Python not found: ${pythonPath}`, 'python_not_found');
    }

    const before = await this.probeEnvironment(pythonPath);
    if (before.hasIpykernel) {
      return { installer: 'none', message: 'ipykernel is already installed' };
    }
    const cached = this.cache[pythonPath];
    const hint = this.buildInstallHint(
      pythonPath, cached?.envType ?? 'system', cached?.envName ?? null, false, before.externallyManaged
    );
    if (before.externallyManaged) {
      throw new KernelProvisionError(
        `This Python is externally managed (PEP 668) — Nebula won't install into it. ` +
        `Set up ipykernel in an isolated environment instead.`,
        'externally_managed',
        hint || undefined
      );
    }

    const plan = await this.planIpykernelInstall(pythonPath);
    console.log(`Installing ipykernel via ${plan.kind}: ${plan.argv.join(' ')}`);
    // Echo the exact command first so the user sees WHAT ran, then live output.
    onOutput?.(`$ ${plan.argv.join(' ')}\n`);
    try {
      await this.runCommand(plan.argv[0], plan.argv.slice(1), this.kernelInstallTimeoutMs, onOutput);
    } catch (e) {
      const detail = this.errorOutput(e);
      if (this.isExternallyManagedError(detail)) {
        throw new KernelProvisionError(
          'This Python blocks package installation (PEP 668). Set up ipykernel in an isolated environment instead.',
          'externally_managed',
          hint || undefined
        );
      }
      // Honest failure: name the installer and surface the tail of its output.
      const tail = detail.trim().split('\n').slice(-8).join('\n').slice(-600);
      throw new KernelProvisionError(
        `${plan.kind} failed to install ipykernel${tail ? `:\n${tail}` : ''}`,
        'install_failed',
        hint || undefined
      );
    }

    const after = await this.probeEnvironment(pythonPath);
    if (!after.hasIpykernel) {
      throw new KernelProvisionError(
        `${plan.kind} reported success but ipykernel is still not importable in ${pythonPath}`,
        'install_failed',
        hint || undefined
      );
    }

    // Reflect reality in the cache so the picker updates without a rescan.
    if (this.cache[pythonPath]) {
      this.cache[pythonPath].hasIpykernel = true;
      this.cache[pythonPath].installHint = null;
      this.saveToCache(this.cache);
    }

    return { installer: plan.kind, message: `Installed ipykernel via ${plan.kind}` };
  }

  /** Extract combined stdout+stderr text from a child_process error. */
  private errorOutput(e: unknown): string {
    const err = e as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
    const parts = [err?.stderr, err?.stdout, err?.message]
      .map(p => (p == null ? '' : p.toString()))
      .filter(Boolean);
    return parts.join('\n');
  }

  /** Detect PEP 668 "externally managed" refusals generically (not tool-specific). */
  private isExternallyManagedError(msg: string): boolean {
    const m = (msg || '').toLowerCase();
    return m.includes('externally-managed')
      || m.includes('externally managed')
      || m.includes('break-system-packages')
      || m.includes('pep 668');
  }
}

// Global instance with default configuration
export const pythonDiscovery = new PythonDiscoveryService();

