/**
 * Conda Location Discovery (VSCode/PET-style filesystem forensics)
 *
 * Finds conda installs and environments WITHOUT executing conda/mamba —
 * spawning conda boots a full Python interpreter and takes seconds, and the
 * binary may not even be on PATH for envs created by mamba/micromamba or
 * from another shell. Instead, everything comes from files conda itself
 * maintains:
 *
 *   - ~/.conda/environments.txt — conda appends EVERY env it creates here
 *     (named, path-based `-p` envs, and base), so this single file covers
 *     envs living in arbitrary locations.
 *   - .condarc `envs_dirs`/`envs_path` — user-configured env containers.
 *   - Well-known install roots (~/miniconda3, /opt/homebrew/…, micromamba…).
 *   - CONDA_* / MAMBA_* environment variables.
 *   - conda/mamba/micromamba binaries on PATH — the install root is derived
 *     from the (symlink-resolved) binary location, never by running it.
 *
 * A directory IS a conda env iff it has a `conda-meta/` directory (pixi envs
 * carry a `conda-meta/pixi` marker and are excluded — the pixi locator owns
 * those). An env is an install root iff it also has `envs/` or `condabin/`.
 */

import { promises as fsp } from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface CondaLocatorContext {
  home: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
}

export interface CondaEnvLocation {
  prefix: string;          // env root directory
  envName: string | null;  // 'base' | name under <root>/envs | basename label
  base?: string;           // owning conda install root, when known
}

export function defaultCondaContext(): CondaLocatorContext {
  return { home: os.homedir(), env: process.env, platform: process.platform };
}

async function isDir(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isDirectory(); } catch { return false; }
}

async function isFile(p: string): Promise<boolean> {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}

/** conda-meta/ present, and not a pixi env (conda-meta/pixi marker). */
export async function isCondaEnv(dir: string): Promise<boolean> {
  if (!(await isDir(path.join(dir, 'conda-meta')))) return false;
  return !(await isFile(path.join(dir, 'conda-meta', 'pixi')));
}

/** An install root is itself an env (base) that also carries envs/ or condabin/. */
export async function isCondaInstall(dir: string): Promise<boolean> {
  if (!(await isCondaEnv(dir))) return false;
  return (await isDir(path.join(dir, 'envs'))) || (await isDir(path.join(dir, 'condabin')));
}

/** Env prefixes recorded by conda itself — one absolute path per line. */
export async function readEnvironmentsTxt(ctx: CondaLocatorContext): Promise<string[]> {
  const file = path.join(ctx.home, '.conda', 'environments.txt');
  let content: string;
  try { content = await fsp.readFile(file, 'utf-8'); } catch { return []; }
  const out: string[] = [];
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (await isCondaEnv(line)) out.push(line);
  }
  return out;
}

function expandUser(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(home, p.slice(2));
  return p;
}

/** Strip surrounding quotes and trailing `  # comment` from a YAML scalar. */
function cleanYamlScalar(raw: string, home: string): string | null {
  let v = raw.replace(/\s+#.*$/, '').trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (!v) return null;
  return expandUser(v, home);
}

/**
 * Minimal .condarc reader for the two keys that name env containers.
 * Handles block lists and inline `[a, b]` lists; deliberately not a full
 * YAML parser — these files are flat and hand-written.
 */
export function parseCondaRcEnvDirs(content: string, home: string): string[] {
  const dirs: string[] = [];
  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(envs_dirs|envs_path)\s*:\s*(.*)$/);
    if (!m) continue;
    const rest = m[2].trim();
    if (rest.startsWith('[')) {
      for (const part of rest.replace(/^\[|\]\s*$/g, '').split(',')) {
        const v = cleanYamlScalar(part, home);
        if (v) dirs.push(v);
      }
      continue;
    }
    // Block list: consume `- item` lines (comments/blanks allowed between)
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (/^\s*(#.*)?$/.test(line)) continue;      // blank or comment
      const item = line.match(/^\s+-\s+(.*)$/);
      if (!item) break;                            // next top-level key
      const v = cleanYamlScalar(item[1], home);
      if (v) dirs.push(v);
    }
  }
  return dirs;
}

/** Every .condarc-style file worth checking, most specific first. */
export function getCondaRcSearchPaths(ctx: CondaLocatorContext): string[] {
  const { home, env } = ctx;
  const paths: string[] = [];
  if (env.CONDARC) paths.push(env.CONDARC);
  if (env.MAMBARC) paths.push(env.MAMBARC);
  for (const root of [env.CONDA_PREFIX, env.CONDA_ROOT].filter(Boolean) as string[]) {
    paths.push(path.join(root, '.condarc'));
  }
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg) paths.push(path.join(xdg, 'conda', '.condarc'));
  paths.push(
    path.join(home, '.config', 'conda', '.condarc'),
    path.join(home, '.conda', '.condarc'),
    path.join(home, '.condarc'),
    path.join(home, '.mambarc'),
    '/etc/conda/.condarc',
    '/var/lib/conda/.condarc',
  );
  return paths;
}

