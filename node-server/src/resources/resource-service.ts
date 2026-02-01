/**
 * Resource Service
 *
 * Collects system resources (RAM, GPU) with defensive timeouts.
 * Resource collection is OPTIONAL and must NEVER block core functionality.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);

// Types
export interface GPUDevice {
  index: number;
  name: string;
  memoryUsed: number;   // GB
  memoryTotal: number;  // GB
  utilization?: number; // %
  temperature?: number; // Celsius
}

export interface GPUInfo {
  vendor: 'nvidia' | 'amd';
  devices: GPUDevice[];
  totalUsed: number;    // GB
  totalMemory: number;  // GB
}

export interface RAMInfo {
  used: number;   // GB
  total: number;  // GB
  percent: number;
}

export interface ServerResources {
  hostname: string;
  ram: RAMInfo;
  gpus: GPUInfo | null;
  gpuError?: 'timeout' | 'not_found' | 'parse_error' | 'command_failed';
  collectedAt: number;
}

// Constants
const GPU_COMMAND_TIMEOUT_MS = 3000;  // 3 seconds - kill if hung
const CACHE_TTL_MS = 30000;           // 30 seconds cache
const STALE_THRESHOLD_MS = 60000;     // 60 seconds before marking stale

/**
 * Execute command with strict timeout
 * Returns null on any failure - never throws
 */
async function execWithTimeout(
  cmd: string,
  timeoutMs: number = GPU_COMMAND_TIMEOUT_MS
): Promise<{ stdout: string; error?: string } | null> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      timeout: timeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024, // 1MB buffer
    });
    return { stdout: stdout.trim(), error: stderr?.trim() };
  } catch (err: any) {
    if (err.killed) {
      console.warn(`[ResourceService] Command timed out after ${timeoutMs}ms: ${cmd}`);
    } else if (err.code === 'ENOENT') {
      // Command not found - this is fine
    } else {
      console.warn(`[ResourceService] Command failed: ${cmd}`, err.message);
    }
    return null;
  }
}

/**
 * Collect RAM info using Node.js os module (always available, instant)
 */
function collectRAM(): RAMInfo {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    used: Math.round((used / (1024 ** 3)) * 100) / 100,     // GB, 2 decimals
    total: Math.round((total / (1024 ** 3)) * 100) / 100,   // GB, 2 decimals
    percent: Math.round((used / total) * 100),
  };
}

/**
 * Parse nvidia-smi CSV output
 */
function parseNvidiaSmi(stdout: string): GPUInfo | null {
  try {
    const lines = stdout.trim().split('\n').filter(line => line.trim());
    if (lines.length === 0) return null;

    const devices: GPUDevice[] = [];
    let totalUsed = 0;
    let totalMemory = 0;

    for (const line of lines) {
      // Format: index, name, memory.used [MiB], memory.total [MiB], utilization.gpu [%], temperature.gpu
      const parts = line.split(',').map(s => s.trim());
      if (parts.length < 4) continue;

      const index = parseInt(parts[0], 10);
      const name = parts[1];
      const memUsedMB = parseInt(parts[2], 10);
      const memTotalMB = parseInt(parts[3], 10);
      const utilization = parts[4] ? parseInt(parts[4], 10) : undefined;
      const temperature = parts[5] ? parseInt(parts[5], 10) : undefined;

      if (isNaN(index) || isNaN(memUsedMB) || isNaN(memTotalMB)) continue;

      const memUsedGB = Math.round((memUsedMB / 1024) * 100) / 100;
      const memTotalGB = Math.round((memTotalMB / 1024) * 100) / 100;

      devices.push({
        index,
        name,
        memoryUsed: memUsedGB,
        memoryTotal: memTotalGB,
        utilization: isNaN(utilization!) ? undefined : utilization,
        temperature: isNaN(temperature!) ? undefined : temperature,
      });

      totalUsed += memUsedGB;
      totalMemory += memTotalGB;
    }

    if (devices.length === 0) return null;

    return {
      vendor: 'nvidia',
      devices,
      totalUsed: Math.round(totalUsed * 100) / 100,
      totalMemory: Math.round(totalMemory * 100) / 100,
    };
  } catch (err) {
    console.warn('[ResourceService] Failed to parse nvidia-smi output:', err);
    return null;
  }
}

/**
 * Parse rocm-smi output for AMD GPUs
 */
function parseRocmSmi(stdout: string): GPUInfo | null {
  try {
    // rocm-smi --showmeminfo vram output format varies by version
    // Typical format:
    // GPU[0] : vram Total Memory (B): 17163091968
    // GPU[0] : vram Total Used Memory (B): 1048576

    const devices: GPUDevice[] = [];
    const deviceMap = new Map<number, Partial<GPUDevice>>();

    const lines = stdout.trim().split('\n');
    for (const line of lines) {
      // Match GPU index
      const gpuMatch = line.match(/GPU\[(\d+)\]/);
      if (!gpuMatch) continue;

      const index = parseInt(gpuMatch[1], 10);
      if (!deviceMap.has(index)) {
        deviceMap.set(index, { index, name: `AMD GPU ${index}` });
      }
      const device = deviceMap.get(index)!;

      // Match memory values (in bytes)
      if (line.includes('Total Memory')) {
        const match = line.match(/:\s*(\d+)/);
        if (match) {
          device.memoryTotal = Math.round((parseInt(match[1], 10) / (1024 ** 3)) * 100) / 100;
        }
      } else if (line.includes('Used Memory')) {
        const match = line.match(/:\s*(\d+)/);
        if (match) {
          device.memoryUsed = Math.round((parseInt(match[1], 10) / (1024 ** 3)) * 100) / 100;
        }
      }
    }

    let totalUsed = 0;
    let totalMemory = 0;

    for (const [, device] of deviceMap) {
      if (device.memoryUsed !== undefined && device.memoryTotal !== undefined) {
        devices.push(device as GPUDevice);
        totalUsed += device.memoryUsed;
        totalMemory += device.memoryTotal;
      }
    }

    if (devices.length === 0) return null;

    return {
      vendor: 'amd',
      devices: devices.sort((a, b) => a.index - b.index),
      totalUsed: Math.round(totalUsed * 100) / 100,
      totalMemory: Math.round(totalMemory * 100) / 100,
    };
  } catch (err) {
    console.warn('[ResourceService] Failed to parse rocm-smi output:', err);
    return null;
  }
}

