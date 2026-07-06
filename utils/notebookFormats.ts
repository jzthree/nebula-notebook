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

/** Text formats the server can serve as notebooks (outputs never saved).
 *  The percent-format family (.py/.R/.jl) opens as text by default with an
 *  explicit "Open as notebook" action; .qmd opens as a notebook directly. */
export const TEXT_NOTEBOOK_EXTENSIONS = ['.qmd', '.py', '.r', '.jl'];

export function isNotebookExtension(ext?: string | null): boolean {
  return !!ext && NOTEBOOK_EXTENSIONS.includes(ext.toLowerCase());
}

export function isTextNotebookExtension(ext?: string | null): boolean {
  return !!ext && TEXT_NOTEBOOK_EXTENSIONS.includes(ext.toLowerCase());
}

/** Percent-format source scripts (.py/.R/.jl): open as text by default, but
 *  can be opened as a notebook. Excludes .qmd, which opens as a notebook. */
export function isScriptNotebookExtension(ext?: string | null): boolean {
  return isTextNotebookExtension(ext) && !isNotebookExtension(ext);
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
