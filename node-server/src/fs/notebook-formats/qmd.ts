/**
 * Quarto adapter (.qmd) — notebook-first.
 *
 * A .qmd is treated as a notebook that doesn't serialize outputs:
 *   - optional YAML front matter (kept opaque; jupyter/nebula keys normalized)
 *   - ```{lang ...} fences are code cells; `#| id: x` carries the cell id;
 *     all other `#|` chunk options stay in cell content verbatim (they are
 *     valid comments) and are never interpreted
 *   - prose between fences becomes markdown cells
 *
 * No Quarto rendering, no chunk-option semantics, one kernel per document.
 *
 * Known unrepresentables (documented v1 limits, inherent to the format):
 *   - markdown cells cannot persist ids (prose has no metadata slot) — they
 *     get the positional `cell-${i}` fallback
 *   - an empty markdown cell is dropped on save
 *   - adjacent markdown cells merge into one on the next load (prose blocks
 *     are delimited only by code fences — jupytext/Quarto behave the same)
 *   - markdown content containing a bare ```{lang} fence-open line outside a
 *     wrapping plain fence is indistinguishable from a real code chunk (in
 *     Quarto itself too) and will re-parse as one
 */

import * as YAML from 'yaml';
import { NebulaCell } from '../types';
import { NotebookFormatAdapter, ParsedTextNotebook } from './types';

const CODE_FENCE_OPEN_RE = /^(`{3,})\{(\w+)([^}]*)\}\s*$/;
const PLAIN_FENCE_RE = /^(`{3,})(?!\{)/;
const ID_OPTION_RE = /^#\|\s*id:\s*(\S+)\s*$/;

const LANG_TO_KERNEL: Record<string, string> = {
  python: 'python3',
  r: 'ir',
};

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

interface FrontMatterParse {
  metadata: Record<string, unknown>;
  kernelspecName: string | null;
  bodyStart: number;
}

function parseFrontMatter(lines: string[]): FrontMatterParse {
  if (lines[0] !== '---') return { metadata: {}, kernelspecName: null, bodyStart: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '---' || lines[i] === '...') { end = i; break; }
  }
  if (end === -1) return { metadata: {}, kernelspecName: null, bodyStart: 0 };
  let fm: Record<string, unknown>;
  try {
    const parsed = YAML.parse(lines.slice(1, end).join('\n'));
    fm = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return { metadata: {}, kernelspecName: null, bodyStart: 0 };
  }

  const metadata: Record<string, unknown> = { __qmd_front_matter: fm };
  let kernelspecName: string | null = null;

  const jupyter = fm.jupyter;
  if (typeof jupyter === 'string') {
    kernelspecName = jupyter;
    metadata.kernelspec = { name: jupyter };
  } else if (jupyter && typeof jupyter === 'object') {
    const kernelspec = (jupyter as Record<string, unknown>).kernelspec;
    if (kernelspec && typeof kernelspec === 'object') {
      metadata.kernelspec = kernelspec;
      const name = (kernelspec as Record<string, unknown>).name;
      if (typeof name === 'string') kernelspecName = name;
    }
  }
  if (fm.nebula && typeof fm.nebula === 'object') {
    metadata.nebula = fm.nebula;
  }

  let bodyStart = end + 1;
  if (lines[bodyStart] === '') bodyStart++;
  return { metadata, kernelspecName, bodyStart };
}

function makeMarkdownCell(index: number, bodyLines: string[]): NebulaCell | null {
  // Trim one leading and one trailing blank line (block separators)
  const body = [...bodyLines];
  if (body[0] === '') body.shift();
  if (body[body.length - 1] === '') body.pop();
  if (body.length === 0) return null;
  return {
    id: `cell-${index}`,
    type: 'markdown',
    content: body.join('\n'),
    outputs: [],
    executionCount: null,
    isExecuting: false,
  };
}

