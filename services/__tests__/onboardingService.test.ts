import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOnboardingState,
  markOnboardingStep,
  dismissOnboarding,
  subscribeOnboarding,
  resetOnboardingForTests,
} from '../onboardingService';

describe('onboardingService', () => {
  beforeEach(() => {
    window.localStorage.removeItem('nebula-getstarted');
    resetOnboardingForTests();
  });

  it('starts with nothing done', () => {
    const s = getOnboardingState();
    expect(s.openedNotebook).toBe(false);
    expect(s.ranCell).toBe(false);
    expect(s.launchedAgent).toBe(false);
    expect(s.dismissed).toBe(false);
  });

  it('marks steps idempotently and persists', () => {
    markOnboardingStep('ranCell');
    markOnboardingStep('ranCell');
    expect(getOnboardingState().ranCell).toBe(true);
    resetOnboardingForTests(); // force reload from storage
    expect(getOnboardingState().ranCell).toBe(true);
  });

  it('notifies subscribers on change only', () => {
    let calls = 0;
    const unsub = subscribeOnboarding(() => { calls += 1; });
    markOnboardingStep('openedNotebook');
    markOnboardingStep('openedNotebook'); // no-op, no notify
    dismissOnboarding();
    unsub();
    markOnboardingStep('launchedAgent'); // after unsub, no notify
    expect(calls).toBe(2);
  });
});
