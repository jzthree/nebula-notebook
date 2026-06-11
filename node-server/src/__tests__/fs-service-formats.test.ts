// @vitest-environment node
/**
 * Integration tests: text notebook formats (.py percent / .qmd) through the
 * full FilesystemService surface — get/save bundle, metadata, permissions,
 * sidecars. The .ipynb path is covered by ipynb-baseline.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell } from '../fs/types';

const cell = (over: Partial<NebulaCell> & { id: string }): NebulaCell => ({
  type: 'code',
  content: '',
  outputs: [],
  executionCount: null,
  isExecuting: false,
  ...over,
});

describe('text notebook formats through FilesystemService', () => {
  let service: FilesystemService;
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-formats-'));
    service = new FilesystemService(dir);
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  describe.each([
    ['percent', 'nb.py'],
    ['qmd', 'nb.qmd'],
  ])('%s (%s)', (_name, filename) => {
    const cells = [
      cell({ id: 'aa1', type: 'markdown', content: '# Title' }),
      cell({
        id: 'bb2',
        type: 'code',
        content: 'x = 1\nprint(x)',
        outputs: [{ id: 'o', type: 'stdout', content: 'SHOULD_NOT_PERSIST' } as any],
        executionCount: 5,
      }),
    ];

    it('saves and reloads cells; outputs and counts are not persisted', async () => {
      const p = path.join(dir, filename);
      const result = await service.saveNotebookCells(p, cells, 'python3');
      expect(result.success).toBe(true);

      const raw = fs.readFileSync(p, 'utf-8');
      expect(raw).not.toContain('SHOULD_NOT_PERSIST');
      expect(raw).toContain('bb2'); // id persisted in-file

      const loaded = service.getNotebookCells(p);
      // qmd markdown cells cannot persist ids (positional fallback, documented);
      // percent persists ids for all cell types.
      const mdId = filename.endsWith('.qmd') ? 'cell-0' : 'aa1';
      expect(loaded.cells.map((c) => ({ id: c.id, type: c.type, content: c.content }))).toEqual([
        { id: mdId, type: 'markdown', content: '# Title' },
        { id: 'bb2', type: 'code', content: 'x = 1\nprint(x)' },
      ]);
      expect(loaded.cells[1].outputs).toEqual([]);
      expect(loaded.cells[1].executionCount).toBeNull();
      expect(loaded.kernelspec).toBe('python3');
      expect(loaded.kernelspecSource).toBe('metadata');
      expect(loaded.mtime).toBeGreaterThan(0);
    });

    it('ids persist across reloads (history/OCC contract)', async () => {
      const p = path.join(dir, `stable-${filename}`);
      await service.saveNotebookCells(p, cells, 'python3');
      const first = service.getNotebookCells(p).cells.map((c) => c.id);
      await service.saveNotebookCells(p, service.getNotebookCells(p).cells as NebulaCell[], 'python3');
      const second = service.getNotebookCells(p).cells.map((c) => c.id);
      expect(second).toEqual(first);
    });

    it('updateNotebookMetadata round-trips nebula settings', async () => {
      const p = path.join(dir, `meta-${filename}`);
      await service.saveNotebookCells(p, cells, 'python3');
      const upd = await service.updateNotebookMetadata(p, { nebula: { full_width: true } });
      expect(upd.success).toBe(true);
      expect(upd.changed).toBe(true);
      const meta = service.getNotebookMetadata(p);
      expect((meta.nebula as any).full_width).toBe(true);
      // cells untouched by the metadata write
      const loaded = service.getNotebookCells(p);
      expect(loaded.cells).toHaveLength(2);
      // no-op update reports changed: false
      const noop = await service.updateNotebookMetadata(p, { nebula: { full_width: true } });
      expect(noop.changed).toBe(false);
    });

    it('setAgentPermission writes the flag in-file and bootstraps history', async () => {
      const p = path.join(dir, `perm-${filename}`);
      await service.saveNotebookCells(p, cells, 'python3');
      const res = await service.setAgentPermission(p, true);
      expect(res.success).toBe(true);
      const status = service.getAgentPermissionStatus(p);
      expect(status.agent_permitted).toBe(true);
      expect(status.has_history).toBe(true);
      expect(status.can_agent_modify).toBe(true);
      // flag actually lives in the text file
      expect(fs.readFileSync(p, 'utf-8')).toContain('agent_permitted');
    });

    it('saveNotebookBundle writes notebook + sidecars atomically', async () => {
      const p = path.join(dir, `bundle-${filename}`);
      const result = await service.saveNotebookBundle(p, cells, 'python3', [
        { type: 'snapshot', cells: [], timestamp: 1 },
      ]);
      expect(result.success).toBe(true);
      expect(service.loadHistory(p)).toHaveLength(1);
      expect(service.getNotebookCells(p).cells).toHaveLength(2);
    });
  });

  it('foo.py and foo.ipynb in one directory get distinct sidecars', async () => {
    const py = path.join(dir, 'foo.py');
    const ipynb = path.join(dir, 'foo.ipynb');
    await service.saveNotebookCells(py, [cell({ id: 'p1', content: '1' })], 'python3');
    await service.saveNotebookCells(ipynb, [cell({ id: 'n1', content: '2' })], 'python3');
    await service.saveHistory(py, [{ marker: 'py-history' }]);
    await service.saveHistory(ipynb, [{ marker: 'ipynb-history' }]);
    expect((service.loadHistory(py) as any)[0].marker).toBe('py-history');
    expect((service.loadHistory(ipynb) as any)[0].marker).toBe('ipynb-history');
    // ipynb sidecar name is the legacy extension-stripped form
    expect(fs.existsSync(path.join(dir, '.nebula', 'foo.history.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, '.nebula', 'foo.py.history.json'))).toBe(true);
  });

  it('rename and duplicate carry text-notebook sidecars along', async () => {
    const p = path.join(dir, 'mv.qmd');
    await service.saveNotebookCells(p, [cell({ id: 'a', content: '1' })], 'python3');
    await service.saveHistory(p, [{ marker: 'mv' }]);
    service.renameFile(p, path.join(dir, 'mv2.qmd'));
    expect((service.loadHistory(path.join(dir, 'mv2.qmd')) as any)[0].marker).toBe('mv');
    service.duplicateFile(path.join(dir, 'mv2.qmd'));
    const dup = fs.readdirSync(dir).find((f) => f.startsWith('mv2') && f !== 'mv2.qmd');
    expect(dup).toBeTruthy();
    expect((service.loadHistory(path.join(dir, dup!)) as any)[0].marker).toBe('mv');
  });

  it('deleting a text notebook removes its sidecars', async () => {
    const p = path.join(dir, 'del.py');
    await service.saveNotebookCells(p, [cell({ id: 'a', content: '1' })], 'python3');
    await service.saveHistory(p, [{ marker: 'del' }]);
    expect(fs.existsSync(path.join(dir, '.nebula', 'del.py.history.json'))).toBe(true);
    service.deleteFile(p);
    expect(fs.existsSync(path.join(dir, '.nebula', 'del.py.history.json'))).toBe(false);
  });

  it('createFile makes a .qmd notebook template but an EMPTY .py script', () => {
    const qmd = service.createFile(path.join(dir, 'fresh.qmd'));
    expect(qmd.is_directory).toBe(false);
    const qmdText = fs.readFileSync(path.join(dir, 'fresh.qmd'), 'utf-8');
    expect(qmdText).toContain('kernelspec');
    expect(service.getNotebookCells(path.join(dir, 'fresh.qmd')).cells).toEqual([]);

    service.createFile(path.join(dir, 'script.py'));
    expect(fs.readFileSync(path.join(dir, 'script.py'), 'utf-8')).toBe('');
  });

  it('getFileType: .qmd is a notebook, .py stays code', () => {
    expect(service.getFileType('.qmd')).toBe('notebook');
    expect(service.getFileType('.py')).toBe('code');
    expect(service.getFileType('.ipynb')).toBe('notebook');
    expect(service.getFileType('.md')).toBe('code');
  });

  it('a plain .py script (no markers) loads as a one-cell notebook with env-default kernel', async () => {
    const p = path.join(dir, 'plain.py');
    fs.writeFileSync(p, 'import sys\nprint(sys.platform)\n');
    const loaded = await service.getNotebookCellsWithKernel(p);
    expect(loaded.cells).toHaveLength(1);
    expect(loaded.cells[0].content).toBe('import sys\nprint(sys.platform)');
    expect(['default', 'env-default']).toContain(loaded.kernelspecSource);
  });
});
