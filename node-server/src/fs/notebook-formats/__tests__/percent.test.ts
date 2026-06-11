// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { percentAdapter } from '../percent';
import { NebulaCell } from '../../types';

const cell = (over: Partial<NebulaCell> & { id: string }): NebulaCell => ({
  type: 'code',
  content: '',
  outputs: [],
  executionCount: null,
  isExecuting: false,
  ...over,
});

const roundtrip = (cells: NebulaCell[], metadata: Record<string, unknown> = {}) =>
  percentAdapter.parse(percentAdapter.serialize(cells, metadata));

describe('percent format: parsing', () => {
  it('parses a basic two-cell file with ids', () => {
    const text = [
      '# %% id=aaa111',
      'x = 1',
      'print(x)',
      '',
      '# %% [markdown] id=bbb222',
      '# # Title',
      '#',
      '# Some prose.',
      '',
    ].join('\n');
    const { cells } = percentAdapter.parse(text);
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ id: 'aaa111', type: 'code', content: 'x = 1\nprint(x)' });
    expect(cells[1]).toMatchObject({
      id: 'bbb222',
      type: 'markdown',
      content: '# Title\n\nSome prose.',
    });
  });

  it('parses marker variants: #%% and extra whitespace', () => {
    const { cells } = percentAdapter.parse('#%% id=a\n1\n\n#  %% id=b\n2\n');
    expect(cells.map((c) => c.id)).toEqual(['a', 'b']);
    expect(cells.map((c) => c.content)).toEqual(['1', '2']);
  });

  it('assigns positional fallback ids when markers carry none', () => {
    const { cells } = percentAdapter.parse('# %%\n1\n\n# %%\n2\n');
    expect(cells.map((c) => c.id)).toEqual(['cell-0', 'cell-1']);
  });

  it('treats a marker-less plain script as one code cell', () => {
    const { cells, kernelspecName } = percentAdapter.parse('import os\nprint(os.name)\n');
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ id: 'cell-0', type: 'code', content: 'import os\nprint(os.name)' });
    expect(kernelspecName).toBeNull();
  });

  it('captures content before the first marker as a leading cell', () => {
    const { cells } = percentAdapter.parse('preamble = True\n\n# %% id=x\n1\n');
    expect(cells).toHaveLength(2);
    expect(cells[0].content).toBe('preamble = True');
    expect(cells[1].id).toBe('x');
  });

  it('parses the jupytext YAML header into metadata and kernel', () => {
    const text = [
      '# ---',
      '# jupyter:',
      '#   kernelspec:',
      '#     display_name: Python 3',
      '#     language: python',
      '#     name: python3',
      '#   nebula:',
      '#     agent_permitted: true',
      '# ---',
      '',
      '# %% id=a',
      '1',
      '',
    ].join('\n');
    const parsed = percentAdapter.parse(text);
    expect(parsed.kernelspecName).toBe('python3');
    expect((parsed.metadata.kernelspec as any).display_name).toBe('Python 3');
    expect((parsed.metadata.nebula as any).agent_permitted).toBe(true);
    expect(parsed.cells).toHaveLength(1);
  });

  it('preserves unknown marker options verbatim', () => {
    const { cells } = percentAdapter.parse('# %% My Title key="v" id=z\n1\n');
    expect(cells[0].id).toBe('z');
    expect((cells[0] as any)._metadata.percent_header_rest).toBe('My Title key="v"');
  });

  it('normalizes CRLF', () => {
    const { cells } = percentAdapter.parse('# %% id=a\r\nx = 1\r\n');
    expect(cells[0].content).toBe('x = 1');
  });

  it('parses [raw] cells as markdown with the raw tag preserved', () => {
    const { cells } = percentAdapter.parse('# %% [raw] id=r\n# raw text\n');
    expect(cells[0].type).toBe('markdown');
    expect(cells[0].content).toBe('raw text');
    expect((cells[0] as any)._metadata.percent_cell_type).toBe('raw');
  });

  it('handles a file without trailing newline', () => {
    const { cells } = percentAdapter.parse('# %% id=a\nx = 1');
    expect(cells[0].content).toBe('x = 1');
  });

  it('handles consecutive markers as empty cells', () => {
    const { cells } = percentAdapter.parse('# %% id=a\n# %% id=b\n1\n');
    expect(cells.map((c) => c.content)).toEqual(['', '1']);
  });
});

