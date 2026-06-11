/**
 * Notebook file-format helpers (shared by the file browser, notebook header,
 * and save paths).
 *
 * .ipynb and .qmd open as notebooks by default. .py is percent-format capable
 * (the server parses any .py as a notebook) but opens as a TEXT file by
 * default — scripts must not be hijacked — with an explicit
 * "Open as notebook" action.
 */

/** Extensions that open as a notebook on click. */
export const NOTEBOOK_EXTENSIONS = ['.ipynb', '.qmd'];

/** Text formats the server can serve as notebooks (outputs never saved). */
export const TEXT_NOTEBOOK_EXTENSIONS = ['.qmd', '.py'];

export function isNotebookExtension(ext?: string | null): boolean {
  return !!ext && NOTEBOOK_EXTENSIONS.includes(ext.toLowerCase());
}

export function isTextNotebookExtension(ext?: string | null): boolean {
  return !!ext && TEXT_NOTEBOOK_EXTENSIONS.includes(ext.toLowerCase());
}

/** Extension of a path including the dot, lowercased ('' if none). */
export function getPathExtension(pathOrName: string): string {
  const base = pathOrName.slice(pathOrName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot).toLowerCase() : '';
}

/** Display name: file name with a notebook extension stripped. */
export function stripNotebookExtension(name: string): string {
  return name.replace(/\.(ipynb|qmd)$/i, '');
}
