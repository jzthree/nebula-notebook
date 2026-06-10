/**
 * Python Discovery Service Types
 */

export type PythonEnvType = 'system' | 'conda' | 'pyenv' | 'venv' | 'homebrew' | 'uv' | 'pixi';

export interface PythonEnvironment {
  path: string;           // Full path to python executable
  version: string;        // e.g., "3.11.5"
  displayName: string;    // e.g., "Python 3.11.5 (conda: base)"
  envType: PythonEnvType; // Environment type
  envName: string | null; // e.g., "base", "myenv"
  hasIpykernel: boolean;  // Whether ipykernel is installed
  kernelName: string | null; // If registered as Jupyter kernel
  // PEP 668: the interpreter forbids installing packages into it directly
  // (uv-managed standalone builds, Homebrew/system Python, etc.). When true,
  // Nebula must guide the user to an isolated env instead of installing in place.
  externallyManaged: boolean;
  // Copy-pasteable command that makes `ipykernel` available for this env,
  // tailored to the detected ecosystem. Null when ipykernel is already present.
  installHint: string | null;
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

// Stable error codes surfaced to the API/frontend so the UI can branch
// (e.g. show guidance) instead of parsing free-text error strings.
export type KernelProvisionErrorCode =
  | 'python_not_found'
  | 'externally_managed' // PEP 668 — cannot pip install into this interpreter
  | 'needs_ipykernel'    // ipykernel missing; user must install it first
  | 'install_failed'
  | 'register_failed';

export class KernelProvisionError extends Error {
  code: KernelProvisionErrorCode;
  installHint?: string;
  constructor(message: string, code: KernelProvisionErrorCode, installHint?: string) {
    super(message);
    this.name = 'KernelProvisionError';
    this.code = code;
    this.installHint = installHint;
  }
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
