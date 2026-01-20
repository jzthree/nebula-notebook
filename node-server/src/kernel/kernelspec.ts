/**
 * Kernelspec Discovery
 *
 * Discovers Jupyter kernelspecs from standard locations.
 * Similar to jupyter_client.kernelspec.find_kernel_specs()
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KernelSpec } from './types';

// Re-export KernelSpec for convenience
export type { KernelSpec } from './types';

/**
 * Standard kernelspec search paths
 */
export function getKernelSearchPaths(): string[] {
  const paths: string[] = [];
  const home = os.homedir();

  // User-local paths
  if (process.platform === 'darwin') {
    paths.push(path.join(home, 'Library', 'Jupyter', 'kernels'));
  } else if (process.platform === 'win32') {
    paths.push(path.join(home, 'AppData', 'Roaming', 'jupyter', 'kernels'));
  } else {
    paths.push(path.join(home, '.local', 'share', 'jupyter', 'kernels'));
  }

  // System paths
  if (process.platform !== 'win32') {
    paths.push('/usr/local/share/jupyter/kernels');
    paths.push('/usr/share/jupyter/kernels');
  }

  // Conda paths
  const condaPrefix = process.env.CONDA_PREFIX;
  if (condaPrefix) {
    paths.push(path.join(condaPrefix, 'share', 'jupyter', 'kernels'));
  }

  // JUPYTER_PATH environment variable
  const jupyterPath = process.env.JUPYTER_PATH;
  if (jupyterPath) {
    for (const p of jupyterPath.split(path.delimiter)) {
      if (p) {
        paths.push(path.join(p, 'kernels'));
      }
    }
  }

  // Homebrew Python paths (macOS)
  if (process.platform === 'darwin') {
    const brewPaths = [
      '/opt/homebrew/share/jupyter/kernels',
      '/usr/local/opt/python/Frameworks/Python.framework/Versions/Current/share/jupyter/kernels',
    ];
    paths.push(...brewPaths);
  }

  // pyenv paths
  const pyenvRoot = process.env.PYENV_ROOT || path.join(home, '.pyenv');
  if (fs.existsSync(pyenvRoot)) {
    const versionsDir = path.join(pyenvRoot, 'versions');
    if (fs.existsSync(versionsDir)) {
      try {
        const versions = fs.readdirSync(versionsDir);
        for (const version of versions) {
          const kernelPath = path.join(versionsDir, version, 'share', 'jupyter', 'kernels');
          paths.push(kernelPath);
        }
      } catch {
        // Ignore read errors
      }
    }
  }

  return paths;
}

/**
 * Read a kernel.json file and return the kernelspec
 */
function readKernelSpec(kernelDir: string): KernelSpec | null {
  const kernelJsonPath = path.join(kernelDir, 'kernel.json');

  if (!fs.existsSync(kernelJsonPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(kernelJsonPath, 'utf-8');
    const spec = JSON.parse(content);

    return {
      name: path.basename(kernelDir),
      displayName: spec.display_name || path.basename(kernelDir),
      language: spec.language || 'python',
      path: kernelDir,
      argv: spec.argv,
      env: spec.env,
    };
  } catch (err) {
    console.error(`Error reading kernelspec from ${kernelDir}:`, err);
    return null;
  }
}

/**
 * Discover all available kernelspecs on the system
 */
export function discoverKernelSpecs(): KernelSpec[] {
  const specs: KernelSpec[] = [];
  const seenNames = new Set<string>();

  const searchPaths = getKernelSearchPaths();

  for (const searchPath of searchPaths) {
    if (!fs.existsSync(searchPath)) {
      continue;
    }

    try {
      const entries = fs.readdirSync(searchPath, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }

        const kernelName = entry.name;
        if (seenNames.has(kernelName)) {
          continue;
        }

        const kernelDir = path.join(searchPath, kernelName);
        const spec = readKernelSpec(kernelDir);

        if (spec) {
          specs.push(spec);
          seenNames.add(kernelName);
        }
      }
    } catch (err) {
      // Ignore errors reading directories
    }
  }

  return specs;
}

/**
 * Get a specific kernelspec by name
 */
export function getKernelSpec(name: string): KernelSpec | null {
  const specs = discoverKernelSpecs();
  return specs.find(s => s.name === name) || null;
}

/**
 * Check if a kernelspec exists
 */
export function hasKernelSpec(name: string): boolean {
  return getKernelSpec(name) !== null;
}
