// @vitest-environment node
/**
 * End-to-end coverage for text notebook formats (.py percent / .qmd) through
 * the headless handler — the same path MCP agent operations take — plus the
 * external-edit history reconciliation that keeps undo/redo infinite.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HeadlessOperationHandler } from '../notebook/headless-handler';
import { OperationRouter } from '../notebook/operation-router';
import { FilesystemService } from '../fs/fs-service';

describe('headless operations on text notebook formats', () => {
  let handler: HeadlessOperationHandler;
  let fsService: FilesystemService;
  let router: OperationRouter;
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'headless-formats-'));
    fsService = new FilesystemService();
    router = new OperationRouter();
    handler = new HeadlessOperationHandler(fsService, router);
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe.each([['percent', 'agent.py'], ['qmd', 'agent.qmd']])(
    '%s (%s)',
    (_name, filename) => {
      it('agent createNotebook → insert → update → flush → reload keeps ids and content', async () => {
        const nbPath = path.join(testDir, filename);

        const created = await handler.applyOperation({
          type: 'createNotebook',
          notebookPath: nbPath,
          kernelName: 'python3',
        });
        expect(created.success).toBe(true);

        // Agent-created flag must live in the file itself
        expect(fs.readFileSync(nbPath, 'utf-8')).toContain('agent_created');
        expect(fsService.getAgentPermissionStatus(nbPath).can_agent_modify).toBe(true);

        const ins = await handler.applyOperation({
          type: 'insertCell',
          notebookPath: nbPath,
          index: 0,
          cell: { id: 'mycell1', type: 'code', content: 'x = 41' },
        });
        expect(ins.success).toBe(true);

        const upd = await handler.applyOperation({
          type: 'updateContent',
          notebookPath: nbPath,
          cellId: 'mycell1',
          content: 'x = 42\nprint(x)',
        });
        expect(upd.success).toBe(true);

        await handler.flush(nbPath);
        handler.invalidate(nbPath);

        const reloaded = fsService.getNotebookCells(nbPath);
        expect(reloaded.cells).toHaveLength(1);
        expect(reloaded.cells[0].id).toBe('mycell1');
        expect(reloaded.cells[0].content).toBe('x = 42\nprint(x)');
        // outputs/counts never persisted for text formats
        const raw = fs.readFileSync(nbPath, 'utf-8');
        expect(raw).toContain('mycell1');
      });

      it('delete and move work and persist', async () => {
        const nbPath = path.join(testDir, `ops-${filename}`);
        await handler.applyOperation({ type: 'createNotebook', notebookPath: nbPath });
        for (const [i, id] of ['c1', 'c2', 'c3'].entries()) {
          await handler.applyOperation({
            type: 'insertCell',
            notebookPath: nbPath,
            index: i,
            cell: { id, type: 'code', content: `v = ${i}` },
          });
        }
        const del = await handler.applyOperation({
          type: 'deleteCell',
          notebookPath: nbPath,
          cellId: 'c2',
        });
        expect(del.success).toBe(true);
        const mv = await handler.applyOperation({
          type: 'moveCell',
          notebookPath: nbPath,
          cellId: 'c1',
          afterCellId: 'c3',
        });
        expect(mv.success).toBe(true);
        await handler.flush(nbPath);
        handler.invalidate(nbPath);
        const cells = fsService.getNotebookCells(nbPath).cells;
        expect(cells.map((c) => c.id)).toEqual(['c3', 'c1']);
      });

      it('update_metadata (notebook-level) persists into the text file', async () => {
        const nbPath = path.join(testDir, `meta-${filename}`);
        await handler.applyOperation({ type: 'createNotebook', notebookPath: nbPath });
        const res = await fsService.updateNotebookMetadata(nbPath, {
          nebula: { output_logging: 'full' },
        });
        expect(res.success).toBe(true);
        expect((fsService.getNotebookMetadata(nbPath).nebula as any).output_logging).toBe('full');
        expect((fsService.getNotebookMetadata(nbPath).nebula as any).agent_created).toBe(true);
      });
    }
  );

  describe('external-edit history reconciliation (infinite undo across vim edits)', () => {
    async function setupNotebook(filename: string) {
      const nbPath = path.join(testDir, filename);
      await handler.applyOperation({ type: 'createNotebook', notebookPath: nbPath });
      await handler.applyOperation({
        type: 'insertCell',
        notebookPath: nbPath,
        index: 0,
        cell: { id: 'keep1', type: 'code', content: 'a = 1' },
      });
      await handler.applyOperation({
        type: 'insertCell',
        notebookPath: nbPath,
        index: 1,
        cell: { id: 'edit2', type: 'code', content: 'b = 2' },
      });
      await handler.flush(nbPath);
      handler.invalidate(nbPath);
      return nbPath;
    }

    it('synthesizes a batch op for an external content edit', async () => {
      const nbPath = await setupNotebook('ext.py');
      const before = fsService.loadHistory(nbPath);

      // "vim": change one cell's content directly on disk
      const text = fs.readFileSync(nbPath, 'utf-8').replace('b = 2', 'b = 2000  # edited in vim');
      fs.writeFileSync(nbPath, text, 'utf-8');

      const after = fsService.loadHistory(nbPath);
      expect(after.length).toBe(before.length + 1);
      const entry = after[after.length - 1] as any;
      expect(entry.type).toBe('batch');
      expect(entry.source).toBe('external');
      expect(entry.operations).toHaveLength(1);
      expect(entry.operations[0]).toMatchObject({
        type: 'updateContent',
        cellId: 'edit2',
        oldContent: 'b = 2',
        newContent: 'b = 2000  # edited in vim',
      });

      // Idempotent: loading again does not duplicate the reconciliation
      const again = fsService.loadHistory(nbPath);
      expect(again.length).toBe(after.length);
    });

    it('synthesizes insert/delete ops for added and removed cells', async () => {
      const nbPath = await setupNotebook('ext2.py');
      // "vim": delete cell keep1 entirely, add a brand-new cell at the end
      let text = fs.readFileSync(nbPath, 'utf-8');
      text = text.replace(/# %% id="keep1"\na = 1\n\n/, '');
      text += '\n# %% id="newcell"\nz = 99\n';
      fs.writeFileSync(nbPath, text, 'utf-8');

      const history = fsService.loadHistory(nbPath);
      const entry = history[history.length - 1] as any;
      expect(entry.type).toBe('batch');
      const types = entry.operations.map((o: any) => o.type).sort();
      expect(types).toEqual(['deleteCell', 'insertCell']);
      const del = entry.operations.find((o: any) => o.type === 'deleteCell');
      expect(del.cell.id).toBe('keep1');
      const ins = entry.operations.find((o: any) => o.type === 'insertCell');
      expect(ins.cell.id).toBe('newcell');
      expect(ins.cell.content).toBe('z = 99');
    });

    it('headless undo walks back through the external edit (infinite undo)', async () => {
      const nbPath = await setupNotebook('ext3.py');
      const text = fs.readFileSync(nbPath, 'utf-8').replace('b = 2', 'b = 777');
      fs.writeFileSync(nbPath, text, 'utf-8');

      // Reconcile (as any history consumer would)
      fsService.loadHistory(nbPath);
      handler.invalidate(nbPath);

      // Undo via the headless handler: should revert the EXTERNAL edit first
      const undo = await handler.applyOperation({ type: 'undo', notebookPath: nbPath });
      expect(undo.success).toBe(true);
      await handler.flush(nbPath);
      handler.invalidate(nbPath);
      const cells = fsService.getNotebookCells(nbPath).cells;
      expect(cells.find((c) => c.id === 'edit2')?.content).toBe('b = 2');

    });

    it('redo reapplies the external edit (undo→redo in one session)', async () => {
      const nbPath = await setupNotebook('ext4.py');
      const text = fs.readFileSync(nbPath, 'utf-8').replace('b = 2', 'b = 777');
      fs.writeFileSync(nbPath, text, 'utf-8');
      fsService.loadHistory(nbPath); // reconcile
      handler.invalidate(nbPath);

      const undo = await handler.applyOperation({ type: 'undo', notebookPath: nbPath });
      expect(undo.success).toBe(true);
      // Redo immediately (redo stacks are session-scoped, same as .ipynb)
      const redo = await handler.applyOperation({ type: 'redo', notebookPath: nbPath });
      expect(redo.success).toBe(true);
      await handler.flush(nbPath);
      handler.invalidate(nbPath);
      const cells = fsService.getNotebookCells(nbPath).cells;
      expect(cells.find((c) => c.id === 'edit2')?.content).toBe('b = 777');
    });

    it('does not reconcile .ipynb (guard is text-format-only)', async () => {
      const nbPath = path.join(testDir, 'plain.ipynb');
      await handler.applyOperation({ type: 'createNotebook', notebookPath: nbPath });
      await handler.applyOperation({
        type: 'insertCell',
        notebookPath: nbPath,
        index: 0,
        cell: { id: 'i1', type: 'code', content: '1' },
      });
      await handler.flush(nbPath);
      const before = fsService.loadHistory(nbPath);
      const again = fsService.loadHistory(nbPath);
      expect(again.length).toBe(before.length);
      expect(fs.existsSync(path.join(testDir, '.nebula', 'plain.lastsave.json'))).toBe(false);
    });
  });
});
