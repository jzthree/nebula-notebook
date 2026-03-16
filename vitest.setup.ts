import '@testing-library/jest-dom';

// Mock IntersectionObserver (not available in jsdom)
if (typeof IntersectionObserver === 'undefined') {
  global.IntersectionObserver = class IntersectionObserver {
    constructor(private callback: IntersectionObserverCallback) {}
    observe() { /* Immediately report as intersecting so lazy CodeMirror mounts */
      this.callback([{ isIntersecting: true, target: document.createElement('div') } as any], this as any);
    }
    unobserve() {}
    disconnect() {}
  } as any;
}

// Use an in-memory session DB during tests to avoid cross-worker contention
// on the repo's `sessions.db` file (route modules construct a KernelService on import).
if (!process.env.NEBULA_SESSIONS_DB_PATH) {
  process.env.NEBULA_SESSIONS_DB_PATH = ':memory:';
}
