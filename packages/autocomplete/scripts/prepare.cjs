/**
 * Build on install — but only when TypeScript is actually installed.
 *
 * Production-mode installs (NODE_ENV=production in the shell, --production,
 * --omit=dev) skip devDependencies, yet npm still runs `prepare` — including
 * for the root repo's `file:` dependency on this package. Hard-failing on the
 * missing tsc strands `npm install` on fresh clones ("sh: 1: tsc: not found").
 * Skip with a warning instead; the repo's postinstall re-installs this package
 * WITH dev dependencies and the build runs then.
 */
const { execSync } = require('child_process');
const path = require('path');

try {
  require.resolve('typescript');
} catch {
  console.warn(
    '[nebula-autocomplete] prepare: typescript is not installed (production-mode ' +
    'install?) — skipping the build. The repo postinstall builds it with dev deps; ' +
    'standalone users: npm install --include=dev'
  );
  process.exit(0);
}

execSync('npx tsc -p tsconfig.json', { stdio: 'inherit', cwd: path.join(__dirname, '..') });