function parse(text: string): ParsedTextNotebook {
  const lines = normalizeEol(text).split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const { metadata, kernelspecName, bodyStart } = parseFrontMatter(lines);

  const cells: NebulaCell[] = [];
  let prose: string[] = [];
  let firstLanguage: string | null = null;

  const flushProse = () => {
    const cell = makeMarkdownCell(cells.length, prose);
    if (cell) cells.push(cell);
    prose = [];
  };

  let i = bodyStart;
  while (i < lines.length) {
    const line = lines[i];
    const codeOpen = line.match(CODE_FENCE_OPEN_RE);
    if (codeOpen) {
      flushProse();
      const ticks = codeOpen[1].length;
      const language = codeOpen[2];
      const fenceInner = `${codeOpen[2]}${codeOpen[3]}`;
      if (!firstLanguage) firstLanguage = language;
      const body: string[] = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (new RegExp(`^\`{${ticks},}\\s*$`).test(lines[i])) { closed = true; i++; break; }
        body.push(lines[i]);
        i++;
      }
      void closed; // unterminated fence: treat rest of file as the cell body
      // Consume a leading `#| id:` option as the cell id
      let id: string | null = null;
      if (body.length > 0) {
        const idMatch = body[0].match(ID_OPTION_RE);
        if (idMatch) {
          id = idMatch[1];
          body.shift();
        }
      }
      const cell: NebulaCell = {
        id: id ?? `cell-${cells.length}`,
        type: 'code',
        content: body.join('\n'),
        outputs: [],
        executionCount: null,
        isExecuting: false,
      };
      (cell as NebulaCell & { _metadata?: Record<string, unknown> })._metadata = {
        qmd_fence_attrs: fenceInner,
      };
      cells.push(cell);
      // Skip one blank separator after the closing fence
      if (lines[i] === '') i++;
      continue;
    }

    const plainFence = line.match(PLAIN_FENCE_RE);
    if (plainFence) {
      // A plain fence inside prose: copy verbatim until its closer so that
      // ```{lang} examples inside it are never mistaken for cell starts.
      const ticks = plainFence[1].length;
      prose.push(line);
      i++;
      while (i < lines.length) {
        prose.push(lines[i]);
        if (new RegExp(`^\`{${ticks},}\\s*$`).test(lines[i])) { i++; break; }
        i++;
      }
      continue;
    }

    prose.push(line);
    i++;
  }
  flushProse();

  if (firstLanguage) metadata.__qmd_language = firstLanguage;

  let resolvedKernel = kernelspecName;
  if (!resolvedKernel && firstLanguage) {
    resolvedKernel = LANG_TO_KERNEL[firstLanguage.toLowerCase()] ?? null;
  }

  return { cells, metadata, kernelspecName: resolvedKernel };
}

function serializeFrontMatter(
  metadata: Record<string, unknown>,
  kernelName?: string
): string[] {
  const base = (metadata.__qmd_front_matter && typeof metadata.__qmd_front_matter === 'object'
    ? { ...(metadata.__qmd_front_matter as Record<string, unknown>) }
    : {}) as Record<string, unknown>;

  const kernelspec = (metadata.kernelspec && typeof metadata.kernelspec === 'object'
    ? { ...(metadata.kernelspec as Record<string, unknown>) }
    : {}) as Record<string, unknown>;
  if (kernelName) kernelspec.name = kernelName;
  if (Object.keys(kernelspec).length > 0) {
    const jupyter = (base.jupyter && typeof base.jupyter === 'object'
      ? { ...(base.jupyter as Record<string, unknown>) }
      : {}) as Record<string, unknown>;
    jupyter.kernelspec = kernelspec;
    base.jupyter = jupyter;
  }
  if (metadata.nebula && typeof metadata.nebula === 'object') {
    base.nebula = metadata.nebula;
  } else {
    delete base.nebula;
  }

  if (Object.keys(base).length === 0) return [];
  const yamlText = YAML.stringify(base, { lineWidth: 0 }).trimEnd();
  return ['---', ...yamlText.split('\n'), '---'];
}

function serialize(
  cells: NebulaCell[],
  metadata: Record<string, unknown>,
  kernelName?: string
): string {
  const language = typeof metadata.__qmd_language === 'string' ? metadata.__qmd_language : 'python';
  const out: string[] = serializeFrontMatter(metadata, kernelName);
  for (const cell of cells) {
    if (cell.type === 'markdown' && cell.content === '') continue; // unrepresentable
    if (out.length > 0) out.push('');
    if (cell.type === 'markdown') {
      out.push(...cell.content.split('\n'));
    } else {
      const meta = (cell as NebulaCell & { _metadata?: Record<string, unknown> })._metadata ?? {};
      const fenceInner = typeof meta.qmd_fence_attrs === 'string' ? meta.qmd_fence_attrs : language;
      // Fence must be longer than any backtick run starting a content line,
      // or the content would close it early.
      let maxRun = 0;
      for (const l of cell.content.split('\n')) {
        const run = l.match(/^(`+)/);
        if (run) maxRun = Math.max(maxRun, run[1].length);
      }
      const fence = '`'.repeat(Math.max(3, maxRun + 1));
      out.push(fence + '{' + fenceInner + '}');
      out.push(`#| id: ${cell.id}`);
      if (cell.content !== '') out.push(...cell.content.split('\n'));
      out.push(fence);
    }
  }
  return out.join('\n') + '\n';
}

export const qmdAdapter: NotebookFormatAdapter = {
  name: 'qmd',
  extensions: ['.qmd'],
  capabilities: { storesOutputs: false, storesCellIds: false },
  parse,
  serialize,
};
