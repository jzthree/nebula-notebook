// @vitest-environment node
/**
 * Per-environment kernelspec discovery tests
 *
 * Kernels registered INSIDE an environment (e.g. `conda install r-irkernel`
 * writes <env>/share/jupyter/kernels/ir/kernel.json) must show up in the
 * picker. Each env's auto-registered default python spec is hidden — the env
 * row itself already represents "run Python here" (VSCode does the same).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  envKernelspecDirs,
  readKernelSpecsFromPaths,
} from '../kernel/kernelspec';

function writeSpec(kernelsDir: string, name: string, spec: Record<string, unknown>): void {
  const dir = path.join(kernelsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'kernel.json'), JSON.stringify(spec));
}

describe('per-env kernelspec discovery', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-envspec-')));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('maps interpreter paths to their share/jupyter/kernels dirs', () => {
    const dirs = envKernelspecDirs(['/opt/miniconda3/envs/r-lab/bin/python', '/usr/bin/python3']);
    expect(dirs).toContain('/opt/miniconda3/envs/r-lab/share/jupyter/kernels');
    expect(dirs).toContain('/usr/share/jupyter/kernels');
  });

  it('finds non-python kernels in env dirs and hides the default python spec', () => {
    const kernels = path.join(tmp, 'env', 'share', 'jupyter', 'kernels');
    writeSpec(kernels, 'ir', {
      display_name: 'R', language: 'R',
      argv: ['/opt/R', '--slave', '-e', 'IRkernel::main()', '--args', '{connection_file}'],
    });
    writeSpec(kernels, 'python3', {
      display_name: 'Python 3 (ipykernel)', language: 'python',
      argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
    });

    const specs = readKernelSpecsFromPaths([kernels], { skipDefaultPythonSpecs: true });
    expect(specs.map(s => s.name)).toEqual(['ir']);
    expect(specs[0].displayName).toBe('R');
  });

  it('keeps default python specs when not filtering (user/system dirs)', () => {
    const kernels = path.join(tmp, 'user-kernels');
    writeSpec(kernels, 'python3', {
      display_name: 'Python 3', language: 'python',
      argv: ['python', '-m', 'ipykernel_launcher', '-f', '{connection_file}'],
    });
    const specs = readKernelSpecsFromPaths([kernels]);
    expect(specs.map(s => s.name)).toEqual(['python3']);
  });

  it('dedupes by kernel name across paths, first path wins', () => {
    const a = path.join(tmp, 'a');
    const b = path.join(tmp, 'b');
    writeSpec(a, 'ir', { display_name: 'R (a)', language: 'R', argv: ['/a/R'] });
    writeSpec(b, 'ir', { display_name: 'R (b)', language: 'R', argv: ['/b/R'] });

    const seen = new Set<string>();
    const first = readKernelSpecsFromPaths([a], { seen });
    const second = readKernelSpecsFromPaths([b], { seen });
    expect(first.map(s => s.displayName)).toEqual(['R (a)']);
    expect(second).toEqual([]);
  });
});
