type ExtensionMode = 'interactive' | 'minimal';
type EditorLanguage = 'python' | 'markdown' | 'unknown';

interface RollingBucket {
  count: number;
  totalMs: number;
  maxMs: number;
  samples: number[];
  nextSampleIndex: number;
}

interface PerfSnapshotBucket {
  count: number;
  sampleCount: number;
  avgMs: number;
  p95Ms: number;
  maxMs: number;
}

interface PerfSnapshot {
  trackingEnabled: boolean;
  minimalExtensionsEnabled: boolean;
  startedAt: string;
  byMode: Record<ExtensionMode, PerfSnapshotBucket>;
  byLanguage: Record<EditorLanguage, PerfSnapshotBucket>;
}

interface EditorPerfWindowApi {
  enableTracking: () => void;
  disableTracking: () => void;
  reset: () => void;
  snapshot: () => PerfSnapshot;
  status: () => { trackingEnabled: boolean; minimalExtensionsEnabled: boolean };
  setMinimalExtensionsEnabled: (enabled: boolean) => void;
}

const MAX_SAMPLES = 500;
const TRACKING_STORAGE_KEY = 'nebula-editor-perf-enabled';
const FORCE_INTERACTIVE_STORAGE_KEY = 'nebula-force-interactive-features';
const TRACKING_QUERY_KEY = 'editorPerf';
const MINIMAL_EXT_QUERY_KEY = 'minimalExtensions';
const DISABLE_MINIMAL_VALUES = new Set(['0', 'off', 'false']);

const createBucket = (): RollingBucket => ({
  count: 0,
  totalMs: 0,
  maxMs: 0,
  samples: [],
  nextSampleIndex: 0,
});

const state = {
  trackingEnabled: false,
  forceInteractiveFeatures: false,
  startedAtMs: Date.now(),
  byMode: {
    interactive: createBucket(),
    minimal: createBucket(),
  } as Record<ExtensionMode, RollingBucket>,
  byLanguage: {
    python: createBucket(),
    markdown: createBucket(),
    unknown: createBucket(),
  } as Record<EditorLanguage, RollingBucket>,
};

const isBrowser = typeof window !== 'undefined';

const pushSample = (bucket: RollingBucket, durationMs: number): void => {
  if (bucket.samples.length < MAX_SAMPLES) {
    bucket.samples.push(durationMs);
    return;
  }
  bucket.samples[bucket.nextSampleIndex] = durationMs;
  bucket.nextSampleIndex = (bucket.nextSampleIndex + 1) % MAX_SAMPLES;
};

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[index];
};

const toSnapshotBucket = (bucket: RollingBucket): PerfSnapshotBucket => ({
  count: bucket.count,
  sampleCount: bucket.samples.length,
  avgMs: bucket.count > 0 ? bucket.totalMs / bucket.count : 0,
  p95Ms: percentile(bucket.samples, 95),
  maxMs: bucket.maxMs,
});

const setTrackingEnabled = (enabled: boolean): void => {
  state.trackingEnabled = enabled;
  if (!isBrowser) return;
  if (enabled) {
    window.localStorage.setItem(TRACKING_STORAGE_KEY, '1');
  } else {
    window.localStorage.removeItem(TRACKING_STORAGE_KEY);
  }
};

const setForceInteractiveFeatures = (enabled: boolean): void => {
  state.forceInteractiveFeatures = enabled;
  if (!isBrowser) return;
  if (enabled) {
    window.localStorage.setItem(FORCE_INTERACTIVE_STORAGE_KEY, '1');
  } else {
    window.localStorage.removeItem(FORCE_INTERACTIVE_STORAGE_KEY);
  }
};

const reset = (): void => {
  state.byMode.interactive = createBucket();
  state.byMode.minimal = createBucket();
  state.byLanguage.python = createBucket();
  state.byLanguage.markdown = createBucket();
  state.byLanguage.unknown = createBucket();
  state.startedAtMs = Date.now();
};

const snapshot = (): PerfSnapshot => ({
  trackingEnabled: state.trackingEnabled,
  minimalExtensionsEnabled: !state.forceInteractiveFeatures,
  startedAt: new Date(state.startedAtMs).toISOString(),
  byMode: {
    interactive: toSnapshotBucket(state.byMode.interactive),
    minimal: toSnapshotBucket(state.byMode.minimal),
  },
  byLanguage: {
    python: toSnapshotBucket(state.byLanguage.python),
    markdown: toSnapshotBucket(state.byLanguage.markdown),
    unknown: toSnapshotBucket(state.byLanguage.unknown),
  },
});

const initFromBrowser = (): void => {
  if (!isBrowser) return;
  const params = new URLSearchParams(window.location.search);
  const queryTracking = params.get(TRACKING_QUERY_KEY);
  const queryMinimal = params.get(MINIMAL_EXT_QUERY_KEY);

  const trackingFromStorage = window.localStorage.getItem(TRACKING_STORAGE_KEY) === '1';
  state.trackingEnabled = queryTracking === '1' || trackingFromStorage;

  if (queryMinimal) {
    state.forceInteractiveFeatures = DISABLE_MINIMAL_VALUES.has(queryMinimal.toLowerCase());
  } else {
    state.forceInteractiveFeatures = window.localStorage.getItem(FORCE_INTERACTIVE_STORAGE_KEY) === '1';
  }
};

const installWindowApi = (): void => {
  if (!isBrowser) return;
  if (window.__nebulaEditorPerf) return;

  const api: EditorPerfWindowApi = {
    enableTracking: () => setTrackingEnabled(true),
    disableTracking: () => setTrackingEnabled(false),
    reset,
    snapshot,
    status: () => ({
      trackingEnabled: state.trackingEnabled,
      minimalExtensionsEnabled: !state.forceInteractiveFeatures,
    }),
    setMinimalExtensionsEnabled: (enabled: boolean) => {
      setForceInteractiveFeatures(!enabled);
    },
  };

  window.__nebulaEditorPerf = api;
};

declare global {
  interface Window {
    __nebulaEditorPerf?: EditorPerfWindowApi;
  }
}

initFromBrowser();
installWindowApi();

export const isEditorPerfTrackingEnabled = (): boolean => state.trackingEnabled;
export const shouldForceInteractiveFeatures = (): boolean => state.forceInteractiveFeatures;

export const recordEditorExtensionBuild = (
  mode: ExtensionMode,
  durationMs: number,
  language: EditorLanguage
): void => {
  if (!state.trackingEnabled) return;
  if (!Number.isFinite(durationMs) || durationMs < 0) return;

  const modeBucket = state.byMode[mode];
  modeBucket.count += 1;
  modeBucket.totalMs += durationMs;
  modeBucket.maxMs = Math.max(modeBucket.maxMs, durationMs);
  pushSample(modeBucket, durationMs);

  const safeLanguage: EditorLanguage = language === 'python' || language === 'markdown' ? language : 'unknown';
  const languageBucket = state.byLanguage[safeLanguage];
  languageBucket.count += 1;
  languageBucket.totalMs += durationMs;
  languageBucket.maxMs = Math.max(languageBucket.maxMs, durationMs);
  pushSample(languageBucket, durationMs);
};
