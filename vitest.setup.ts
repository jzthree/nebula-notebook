import '@testing-library/jest-dom';

// Use an in-memory session DB during tests to avoid cross-worker contention
// on the repo's `sessions.db` file (route modules construct a KernelService on import).
if (!process.env.NEBULA_SESSIONS_DB_PATH) {
  process.env.NEBULA_SESSIONS_DB_PATH = ':memory:';
}
