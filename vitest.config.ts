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
    exclude: [...configDefaults.exclude, 'node-server/dist/**'],
  },
});
