import { describe, it, expect } from 'vitest';
import { computeDefaultCellHeight, estimateCellHeight } from '../virtualCellMetrics';
import { Cell } from '../../types';

describe('virtualCellMetrics', () => {
  const baseCell = (overrides: Partial<Cell> = {}): Cell => ({
    id: 'cell-1',
    type: 'code',
    content: 'print("hi")',
    outputs: [],
    isExecuting: false,
    ...overrides,
  });

  it('estimates height with base content and outputs', () => {
    const cell = baseCell({
      content: 'a\nb\nc',
      outputs: [
        { id: 'out-1', type: 'stdout', content: 'x\ny\nz', timestamp: Date.now() },
      ],
    });

    // Base 104 + max(40, 3 * 20 = 60) + output min(3 * 16 = 48, 600) = 212
    expect(estimateCellHeight(cell)).toBe(212);
  });

  it('returns fallback height for empty cell list', () => {
    expect(computeDefaultCellHeight([], new Map())).toBe(150);
  });

  it('prefers cached heights when available', () => {
    const cellA = baseCell({ id: 'a', content: 'short' });
    const cellB = baseCell({ id: 'b', content: 'short' });
    const cache = new Map<string, number>([['a', 500]]);

    const average = computeDefaultCellHeight([cellA, cellB], cache);
    // cellA uses cache 500, cellB estimated: base 104 + max(40, 20) = 144
    // average = (500 + 144) / 2 = 322
    expect(average).toBe(322);
  });
});
