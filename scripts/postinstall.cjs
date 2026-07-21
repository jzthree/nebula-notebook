/**
 * Repo-checkout convenience: install the packages/autocomplete, node-server,
 * and packages/mcp subpackage dependencies after a root `npm install`.
 * packages/autocomplete is listed first so its `prepare` step builds dist/
 * before node-server (which links to it via file:) is set up.
 *
 * Skipped entirely when nebula-notebook is installed from npm as a
 * dependency — the published package is self-contained (server runtime
 * deps live in the root package.json; nebula-autocomplete is a bundled
 * dependency; dist artifacts are prebuilt).
 */
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

if (__dirname.split(path.sep).includes('node_modules')) {
  process.exit(0);
}

const root = path.join(__dirname, '..');
for (const dir of [path.join('packages', 'autocomplete'), 'node-server', path.join('packages', 'mcp')]) {
  const pkg = path.join(root, dir, 'package.json');
  if (!fs.existsSync(pkg)) continue;
  try {
    // --include=dev: the subpackage builds (tsc) need their devDependencies
    // even when the environment forces production installs (NODE_ENV=production
    // in server shells, npm production config) — without it, tsc is missing
    // and the prepare builds are skipped.
    execSync('npm install --include=dev', { cwd: path.join(root, dir), stdio: 'inherit' });
  } catch {
    console.warn(`⚠️  postinstall: npm install failed in ${dir}`);
  }
}

// The autocomplete build is load-bearing (the root depends on its dist/ via
// file:). Its prepare skips quietly when typescript is absent, so verify the
// artifact exists and fall back to an explicit build.
const autocompleteDir = path.join(root, 'packages', 'autocomplete');
if (fs.existsSync(path.join(autocompleteDir, 'package.json')) &&
    !fs.existsSync(path.join(autocompleteDir, 'dist', 'index.js'))) {
  try {
    execSync('npm run build', { cwd: autocompleteDir, stdio: 'inherit' });
  } catch {
    console.warn('⚠️  postinstall: nebula-autocomplete build failed — run "npm install --include=dev && npm run build" in packages/autocomplete');
  }
}
