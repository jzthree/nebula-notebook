/**
 * Onboarding progress tracker — the "Get started" checklist.
 *
 * Steps are checked off by REAL events (opening a notebook, running a cell,
 * launching an agent, allocating compute), not by a guided tour: call sites
 * fire mark() one-liners and the Dashboard card renders progress. Persisted
 * per-browser in localStorage; disappears forever once complete or dismissed.
 */

const KEY = 'nebula-getstarted';

export type OnboardingStep = 'openedNotebook' | 'ranCell' | 'launchedAgent' | 'allocatedCompute';

export interface OnboardingState {
  openedNotebook: boolean;
  ranCell: boolean;
  launchedAgent: boolean;
  allocatedCompute: boolean;
  dismissed: boolean;
}

const DEFAULT_STATE: OnboardingState = {
  openedNotebook: false,
  ranCell: false,
  launchedAgent: false,
  allocatedCompute: false,
  dismissed: false,
};

let cached: OnboardingState | null = null;
const listeners = new Set<() => void>();

function load(): OnboardingState {
  if (cached) return cached;
  try {
    const raw = localStorage.getItem(KEY);
    cached = raw ? { ...DEFAULT_STATE, ...JSON.parse(raw) } : { ...DEFAULT_STATE };
  } catch {
    cached = { ...DEFAULT_STATE };
  }
  return cached;
}

function save(next: OnboardingState): void {
  cached = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
  for (const l of listeners) l();
}

export function getOnboardingState(): OnboardingState {
  return load();
}

/** Idempotent; cheap enough to call from hot paths. */
export function markOnboardingStep(step: OnboardingStep): void {
  const state = load();
  if (state[step]) return;
  save({ ...state, [step]: true });
}

export function dismissOnboarding(): void {
  const state = load();
  if (state.dismissed) return;
  save({ ...state, dismissed: true });
}

export function subscribeOnboarding(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test hook. */
export function resetOnboardingForTests(): void {
  cached = null;
}
