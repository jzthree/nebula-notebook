/**
 * Plain-text notebook format adapters (jupytext percent .py, Quarto .qmd).
 *
 * These formats are "notebooks that don't serialize outputs": the in-memory
 * model is the same NebulaCell[] the rest of the system uses; only the
 * on-disk representation differs. Outputs, execution counts, and UI state
 * are never written to disk for these formats — that is the point of them.
 *
 * .ipynb is deliberately NOT an adapter: every dispatch site checks .ipynb
 * first and falls into the existing, unmodified Jupyter JSON code path.
 */

import { NebulaCell } from '../types';

export interface ParsedTextNotebook {
  /** Cells with outputs: [], executionCount: null. Ids come from in-file
   *  markers when present, else the positional `cell-${i}` fallback (the
   *  same degraded mode legacy .ipynb files without nebula_id use). */
  cells: NebulaCell[];
  /** Normalized notebook metadata: kernelspec?, nebula?, plus opaque
   *  format-specific keys the serializer round-trips. */
  metadata: Record<string, unknown>;
  /** Kernelspec name if the file declares one, else null (caller falls back
   *  to the existing env-default resolution). */
  kernelspecName: string | null;
}

export interface NotebookFormatAdapter {
  name: 'percent' | 'qmd';
  /** Lowercased extensions including the dot, e.g. ['.py']. */
  extensions: string[];
  capabilities: {
    storesOutputs: false;
    /** Whether cell ids can persist in the file for ALL cell types.
     *  percent: true. qmd: code cells only (prose has no metadata slot). */
    storesCellIds: boolean;
  };
  parse(text: string): ParsedTextNotebook;
  serialize(
    cells: NebulaCell[],
    metadata: Record<string, unknown>,
    kernelName?: string
  ): string;
}
