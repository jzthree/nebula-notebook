import React, { useState } from 'react';
import { Lightbulb, Check, Loader2 } from 'lucide-react';
import { kernelService } from '../services/kernelService';
import { KernelHint } from '../utils/kernelHints';

/**
 * A small, dismissible-feeling hint shown under a cell whose error we recognize.
 * The "apply" button runs the fix in the *current* kernel (session-scoped) — it
 * never writes files or changes config. See utils/kernelHints.ts.
 */
export const KernelHintBar: React.FC<{ hint: KernelHint; kernelSessionId?: string }> = ({
  hint,
  kernelSessionId,
}) => {
  const [state, setState] = useState<'idle' | 'applying' | 'applied' | 'error'>('idle');

  const apply = async () => {
    if (!kernelSessionId) return;
    setState('applying');
    try {
      // Side-execute (no cell id): runs the fix in the live kernel, produces no
      // visible output. The user then re-runs their cell to render the plot.
      await kernelService.executeCode(kernelSessionId, hint.fixCode, () => {});
      setState('applied');
    } catch {
      setState('error');
    }
  };

  return (
    <div className="flex items-start gap-2 mt-1 mb-2 px-3 py-2 rounded-md border border-amber-200 bg-amber-50 text-amber-900 text-sm">
      <Lightbulb className="w-4 h-4 mt-0.5 flex-shrink-0 text-amber-500" />
      <div className="min-w-0">
        <div className="font-medium">{hint.title}</div>
        <div className="text-amber-800">{hint.detail}</div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {state === 'applied' ? (
            <span className="inline-flex items-center gap-1 text-green-700 font-medium">
              <Check className="w-4 h-4" /> Applied — re-run the cell
            </span>
          ) : (
            <button
              onClick={apply}
              disabled={!kernelSessionId || state === 'applying'}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-amber-600 text-white text-xs font-medium hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
              title={
                kernelSessionId
                  ? `Runs ${hint.fixCode} in this kernel`
                  : 'No live kernel to apply to'
              }
            >
              {state === 'applying' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {hint.fixLabel}
            </button>
          )}
          <code className="text-xs text-amber-700 font-mono">{hint.fixCode}</code>
        </div>
        {state === 'error' && (
          <div className="text-red-600 text-xs mt-1.5">
            Couldn't apply — is the kernel connected?
          </div>
        )}
        {state === 'applied' && hint.permanenceNote && (
          <div className="text-amber-800 text-xs mt-1.5">{hint.permanenceNote}</div>
        )}
      </div>
    </div>
  );
};
