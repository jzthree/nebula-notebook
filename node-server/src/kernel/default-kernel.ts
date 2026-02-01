/**
 * Default kernel resolution based on the Python executable in the server env.
 */

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { discoverKernelSpecs, KernelSpec } from './kernelspec';

const execFileAsync = promisify(execFile);

let defaultKernelPromise: Promise<string | null> | null = null;
let defaultKernelValue: string | null | undefined = undefined;

const DEFAULT_PYTHON_COMMANDS = [
  process.env.PYTHON,
  'python3',
  'python',
].filter(Boolean) as string[];

async function resolveRealPath(filePath: string): Promise<string> {
  try {
    return await fs.promises.realpath(filePath);
  } catch {
    return filePath;
  }
}

async function findExecutableOnPath(command: string, envPath?: string): Promise<string | null> {
  if (!envPath) return null;
  const pathEntries = envPath.split(path.delimiter).filter(Boolean);
  for (const entry of pathEntries) {
    const candidate = path.join(entry, command);
    try {
      await fs.promises.access(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // Keep searching
    }
  }
  return null;
}

async function resolveKernelPython(spec: KernelSpec): Promise<string | null> {
  const argv0 = spec.argv?.[0];
  if (!argv0) return null;
  if (path.isAbsolute(argv0)) return argv0;

  const envPath = spec.env?.PATH || process.env.PATH;
  return await findExecutableOnPath(argv0, envPath);
}

async function detectPythonExecutable(): Promise<string | null> {
  for (const cmd of DEFAULT_PYTHON_COMMANDS) {
    try {
      const { stdout } = await execFileAsync(
        cmd,
        ['-c', 'import sys; print(sys.executable)'],
        { env: process.env, timeout: 5000, maxBuffer: 1024 * 1024 }
      );
      const trimmed = stdout.trim();
      if (trimmed) return trimmed;
    } catch {
      // Try next candidate
    }
  }
  return null;
}

export async function getDefaultKernelName(): Promise<string | null> {
  if (defaultKernelValue !== undefined) {
    return defaultKernelValue;
  }

  if (!defaultKernelPromise) {
    defaultKernelPromise = (async () => {
      const pythonExe = await detectPythonExecutable();
      if (!pythonExe) return null;

      const pythonReal = await resolveRealPath(pythonExe);
      const specs = discoverKernelSpecs();

      for (const spec of specs) {
        const resolved = await resolveKernelPython(spec);
        if (!resolved) continue;
        const resolvedReal = await resolveRealPath(resolved);
        if (resolvedReal === pythonReal) {
          return spec.name;
        }
      }

      return null;
    })()
      .then((name) => {
        defaultKernelValue = name;
        return name;
      })
      .catch((err) => {
        console.warn('[DefaultKernel] Failed to detect default kernel:', err);
        defaultKernelValue = null;
        return null;
      });
  }

  return defaultKernelPromise;
}

export function invalidateDefaultKernelName(): void {
  defaultKernelValue = undefined;
  defaultKernelPromise = null;
}
