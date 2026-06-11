// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { qmdAdapter } from '../qmd';
import { NebulaCell } from '../../types';

const cell = (over: Partial<NebulaCell> & { id: string }): NebulaCell => ({
  type: 'code',
  content: '',
  outputs: [],
  executionCount: null,
  isExecuting: false,
  ...over,
});

describe('qmd format: parsing', () => {
  it('parses front matter, prose, and code chunks', () => {
    const text = [
      '---',
      'title: "Exoplanets"',
      'jupyter: python3',
      '---',
      '',
      '# Intro',
      '',
      'Some prose.',
      '',
      '```{python}',
      '#| id: abc123',
      'import pandas as pd',
      '```',
      '',
      'More prose.',
      '',
    ].join('\n');
    const parsed = qmdAdapter.parse(text);
    expect(parsed.kernelspecName).toBe('python3');
    expect((parsed.metadata.__qmd_front_matter as any).title).toBe('Exoplanets');
    expect(parsed.cells.map((c) => c.type)).toEqual(['markdown', 'code', 'markdown']);
    expect(parsed.cells[0].content).toBe('# Intro\n\nSome prose.');
    expect(parsed.cells[1]).toMatchObject({ id: 'abc123', content: 'import pandas as pd' });
    expect(parsed.cells[2].content).toBe('More prose.');
  });

  it('keeps non-id chunk options in cell content verbatim', () => {
    const text = '```{python}\n#| id: x\n#| echo: false\n#| fig-width: 8\n1 + 1\n```\n';
    const { cells } = qmdAdapter.parse(text);
    expect(cells[0].id).toBe('x');
    expect(cells[0].content).toBe('#| echo: false\n#| fig-width: 8\n1 + 1');
  });

  it('infers kernel from R chunks when front matter lacks jupyter', () => {
    const parsed = qmdAdapter.parse('```{r}\nlibrary(ggplot2)\n```\n');
    expect(parsed.kernelspecName).toBe('ir');
    expect(parsed.metadata.__qmd_language).toBe('r');
  });

  it('does not split cells at ```{python} examples inside plain fences', () => {
    const text = [
      'Look at this example:',
      '',
      '````',
      '```{python}',
      'this is prose, not code',
      '```',
      '````',
      '',
      '```{python}',
      '#| id: real',
      'x = 1',
      '```',
      '',
    ].join('\n');
    const { cells } = qmdAdapter.parse(text);
    expect(cells).toHaveLength(2);
    expect(cells[0].type).toBe('markdown');
    expect(cells[0].content).toContain('this is prose, not code');
    expect(cells[1]).toMatchObject({ id: 'real', type: 'code', content: 'x = 1' });
  });

  it('preserves fence attributes verbatim', () => {
    const { cells } = qmdAdapter.parse('```{python .hide-cell key="v"}\n#| id: a\n1\n```\n');
    expect((cells[0] as any)._metadata.qmd_fence_attrs).toBe('python .hide-cell key="v"');
  });

  it('handles an unterminated fence as cell-to-EOF', () => {
    const { cells } = qmdAdapter.parse('```{python}\n#| id: a\nx = 1\n');
    expect(cells).toHaveLength(1);
    expect(cells[0].content).toBe('x = 1');
  });

  it('assigns positional ids to marker-less (foreign) markdown and id-less chunks', () => {
    const { cells } = qmdAdapter.parse('prose\n\n```{python}\n1\n```\n');
    expect(cells.map((c) => c.id)).toEqual(['cell-0', 'cell-1']);
  });

  it('markdown markers carry ids and delimit adjacent cells', () => {
    const text = [
      '<!-- #| id: md1 -->',
      'First block.',
      '',
      '<!-- #| id: md2 -->',
      'Second block, distinct cell.',
      '',
    ].join('\n');
    const { cells } = qmdAdapter.parse(text);
    expect(cells.map((c) => ({ id: c.id, content: c.content }))).toEqual([
      { id: 'md1', content: 'First block.' },
      { id: 'md2', content: 'Second block, distinct cell.' },
    ]);
  });

  it('normalizes CRLF', () => {
    const { cells } = qmdAdapter.parse('```{python}\r\n#| id: a\r\nx = 1\r\n```\r\n');
    expect(cells[0].content).toBe('x = 1');
  });
});

