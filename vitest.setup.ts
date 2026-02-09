import '@testing-library/jest-dom';
import * as os from 'os';
import * as path from 'path';

// Use an in-memory session DB during tests to avoid cross-worker contention
// on the repo's `sessions.db` file (route modules construct a KernelService on import).
if (!process.env.NEBULA_SESSIONS_DB_PATH) {
  process.env.NEBULA_SESSIONS_DB_PATH = ':memory:';
}

// Avoid cross-worker contention on kernel output spool files.
if (!process.env.NEBULA_KERNEL_OUTPUT_SPOOL_DIR) {
  process.env.NEBULA_KERNEL_OUTPUT_SPOOL_DIR = path.join(os.tmpdir(), `nebula-output-spool-${process.pid}`);
}
