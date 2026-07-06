import '@testing-library/jest-dom';

// Node >= 22 exposes its own experimental `localStorage`/`sessionStorage`
// globals which shadow jsdom's working Storage implementation inside vitest's
// jsdom environment. On this setup they are method-less objects (getItem /
// setItem are undefined), so any code touching web storage throws
// "localStorage.getItem is not a function". Replace broken globals with a
// functional in-memory Storage stub.
function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => { store.clear(); },
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => { store.delete(key); },
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
  } as Storage;
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  const existing = (globalThis as any)[name];
  if (typeof existing?.getItem !== 'function') {
    Object.defineProperty(globalThis, name, {
      value: createStorageStub(),
      writable: true,
      configurable: true,
    });
  }
}

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
