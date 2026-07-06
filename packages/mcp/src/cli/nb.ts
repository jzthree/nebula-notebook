/**
 * `nebula nb …` — notebook cell commands (read / edit / insert / delete / search).
 *
 * Thin wrappers over the shared tool objects in ../tools and NebulaClient
 * operations; all HTTP goes through the same code the MCP server uses.
 */

import { randomBytes } from 'node:crypto';
import type { NotebookCell } from '../types.js';
import {
  readNotebookTool,
  readCellTool,
  insertCellTool,
  deleteCellTool,
  searchCellsTool,
} from '../tools/notebook.js';
import {
  CliError,
  EXIT,
  firstLineOf,
  makeClient,
  parse,
  parseIntFlag,
  printHint,
  printJson,
  requirePositional,
  resolveContentInput,
  resolveUrl,
  tailLines,
  toCliError,
  type ParsedArgs,
} from './shared.js';

const NB_HELP = `usage: nebula nb <read|edit|insert|delete|search> …

examples:
  nebula nb read analysis.ipynb
  nebula nb edit analysis.ipynb cell-3 --content 'x = 42'
  nebula nb insert analysis.ipynb --index -1 --content 'print(x)'
  nebula nb delete analysis.ipynb cell-3
  nebula nb search analysis.ipynb "read_csv"

Run 'nebula nb <subcommand> --help' for details.`;

export async function cmdNb(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'read':
      return nbRead(rest);
    case 'edit':
      return nbEdit(rest);
    case 'insert':
      return nbInsert(rest);
    case 'delete':
      return nbDelete(rest);
    case 'search':
      return nbSearch(rest);
    case undefined:
    case '--help':
    case '-h':
      console.log(NB_HELP);
      return sub === undefined ? EXIT.USAGE : EXIT.OK;
    default:
      throw new CliError(`unknown nb subcommand: ${sub}`, EXIT.USAGE, "run 'nebula nb --help' for the list");
  }
}

// =============================================================================
// nb read
// =============================================================================

const READ_HELP = `usage: nebula nb read <path> [--cells A-B|id,id] [--outputs] [--full]

One line per cell: #<idx> <id> <type> [exec_count] <first line…>

examples:
  nebula nb read analysis.ipynb              # compact listing
  nebula nb read analysis.ipynb --outputs    # append truncated output tails
  nebula nb read analysis.ipynb --full       # full cell sources
  nebula nb read analysis.ipynb --cells 2-5  # only cells #2..#5
  nebula nb read analysis.ipynb --cells cell-a,cell-b`;

/** Parse --cells selector: comma list of 1-based indices, A-B ranges, or cell ids. */
function selectCells(
  cells: NotebookCell[],
  selector: string | undefined
): Array<{ cell: NotebookCell; index: number }> {
  const all = cells.map((cell, index) => ({ cell, index }));
  if (!selector) return all;

  const keep = new Set<number>();
  for (const token of selector.split(',').map((t) => t.trim()).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const from = Number.parseInt(range[1], 10);
      const to = Number.parseInt(range[2], 10);
      for (let i = from; i <= to; i++) keep.add(i - 1);
      continue;
    }
    if (/^\d+$/.test(token)) {
      keep.add(Number.parseInt(token, 10) - 1);
      continue;
    }
    const byId = cells.findIndex((c) => c.id === token);
    if (byId === -1) {
      throw new CliError(`no cell matches selector "${token}"`, EXIT.ERROR, 'list cell ids with: nebula nb read <path>');
    }
    keep.add(byId);
  }
  return all.filter(({ index }) => keep.has(index));
}

function cellLine(cell: NotebookCell, index: number): string {
  const exec = cell.executionCount ? ` [${cell.executionCount}]` : '';
  const first = firstLineOf(cell.content);
  return `#${index + 1} ${cell.id} ${cell.type}${exec}${first ? ` ${first}` : ''}`;
}

function outputTailLines(cell: NotebookCell, maxLines = 3, maxChars = 120): string[] {
  if (!cell.outputs || cell.outputs.length === 0) return [];
  const text = cell.outputs
    .map((o) => (o.type === 'image' ? '[image]\n' : o.type === 'error' ? `[error] ${o.content}\n` : o.content))
    .join('');
  return tailLines(text, maxLines).map((line) => {
    const trimmed = line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
    return `    out: ${trimmed}`;
  });
}

