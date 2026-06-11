/**
 * jupytext percent-format adapter (.py).
 *
 * Format essentials:
 *   - optional jupytext-style header: `# ---` / `# `-prefixed YAML / `# ---`
 *   - `# %%` markers start cells; `[markdown]` / `[raw]` tag cell type;
 *     `id=<token>` carries the Nebula cell id (jupytext-legal key=value)
 *   - markdown/raw bodies are `# `-commented
 *   - outputs and execution counts are never serialized
 *
 * Anything on a marker line that we don't understand is preserved verbatim
 * (cell._metadata.percent_header_rest) and re-emitted — never interpreted.
 */

import * as YAML from 'yaml';
import { NebulaCell } from '../types';
import { NotebookFormatAdapter, ParsedTextNotebook } from './types';

const MARKER_RE = /^#\s*%%(.*)$/;
// Accept quoted (proper jupytext key="value" metadata) and bare id tokens
const ID_TOKEN_RE = /(^|\s)id="?([A-Za-z0-9_-]+)"?/;

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

interface MarkerInfo {
  cellType: 'code' | 'markdown' | 'raw';
  id: string | null;
  rest: string; // verbatim remainder, excluding the type tag and id token
}

function parseMarkerRemainder(remainder: string): MarkerInfo {
  let rest = remainder;
  let cellType: MarkerInfo['cellType'] = 'code';
  if (/(^|\s)\[markdown\](\s|$)/.test(rest)) {
    cellType = 'markdown';
    rest = rest.replace(/(^|\s)\[markdown\](?=\s|$)/, '$1');
  } else if (/(^|\s)\[raw\](\s|$)/.test(rest)) {
    cellType = 'raw';
    rest = rest.replace(/(^|\s)\[raw\](?=\s|$)/, '$1');
  }
  let id: string | null = null;
  const idMatch = rest.match(ID_TOKEN_RE);
  if (idMatch) {
    id = idMatch[2];
    rest = rest.replace(ID_TOKEN_RE, '$1');
  }
  return { cellType, id, rest: rest.replace(/\s+/g, ' ').trim() };
}

/** Markdown/raw bodies are `# `-commented. A body line that would itself
 *  render as a cell marker is backslash-escaped (`\%%` ↔ `%%`) so the
 *  file-level scanner can never mistake it for a marker. Classical escape:
 *  serializer prepends one backslash to any leading `\*%%` run, parser
 *  removes one. Lossless for all inputs. */
function encodeCommentLine(line: string): string {
  const escaped = /^(\s*)(\\*)%%/.test(line)
    ? line.replace(/^(\s*)(\\*)%%/, '$1\\$2%%')
    : line;
  return escaped === '' ? '#' : `# ${escaped}`;
}

function decodeCommentLine(line: string): string {
  let body: string;
  if (line === '#') body = '';
  else if (line.startsWith('# ')) body = line.slice(2);
  else if (line.startsWith('#')) body = line.slice(1);
  else body = line; // lenient: uncommented line inside a markdown body
  return /^(\s*)\\(\\*)%%/.test(body) ? body.replace(/^(\s*)\\(\\*)%%/, '$1$2%%') : body;
}

interface HeaderParse {
  metadata: Record<string, unknown>;
  kernelspecName: string | null;
  bodyStart: number; // line index where content begins
}

function parseHeader(lines: string[]): HeaderParse {
  if (lines[0] !== '# ---') return { metadata: {}, kernelspecName: null, bodyStart: 0 };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === '# ---') { end = i; break; }
    if (!lines[i].startsWith('#')) return { metadata: {}, kernelspecName: null, bodyStart: 0 };
  }
  if (end === -1) return { metadata: {}, kernelspecName: null, bodyStart: 0 };
  const yamlText = lines
    .slice(1, end)
    .map((l) => (l === '#' ? '' : l.startsWith('# ') ? l.slice(2) : l.slice(1)))
    .join('\n');
  let headerObj: Record<string, unknown>;
  try {
    const parsed = YAML.parse(yamlText);
    headerObj = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    // Unparseable header: treat the whole block as content rather than lose it
    return { metadata: {}, kernelspecName: null, bodyStart: 0 };
  }
  const jupyter = (headerObj.jupyter && typeof headerObj.jupyter === 'object'
    ? headerObj.jupyter
    : {}) as Record<string, unknown>;
  const metadata: Record<string, unknown> = { ...jupyter };
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(headerObj)) {
    if (k !== 'jupyter') extra[k] = v;
  }
  if (Object.keys(extra).length > 0) metadata.__percent_header_extra = extra;
  const kernelspec = metadata.kernelspec as Record<string, unknown> | undefined;
  const kernelspecName = typeof kernelspec?.name === 'string' ? kernelspec.name : null;
  // Skip one blank separator line after the header if present
  let bodyStart = end + 1;
  if (lines[bodyStart] === '') bodyStart++;
  return { metadata, kernelspecName, bodyStart };
}

