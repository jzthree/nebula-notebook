// @vitest-environment node
/**
 * Conda Location Discovery Tests
 *
 * Filesystem-forensics conda discovery (VSCode/PET-style): find conda envs
 * from environments.txt, .condarc, known roots, env vars, and PATH-derived
 * install roots — without ever executing conda.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isCondaEnv,
  isCondaInstall,
  readEnvironmentsTxt,
  getCondaRcEnvDirs,
  getKnownCondaRoots,
  getCondaRootsFromPath,
  collectCondaEnvs,
  findCondaLikeBinaries,
  pythonExeForPrefix,
  CondaLocatorContext,
} from '../discovery/conda-locations';

/** Create a bare conda env: a dir with conda-meta/ and bin/python. */
function mkCondaEnv(dir: string): void {
  fs.mkdirSync(path.join(dir, 'conda-meta'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bin', 'python'), '#!/bin/sh\n', { mode: 0o755 });
}

/** Create a conda install root (base env + envs/ + optional named envs). */
function mkCondaInstall(root: string, envNames: string[] = []): void {
  mkCondaEnv(root);
  fs.mkdirSync(path.join(root, 'envs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'condabin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'conda'), '#!/bin/sh\n', { mode: 0o755 });
  for (const name of envNames) {
    mkCondaEnv(path.join(root, 'envs', name));
  }
}

describe('conda-locations', () => {
  let tmp: string;
  let home: string;
  let ctx: CondaLocatorContext;

  beforeEach(() => {
    // realpath: os.tmpdir() is symlinked on macOS (/var → /private/var), and
    // the locator canonicalizes via realpath — keep expected strings identical.
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-conda-loc-')));
    home = path.join(tmp, 'home');
    fs.mkdirSync(home, { recursive: true });
    ctx = { home, env: {}, platform: process.platform };
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  describe('isCondaEnv / isCondaInstall', () => {
    it('recognizes a dir with conda-meta as a conda env', async () => {
      const env = path.join(tmp, 'someenv');
      mkCondaEnv(env);
      expect(await isCondaEnv(env)).toBe(true);
    });

    it('rejects a plain directory and a missing directory', async () => {
      const plain = path.join(tmp, 'plain');
      fs.mkdirSync(plain);
      expect(await isCondaEnv(plain)).toBe(false);
      expect(await isCondaEnv(path.join(tmp, 'missing'))).toBe(false);
    });

    it('rejects a pixi env (conda-meta/pixi marker)', async () => {
      const env = path.join(tmp, 'pixienv');
      mkCondaEnv(env);
      fs.writeFileSync(path.join(env, 'conda-meta', 'pixi'), '{}');
      expect(await isCondaEnv(env)).toBe(false);
    });

    it('recognizes an install root (conda-meta + envs/ or condabin/)', async () => {
      const root = path.join(tmp, 'miniconda3');
      mkCondaInstall(root);
      expect(await isCondaInstall(root)).toBe(true);
    });

    it('does not treat a plain env as an install root', async () => {
      const env = path.join(tmp, 'justenv');
      mkCondaEnv(env);
      expect(await isCondaInstall(env)).toBe(false);
    });
  });

  describe('readEnvironmentsTxt', () => {
    it('returns existing env prefixes, skipping blanks, comments and stale entries', async () => {
      const envA = path.join(tmp, 'projects', 'weird spot', 'envA');
      mkCondaEnv(envA);
      fs.mkdirSync(path.join(home, '.conda'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.conda', 'environments.txt'),
        `${envA}\n\n# a comment\n${path.join(tmp, 'deleted-env')}\n`
      );
      const found = await readEnvironmentsTxt(ctx);
      expect(found).toContain(envA);
      expect(found).not.toContain(path.join(tmp, 'deleted-env'));
      expect(found).toHaveLength(1);
    });

    it('returns empty list when the file is missing', async () => {
      expect(await readEnvironmentsTxt(ctx)).toEqual([]);
    });
  });

  describe('getCondaRcEnvDirs', () => {
    it('parses envs_dirs block lists with comments and quotes', async () => {
      fs.writeFileSync(
        path.join(home, '.condarc'),
        [
          'channels:',
          '  - conda-forge',
          'envs_dirs:',
          `  - ${path.join(tmp, 'data', 'envs')}  # shared`,
          `  - "~/custom-envs"`,
          'ssl_verify: true',
        ].join('\n')
      );
      const dirs = await getCondaRcEnvDirs(ctx);
      expect(dirs).toContain(path.join(tmp, 'data', 'envs'));
      expect(dirs).toContain(path.join(home, 'custom-envs'));
    });

    it('parses inline lists and the envs_path alias', async () => {
      fs.writeFileSync(
        path.join(home, '.condarc'),
        `envs_path: [${path.join(tmp, 'a')}, ${path.join(tmp, 'b')}]\n`
      );
      const dirs = await getCondaRcEnvDirs(ctx);
      expect(dirs).toContain(path.join(tmp, 'a'));
      expect(dirs).toContain(path.join(tmp, 'b'));
    });

    it('reads the file named by $CONDARC', async () => {
      const rc = path.join(tmp, 'custom-rc.yaml');
      fs.writeFileSync(rc, `envs_dirs:\n  - ${path.join(tmp, 'from-condarc-var')}\n`);
      ctx.env.CONDARC = rc;
      const dirs = await getCondaRcEnvDirs(ctx);
      expect(dirs).toContain(path.join(tmp, 'from-condarc-var'));
    });
  });

  describe('getKnownCondaRoots', () => {
    it('includes home-based roots for anaconda3/miniconda3/miniforge3/micromamba', () => {
      const roots = getKnownCondaRoots(ctx);
      for (const name of ['anaconda3', 'miniconda3', 'miniforge3', 'micromamba']) {
        expect(roots).toContain(path.join(home, name));
      }
    });

    it('includes roots from CONDA_ROOT / MAMBA_ROOT_PREFIX / CONDA_PREFIX', () => {
      ctx.env.CONDA_ROOT = path.join(tmp, 'cr');
      ctx.env.MAMBA_ROOT_PREFIX = path.join(tmp, 'mrp');
      ctx.env.CONDA_PREFIX = path.join(tmp, 'cp');
      const roots = getKnownCondaRoots(ctx);
      expect(roots).toContain(path.join(tmp, 'cr'));
      expect(roots).toContain(path.join(tmp, 'mrp'));
      expect(roots).toContain(path.join(tmp, 'cp'));
    });
  });

  describe('getCondaRootsFromPath', () => {
    it('derives the install root from a conda binary on PATH without executing it', async () => {
      const root = path.join(tmp, 'installs', 'miniforge3');
      mkCondaInstall(root);
      ctx.env.PATH = `${path.join(root, 'bin')}:${'/usr/bin'}`;
      const roots = await getCondaRootsFromPath(ctx);
      expect(roots).toContain(root);
    });

    it('resolves symlinked binaries (homebrew-style shims)', async () => {
      const root = path.join(tmp, 'Caskroom', 'miniconda', 'base');
      mkCondaInstall(root);
      const shimDir = path.join(tmp, 'brew-bin');
      fs.mkdirSync(shimDir, { recursive: true });
      fs.symlinkSync(path.join(root, 'bin', 'conda'), path.join(shimDir, 'conda'));
      ctx.env.PATH = shimDir;
      const roots = await getCondaRootsFromPath(ctx);
      expect(roots).toContain(root);
    });

    it('finds micromamba root via MAMBA_EXE-style bin placement', async () => {
      const root = path.join(tmp, 'micromamba-root');
      mkCondaInstall(root);
      fs.writeFileSync(path.join(root, 'bin', 'micromamba'), '#!/bin/sh\n', { mode: 0o755 });
      ctx.env.PATH = path.join(root, 'bin');
      const roots = await getCondaRootsFromPath(ctx);
      expect(roots).toContain(root);
    });
  });

  describe('collectCondaEnvs (end to end over a fixture filesystem)', () => {
    it('finds base + named envs from an install root, path-based envs from environments.txt, and container dirs from .condarc', async () => {
      // 1. An install root in a known location (under home)
      const root = path.join(home, 'miniconda3');
      mkCondaInstall(root, ['ml', 'web']);

      // 2. A path-based env in a random location, known only via environments.txt
      const stray = path.join(tmp, 'Code', '.conda-envs', 'hypir');
      mkCondaEnv(stray);
      fs.mkdirSync(path.join(home, '.conda'), { recursive: true });
      fs.writeFileSync(path.join(home, '.conda', 'environments.txt'), `${stray}\n`);

      // 3. A container dir referenced from .condarc
      const container = path.join(tmp, 'shared-envs');
      mkCondaEnv(path.join(container, 'teamenv'));
      fs.writeFileSync(path.join(home, '.condarc'), `envs_dirs:\n  - ${container}\n`);

      const envs = await collectCondaEnvs(ctx);
      const byPrefix = new Map(envs.map(e => [e.prefix, e]));

      expect(byPrefix.get(root)?.envName).toBe('base');
      expect(byPrefix.get(path.join(root, 'envs', 'ml'))?.envName).toBe('ml');
      expect(byPrefix.get(path.join(root, 'envs', 'web'))?.envName).toBe('web');
      // Path-based env: basename used as a display label
      expect(byPrefix.get(stray)?.envName).toBe('hypir');
      expect(byPrefix.get(container + path.sep + 'teamenv')?.envName).toBe('teamenv');
    });

    it('recovers the base install when environments.txt only lists an env under <root>/envs', async () => {
      const root = path.join(tmp, 'Caskroom', 'miniforge', 'base');
      mkCondaInstall(root, ['test']);
      fs.mkdirSync(path.join(home, '.conda'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.conda', 'environments.txt'),
        `${path.join(root, 'envs', 'test')}\n`
      );
      const envs = await collectCondaEnvs(ctx);
      const prefixes = envs.map(e => e.prefix);
      expect(prefixes).toContain(path.join(root, 'envs', 'test'));
      expect(prefixes).toContain(root); // base recovered from the grandparent
    });

    it('scans ~/.conda/envs and CONDA_ENVS_PATH containers', async () => {
      mkCondaEnv(path.join(home, '.conda', 'envs', 'dotconda'));
      const extra = path.join(tmp, 'extra-envs');
      mkCondaEnv(path.join(extra, 'fromvar'));
      ctx.env.CONDA_ENVS_PATH = extra;

      const envs = await collectCondaEnvs(ctx);
      const prefixes = envs.map(e => e.prefix);
      expect(prefixes).toContain(path.join(home, '.conda', 'envs', 'dotconda'));
      expect(prefixes).toContain(path.join(extra, 'fromvar'));
    });

    it('dedupes envs reachable from several sources', async () => {
      const root = path.join(home, 'miniconda3');
      mkCondaInstall(root, ['ml']);
      fs.mkdirSync(path.join(home, '.conda'), { recursive: true });
      fs.writeFileSync(
        path.join(home, '.conda', 'environments.txt'),
        `${root}\n${path.join(root, 'envs', 'ml')}\n`
      );
      const envs = await collectCondaEnvs(ctx);
      const matching = envs.filter(e => e.prefix === path.join(root, 'envs', 'ml'));
      expect(matching).toHaveLength(1);
    });
  });

  describe('findCondaLikeBinaries', () => {
    it('finds conda/mamba/micromamba from PATH and known roots without executing them', async () => {
      const root = path.join(home, 'miniconda3');
      mkCondaInstall(root); // writes bin/conda
      const mm = path.join(tmp, 'mm-bin');
      fs.mkdirSync(mm, { recursive: true });
      fs.writeFileSync(path.join(mm, 'micromamba'), '#!/bin/sh\n', { mode: 0o755 });
      ctx.env.PATH = mm;

      const bins = await findCondaLikeBinaries(ctx);
      expect(bins).toContain(path.join(mm, 'micromamba'));
      expect(bins).toContain(path.join(root, 'bin', 'conda'));
    });
  });

  describe('pythonExeForPrefix', () => {
    it('maps a prefix to its python executable per platform', () => {
      expect(pythonExeForPrefix('/opt/miniconda3', 'darwin')).toBe('/opt/miniconda3/bin/python');
      expect(pythonExeForPrefix('C:\\miniconda3', 'win32')).toBe('C:\\miniconda3\\python.exe');
    });
  });
});