/** Env container dirs from every .condarc found (envs_dirs / envs_path). */
export async function getCondaRcEnvDirs(ctx: CondaLocatorContext): Promise<string[]> {
  const dirs: string[] = [];
  for (const rc of getCondaRcSearchPaths(ctx)) {
    try {
      const content = await fsp.readFile(rc, 'utf-8');
      dirs.push(...parseCondaRcEnvDirs(content, ctx.home));
    } catch { /* missing/unreadable rc — skip */ }
  }
  return [...new Set(dirs)];
}

const INSTALL_DIR_NAMES = [
  'anaconda', 'anaconda3',
  'miniconda', 'miniconda3',
  'miniforge', 'miniforge3',
  'mambaforge', 'micromamba',
];

/** Well-known install roots (cheap string candidates; existence checked later). */
export function getKnownCondaRoots(ctx: CondaLocatorContext): string[] {
  const { home, env, platform } = ctx;
  const roots: string[] = [];
  for (const v of [env.CONDA_ROOT, env.CONDA_PREFIX, env.MAMBA_ROOT_PREFIX, env.CONDA_DIR, env.CONDA]) {
    if (v) roots.push(expandUser(v, home));
  }
  const prefixes = [
    home,
    path.join(home, 'opt'),
    path.join(home, '.conda'),
    path.join(home, '.local'),
    '/opt', '/usr/share', '/usr/local', '/usr',
  ];
  if (platform === 'darwin') prefixes.push('/opt/homebrew');
  if (platform === 'linux') prefixes.push('/home/linuxbrew/.linuxbrew');
  for (const prefix of prefixes) {
    for (const name of INSTALL_DIR_NAMES) {
      roots.push(path.join(prefix, name));
    }
  }
  roots.push('/opt/conda', '/anaconda', '/anaconda3', '/miniconda', '/miniconda3', '/miniforge3', '/micromamba');
  return [...new Set(roots)];
}

const CONDA_BINARY_NAMES = ['conda', 'mamba', 'micromamba'];

function pathEntries(ctx: CondaLocatorContext): string[] {
  const sep = ctx.platform === 'win32' ? ';' : ':';
  return (ctx.env.PATH || '').split(sep).filter(Boolean);
}

function binaryCandidates(dir: string, name: string, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    return [path.join(dir, `${name}.exe`), path.join(dir, `${name}.bat`)];
  }
  return [path.join(dir, name)];
}

/**
 * Derive install roots from conda-like binaries on PATH: resolve the symlink
 * (homebrew shims point into Caskroom), then walk out of bin/condabin/Scripts.
 * The binary is never executed.
 */
export async function getCondaRootsFromPath(ctx: CondaLocatorContext): Promise<string[]> {
  const roots: string[] = [];
  for (const dir of pathEntries(ctx)) {
    for (const name of CONDA_BINARY_NAMES) {
      for (const exe of binaryCandidates(dir, name, ctx.platform)) {
        if (!(await isFile(exe))) continue;
        let real = exe;
        try { real = await fsp.realpath(exe); } catch { /* keep original */ }
        const parent = path.dirname(real);
        const candidate = ['bin', 'condabin', 'Scripts'].includes(path.basename(parent).toLowerCase())
          ? path.dirname(parent)
          : parent;
        if (await isCondaEnv(candidate)) roots.push(candidate);
      }
    }
  }
  return [...new Set(roots)];
}

/**
 * Locate conda/mamba/micromamba binaries (PATH first, then known roots) for
 * callers that DO need to run conda — e.g. `conda install -p <prefix>` in the
 * ipykernel install flow. Discovery itself never executes these.
 */
export async function findCondaLikeBinaries(ctx: CondaLocatorContext = defaultCondaContext()): Promise<string[]> {
  const found: string[] = [];
  const seen = new Set<string>();
  const add = async (exe: string) => {
    if (!(await isFile(exe))) return;
    let real = exe;
    try { real = await fsp.realpath(exe); } catch { /* keep original */ }
    if (seen.has(real)) return;
    seen.add(real);
    found.push(exe);
  };
  for (const dir of pathEntries(ctx)) {
    for (const name of CONDA_BINARY_NAMES) {
      for (const exe of binaryCandidates(dir, name, ctx.platform)) await add(exe);
    }
  }
  const binDirs = ctx.platform === 'win32' ? ['Scripts', 'condabin'] : ['bin', 'condabin'];
  for (const root of [...getKnownCondaRoots(ctx), ...(await getCondaRootsFromPath(ctx))]) {
    for (const sub of binDirs) {
      for (const name of CONDA_BINARY_NAMES) {
        for (const exe of binaryCandidates(path.join(root, sub), name, ctx.platform)) await add(exe);
      }
    }
  }
  return found;
}

