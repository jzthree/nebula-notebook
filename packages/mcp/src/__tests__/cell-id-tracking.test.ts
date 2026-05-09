/**
 * Tests for Cell ID stability and metadata updates via operation router.
 *
 * Requires a running Nebula server at http://localhost:8000
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { NebulaClient } from '../notebook/client.js';
import * as path from 'path';

describe('Cell ID Tracking (operation router)', () => {
  let client: NebulaClient;
  let testNotebookPath: string;

  beforeEach(async () => {
    client = new NebulaClient({
      baseUrl: process.env.NEBULA_URL || 'http://localhost:3000',
      agentId: 'cell-id-test-agent',
      autoStartAgentSession: true,
    });
    testNotebookPath = path.join(
      '/tmp',
      `nebula-test-${Date.now()}-${Math.random().toString(16).slice(2)}.ipynb`
    );

    // Create notebook via operation router (sets agent_created: true)
    const createResult = await client.createNotebookOp(testNotebookPath, { overwrite: true });
    if (!createResult.success) {
      throw new Error(`Failed to create notebook: ${createResult.error}`);
    }

    // Insert the initial cells
    await client.insertCellOp(testNotebookPath, -1, {
      id: 'existing-cell-1',
      type: 'code',
      content: 'print("Cell 1")',
    });
    await client.insertCellOp(testNotebookPath, -1, {
      id: 'existing-cell-2',
      type: 'code',
      content: 'print("Cell 2")',
    });
  });

  afterEach(async () => {
    try {
      await client.deleteFile(testNotebookPath);
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should create a cell with specified ID', async () => {
    const result = await client.insertCellOp(testNotebookPath, -1, {
      id: 'my-new-cell',
      type: 'code',
      content: 'print("New cell")',
    });

    expect(result.success).toBe(true);

    const notebook = await client.readNotebookViaRouter(testNotebookPath);
    expect(notebook.success).toBe(true);
    const ids = notebook.data?.cells.map(c => c.id) || [];
    expect(ids).toContain('my-new-cell');
  }, 15000);

  it('should avoid duplicate IDs on insert', async () => {
    const result = await client.insertCellOp(testNotebookPath, -1, {
      id: 'existing-cell-1',
      type: 'code',
      content: 'print("Duplicate ID")',
    });

    expect(result.success).toBe(true);

    const notebook = await client.readNotebookViaRouter(testNotebookPath);
    expect(notebook.success).toBe(true);
    const ids = notebook.data?.cells.map(c => c.id) || [];
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('should read a cell by ID', async () => {
    const result = await client.readCellOp(testNotebookPath, { cellId: 'existing-cell-2' });
    expect(result.success).toBe(true);
    expect(result.data?.cell.id).toBe('existing-cell-2');
    expect(result.data?.cell.content).toContain('Cell 2');
  });

  it('should preserve ID after content update', async () => {
    const update = await client.updateContentOp(testNotebookPath, 'existing-cell-1', 'print("Updated content")');
    expect(update.success).toBe(true);

    const read = await client.readCellOp(testNotebookPath, { cellId: 'existing-cell-1' });
    expect(read.success).toBe(true);
    expect(read.data?.cell.id).toBe('existing-cell-1');
    expect(read.data?.cell.content).toContain('Updated content');
  });

  it('should update cell type via metadata', async () => {
    const meta = await client.updateMetadataOp(testNotebookPath, 'existing-cell-1', { type: 'markdown' });
    expect(meta.success).toBe(true);

    const read = await client.readCellOp(testNotebookPath, { cellId: 'existing-cell-1' });
    expect(read.success).toBe(true);
    expect(read.data?.cell.type).toBe('markdown');
  });
});
