/**
 * Actionable hints for known, recognizable kernel errors.
 *
 * Nebula's philosophy is detect + guide, not silently reconfigure the user's
 * environment. When a cell fails with an error we recognize, we surface a hint
 * and — where there's a safe, session-scoped fix — a one-click "apply" that runs
 * it in the *current* kernel. It never mutates files or config behind the user's
 * back; making a fix permanent stays the user's choice (see docs/R_KERNEL.md).
 *
 * This is a small, data-driven table so new hints are one entry, not new plumbing.
 */

export interface KernelHint {
  /** stable id (for keys / future dismissal state) */
  id: string;
  /** short headline shown in the hint bar */
  title: string;
  /** one-line explanation */
  detail: string;
  /** code run in the current kernel when the user clicks apply (session-scoped) */
  fixCode: string;
  /** button label */
  fixLabel: string;
  /** optional note shown after a successful apply (e.g. how to make it permanent) */
  permanenceNote?: string;
}

interface HintRule {
  id: string;
  /** matches against the concatenated error/stderr text of the cell */
  test: RegExp;
  build: () => KernelHint;
}

const RULES: HintRule[] = [
  {
    // Headless R: the default bitmap (png) device is X11, which needs a display
    // the server/container/compute node doesn't have. IRkernel opens a device
    // per cell, so plots fail with "unable to start device PNG".
    id: 'r-headless-cairo',
    test: /unable to start device PNG|unable to open connection to X11 display/i,
    build: () => ({
      id: 'r-headless-cairo',
      title: 'Headless R: switch the plotting device to cairo',
      detail:
        "R's default bitmap device (X11) can't open a display on this server, so plots fail. Cairo needs no display.",
      fixCode: 'options(bitmapType = "cairo")',
      fixLabel: 'Apply cairo fix',
      permanenceNote:
        'Applied to the current session. To make it stick across restarts, add the same line to your ~/.Rprofile.',
    }),
  },
];

/**
 * Scan a cell's outputs for a known, actionable error. Returns the first
 * matching hint, or null. Only error/stderr text is considered.
 */
export function detectKernelHint(
  outputs: Array<{ type: string; content?: string }>
): KernelHint | null {
  const errorText = outputs
    .filter((o) => o.type === 'error' || o.type === 'stderr')
    .map((o) => o.content || '')
    .join('\n');
  if (!errorText.trim()) return null;

  for (const rule of RULES) {
    if (rule.test.test(errorText)) return rule.build();
  }
  return null;
}
