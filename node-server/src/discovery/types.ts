/**
 * Python Discovery Service Types
 */

export type PythonEnvType = 'system' | 'conda' | 'pyenv' | 'venv' | 'homebrew';

export interface PythonEnvironment {
  path: string;           // Full path to python executable
  version: string;        // e.g., "3.11.5"
  displayName: string;    // e.g., "Python 3.11.5 (conda: base)"
  envType: PythonEnvType; // Environment type
  envName: string | null; // e.g., "base", "myenv"
  hasIpykernel: boolean;  // Whether ipykernel is installed
  kernelName: string | null; // If registered as Jupyter kernel
}

export interface DiscoveryCandidate {
  path: string;
  envType: PythonEnvType;
  envName: string | null;
  base?: string; // For conda - the base conda path
}

export interface CacheData {
  environments: Record<string, PythonEnvironment>;
  timestamp: number;
}

export interface InstallKernelResult {
  kernelName: string;
  pythonPath: string;
  message: string;
}

export interface CacheInfo {
  cachedCount: number;
  cacheAgeHours: number | null;
  cacheValid: boolean;
  cacheFile: string;
}

// Configuration defaults
export const DEFAULT_CACHE_TTL_HOURS = 24;
export const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 5000;
export const DEFAULT_IPYKERNEL_CHECK_TIMEOUT_MS = 10000;
export const DEFAULT_CONDA_LIST_TIMEOUT_MS = 30000;
export const DEFAULT_KERNEL_INSTALL_TIMEOUT_MS = 120000;
export const DEFAULT_REGISTRATION_TIMEOUT_MS = 60000;
