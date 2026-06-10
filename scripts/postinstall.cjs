/**
 * Repo-checkout convenience: install the node-server and packages/mcp
 * subpackage dependencies after a root `npm install`.
 *
 * Skipped entirely when nebula-notebook is installed from npm as a
 * dependency — the published package is self-contained (server runtime
 * deps live in the root package.json; dist artifacts are prebuilt).
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

if (__dirname.split(path.sep).includes('node_modules')) {
  process.exit(0);
}

const root = path.join(__dirname, '..');
for (const dir of ['node-server', path.join('packages', 'mcp')]) {
  const pkg = path.join(root, dir, 'package.json');
  if (!fs.existsSync(pkg)) continue;
  try {
    execSync('npm install', { cwd: path.join(root, dir), stdio: 'inherit' });
  } catch {
    console.warn(`⚠️  postinstall: npm install failed in ${dir}`);
  }
}