/**
 * Collect GPU info - tries nvidia-smi first, then rocm-smi
 * Returns null if no GPU or collection fails
 */
async function collectGPUs(): Promise<{ gpus: GPUInfo | null; error?: ServerResources['gpuError'] }> {
  // Try NVIDIA first (more common)
  const nvidiaCmd = 'nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,nounits,noheader';
  const nvidiaResult = await execWithTimeout(nvidiaCmd);

  if (nvidiaResult?.stdout) {
    const gpus = parseNvidiaSmi(nvidiaResult.stdout);
    if (gpus) return { gpus };
    return { gpus: null, error: 'parse_error' };
  }

  // Check if nvidia-smi exists but timed out
  if (nvidiaResult === null) {
    // Could be timeout or not found - try to distinguish
    const whichResult = await execWithTimeout('which nvidia-smi', 1000);
    if (whichResult?.stdout) {
      // nvidia-smi exists but timed out - GPU might be stuck
      return { gpus: null, error: 'timeout' };
    }
  }

  // Try AMD ROCm
  const rocmResult = await execWithTimeout('rocm-smi --showmeminfo vram');

  if (rocmResult?.stdout) {
    const gpus = parseRocmSmi(rocmResult.stdout);
    if (gpus) return { gpus };
    return { gpus: null, error: 'parse_error' };
  }

  // Check if rocm-smi exists but failed
  if (rocmResult === null) {
    const whichResult = await execWithTimeout('which rocm-smi', 1000);
    if (whichResult?.stdout) {
      return { gpus: null, error: 'timeout' };
    }
  }

  // No GPU tools found - this is fine, not an error
  return { gpus: null };
}

/**
 * Resource Service - Singleton
 *
 * Provides cached, non-blocking access to system resources.
 */
class ResourceService {
  private cache: ServerResources | null = null;
  private cacheTime: number = 0;
  private collecting: boolean = false;
  private hostname: string;

  constructor() {
    this.hostname = os.hostname();
  }

  /**
   * Get resources - NEVER blocks, returns cached or empty
   * Triggers async collection if cache is stale
   */
  getResources(): ServerResources {
    const now = Date.now();

    // Trigger async collection if cache is stale and not already collecting
    if (!this.collecting && (now - this.cacheTime) > CACHE_TTL_MS) {
      this.collectAsync();
    }

    // Return cached data or empty resources (never block)
    return this.cache ?? this.getEmptyResources();
  }

  /**
   * Force refresh - waits for collection but still has timeout protection
   * Use sparingly (e.g., on explicit user request)
   */
  async refreshResources(): Promise<ServerResources> {
    await this.collectAsync();
    return this.cache ?? this.getEmptyResources();
  }

  /**
   * Check if cached data is stale
   */
  isStale(): boolean {
    return (Date.now() - this.cacheTime) > STALE_THRESHOLD_MS;
  }

  /**
   * Get empty resources (fallback)
   */
  private getEmptyResources(): ServerResources {
    return {
      hostname: this.hostname,
      ram: collectRAM(),  // RAM is always instant and available
      gpus: null,
      collectedAt: Date.now(),
    };
  }

  /**
   * Async collection - runs in background, updates cache
   */
  private async collectAsync(): Promise<void> {
    if (this.collecting) return;
    this.collecting = true;

    try {
      // RAM is instant, GPU may timeout (that's OK)
      const [ram, gpuResult] = await Promise.all([
        Promise.resolve(collectRAM()),
        collectGPUs(),
      ]);

      this.cache = {
        hostname: this.hostname,
        ram,
        gpus: gpuResult.gpus,
        gpuError: gpuResult.error,
        collectedAt: Date.now(),
      };
      this.cacheTime = Date.now();

      if (gpuResult.gpus) {
        console.log(`[ResourceService] Collected: RAM ${ram.used}/${ram.total}GB, GPU ${gpuResult.gpus.totalUsed}/${gpuResult.gpus.totalMemory}GB (${gpuResult.gpus.devices.length} devices)`);
      } else if (gpuResult.error) {
        console.log(`[ResourceService] Collected: RAM ${ram.used}/${ram.total}GB, GPU unavailable (${gpuResult.error})`);
      } else {
        console.log(`[ResourceService] Collected: RAM ${ram.used}/${ram.total}GB, no GPU detected`);
      }
    } catch (err) {
      console.error('[ResourceService] Collection failed:', err);
      // Still update RAM at least
      this.cache = this.getEmptyResources();
      this.cacheTime = Date.now();
    } finally {
      this.collecting = false;
    }
  }
}

// Singleton instance
let instance: ResourceService | null = null;

export function getResourceService(): ResourceService {
  if (!instance) {
    instance = new ResourceService();
  }
  return instance;
}

export { ResourceService };
