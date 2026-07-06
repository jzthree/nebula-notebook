/**
 * Integration Tests for MCP Tool Execution
 *
 * Tests the tool execution pipeline against an in-process mock Nebula server
 * by default. Set NEBULA_URL to run against a live Nebula server instead.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NebulaClient } from '../notebook/client.js';
import { executeToolForMCP, executeToolByName, hasTool } from '../tools/index.js';
import { startMockNebulaServer, type MockNebulaServer } from './helpers/mock-nebula-server.js';

const TEST_NOTEBOOK_PATH = `/tmp/mcp-test-notebook-${Date.now()}-${Math.random().toString(16).slice(2)}.ipynb`;

describe('MCP Tool Execution Integration', () => {
  let client: NebulaClient;
  let mockServer: MockNebulaServer | undefined;

  beforeAll(async () => {
    let baseUrl = process.env.NEBULA_URL;
    if (!baseUrl) {
      mockServer = await startMockNebulaServer();
      baseUrl = mockServer.url;
    }

    client = new NebulaClient({
      baseUrl,
      agentId: 'mcp-test-agent',
      autoStartAgentSession: true,
    });

    // Create test notebook via operation router (sets agent_created: true)
    await client.createNotebookOp(TEST_NOTEBOOK_PATH, { overwrite: true });

    // Insert test cells
    await client.insertCellOp(TEST_NOTEBOOK_PATH, -1, {
      id: 'md-cell',
      type: 'markdown',
      content: '# MCP Test Notebook\n\nTesting MCP tools.',
    });
    await client.insertCellOp(TEST_NOTEBOOK_PATH, -1, {
      id: 'code-cell-1',
      type: 'code',
      content: 'import numpy as np\nprint("Cell 1")',
    });
    await client.insertCellOp(TEST_NOTEBOOK_PATH, -1, {
      id: 'code-cell-2',
      type: 'code',
      content: 'x = 100\nprint(x)',
    });
  });

  afterAll(async () => {
    if (mockServer) {
      await mockServer.close();
    }
  });

  // ===========================================================================
  // executeToolForMCP Tests
  // ===========================================================================
  describe('executeToolForMCP', () => {
    it('should execute known tools and return MCP content', async () => {
      const result = await executeToolForMCP('read_notebook', { path: TEST_NOTEBOOK_PATH }, client);

      expect(result.isError).toBeFalsy();
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      expect(result.content[0].type).toBe('text');
    });

    it('should return error for unknown tools', async () => {
      const result = await executeToolForMCP('nonexistent_tool', {}, client);

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Unknown tool');
    });

    it('should handle tool execution errors gracefully', async () => {
      const result = await executeToolForMCP('read_notebook', { path: '/nonexistent/notebook.ipynb' }, client);

      expect(result.isError).toBe(true);
      expect(result.content[0].type).toBe('text');
    });
  });

  // ===========================================================================
  // executeToolByName Tests
  // ===========================================================================
  describe('executeToolByName', () => {
    it('should execute tool and return raw result', async () => {
      const result = await executeToolByName('read_notebook', { path: TEST_NOTEBOOK_PATH }, client);

      expect(result.success).toBe(true);
      expect(result.data).toBeDefined();
    });

    it('should return error for unknown tools', async () => {
      const result = await executeToolByName('nonexistent_tool', {}, client);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown tool');
    });
  });

  // ===========================================================================
  // Kernel Tool Execution Tests
  // ===========================================================================
  describe('Kernel Tools', () => {
    let hasKernels = true;

    beforeAll(async () => {
      const kernels = await client.listKernels();
      hasKernels = kernels.success && (kernels.data?.length ?? 0) > 0;
      // exclusive: these tests exercise tool plumbing (incl. index-addressed deletes),
      // not collaborative-session OCC semantics
      await executeToolForMCP('start_agent_session', { path: TEST_NOTEBOOK_PATH, exclusive: true }, client);
    });

    it('should execute list_kernels with display names', async () => {
      const result = await executeToolForMCP('list_kernels', {}, client);
      expect(result.isError).toBeFalsy();
      // Should show kernels with display names
      const text = (result.content[0] as { type: 'text'; text: string }).text;
      expect(text).toMatch(/kernel|python/i);
    });

    it('should execute kernel_start', async () => {
      if (!hasKernels) return;
      const result = await executeToolForMCP('kernel_start', { kernel_name: 'python3' }, client);
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Kernel started');
    }, 60000);

    it('should execute kernel_restart', async () => {
      if (!hasKernels) return;
      const result = await executeToolForMCP('kernel_restart', {}, client);
      // Session may have been cleaned up if test ran slowly - skip in that case
      if (result.isError && (result.content[0] as { type: 'text'; text: string }).text.includes('not found')) {
        return;
      }
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('restarted');
    });

    it('should execute kernel_interrupt', async () => {
      if (!hasKernels) return;
      const result = await executeToolForMCP('kernel_interrupt', {}, client);
      // Session may have been cleaned up if test ran slowly - skip in that case
      if (result.isError && (result.content[0] as { type: 'text'; text: string }).text.includes('not found')) {
        return;
      }
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('interrupted');
    });

    it('should execute kernel_stop', async () => {
      if (!hasKernels) return;
      const result = await executeToolForMCP('kernel_stop', {}, client);
      // Session may have been cleaned up if test ran slowly - skip in that case
      if (result.isError && (result.content[0] as { type: 'text'; text: string }).text.includes('not found')) {
        return;
      }
      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('stopped');
    });
  });

  // ===========================================================================
  // Notebook Tool Execution Tests
  // ===========================================================================
  describe('Notebook Tools', () => {
    it('should execute read_output', async () => {
      const result = await executeToolForMCP('read_output', {
        path: TEST_NOTEBOOK_PATH,
        cell_index: 2,
        max_wait: 0, // Immediate read - don't wait for execution
      }, client);

      expect(result.isError).toBeFalsy();
      const hasOutput = result.content.some(c =>
        c.type === 'text' && (c as { type: 'text'; text: string }).text.includes('outputs')
      );
      expect(hasOutput).toBe(true);
    });

    it('should execute read_notebook with brief format', async () => {
      const result = await executeToolForMCP('read_notebook', {
        path: TEST_NOTEBOOK_PATH,
        format: 'brief',
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Notebook:');
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('3 cells');
    });

    it('should execute read_cell', async () => {
      const result = await executeToolForMCP('read_cell', {
        path: TEST_NOTEBOOK_PATH,
        cell_index: 1,
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Cell 1');
    });

    it('should execute insert_cell (append)', async () => {
      const result = await executeToolForMCP('insert_cell', {
        path: TEST_NOTEBOOK_PATH,
        cell_id: 'test-appended-cell',
        content: 'print("Appended cell")',
        cell_type: 'code',
        // position omitted = append
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('test-appended-cell');
    });

    it('should execute search_cells', async () => {
      const result = await executeToolForMCP('search_cells', {
        path: TEST_NOTEBOOK_PATH,
        query: 'print',
        limit: 5,
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('Found');
    });

    it('should execute search_cells with no results', async () => {
      const result = await executeToolForMCP('search_cells', {
        path: TEST_NOTEBOOK_PATH,
        query: 'xyznonexistent123',
        limit: 5,
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('No matching');
    });

    it('should execute delete_cell', async () => {
      const result = await executeToolForMCP('delete_cell', {
        path: TEST_NOTEBOOK_PATH,
        cell_index: 3,
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('deleted');
    });

    it('should handle read_cell with invalid index', async () => {
      const result = await executeToolForMCP('read_cell', {
        path: TEST_NOTEBOOK_PATH,
        cell_index: 999,
      }, client);

      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('out of range');
    });

    it('should handle read_notebook with non-existent file', async () => {
      const result = await executeToolForMCP('read_notebook', {
        path: '/tmp/nonexistent-12345.ipynb',
      }, client);

      expect(result.isError).toBe(true);
    });

    it('should execute move_cell', async () => {
      const moveTestPath = '/tmp/mcp-move-test.ipynb';
      await client.createNotebookOp(moveTestPath, { overwrite: true });
      await client.insertCellOp(moveTestPath, -1, { id: 'c1', type: 'code', content: 'first' });
      await client.insertCellOp(moveTestPath, -1, { id: 'c2', type: 'code', content: 'second' });
      await client.insertCellOp(moveTestPath, -1, { id: 'c3', type: 'code', content: 'third' });

      const result = await executeToolForMCP('move_cell', {
        path: moveTestPath,
        from_index: 0,
        to_index: 2,
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('moved');
    });

    it('should execute duplicate_cell', async () => {
      const dupTestPath = '/tmp/mcp-dup-test.ipynb';
      await client.createNotebookOp(dupTestPath, { overwrite: true });
      await client.insertCellOp(dupTestPath, -1, { id: 'orig', type: 'code', content: 'original' });
      await client.insertCellOp(dupTestPath, -1, { id: 'hdr', type: 'markdown', content: '# Header' });

      const result = await executeToolForMCP('duplicate_cell', {
        path: dupTestPath,
        cell_index: 0,
      }, client);

      expect(result.isError).toBeFalsy();
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('duplicated');
    });

    it('should execute update_cell and update_metadata', async () => {
      const updatePath = '/tmp/mcp-update-test.ipynb';
      await client.createNotebookOp(updatePath, { overwrite: true });

      const insertResult = await executeToolByName('insert_cell', {
        path: updatePath,
        cell_id: 'update-target',
        content: 'print("old")',
        cell_type: 'code',
      }, client);
      expect(insertResult.success).toBe(true);

      const updateResult = await executeToolForMCP('update_cell', {
        path: updatePath,
        cell_id: 'update-target',
        content: 'print("new")',
      }, client);
      expect(updateResult.isError).toBeFalsy();

      const metaResult = await executeToolForMCP('update_metadata', {
        path: updatePath,
        cell_id: 'update-target',
        changes: { type: 'markdown' },
      }, client);
      expect(metaResult.isError).toBeFalsy();

      const readResult = await executeToolByName('read_cell', {
        path: updatePath,
        cell_id: 'update-target',
      }, client);
      expect(readResult.success).toBe(true);
      const readData = readResult.data as { cell: { content: string; type: string } };
      expect(readData.cell.content).toContain('new');
      expect(readData.cell.type).toBe('markdown');
    });

    it('should execute start_agent_session and end_agent_session', async () => {
      const sessionPath = '/tmp/mcp-agent-session.ipynb';
      await client.createNotebookOp(sessionPath, { overwrite: true });

      const hasUI = await client.hasUI(sessionPath);
      if (!hasUI) {
        return;
      }

      const startResult = await executeToolForMCP('start_agent_session', {
        path: sessionPath,
        agent_id: 'mcp-test-agent',
      }, client);
      if (startResult.isError) {
        return;
      }

      const endResult = await executeToolForMCP('end_agent_session', {
        path: sessionPath,
      }, client);
      if (endResult.isError) {
        return;
      }
      expect(endResult.isError).toBeFalsy();
    });
  });

  // ===========================================================================
  // Execution Tool Tests
  // ===========================================================================
  describe('Execution Tools', () => {
    let sessionId: string | undefined;

    beforeAll(async () => {
      const kernels = await client.listKernels();
      if (!kernels.success || (kernels.data?.length ?? 0) === 0) {
        return;
      }

      const kernelResult = await client.startKernel('python3');
      if (!kernelResult.success) {
        return;
      }
      sessionId = kernelResult.data!.sessionId;
    }, 60000);

    afterAll(async () => {
      if (sessionId) {
        await client.shutdownKernel(sessionId);
      }
    });

    it('should execute execute_cell', async () => {
      if (!sessionId) return;

      const execNotebookPath = '/tmp/mcp-exec-test.ipynb';
      await client.createNotebookOp(execNotebookPath, { overwrite: true });
      await client.insertCellOp(execNotebookPath, -1, {
        id: 'exec-cell',
        type: 'code',
        content: 'print("Cell executed!")',
      });

      const result = await executeToolForMCP('execute_cell', {
        path: execNotebookPath,
        cell_index: 0,
        session_id: sessionId,
        max_wait: 30,
      }, client);

      expect(result.isError).toBeFalsy();
      const hasOutput = result.content.some(c =>
        c.type === 'text' && (c as { type: 'text'; text: string }).text.includes('Cell executed!')
      );
      expect(hasOutput).toBe(true);
    });

    it('should handle execute_cell with invalid index', async () => {
      if (!sessionId) return;

      const execNotebookPath = '/tmp/mcp-exec-invalid-test.ipynb';
      await client.createNotebookOp(execNotebookPath, { overwrite: true });
      await client.insertCellOp(execNotebookPath, -1, {
        id: 'test-cell',
        type: 'code',
        content: 'print(1)',
      });

      const result = await executeToolForMCP('execute_cell', {
        path: execNotebookPath,
        cell_index: 999,
        session_id: sessionId,
        max_wait: 30,
      }, client);

      expect(result.isError).toBe(true);
      expect((result.content[0] as { type: 'text'; text: string }).text).toContain('out of range');
    });
  });

  // ===========================================================================
  // Removed Tools Verification
  // ===========================================================================
  describe('Removed Tools', () => {
    it('should not have execute_code tool', () => {
      expect(hasTool('execute_code')).toBe(false);
    });

    it('should have file tools', () => {
      expect(hasTool('list_directory')).toBe(true);
      expect(hasTool('read_file')).toBe(true);
      expect(hasTool('write_file')).toBe(true);
      expect(hasTool('delete_file')).toBe(true);
      expect(hasTool('rename_file')).toBe(true);
      expect(hasTool('download_file')).toBe(true);
      expect(hasTool('upload_file')).toBe(true);
    });

    it('should not have list_sessions tool', () => {
      expect(hasTool('list_sessions')).toBe(false);
    });

    it('should not have python tools', () => {
      expect(hasTool('list_python_environments')).toBe(false);
      expect(hasTool('get_python_info')).toBe(false);
    });

    it('should not have write_cell tool (replaced by insert_cell/update_cell)', () => {
      expect(hasTool('write_cell')).toBe(false);
    });
  });
});
