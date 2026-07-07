import { defineConfig } from 'vitest/config';

// Self-contained config so this package's tests don't inherit the parent
// nebula-notebook vitest config (which sets up a jsdom/React environment and
// a setupFiles path that doesn't exist here). This package is a plain
// Node/TS library — default node environment, tests under test/.
export default defineConfig({
  root: __dirname,
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