describe('qmd format: round-trip', () => {
  const roundtrip = (cells: NebulaCell[], metadata: Record<string, unknown> = {}) =>
    qmdAdapter.parse(qmdAdapter.serialize(cells, metadata));

  it('round-trips a mixed notebook semantically (md ids persist)', () => {
    const cells = [
      cell({ id: 'mdx', type: 'markdown', content: '# Title\n\nProse.' }),
      cell({ id: 'k1', type: 'code', content: 'import numpy as np\n\nprint(np.pi)' }),
      cell({ id: 'k2', type: 'code', content: '' }),
    ];
    const { cells: back } = roundtrip(cells);
    expect(back.map((c) => ({ id: c.id, type: c.type, content: c.content }))).toEqual(
      cells.map((c) => ({ id: c.id, type: c.type, content: c.content }))
    );
  });

  it('serialize∘parse∘serialize is byte-stable', () => {
    const cells = [
      cell({ id: 'mdy', type: 'markdown', content: 'Intro prose.' }),
      cell({ id: 'a', content: 'x = 1' }),
    ];
    const meta = {
      __qmd_front_matter: { title: 'T' },
      kernelspec: { name: 'python3' },
      __qmd_language: 'python',
    };
    const once = qmdAdapter.serialize(cells, meta);
    const parsed = qmdAdapter.parse(once);
    const twice = qmdAdapter.serialize(parsed.cells, parsed.metadata);
    expect(twice).toBe(once);
  });

  it('round-trips front matter unknown keys and nebula flags', () => {
    const meta = {
      __qmd_front_matter: { title: 'Keep', format: { html: { toc: true } } },
      nebula: { agent_created: true, agent_permitted: true },
      kernelspec: { name: 'python3' },
    };
    const text = qmdAdapter.serialize([cell({ id: 'a', content: '1' })], meta);
    const parsed = qmdAdapter.parse(text);
    expect((parsed.metadata.__qmd_front_matter as any).title).toBe('Keep');
    expect((parsed.metadata.__qmd_front_matter as any).format.html.toc).toBe(true);
    expect((parsed.metadata.nebula as any).agent_permitted).toBe(true);
    expect(parsed.kernelspecName).toBe('python3');
  });

  it('uses a longer fence when content contains backtick runs', () => {
    const c = cell({ id: 'a', content: 'md = """\n```\nfenced\n```\n"""' });
    const { cells } = roundtrip([c]);
    expect(cells).toHaveLength(1);
    expect(cells[0].content).toBe(c.content);
  });

  it('keeps empty markdown cells and adjacent markdown cells distinct', () => {
    const cells = [
      cell({ id: 'm1', type: 'markdown', content: '' }),
      cell({ id: 'm2', type: 'markdown', content: 'second' }),
      cell({ id: 'm3', type: 'markdown', content: 'third' }),
      cell({ id: 'a', content: '' }),
    ];
    const { cells: back } = roundtrip(cells);
    expect(back.map((c) => ({ id: c.id, type: c.type, content: c.content }))).toEqual(
      cells.map((c) => ({ id: c.id, type: c.type, content: c.content }))
    );
  });

  it('never serializes outputs or execution counts', () => {
    const c = cell({ id: 'a', content: 'print(1)' });
    c.outputs = [{ id: 'o', type: 'stdout', content: 'SECRET_OUTPUT' } as any];
    c.executionCount = 9;
    const text = qmdAdapter.serialize([c], {});
    expect(text).not.toContain('SECRET_OUTPUT');
    const { cells } = qmdAdapter.parse(text);
    expect(cells[0].outputs).toEqual([]);
    expect(cells[0].executionCount).toBeNull();
  });

  it('preserves R language for new cells via __qmd_language', () => {
    const text = qmdAdapter.serialize(
      [cell({ id: 'a', content: 'library(dplyr)' })],
      { __qmd_language: 'r' }
    );
    expect(text).toContain('```{r}');
  });
});
