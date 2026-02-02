/**
 * Cluster Secret
 *
 * Shared secret for inter-server auth in client mode.
 * Stored at ~/.nebula/cluster.json with 0600 perms.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomBytes } from 'crypto';

const NEBULA_DIR = path.join(os.homedir(), '.nebula');
const CLUSTER_CONFIG_FILE = path.join(NEBULA_DIR, 'cluster.json');

interface ClusterConfig {
  secret: string;
  createdAt: number;
}

function ensureNebulaDir(): void {
  if (!fs.existsSync(NEBULA_DIR)) {
    fs.mkdirSync(NEBULA_DIR, { recursive: true, mode: 0o700 });
  }
}

export function readClusterSecret(): string | null {
  try {
    if (!fs.existsSync(CLUSTER_CONFIG_FILE)) {
      return null;
    }
    const data = fs.readFileSync(CLUSTER_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data) as ClusterConfig;
    return parsed.secret || null;
  } catch {
    return null;
  }
}

export function writeClusterSecret(secret: string): void {
  ensureNebulaDir();
  const payload: ClusterConfig = {
    secret,
    createdAt: Date.now(),
  };
  fs.writeFileSync(CLUSTER_CONFIG_FILE, JSON.stringify(payload, null, 2), {
    mode: 0o600,
  });
}

export function getOrCreateClusterSecret({ allowCreate }: { allowCreate: boolean }): string | null {
  const existing = readClusterSecret();
  if (existing) {
    return existing;
  }
  if (!allowCreate) {
    return null;
  }
  const secret = randomBytes(32).toString('hex');
  writeClusterSecret(secret);
  return secret;
}

