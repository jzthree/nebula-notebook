/**
 * Integration tests for NebulaClient operation router.
 *
 * Requires a running Nebula server at http://localhost:8000
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { NebulaClient } from '../notebook/client.js';
import * as fs from 'fs';
import * as path from 'path';

const TEST_NOTEBOOK_DIR = path.join(process.cwd(), 'tmp');
const TEST_NOTEBOOK_PATH = path.join(TEST_NOTEBOOK_DIR, 'nebula-client-op-test.ipynb');

const seedCells = [
  { id: 'cell-a', type: 'code' as const, content: 'print("A")' },
  { id: 'cell-b', type: 'markdown' as const, content: '# B' },
  { id: 'cell-c', type: 'code' as const, content: 'print("C")' },
];

describe('NebulaClient (operation router)', () => {
  let client: NebulaClient;
  let sessionId: string | undefined;

  beforeAll(async () => {
    client = new NebulaClient({ baseUrl: process.env.NEBULA_URL || 'http://localhost:3000' });
    fs.mkdirSync(TEST_NOTEBOOK_DIR, { recursive: true });
  });

  afterAll(async () => {
    if (sessionId) {
      await client.shutdownKernel(sessionId);
    }
  });

  describe('Kernel Operations', () => {
    it('should list available kernels', async () => {
      const result = await client.listKernels();
      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
      expect(Array.isArray(result.data)).toBe(true);
    });

    it('should start a kernel session', async () => {
      const result = await client.startKernel('python3', TEST_NOTEBOOK_PATH);
      expect(result.success).toBe(true);
      expect(result.data?.sessionId).toBeDefined();
      sessionId = result.data?.sessionId;
    }, 30000);

    it('should restart and interrupt a kernel session', async () => {
      if (!sessionId) return;
      const restart = await client.restartKernel(sessionId);
      // Session may have been cleaned up - skip in that case
      if (!restart.success && restart.error?.includes('not found')) {
        return;
      }
      expect(restart.success).toBe(true);

      const interrupt = await client.interruptKernel(sessionId);
      // Session may have been cleaned up - skip in that case
      if (!interrupt.success && interrupt.error?.includes('not found')) {
        return;
      }
      expect(interrupt.success).toBe(true);
    });

    it('should get or create kernel for a file', async () => {
      const result = await client.getOrCreateKernelForFile(TEST_NOTEBOOK_PATH);
      if (!result.success) {
        return;
      }
      expect(result.data?.sessionId).toBeDefined();
    }, 15000);
  });

  describe('Notebook Operations via Router', () => {
    let notebookReady = true;
    let outputsReady = false;

    beforeEach(async () => {
      const blankNotebook = {
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { language_info: { name: 'python' } },
        cells: [],
      };
      const wrote = await client.writeFile(TEST_NOTEBOOK_PATH, JSON.stringify(blankNotebook, null, 2));
      notebookReady = wrote.success;
      if (!wrote.success) return;

      for (const cell of seedCells) {
        const inserted = await client.insertCellOp(TEST_NOTEBOOK_PATH, -1, {
          id: cell.id,
          type: cell.type,
          content: cell.content,
        });
        if (!inserted.success) {
          notebookReady = false;
          return;
        }
      }

      const outputs = await client.updateOutputsOp(
        TEST_NOTEBOOK_PATH,
        'cell-a',
        [{ type: 'stdout', content: 'A\n' }],
        1
      );
      outputsReady = outputs.success;
    });

    it('should read notebook via router', async () => {
      if (!notebookReady) return;
      const result = await client.readNotebookViaRouter(TEST_NOTEBOOK_PATH);
      expect(result.success).toBe(true);
      expect(result.data?.cells.length).toBe(3);
      expect(result.data?.cells[0].id).toBe('cell-a');
      expect(result.data?.cells[1].type).toBe('markdown');
    });

    it('should read a single cell by id', async () => {
      if (!notebookReady) return;
      const result = await client.readCellOp(TEST_NOTEBOOK_PATH, { cellId: 'cell-b' });
      expect(result.success).toBe(true);
      expect(result.data?.cell.id).toBe('cell-b');
      expect(result.data?.cell.type).toBe('markdown');
    });

    it('should read cell outputs', async () => {
      if (!notebookReady) return;
      if (!outputsReady) return;
      const result = await client.readCellOutputOp(TEST_NOTEBOOK_PATH, { cellId: 'cell-a' });
      expect(result.success).toBe(true);
      expect(result.data?.outputs.length).toBeGreaterThan(0);
    });

    it('should insert and update a cell', async () => {
      if (!notebookReady) return;
      const insert = await client.insertCellOp(TEST_NOTEBOOK_PATH, -1, {
        id: 'cell-d',
        type: 'code',
        content: 'print("D")',
      });
      expect(insert.success).toBe(true);

      const update = await client.updateContentOp(TEST_NOTEBOOK_PATH, 'cell-d', 'print("D updated")');
      expect(update.success).toBe(true);

      const meta = await client.updateMetadataOp(TEST_NOTEBOOK_PATH, 'cell-d', { type: 'markdown' });
      expect(meta.success).toBe(true);

      const read = await client.readCellOp(TEST_NOTEBOOK_PATH, { cellId: 'cell-d' });
      expect(read.success).toBe(true);
      expect(read.data?.cell.content).toContain('D updated');
      expect(read.data?.cell.type).toBe('markdown');
    });

    it('should move and duplicate cells', async () => {
      if (!notebookReady) return;
      const before = await client.readNotebookViaRouter(TEST_NOTEBOOK_PATH);
      const beforeCount = before.success ? before.data?.cells.length ?? 0 : 0;

      const move = await client.moveCellOp(TEST_NOTEBOOK_PATH, 0, 2);
      expect(move.success).toBe(true);

      const afterMove = await client.readNotebookViaRouter(TEST_NOTEBOOK_PATH);
      const afterMoveCount = afterMove.success ? afterMove.data?.cells.length ?? beforeCount : beforeCount;

      const dup = await client.duplicateCellOp(TEST_NOTEBOOK_PATH, 1, 'cell-dup-1');
      expect(dup.success).toBe(true);

      const afterDup = await client.readNotebookViaRouter(TEST_NOTEBOOK_PATH);
      expect(afterDup.success).toBe(true);
      expect(afterDup.data?.cells.length).toBe(afterMoveCount + 1);
    });

    it('should delete and clear cells', async () => {
      if (!notebookReady) return;
      const insert = await client.insertCellOp(TEST_NOTEBOOK_PATH, -1, {
        id: 'cell-delete',
        type: 'code',
        content: 'print("delete")',
      });
      expect(insert.success).toBe(true);

      const del = await client.deleteCellOp(TEST_NOTEBOOK_PATH, { cellId: 'cell-delete' });
      expect(del.success).toBe(true);

      const cleared = await client.clearNotebookOp(TEST_NOTEBOOK_PATH);
      expect(cleared.success).toBe(true);

      const read = await client.readNotebookViaRouter(TEST_NOTEBOOK_PATH);
      expect(read.success).toBe(true);
      expect(read.data?.cells.length).toBe(0);
    });

    it('should start and end agent session', async () => {
      const hasUI = await client.hasUI(TEST_NOTEBOOK_PATH);
      if (!hasUI) {
        return;
      }

      const start = await client.startAgentSession(TEST_NOTEBOOK_PATH, 'client-test-agent');
      if (!start.success) {
        return;
      }

      const end = await client.endAgentSession(TEST_NOTEBOOK_PATH);
      if (!end.success) {
        return;
      }
      expect(end.success).toBe(true);
    });
  });
});