function makeCell(
  index: number,
  info: MarkerInfo | null,
  bodyLines: string[],
  trimSeparator: boolean
): NebulaCell {
  const cellType = info?.cellType ?? 'code';
  // The serializer emits exactly one blank separator line between a cell body
  // and the NEXT marker. Trim it only when a following marker caused this
  // flush — at EOF there is no separator, so trailing blanks belong to the
  // cell content itself.
  const body = [...bodyLines];
  if (trimSeparator && body[body.length - 1] === '') body.pop();
  const content =
    cellType === 'code'
      ? body.join('\n')
      : body.map(decodeCommentLine).join('\n');
  const cell: NebulaCell = {
    id: info?.id ?? `cell-${index}`,
    type: cellType === 'code' ? 'code' : 'markdown',
    content,
    outputs: [],
    executionCount: null,
    isExecuting: false,
  };
  const meta: Record<string, unknown> = {};
  if (cellType === 'raw') meta.percent_cell_type = 'raw';
  if (info && info.rest) meta.percent_header_rest = info.rest;
  if (Object.keys(meta).length > 0) (cell as NebulaCell & { _metadata?: Record<string, unknown> })._metadata = meta;
  return cell;
}

function parse(text: string): ParsedTextNotebook {
  const lines = normalizeEol(text).split('\n');
  // Drop the implicit final empty string from a trailing newline
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const { metadata, kernelspecName, bodyStart } = parseHeader(lines);

  const cells: NebulaCell[] = [];
  let currentInfo: MarkerInfo | null = null;
  let currentBody: string[] = [];
  let sawMarker = false;
  let started = false; // whether any non-blank content seen before first marker

  const flush = (trimSeparator: boolean) => {
    if (currentInfo === null && !started) return; // nothing accumulated
    cells.push(makeCell(cells.length, currentInfo, currentBody, trimSeparator));
  };

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    const m = line.match(MARKER_RE);
    if (m) {
      if (sawMarker || started) flush(true);
      currentInfo = parseMarkerRemainder(m[1]);
      currentBody = [];
      sawMarker = true;
      started = true;
    } else {
      if (!started && line.trim() !== '') started = true;
      currentBody.push(line);
    }
  }
  if (sawMarker || started) flush(false);

  return { cells, metadata, kernelspecName };
}

function serializeHeader(
  metadata: Record<string, unknown>,
  kernelName?: string
): string[] {
  const jupyter: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(metadata)) {
    if (k !== '__percent_header_extra') jupyter[k] = v;
  }
  if (kernelName) {
    const existing = (jupyter.kernelspec && typeof jupyter.kernelspec === 'object'
      ? jupyter.kernelspec
      : {}) as Record<string, unknown>;
    jupyter.kernelspec = { ...existing, name: kernelName };
  }
  const extra = (metadata.__percent_header_extra ?? {}) as Record<string, unknown>;
  const headerObj: Record<string, unknown> = { ...extra };
  if (Object.keys(jupyter).length > 0) headerObj.jupyter = jupyter;
  if (Object.keys(headerObj).length === 0) return [];
  const yamlText = YAML.stringify(headerObj, { lineWidth: 0 }).trimEnd();
  return [
    '# ---',
    ...yamlText.split('\n').map((l) => (l === '' ? '#' : `# ${l}`)),
    '# ---',
  ];
}

function serializeMarker(cell: NebulaCell): string {
  const meta = (cell as NebulaCell & { _metadata?: Record<string, unknown> })._metadata ?? {};
  const parts: string[] = [];
  const rest = typeof meta.percent_header_rest === 'string' ? meta.percent_header_rest : '';
  if (rest) parts.push(rest);
  if (meta.percent_cell_type === 'raw') parts.push('[raw]');
  else if (cell.type === 'markdown') parts.push('[markdown]');
  parts.push(`id="${cell.id}"`);
  return `# %% ${parts.join(' ')}`;
}

function serialize(
  cells: NebulaCell[],
  metadata: Record<string, unknown>,
  kernelName?: string
): string {
  const out: string[] = serializeHeader(metadata, kernelName);
  cells.forEach((cell, i) => {
    // Exactly one blank separator before every marker except a file-leading one
    if (out.length > 0) out.push('');
    out.push(serializeMarker(cell));
    const contentLines = cell.content === '' ? [] : cell.content.split('\n');
    if (cell.type === 'code') out.push(...contentLines);
    else out.push(...contentLines.map(encodeCommentLine));
    void i;
  });
  return out.join('\n') + '\n';
}

export const percentAdapter: NotebookFormatAdapter = {
  name: 'percent',
  extensions: ['.py'],
  capabilities: { storesOutputs: false, storesCellIds: true },
  parse,
  serialize,
};
