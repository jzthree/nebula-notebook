/**
 * Update check — notify-only, never auto-installs.
 *
 * Once at startup (and daily after), asks the npm registry for the latest
 * published nebula-notebook version and compares it to the running one.
 * Result is surfaced in /api/health (`update`) for the UI pill and logged
 * once to the server console. Opt out with NEBULA_NO_UPDATE_CHECK=1.
 * Network failures are silent: an update check must never affect operation.
 */

import * as fs from 'fs';
import * as path from 'path';

const REGISTRY_URL = 'https://registry.npmjs.org/nebula-notebook/latest';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
const FETCH_TIMEOUT_MS = 4000;

export interface UpdateInfo {
  current: string;
  latest: string | null;
  update_available: boolean;
  checked_at: number | null;
}

let info: UpdateInfo = { current: readCurrentVersion(), latest: null, update_available: false, checked_at: null };
let timer: NodeJS.Timeout | null = null;

/** Running version from the repo/package root (this file is at node-server/{src,dist}/ — 2 levels up). */
function readCurrentVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, '..', '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    if (typeof pkg.version === 'string') return pkg.version;
  } catch { /* fall through */ }
  return '0.0.0';
}

/** Numeric semver compare on MAJOR.MINOR.PATCH; ignores prerelease tags. */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string) => v.replace(/^v/, '').split('-')[0].split('.').map(n => parseInt(n, 10) || 0);
  const [lMaj, lMin, lPat] = parse(latest);
  const [cMaj, cMin, cPat] = parse(current);
  if (lMaj !== cMaj) return lMaj > cMaj;
  if (lMin !== cMin) return lMin > cMin;
  return lPat > cPat;
}

async function checkOnce(): Promise<void> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return;
    const data = (await res.json()) as { version?: string };
    if (typeof data.version !== 'string') return;
    const updateAvailable = isNewerVersion(data.version, info.current);
    const firstDiscovery = updateAvailable && !info.update_available;
    info = { ...info, latest: data.version, update_available: updateAvailable, checked_at: Date.now() };
    if (firstDiscovery) {
      console.log(
        `[Update] nebula-notebook v${data.version} is available (running v${info.current}) — ` +
        `update with: npx nebula-notebook@latest (or git pull for source installs)`
      );
    }
  } catch { /* offline / registry down / air-gapped cluster — stay quiet */ }
}

export function startUpdateChecker(): void {
  if (process.env.NEBULA_NO_UPDATE_CHECK) return;
  void checkOnce();
  timer = setInterval(() => void checkOnce(), CHECK_INTERVAL_MS);
  timer.unref?.(); // never keep the process alive for this
}

export function stopUpdateChecker(): void {
  if (timer) { clearInterval(timer); timer = null; }
}

export function getUpdateInfo(): UpdateInfo {
  return info;
}