export function pythonExeForPrefix(prefix: string, platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? path.win32.join(prefix, 'python.exe')
    : path.join(prefix, 'bin', 'python');
}

/** Inverse of pythonExeForPrefix: the env prefix a python executable lives in. */
export function prefixForPythonExe(pythonPath: string): string {
  const parent = path.dirname(pythonPath);
  return ['bin', 'scripts'].includes(path.basename(parent).toLowerCase())
    ? path.dirname(parent)
    : parent;
}

/** First match for an executable name on the context's PATH (fs check only). */
export async function findExecutableOnPath(
  name: string,
  ctx: CondaLocatorContext = defaultCondaContext()
): Promise<string | null> {
  for (const dir of pathEntries(ctx)) {
    for (const exe of binaryCandidates(dir, name, ctx.platform)) {
      if (await isFile(exe)) return exe;
    }
  }
  return null;
}

/**
 * Name an env prefix the way conda users know it: install roots are 'base',
 * children of an install's envs/ keep their dirname (and remember the owning
 * install), and path-based `-p` envs fall back to their basename as a display
 * label (activation-by-name doesn't apply — Nebula execs the python binary).
 */
async function locate(prefix: string): Promise<CondaEnvLocation> {
  if (await isCondaInstall(prefix)) {
    return { prefix, envName: 'base', base: prefix };
  }
  const parent = path.dirname(prefix);
  const grandparent = path.dirname(parent);
  if (path.basename(parent) === 'envs' && (await isCondaInstall(grandparent))) {
    return { prefix, envName: path.basename(prefix), base: grandparent };
  }
  return { prefix, envName: path.basename(prefix) };
}

/**
 * The full sweep: merge every source, expand install roots and containers,
 * and return deduped env locations.
 */
export async function collectCondaEnvs(ctx: CondaLocatorContext = defaultCondaContext()): Promise<CondaEnvLocation[]> {
  const byPrefix = new Map<string, CondaEnvLocation>();
  const add = async (prefix: string) => {
    // realpath so the same env reached via different spellings (symlinked
    // /var vs /private/var, shim dirs, …) dedupes to one entry.
    let norm: string;
    try { norm = await fsp.realpath(prefix); } catch { return; }
    if (byPrefix.has(norm)) return;
    if (!(await isCondaEnv(norm))) return;
    byPrefix.set(norm, await locate(norm));
  };

  // 1. environments.txt — the authoritative record, catches arbitrary -p envs.
  //    If an entry sits under <root>/envs, surface the root's base env too
  //    (Caskroom-style installs are often only reachable this way).
  for (const prefix of await readEnvironmentsTxt(ctx)) {
    await add(prefix);
    const parent = path.dirname(prefix);
    if (path.basename(parent) === 'envs') {
      await add(path.dirname(parent));
    }
  }

  // 2. Install roots: well-known locations + roots derived from PATH binaries.
  const roots = [...getKnownCondaRoots(ctx), ...(await getCondaRootsFromPath(ctx))];
  const containers: string[] = [];
  for (const root of roots) {
    if (await isCondaInstall(root)) {
      await add(root);
      containers.push(path.join(root, 'envs'));
      // Per-install .condarc can add more env containers
      try {
        const rc = await fsp.readFile(path.join(root, '.condarc'), 'utf-8');
        containers.push(...parseCondaRcEnvDirs(rc, ctx.home));
      } catch { /* no per-install rc */ }
    } else if (await isCondaEnv(root)) {
      await add(root);
    }
  }

  // 3. Env containers: ~/.conda/envs, $CONDA_ENVS_PATH entries, .condarc envs_dirs.
  containers.push(path.join(ctx.home, '.conda', 'envs'));
  const envsPathSep = ctx.platform === 'win32' ? ';' : ':';
  for (const entry of (ctx.env.CONDA_ENVS_PATH || '').split(envsPathSep).filter(Boolean)) {
    containers.push(expandUser(entry, ctx.home));
  }
  containers.push(...(await getCondaRcEnvDirs(ctx)));

  for (const container of [...new Set(containers)]) {
    let entries: string[];
    try { entries = await fsp.readdir(container); } catch { continue; }
    for (const entry of entries) {
      await add(path.join(container, entry));
    }
  }

  return [...byPrefix.values()];
}