async function nbRead(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    cells: { type: 'string' },
    outputs: { type: 'boolean' },
    full: { type: 'boolean' },
  });
  if (values.help) {
    console.log(READ_HELP);
    return EXIT.OK;
  }
  const nbPath = requirePositional(positionals, 0, 'path', 'nebula nb read <path> [--cells …] [--outputs] [--full]');
  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);

  const wantOutputs = Boolean(values.outputs);
  const result = await readNotebookTool.execute(
    { path: nbPath, format: 'content', include_outputs: wantOutputs },
    client
  );
  if (!result.success) throw toCliError(result.error, nbPath);

  const { cells, totalCells } = result.data!;
  const selected = selectCells(cells, values.cells as string | undefined);

  if (values.json) {
    printJson({ path: nbPath, totalCells, cells: selected.map(({ cell, index }) => ({ index, ...cell })) });
    return EXIT.OK;
  }

  console.log(`${nbPath} (${totalCells} cells)`);
  for (const { cell, index } of selected) {
    if (values.full) {
      console.log('');
      console.log(cellLine(cell, index));
      console.log(cell.content);
    } else {
      console.log(cellLine(cell, index));
    }
    if (wantOutputs) {
      for (const line of outputTailLines(cell)) console.log(line);
    }
  }

  if (totalCells === 0) {
    printHint(`add a cell with: nebula nb insert ${nbPath} --index -1 --content '…'`, values);
  } else {
    printHint(`execute a cell with: nebula run ${nbPath} <cell-id>`, values);
  }
  return EXIT.OK;
}

// =============================================================================
// nb edit
// =============================================================================

const EDIT_HELP = `usage: nebula nb edit <path> <cell-id> (--content <str> | --content-file <f> | -)

Updates a cell's content. The write is OCC-checked: if the cell changed since
you last read it, the command exits 9 and prints the current content so you
can retry against it.

examples:
  nebula nb edit analysis.ipynb cell-3 --content 'x = 42'
  nebula nb edit analysis.ipynb cell-3 --content-file new_cell.py
  echo 'x = 42' | nebula nb edit analysis.ipynb cell-3 -`;

async function nbEdit(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    content: { type: 'string' },
    'content-file': { type: 'string' },
  });
  if (values.help) {
    console.log(EDIT_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula nb edit <path> <cell-id> (--content <str> | --content-file <f> | -)';
  const nbPath = requirePositional(positionals, 0, 'path', usage);
  const cellId = requirePositional(positionals, 1, 'cell-id', usage);
  const stdinMarker = positionals[2] === '-';
  if (positionals.length > 2 && !stdinMarker) {
    throw new CliError(`unexpected argument: ${positionals[2]}`, EXIT.USAGE, `usage: ${usage}`);
  }
  const content = await resolveContentInput(values.content, values['content-file'], stdinMarker);

  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);

  // Use the shared operation path directly so OCC conflict metadata
  // (conflict/currentContent) survives to the CLI.
  const result = await client.applyOperation({ type: 'updateContent', notebookPath: nbPath, cellId, content });
  if (!result.success) throw toCliError(result.error, nbPath);

  const op = result.data!;
  if (!op.success) {
    const isConflict = op.conflict === true || /conflict/i.test(op.error ?? '');
    if (isConflict) {
      let current = op.currentContent;
      if (current === undefined) {
        const read = await readCellTool.execute({ path: nbPath, cell_id: cellId }, client);
        current = read.success ? read.data!.cell.content : undefined;
      }
      console.log('CONFLICT: cell changed — current content below; retry your edit against it');
      if (current !== undefined) console.log(current);
      console.error(`error: cell ${cellId} was modified since you last read it (OCC conflict)`);
      return EXIT.CONFLICT;
    }
    throw toCliError(op.error, nbPath);
  }

  if (values.json) {
    printJson({ path: nbPath, cellId, updated: true });
    return EXIT.OK;
  }
  console.log(`updated ${cellId}`);
  printHint(`execute it with: nebula run ${nbPath} ${cellId}`, values);
  return EXIT.OK;
}

// =============================================================================
// nb insert
// =============================================================================

const INSERT_HELP = `usage: nebula nb insert <path> --index N (--content <str> | --content-file <f> | -)
                        [--type code|markdown] [--id ID]

--index is 0-based; use -1 to append at the end.

examples:
  nebula nb insert analysis.ipynb --index -1 --content 'print(df.shape)'
  nebula nb insert analysis.ipynb --index 0 --type markdown --content '# Intro'
  cat setup.py | nebula nb insert analysis.ipynb --index 2 -`;