describe('percent format: round-trip', () => {
  it('round-trips cells semantically (modulo outputs)', () => {
    const cells = [
      cell({ id: 'k1', type: 'code', content: 'import numpy as np\n\nx = np.eye(3)' }),
      cell({ id: 'k2', type: 'markdown', content: '# Heading\n\nProse with `code`.' }),
      cell({ id: 'k3', type: 'code', content: '' }),
      cell({ id: 'k4', type: 'code', content: 'print(1)\n' }),
    ];
    const { cells: back } = roundtrip(cells);
    expect(back.map((c) => ({ id: c.id, type: c.type, content: c.content }))).toEqual(
      cells.map((c) => ({ id: c.id, type: c.type, content: c.content }))
    );
  });

  it('serialize∘parse∘serialize is byte-stable (canonical idempotence)', () => {
    const cells = [
      cell({ id: 'a', content: 'x = 1' }),
      cell({ id: 'b', type: 'markdown', content: 'hello\n\nworld' }),
    ];
    const meta = { kernelspec: { name: 'python3', display_name: 'Python 3' } };
    const once = percentAdapter.serialize(cells, meta);
    const parsed = percentAdapter.parse(once);
    const twice = percentAdapter.serialize(parsed.cells, parsed.metadata);
    expect(twice).toBe(once);
  });

  it('escapes markdown lines that would read as cell markers', () => {
    const md = cell({ id: 'm', type: 'markdown', content: '%%time is a magic\n\\%%literal' });
    const text = percentAdapter.serialize([md], {});
    const { cells } = percentAdapter.parse(text);
    expect(cells).toHaveLength(1);
    expect(cells[0].content).toBe('%%time is a magic\n\\%%literal');
  });

  it('round-trips header metadata including unknown keys', () => {
    const meta = {
      kernelspec: { name: 'nebula', display_name: 'Nebula' },
      nebula: { agent_created: true },
      custom_top: { keep: 'me' },
    };
    const text = percentAdapter.serialize([cell({ id: 'a', content: '1' })], meta);
    const parsed = percentAdapter.parse(text);
    expect(parsed.kernelspecName).toBe('nebula');
    expect((parsed.metadata.nebula as any).agent_created).toBe(true);
    expect((parsed.metadata.custom_top as any).keep).toBe('me');
  });

  it('round-trips unknown marker options', () => {
    const c = cell({ id: 'a', content: '1' });
    (c as any)._metadata = { percent_header_rest: 'My Title key="v"' };
    const { cells } = roundtrip([c]);
    expect((cells[0] as any)._metadata.percent_header_rest).toBe('My Title key="v"');
  });

  it('round-trips raw cells', () => {
    const c = cell({ id: 'r', type: 'markdown', content: 'raw body' });
    (c as any)._metadata = { percent_cell_type: 'raw' };
    const { cells } = roundtrip([c]);
    expect((cells[0] as any)._metadata.percent_cell_type).toBe('raw');
    expect(cells[0].content).toBe('raw body');
  });

  it('kernelName argument lands in the header', () => {
    const text = percentAdapter.serialize([cell({ id: 'a', content: '1' })], {}, 'nebula');
    expect(percentAdapter.parse(text).kernelspecName).toBe('nebula');
  });

  it('never serializes outputs or execution counts', () => {
    const c = cell({ id: 'a', content: 'print(1)' });
    c.outputs = [{ id: 'o', type: 'stdout', content: 'hi' } as any];
    c.executionCount = 7;
    const text = percentAdapter.serialize([c], {});
    expect(text).not.toContain('hi');
    expect(text).not.toContain('7');
    const { cells } = percentAdapter.parse(text);
    expect(cells[0].outputs).toEqual([]);
    expect(cells[0].executionCount).toBeNull();
  });
});
