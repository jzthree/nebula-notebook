#!/usr/bin/env node
/**
 * Production launcher for the published nebula-notebook package.
 *
 *   npx nebula-notebook                  # serve UI + API on :3000
 *   npx nebula-notebook --workdir ~/work # set file-browser root
 *   npx nebula-notebook --noauth         # disable 2FA (local/dev)
 *
 * All flags are passed through to the Nebula server.
 */
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(__dirname, '..', 'node-server', 'dist', 'index.js');

if (!fs.existsSync(serverEntry)) {
  console.error(`nebula-notebook: server build not found at ${serverEntry}`);
  console.error('If you are running from a repo checkout, run "npm run build && npm run node-server:build" first.');
  process.exit(1);
}

const child = spawn(process.execPath, [serverEntry, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: process.env,
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code) => process.exit(code ?? 0));
