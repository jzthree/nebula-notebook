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
 * Silent on command-not-found errors (expected on systems without GPU tools)
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
      // Only log actual timeouts - these are important
      console.warn(`[ResourceService] Command timed out after ${timeoutMs}ms: ${cmd.split(' ')[0]}`);
    }
    // Don't log command-not-found or other errors - expected on systems without GPU tools
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
 * Handles multiple output formats across rocm-smi versions
 */
function parseRocmSmi(stdout: string): GPUInfo | null {
  try {
    const devices: GPUDevice[] = [];
    const deviceMap = new Map<number, Partial<GPUDevice>>();

    const lines = stdout.trim().split('\n');

    for (const line of lines) {
      // Format 1: GPU[0] : vram Total Memory (B): 17163091968
      const gpuBracketMatch = line.match(/GPU\[(\d+)\]/);
      if (gpuBracketMatch) {
        const index = parseInt(gpuBracketMatch[1], 10);
        if (!deviceMap.has(index)) {
          deviceMap.set(index, { index, name: `AMD GPU ${index}` });
        }
        const device = deviceMap.get(index)!;

        // Match memory values (in bytes) - handles "Total Memory" and "Used Memory"
        if (line.includes('Total Memory') && !line.includes('Used')) {
          const match = line.match(/:\s*(\d+)\s*$/);
          if (match) {
            device.memoryTotal = Math.round((parseInt(match[1], 10) / (1024 ** 3)) * 100) / 100;
          }
        } else if (line.includes('Used Memory') || line.includes('Total Used')) {
          const match = line.match(/:\s*(\d+)\s*$/);
          if (match) {
            device.memoryUsed = Math.round((parseInt(match[1], 10) / (1024 ** 3)) * 100) / 100;
          }
        }
        continue;
      }

      // Format 2: Table format with GPU index in first column
      // GPU  Temp   AvgPwr  SCLK    MCLK     Fan  Perf  PwrCap  VRAM%  GPU%
      // 0    45c    35.0W   300Mhz  1200Mhz  0%   auto  250.0W  5%     0%
      const tableMatch = line.match(/^(\d+)\s+\d+c/);
      if (tableMatch) {
        const index = parseInt(tableMatch[1], 10);
        if (!deviceMap.has(index)) {
          deviceMap.set(index, { index, name: `AMD GPU ${index}` });
        }
        // Extract VRAM% if present
        const vramMatch = line.match(/(\d+)%\s+\d+%\s*$/);
        if (vramMatch) {
          const device = deviceMap.get(index)!;
          // We only get percentage, not absolute values in this format
          device.utilization = parseInt(vramMatch[1], 10);
        }
      }
    }

    let totalUsed = 0;
    let totalMemory = 0;

    for (const [, device] of deviceMap) {
      // Accept device if we have both memory values, or at least an index
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
  } catch {
    // Silent failure - parsing errors are not critical
    return null;
  }
}

/**
 * Collect GPU info - tries nvidia-smi first, then rocm-smi
 * Returns null if no GPU or collection fails
 * Only reports errors for actual problems (timeouts), not for missing tools
 */
async function collectGPUs(): Promise<{ gpus: GPUInfo | null; error?: ServerResources['gpuError'] }> {
  // Try NVIDIA first (more common)
  const nvidiaCmd = 'nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu --format=csv,nounits,noheader';
  const nvidiaResult = await execWithTimeout(nvidiaCmd);

  if (nvidiaResult?.stdout) {
    const gpus = parseNvidiaSmi(nvidiaResult.stdout);
    if (gpus) return { gpus };
    // Output exists but couldn't parse - continue to try rocm-smi
  }

  // Try AMD ROCm
  const rocmResult = await execWithTimeout('rocm-smi --showmeminfo vram');

  if (rocmResult?.stdout) {
    const gpus = parseRocmSmi(rocmResult.stdout);
    if (gpus) return { gpus };
    // Output exists but couldn't parse - no error, just no GPUs found
  }

  // No GPU tools found or no parseable output - this is fine, not an error
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
  private hasLoggedOnce: boolean = false;

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

      // Only log once on startup
      if (!this.hasLoggedOnce) {
        this.hasLoggedOnce = true;
        if (gpuResult.gpus) {
          console.log(`[ResourceService] RAM ${ram.total}GB, GPU ${gpuResult.gpus.totalMemory}GB (${gpuResult.gpus.devices.length} ${gpuResult.gpus.vendor} device${gpuResult.gpus.devices.length > 1 ? 's' : ''})`);
        } else {
          console.log(`[ResourceService] RAM ${ram.total}GB, no GPU`);
        }
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
