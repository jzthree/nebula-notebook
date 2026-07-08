// @vitest-environment node
/**
 * Outputs-unchanged elision (payload diet for slow uplinks): a save may replace
 * a code cell's outputs with OUTPUTS_UNCHANGED_SENTINEL; the server must
 * re-use the outputs already on disk (matched by nebula_id), and must demand a
 * full payload (needsFull) whenever it cannot resolve the sentinel.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell, OUTPUTS_UNCHANGED_SENTINEL, JupyterNotebook } from '../fs/types';

const cell = (over: Partial<NebulaCell> & { id: string }): NebulaCell => ({
  type: 'code',
  content: '',
  outputs: [],
  executionCount: null,
  isExecuting: false,
  ...over,
});

const sentinelOutputs = OUTPUTS_UNCHANGED_SENTINEL as unknown as NebulaCell['outputs'];

describe('outputs-unchanged sentinel on .ipynb saves', () => {
  let service: FilesystemService;
  let dir: string;
  let nb: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-elide-'));
    service = new FilesystemService(dir);
    nb = path.join(dir, 'elide.ipynb');
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const readRaw = (): JupyterNotebook => JSON.parse(fs.readFileSync(nb, 'utf-8'));

  it('re-uses on-disk outputs for sentinel cells', async () => {
    const bigOutput = [{
      type: 'display_data' as const,
      content: '',
      mimeBundle: { 'image/png': 'AAAB64==' },
    }];
    // Full save first
    const first = await service.saveNotebookCells(nb, [
      cell({ id: 'plot', content: 'plot()', outputs: bigOutput as never, executionCount: 1 }),
      cell({ id: 'calc', content: 'x=1' }),
    ]);
    expect(first.success).toBe(true);
    const savedOutputs = readRaw().cells[0].outputs;
    expect(JSON.stringify(savedOutputs)).toContain('AAAB64==');

    // Second save: plot's outputs elided, calc edited
    const second = await service.saveNotebookCells(nb, [
      cell({ id: 'plot', content: 'plot()  # tweaked comment', outputs: sentinelOutputs, executionCount: 1 }),
      cell({ id: 'calc', content: 'x=2' }),
    ]);
    expect(second.success).toBe(true);
    const after = readRaw();
    // Outputs preserved verbatim from disk; content update applied
    expect(after.cells[0].outputs).toEqual(savedOutputs);
    expect(String(after.cells[0].source)).toContain('tweaked comment');
    expect(String(after.cells[1].source)).toContain('x=2');
    // The sentinel string itself never lands in the file
    expect(fs.readFileSync(nb, 'utf-8')).not.toContain(OUTPUTS_UNCHANGED_SENTINEL);
  });

  it('returns needsFull when a sentinel cell id is not on disk', async () => {
    const res = await service.saveNotebookCells(nb, [
      cell({ id: 'brand-new-cell', content: 'y=3', outputs: sentinelOutputs }),
    ]);
    expect(res.success).toBe(false);
    expect(res.needsFull).toBe(true);
  });

  it('returns needsFull when the file does not exist yet', async () => {
    const res = await service.saveNotebookCells(path.join(dir, 'missing.ipynb'), [
      cell({ id: 'a', content: 'z=1', outputs: sentinelOutputs }),
    ]);
    expect(res.success).toBe(false);
    expect(res.needsFull).toBe(true);
  });

  it('text formats neutralize the sentinel instead of writing it', async () => {
    const qmd = path.join(dir, 'elide.qmd');
    const first = await service.saveNotebookCells(qmd, [cell({ id: 'a', content: 'x=1' })]);
    expect(first.success).toBe(true);
    const second = await service.saveNotebookCells(qmd, [
      cell({ id: 'a', content: 'x=2', outputs: sentinelOutputs }),
    ]);
    expect(second.success).toBe(true);
    expect(fs.readFileSync(qmd, 'utf-8')).not.toContain(OUTPUTS_UNCHANGED_SENTINEL);
  });
});
