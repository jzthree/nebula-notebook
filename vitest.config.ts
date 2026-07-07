import { defineConfig, configDefaults } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    // Forks are more reliable than worker threads with native addons used by node-server (e.g. better-sqlite3).
    pool: 'forks',
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // packages/* are standalone sub-packages with their own test runners
    // (npm run mcp:test / autocomplete:test) — don't sweep them into the
    // root jsdom/React run.
    exclude: [...configDefaults.exclude, 'node-server/dist/**', 'packages/**'],
  },
});
