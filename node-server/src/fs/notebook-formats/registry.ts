/**
 * Registry for plain-text notebook format adapters.
 *
 * .ipynb is intentionally NOT registered here: dispatch sites check .ipynb
 * first and fall through to the existing Jupyter JSON code path untouched.
 */

import * as path from 'path';
import { NotebookFormatAdapter } from './types';
import { percentAdapter } from './percent';
import { qmdAdapter } from './qmd';

const ADAPTERS: NotebookFormatAdapter[] = [percentAdapter, qmdAdapter];

const BY_EXTENSION = new Map<string, NotebookFormatAdapter>();
for (const adapter of ADAPTERS) {
  for (const ext of adapter.extensions) BY_EXTENSION.set(ext, adapter);
}

export function getFormatAdapter(filePath: string): NotebookFormatAdapter | null {
  return BY_EXTENSION.get(path.extname(filePath).toLowerCase()) ?? null;
}

/**
 * Default kernel for a text-notebook file that does not declare one in its
 * header, keyed by extension. Falls back to python3 for unknown extensions.
 * (.qmd resolves its kernel from the first code fence's language instead.)
 */
const DEFAULT_KERNEL_BY_EXTENSION: Record<string, string> = {
  '.py': 'python3',
  '.r': 'ir',
  '.jl': 'julia',
};

export function defaultKernelForPath(filePath: string): string {
  return DEFAULT_KERNEL_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'python3';
}

export function isTextNotebookPath(filePath: string): boolean {
  return BY_EXTENSION.has(path.extname(filePath).toLowerCase());
}

/** True for any path Nebula can treat as a notebook (.ipynb or text format). */
export function isNotebookPath(filePath: string): boolean {
  return path.extname(filePath).toLowerCase() === '.ipynb' || isTextNotebookPath(filePath);
}
