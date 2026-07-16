// @vitest-environment node
/**
 * Env-kernel (raw launch) tests
 *
 * VSCode-style: any discovered Python environment is launchable as a kernel
 * WITHOUT registering a kernelspec — the kernel name `env:<pythonPath>`
 * resolves to a synthetic spec that spawns `<python> -m ipykernel_launcher`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ENV_KERNEL_PREFIX,
  isEnvKernelName,
  envKernelPythonPath,
  makeEnvKernelSpec,
  resolveKernelSpec,
} from '../kernel/kernelspec';
import { KernelService } from '../kernel/kernel-service';
import { SessionStore } from '../kernel/session-store';
import { KernelProvisionError } from '../discovery/types';

describe('env kernel names', () => {
  it('round-trips a python path through the env: kernel name', () => {
    const py = '/Users/x/Code/.conda-envs/hypir/bin/python';
    const name = ENV_KERNEL_PREFIX + py;
    expect(isEnvKernelName(name)).toBe(true);
    expect(envKernelPythonPath(name)).toBe(py);
    expect(isEnvKernelName('python3')).toBe(false);
    expect(envKernelPythonPath('python3')).toBeNull();
  });

  it('builds a synthetic spec that raw-launches ipykernel', () => {
    const py = '/opt/miniconda3/envs/ml/bin/python';
    const spec = makeEnvKernelSpec(py, 'Python 3.11 (conda: ml)');
    expect(spec.argv).toEqual([py, '-m', 'ipykernel_launcher', '-f', '{connection_file}']);
    expect(spec.name).toBe(`env:${py}`);
    expect(spec.displayName).toBe('Python 3.11 (conda: ml)');
    expect(spec.language).toBe('python');
  });

  it('falls back to a path-derived display name', () => {
    const spec = makeEnvKernelSpec('/some/env/bin/python');
    expect(spec.displayName).toContain('/some/env/bin/python');
  });

  it('resolveKernelSpec handles env: names without touching disk kernelspecs', () => {
    const spec = resolveKernelSpec('env:/x/bin/python');
    expect(spec).not.toBeNull();
    expect(spec!.argv[0]).toBe('/x/bin/python');
  });

  it('resolveKernelSpec still resolves registered kernelspec names to null when unknown', () => {
    expect(resolveKernelSpec('definitely-not-a-registered-kernel-xyz')).toBeNull();
  });
});

describe('KernelService env-kernel preflight', () => {
  let tmp: string;
  let service: KernelService;
  let store: SessionStore;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-envk-')));
    store = new SessionStore(path.join(tmp, 'sessions.db'));
    service = new KernelService({}, store);
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('fails fast with python_not_found for a dead interpreter path', async () => {
    const err = await service
      .startKernel({ kernelName: `env:${path.join(tmp, 'gone', 'bin', 'python')}` })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KernelProvisionError);
    expect((err as KernelProvisionError).code).toBe('python_not_found');
  });

  it('fails fast with needs_ipykernel (plus an install hint) when ipykernel is missing', async () => {
    // Stub interpreter: answers --version and reports no ipykernel on probe
    const envDir = path.join(tmp, 'venv');
    fs.mkdirSync(path.join(envDir, 'bin'), { recursive: true });
    const py = path.join(envDir, 'bin', 'python');
    fs.writeFileSync(
      py,
      '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.11.2"; exit 0; fi\n' +
      'echo \'{"ipykernel": false, "externally_managed": false, "venv": true}\'\n',
      { mode: 0o755 }
    );

    const err = await service
      .startKernel({ kernelName: `env:${py}` })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(KernelProvisionError);
    expect((err as KernelProvisionError).code).toBe('needs_ipykernel');
    expect((err as KernelProvisionError).installHint).toBeTruthy();
  });
});
