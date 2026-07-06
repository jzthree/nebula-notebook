/**
 * GetStartedCard — the event-driven "Get started" checklist.
 *
 * Steps check themselves off as the user actually does things (tracked by
 * onboardingService via real call sites), so there is no tour to follow or
 * skip. The compute step appears only when the server has a scheduler.
 * Hidden forever once dismissed; celebrates + offers dismiss when complete.
 */

import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { CheckCircle2, Circle, ListChecks, X } from 'lucide-react';
import {
  getOnboardingState,
  subscribeOnboarding,
  dismissOnboarding,
  OnboardingStep,
} from '../services/onboardingService';
import { getComputeStatus } from '../services/computeService';

const STEPS: { key: OnboardingStep; label: string; hint: string; computeOnly?: boolean }[] = [
  { key: 'openedNotebook', label: 'Open a notebook', hint: 'pick one from the file browser, or create one' },
  { key: 'ranCell', label: 'Run a cell', hint: 'Shift+Enter, or Run All in the toolbar' },
  { key: 'launchedAgent', label: 'Launch the agent', hint: 'terminal panel → Agent tab → Claude Code' },
  { key: 'allocatedCompute', label: 'Allocate compute', hint: 'kernel menu → New compute allocation', computeOnly: true },
];

export const GetStartedCard: React.FC = () => {
  const state = useSyncExternalStore(
    useCallback((cb) => subscribeOnboarding(cb), []),
    () => getOnboardingState()
  );
  const [computeEnabled, setComputeEnabled] = useState(false);

  useEffect(() => {
    getComputeStatus()
      .then((s) => setComputeEnabled(!!s?.enabled))
      .catch(() => setComputeEnabled(false));
  }, []);

  const steps = STEPS.filter((s) => !s.computeOnly || computeEnabled);
  const done = steps.filter((s) => state[s.key]).length;
  const allDone = done === steps.length;

  // Once everything is checked, celebrate briefly then retire the card for
  // good — completion shouldn't require finding the X.
  useEffect(() => {
    if (!allDone || state.dismissed) return;
    const timer = setTimeout(dismissOnboarding, 8000);
    return () => clearTimeout(timer);
  }, [allDone, state.dismissed]);

  if (state.dismissed) return null;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 mb-4">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <ListChecks className="w-4 h-4 text-blue-600" />
          <h3 className="text-sm font-semibold text-slate-800">
            {allDone ? 'You’re all set 🎉' : 'Get started'}
          </h3>
          <span className="text-xs text-slate-400">{done}/{steps.length}</span>
        </div>
        <button
          onClick={dismissOnboarding}
          aria-label="Dismiss checklist"
          className="p-0.5 text-slate-400 hover:text-slate-600 rounded"
          title={allDone ? 'Hide this — you’ve done it all' : 'Hide this checklist permanently'}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {/* progress bar */}
      <div className="h-1 rounded-full bg-slate-100 overflow-hidden mb-3">
        <div
          className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-blue-500 transition-all"
          style={{ width: `${(done / steps.length) * 100}%` }}
        />
      </div>
      <ul className="space-y-1.5">
        {steps.map((s) => {
          const checked = state[s.key];
          return (
            <li key={s.key} className="flex items-center gap-2 text-sm">
              {checked
                ? <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />
                : <Circle className="w-4 h-4 text-slate-300 flex-shrink-0" />}
              <span className={checked ? 'text-slate-400 line-through' : 'text-slate-700'}>{s.label}</span>
              {!checked && <span className="text-xs text-slate-400 truncate">— {s.hint}</span>}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
