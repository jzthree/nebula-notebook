// @vitest-environment node
/**
 * Property test: serialize → parse is a fixpoint for randomly generated cell
 * lists whose content draws from a hostile corpus (marker-lookalikes, chunk
 * options, backtick runs, YAML delimiters). Seeded PRNG — the seed is printed
 * on failure for reproduction.
 *
 * Documented unrepresentables are excluded by the generator (they are format
 * limits, not adapter bugs):
 *  - qmd: markdown content with bare ```{lang} fence opens, lines that are
 *    themselves `<!-- #| id: ... -->` markers, leading/trailing blank lines,
 *    or a first line matching `#| id:` (consumed as id by the code parser)
 *  - percent: none beyond outputs/executionCount
 */

import { describe, it, expect } from 'vitest';
import { percentAdapter } from '../percent';
import { qmdAdapter } from '../qmd';
import { NebulaCell } from '../../types';

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOSTILE_LINES = [
  'x = 1',
  'print("hello")',
  '',
  '# a comment',
  '# %% not a marker when inside code? actually it IS one — code-only',
  '#| echo: false',
  '#|fig-width: 8',
  '%%time',
  '\\%%escaped',
  '%%%triple',
  '---',
  '...',
  '```',
  '````',
  'def f():',
  '    return 42',
  'text with `inline` ticks',
  'jupyter: python3',
  '# ---',
  '   indented',
  'unicode: ∂Ω ≈ π 🚀',
  'tab\there',
  '[markdown] not a tag here',
  'id=notanid here',
];

// Lines legal inside CODE cells for each format (code bodies are verbatim,
// so marker-lookalikes would genuinely split — that is format semantics, not
// a bug; exclude them from code bodies).
const isLegalPercentCodeLine = (l: string) => !/^#\s*%%/.test(l);
const isLegalQmdCodeLine = (l: string) => true;
// Markdown bodies: percent escapes everything; qmd cannot hold fence opens
// or blank boundary lines.
const isLegalPercentMdLine = (_l: string) => true;
const isLegalQmdMdLine = (l: string) =>
  !/^`{3,}/.test(l) && !/^#\|\s*id:/.test(l) && !/^<!--\s*#\|/.test(l);

function genContent(rnd: () => number, legal: (l: string) => boolean, allowBlankEdges: boolean): string {
  const n = Math.floor(rnd() * 6); // 0..5 lines
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    const pick = HOSTILE_LINES[Math.floor(rnd() * HOSTILE_LINES.length)];
    if (legal(pick)) lines.push(pick);
  }
  let content = lines.join('\n');
  if (!allowBlankEdges) {
    content = content.replace(/^\n+/, '').replace(/\n+$/, '');
  }
  return content;
}

function genCells(
  rnd: () => number,
  format: 'percent' | 'qmd'
): NebulaCell[] {
  const count = 1 + Math.floor(rnd() * 6);
  const cells: NebulaCell[] = [];
  for (let i = 0; i < count; i++) {
    const isMd = rnd() < 0.4;
    if (format === 'qmd' && isMd) {
      cells.push({
        id: `qm${i}d`,
        type: 'markdown',
        content: genContent(rnd, isLegalQmdMdLine, false),
        outputs: [],
        executionCount: null,
        isExecuting: false,
      });
    } else if (isMd) {
      cells.push({
        id: `md${i}x`,
        type: 'markdown',
        content: genContent(rnd, isLegalPercentMdLine, true),
        outputs: [],
        executionCount: null,
        isExecuting: false,
      });
    } else {
      cells.push({
        id: `c${i}q`,
        type: 'code',
        content: genContent(
          rnd,
          format === 'percent' ? isLegalPercentCodeLine : isLegalQmdCodeLine,
          true
        ),
        outputs: [],
        executionCount: null,
        isExecuting: false,
      });
    }
  }
  if (cells.length === 0) {
    cells.push({ id: 'c0q', type: 'code', content: 'x = 1', outputs: [], executionCount: null, isExecuting: false });
  }
  return cells;
}

const strip = (cells: NebulaCell[]) =>
  cells.map((c) => ({ id: c.id, type: c.type, content: c.content }));

describe('round-trip property (seeded, 500 iterations per adapter)', () => {
  it('percent: serialize → parse is a fixpoint', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = mulberry32(seed);
      const cells = genCells(rnd, 'percent');
      const meta = rnd() < 0.5 ? { kernelspec: { name: 'python3' } } : {};
      const text = percentAdapter.serialize(cells, meta);
      const back = percentAdapter.parse(text);
      try {
        expect(strip(back.cells)).toEqual(strip(cells));
        // idempotence: second serialize byte-identical
        expect(percentAdapter.serialize(back.cells, back.metadata)).toBe(text);
      } catch (e) {
        throw new Error(`percent property failed at seed=${seed}\n${(e as Error).message}`);
      }
    }
  });

  it('qmd: serialize → parse is a fixpoint', () => {
    for (let seed = 1; seed <= 500; seed++) {
      const rnd = mulberry32(seed);
      const cells = genCells(rnd, 'qmd');
      const meta: Record<string, unknown> = { __qmd_language: 'python' };
      if (rnd() < 0.5) meta.kernelspec = { name: 'python3' };
      const text = qmdAdapter.serialize(cells, meta);
      const back = qmdAdapter.parse(text);
      try {
        expect(strip(back.cells)).toEqual(strip(cells));
        expect(qmdAdapter.serialize(back.cells, back.metadata)).toBe(text);
      } catch (e) {
        throw new Error(`qmd property failed at seed=${seed}\n${(e as Error).message}`);
      }
    }
  });
});
