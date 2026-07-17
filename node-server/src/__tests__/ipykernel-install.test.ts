// @vitest-environment node
/**
 * ipykernel install flow tests
 *
 * VSCode-style: ONE installer is chosen up front (conda-like binary for conda
 * envs → uv anywhere on PATH → the env's own pip), the command runs to
 * completion, and failure is reported honestly (code + output + hint) with no
 * silent fallback chain.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PythonDiscoveryService } from '../discovery/discovery-service';
import { KernelProvisionError } from '../discovery/types';

/** A stub interpreter that reports ipykernel present iff `flagFile` exists. */
function writeStubPython(pyPath: string, flagFile: string): void {
  fs.mkdirSync(path.dirname(pyPath), { recursive: true });
  fs.writeFileSync(
    pyPath,
    '#!/bin/sh\n' +
    'if [ "$1" = "--version" ]; then echo "Python 3.11.9"; exit 0; fi\n' +
    `if [ -f "${flagFile}" ]; then echo '{"ipykernel": true, "externally_managed": false, "venv": true}';\n` +
    `else echo '{"ipykernel": false, "externally_managed": false, "venv": true}'; fi\n`,
    { mode: 0o755 }
  );
}

describe('ipykernel install', () => {
  let tmp: string;
  let home: string;
  let service: PythonDiscoveryService;
  let ctxEnv: Record<string, string | undefined>;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-ipyk-')));
    home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    ctxEnv = { PATH: path.join(tmp, 'bin') };
    fs.mkdirSync(path.join(tmp, 'bin'), { recursive: true });
    service = new PythonDiscoveryService({
      cacheFile: path.join(tmp, 'cache.json'),
      condaLocator: { home, env: ctxEnv },
    });
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('planIpykernelInstall — one installer, chosen up front', () => {
    it('uses a conda-like binary with -p <prefix> for conda envs', async () => {
      const prefix = path.join(tmp, 'cenv');
      fs.mkdirSync(path.join(prefix, 'conda-meta'), { recursive: true });
      const py = path.join(prefix, 'bin', 'python');
      writeStubPython(py, path.join(tmp, 'nope'));
      const mamba = path.join(tmp, 'bin', 'mamba');
      fs.writeFileSync(mamba, '#!/bin/sh\n', { mode: 0o755 });

      const plan = await service.planIpykernelInstall(py);
      expect(plan.kind).toBe('conda');
      expect(plan.argv).toEqual([mamba, 'install', '-p', prefix, 'ipykernel', '-y']);
    });

    it('falls back to uv for a conda env when no conda-like binary exists', async () => {
      const prefix = path.join(tmp, 'cenv2');
      fs.mkdirSync(path.join(prefix, 'conda-meta'), { recursive: true });
      const py = path.join(prefix, 'bin', 'python');
      writeStubPython(py, path.join(tmp, 'nope'));
      const uv = path.join(tmp, 'bin', 'uv');
      fs.writeFileSync(uv, '#!/bin/sh\n', { mode: 0o755 });

      const plan = await service.planIpykernelInstall(py);
      expect(plan.kind).toBe('uv');
      expect(plan.argv).toEqual([uv, 'pip', 'install', '--python', py, 'ipykernel']);
    });

    it('prefers uv over pip for plain envs, pip when uv is absent', async () => {
      const py = path.join(tmp, 'venv', 'bin', 'python');
      writeStubPython(py, path.join(tmp, 'nope'));

      const noUv = await service.planIpykernelInstall(py);
      expect(noUv.kind).toBe('pip');
      expect(noUv.argv).toEqual([py, '-m', 'pip', 'install', 'ipykernel']);

      const uv = path.join(tmp, 'bin', 'uv');
      fs.writeFileSync(uv, '#!/bin/sh\n', { mode: 0o755 });
      const withUv = await service.planIpykernelInstall(py);
      expect(withUv.kind).toBe('uv');
    });
  });

  describe('installIpykernel — run, verify, report honestly', () => {
    it('runs the chosen installer and verifies ipykernel became importable', async () => {
      const flag = path.join(tmp, 'ik-flag');
      const py = path.join(tmp, 'venv', 'bin', 'python');
      writeStubPython(py, flag);
      // Stub uv "installs" by creating the flag the stub python checks
      const uv = path.join(tmp, 'bin', 'uv');
      fs.writeFileSync(uv, `#!/bin/sh\ntouch "${flag}"\n`, { mode: 0o755 });

      const result = await service.installIpykernel(py);
      expect(result.installer).toBe('uv');
      expect(fs.existsSync(flag)).toBe(true);
    });

    it('streams installer output to the onOutput callback as it runs', async () => {
      const flag = path.join(tmp, 'ik-flag-stream');
      const py = path.join(tmp, 'venv', 'bin', 'python');
      writeStubPython(py, flag);
      const uv = path.join(tmp, 'bin', 'uv');
      fs.writeFileSync(
        uv,
        `#!/bin/sh\necho "Resolved 5 packages in 120ms"\necho "warning: hash mismatch retried" >&2\ntouch "${flag}"\n`,
        { mode: 0o755 }
      );

      const chunks: string[] = [];
      const result = await service.installIpykernel(py, (c) => chunks.push(c));
      expect(result.installer).toBe('uv');
      const all = chunks.join('');
      expect(all).toContain('Resolved 5 packages');          // stdout streamed
      expect(all).toContain('hash mismatch retried');        // stderr streamed too
      expect(all).toContain('uv pip install');               // the command line itself
    });

    it('reports already-installed without running any installer', async () => {
      const flag = path.join(tmp, 'ik-flag2');
      fs.writeFileSync(flag, '');
      const py = path.join(tmp, 'venv', 'bin', 'python');
      writeStubPython(py, flag);

      const result = await service.installIpykernel(py);
      expect(result.installer).toBe('none');
    });

    it('fails with install_failed carrying the installer output — no silent fallback', async () => {
      const py = path.join(tmp, 'venv', 'bin', 'python');
      writeStubPython(py, path.join(tmp, 'never'));
      const uv = path.join(tmp, 'bin', 'uv');
      fs.writeFileSync(uv, '#!/bin/sh\necho "No solution found: torment nexus unavailable" >&2\nexit 1\n', { mode: 0o755 });

      const err = await service.installIpykernel(py).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(KernelProvisionError);
      expect((err as KernelProvisionError).code).toBe('install_failed');
      expect((err as KernelProvisionError).message).toContain('torment nexus');
    });

    it('refuses externally-managed interpreters with guidance, before running anything', async () => {
      const py = path.join(tmp, 'sys', 'bin', 'python');
      fs.mkdirSync(path.dirname(py), { recursive: true });
      fs.writeFileSync(
        py,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Python 3.12.1"; exit 0; fi\n' +
        'echo \'{"ipykernel": false, "externally_managed": true, "venv": false}\'\n',
        { mode: 0o755 }
      );

      const err = await service.installIpykernel(py).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(KernelProvisionError);
      expect((err as KernelProvisionError).code).toBe('externally_managed');
      expect((err as KernelProvisionError).installHint).toBeTruthy();
    });
  });
});