async function nbInsert(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    index: { type: 'string' },
    content: { type: 'string' },
    'content-file': { type: 'string' },
    type: { type: 'string' },
    id: { type: 'string' },
  });
  if (values.help) {
    console.log(INSERT_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula nb insert <path> --index N (--content … | --content-file … | -) [--type code|markdown] [--id ID]';
  const nbPath = requirePositional(positionals, 0, 'path', usage);
  if (values.index === undefined) {
    throw new CliError('missing --index (use -1 to append)', EXIT.USAGE, `usage: ${usage}`);
  }
  const index = parseIntFlag(values.index, '--index', -1);
  const stdinMarker = positionals[1] === '-';
  const content = await resolveContentInput(values.content, values['content-file'], stdinMarker);

  const cellType = (values.type as string | undefined) ?? 'code';
  if (cellType !== 'code' && cellType !== 'markdown') {
    throw new CliError(`--type must be code or markdown, got "${cellType}"`, EXIT.USAGE);
  }
  const cellId =
    (values.id as string | undefined) ?? `cell-${Date.now().toString(36)}-${randomBytes(2).toString('hex')}`;

  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);
  const result = await insertCellTool.execute(
    { path: nbPath, cell_id: cellId, content, cell_type: cellType, position: index },
    client
  );
  if (!result.success) throw toCliError(result.error, nbPath);

  const data = result.data!;
  if (values.json) {
    printJson({ path: nbPath, ...data });
    return EXIT.OK;
  }
  let line = `inserted ${data.cellId} at #${data.cellIndex + 1}`;
  if (data.idModified) {
    line += ` (requested id "${data.requestedId}" was taken)`;
  }
  console.log(line);
  printHint(`execute it with: nebula run ${nbPath} ${data.cellId}`, values);
  return EXIT.OK;
}

// =============================================================================
// nb delete
// =============================================================================

const DELETE_HELP = `usage: nebula nb delete <path> <cell-id>

examples:
  nebula nb delete analysis.ipynb cell-3`;

async function nbDelete(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    console.log(DELETE_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula nb delete <path> <cell-id>';
  const nbPath = requirePositional(positionals, 0, 'path', usage);
  const cellId = requirePositional(positionals, 1, 'cell-id', usage);

  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);
  const result = await deleteCellTool.execute({ path: nbPath, cell_id: cellId }, client);
  if (!result.success) throw toCliError(result.error, nbPath);

  if (values.json) {
    printJson({ path: nbPath, cellId, deleted: true });
    return EXIT.OK;
  }
  console.log(`deleted ${cellId}`);
  printHint(`review remaining cells with: nebula nb read ${nbPath}`, values);
  return EXIT.OK;
}

// =============================================================================
// nb search
// =============================================================================

const SEARCH_HELP = `usage: nebula nb search <path> <query> [--limit N]

examples:
  nebula nb search analysis.ipynb "read_csv"
  nebula nb search analysis.ipynb TODO --limit 20`;

async function nbSearch(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, { limit: { type: 'string' } });
  if (values.help) {
    console.log(SEARCH_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula nb search <path> <query> [--limit N]';
  const nbPath = requirePositional(positionals, 0, 'path', usage);
  const query = requirePositional(positionals, 1, 'query', usage);
  const limit = parseIntFlag(values.limit, '--limit', 10);

  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);
  const result = await searchCellsTool.execute({ path: nbPath, query, limit }, client);
  if (!result.success) throw toCliError(result.error, nbPath);

  const data = result.data!;
  if (values.json) {
    printJson(data);
    return EXIT.OK;
  }

  console.log(`${data.matchCount} match${data.matchCount === 1 ? '' : 'es'} for "${query}"`);
  for (const m of data.matches) {
    const loc = m.matchLocation === 'output' ? `output[${m.outputIndex ?? 0}]` : `source:${m.matchLine ?? 0}`;
    console.log(`#${m.cellIndex + 1} ${m.cellId} ${loc}  ${m.preview}`);
  }
  if (data.hasMore) {
    console.log(`(showing first ${data.matches.length}; raise --limit for more)`);
  }
  if (data.matchCount > 0) {
    printHint(`view a matching cell with: nebula nb read ${nbPath} --cells <cell-id> --full`, values);
  }
  return EXIT.OK;
}
