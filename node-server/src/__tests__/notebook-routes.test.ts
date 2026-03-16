// @vitest-environment node
/**
 * Notebook Routes Tests
 *
 * Tests for all /api/notebook/* endpoints to ensure functional parity
 * with the Python backend.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import Fastify, { FastifyInstance } from 'fastify';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import routes
import notebookRoutes from '../routes/notebook';

describe('Notebook Routes', () => {
  let app: FastifyInstance;
  let testDir: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(notebookRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    // Create a temporary test directory
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-routes-test-'));
  });

  afterEach(() => {
    // Clean up test directory
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('GET /api/cell/metadata-schema', () => {
    it('should return cell metadata schema', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/cell/metadata-schema' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('type');
      expect(body).toHaveProperty('scrolled');
      expect(body).toHaveProperty('scrolledHeight');
    });

    it('should have agentMutable property on all fields', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/cell/metadata-schema' });
      const body = JSON.parse(response.body);

      expect(body.id.agentMutable).toBe(true);
      expect(body.type.agentMutable).toBe(true);
      expect(body.scrolled.agentMutable).toBe(true);
      expect(body.scrolledHeight.agentMutable).toBe(true);
    });

    it('should have correct type definitions', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/cell/metadata-schema' });
      const body = JSON.parse(response.body);

      expect(body.id.type).toBe('string');
      expect(body.type.type).toBe('enum');
      expect(body.type.values).toEqual(['code', 'markdown']);
      expect(body.scrolled.type).toBe('boolean');
      expect(body.scrolledHeight.type).toBe('number');
    });
  });

  describe('GET /api/notebook/cells', () => {
    it('should return notebook cells', async () => {
      // Create a test notebook
      const notebookPath = path.join(testDir, 'test.ipynb');
      const notebook = {
        cells: [
          {
            cell_type: 'code',
            source: ['print("hello")'],
            metadata: { id: 'cell-1' },
            outputs: [],
            execution_count: null,
          },
        ],
        metadata: {
          kernelspec: { name: 'python3', display_name: 'Python 3' },
          nebula: {},
        },
        nbformat: 4,
        nbformat_minor: 5,
      };
      fs.writeFileSync(notebookPath, JSON.stringify(notebook));

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/cells?path=${encodeURIComponent(notebookPath)}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('path');
      expect(body).toHaveProperty('cells');
      expect(body).toHaveProperty('kernelspec');
      expect(body).toHaveProperty('mtime');
      expect(Array.isArray(body.cells)).toBe(true);
    });

    it('should return 400 if path is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notebook/cells' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });

    it('should return 404 for non-existent notebook', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/notebook/cells?path=/nonexistent/path.ipynb',
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(404);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('POST /api/notebook/save', () => {
    it('should save notebook cells', async () => {
      const notebookPath = path.join(testDir, 'save-test.ipynb');
      // Create initial notebook
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const cells = [
        {
          id: 'cell-1',
          type: 'code',
          content: 'print("saved")',
          outputs: [],
        },
      ];

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/save',
        payload: { path: notebookPath, cells, kernel_name: 'python3' },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('path');
      expect(body).toHaveProperty('mtime');
    });

    it('should return 400 if path is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/save',
        payload: { cells: [] },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });

    it('should return 400 if cells is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/save',
        payload: { path: '/some/path.ipynb' },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });

    it('should save without kernel output seq metadata', async () => {
      const notebookPath = path.join(testDir, 'save-seq.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/save',
        payload: {
          path: notebookPath,
          cells: [],
          kernel_name: 'python3',
        },
      });

      expect(response.statusCode).toBe(200);
      const saved = JSON.parse(fs.readFileSync(notebookPath, 'utf-8'));
      // No kernel_output_seq metadata should be written
      expect(saved.metadata?.nebula?.kernel_output_seq).toBeUndefined();
      expect(saved.metadata?.nebula?.kernel_output_session_id).toBeUndefined();
    });
  });

  describe('GET /api/notebook/history', () => {
    it('should return empty history for new notebook', async () => {
      const notebookPath = path.join(testDir, 'history-test.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/history?notebook_path=${encodeURIComponent(notebookPath)}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('notebook_path');
      expect(body).toHaveProperty('history');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notebook/history' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('POST /api/notebook/history', () => {
    it('should save history', async () => {
      const notebookPath = path.join(testDir, 'history-save.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const history = [{ type: 'insertCell', index: 0 }];

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/history',
        payload: { notebook_path: notebookPath, history },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('notebook_path');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/history',
        payload: { history: [] },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('GET /api/notebook/session', () => {
    it('should return empty session for new notebook', async () => {
      const notebookPath = path.join(testDir, 'session-test.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/session?notebook_path=${encodeURIComponent(notebookPath)}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('notebook_path');
      expect(body).toHaveProperty('session');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notebook/session' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('POST /api/notebook/session', () => {
    it('should save session', async () => {
      const notebookPath = path.join(testDir, 'session-save.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const session = { lastKernel: 'python3' };

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/session',
        payload: { notebook_path: notebookPath, session },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('notebook_path');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/session',
        payload: { session: {} },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('POST /api/notebook/permit-agent', () => {
    it('should grant agent permission', async () => {
      const notebookPath = path.join(testDir, 'permit-test.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/permit-agent',
        payload: { notebook_path: notebookPath, permitted: true },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('status', 'ok');
      expect(body).toHaveProperty('notebook_path');
      expect(body).toHaveProperty('agent_permitted');
      expect(body).toHaveProperty('agent_created');
      expect(body).toHaveProperty('has_history');
      expect(body).toHaveProperty('can_agent_modify');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/permit-agent',
        payload: { permitted: true },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('GET /api/notebook/agent-status', () => {
    it('should return agent status', async () => {
      const notebookPath = path.join(testDir, 'agent-status.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/agent-status?path=${encodeURIComponent(notebookPath)}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('notebook_path');
      expect(body).toHaveProperty('agent_created');
      expect(body).toHaveProperty('agent_permitted');
      expect(body).toHaveProperty('has_history');
      expect(body).toHaveProperty('can_agent_modify');
      expect(body).toHaveProperty('reason');
    });

    it('should return 400 if path is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notebook/agent-status' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('GET /api/notebook/read', () => {
    it('should read notebook via operation router', async () => {
      const notebookPath = path.join(testDir, 'read-test.ipynb');
      const notebook = {
        cells: [
          {
            cell_type: 'code',
            source: ['x = 1'],
            metadata: { id: 'cell-1' },
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
            execution_count: 1,
          },
        ],
        metadata: { kernelspec: { name: 'python3' } },
        nbformat: 4,
        nbformat_minor: 5,
      };
      fs.writeFileSync(notebookPath, JSON.stringify(notebook));

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/read?path=${encodeURIComponent(notebookPath)}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('success', true);
      expect(body).toHaveProperty('data');
      expect(body.data).toHaveProperty('cells');
      expect(body.data).toHaveProperty('path');
    });

    it('should support include_outputs=false', async () => {
      const notebookPath = path.join(testDir, 'read-no-outputs.ipynb');
      const notebook = {
        cells: [
          {
            cell_type: 'code',
            source: ['x = 1'],
            metadata: { id: 'cell-1' },
            outputs: [{ output_type: 'stream', name: 'stdout', text: ['1\n'] }],
            execution_count: 1,
          },
        ],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      };
      fs.writeFileSync(notebookPath, JSON.stringify(notebook));

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/read?path=${encodeURIComponent(notebookPath)}&include_outputs=false`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body.success).toBe(true);
      expect(body.data.cells[0].outputs).toEqual([]);
    });

    it('should return 400 if path is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notebook/read' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('GET /api/notebook/has-ui', () => {
    it('should return hasUI status', async () => {
      const notebookPath = path.join(testDir, 'has-ui.ipynb');

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/has-ui?path=${encodeURIComponent(notebookPath)}`,
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('hasUI');
      expect(body).toHaveProperty('path');
      expect(body.hasUI).toBe(false); // No UI connected in tests
    });

    it('should return 400 if path is missing', async () => {
      const response = await app.inject({ method: 'GET', url: '/api/notebook/has-ui' });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });
  });

  describe('POST /api/notebook/operation', () => {
    it('should return 400 if operation type is missing', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/operation',
        payload: { notebookPath: '/some/path.ipynb' },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(400);
      expect(body).toHaveProperty('detail');
    });

    it('should handle insertCell operation (headless mode)', async () => {
      const notebookPath = path.join(testDir, 'op-insert.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: { nebula: { agent_created: true } },
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const agentId = 'test-agent-insert';

      // Start agent session first
      await app.inject({
        method: 'POST',
        url: '/api/notebook/operation',
        payload: {
          type: 'startAgentSession',
          notebookPath,
          agentId,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/operation',
        payload: {
          type: 'insertCell',
          notebookPath,
          agentId,
          index: 0,
          cell: { id: 'new-cell', type: 'code', content: 'print("hello")' },
        },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('success', true);
    });

    it('should handle deleteCell operation (headless mode)', async () => {
      const notebookPath = path.join(testDir, 'op-delete.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [
          { cell_type: 'code', source: ['x=1'], metadata: { nebula_id: 'cell-to-delete' }, outputs: [] },
        ],
        metadata: { nebula: { agent_created: true } },
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const agentId = 'test-agent-delete';

      // Start agent session first
      await app.inject({
        method: 'POST',
        url: '/api/notebook/operation',
        payload: {
          type: 'startAgentSession',
          notebookPath,
          agentId,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/operation',
        payload: {
          type: 'deleteCell',
          notebookPath,
          agentId,
          cellId: 'cell-to-delete',
        },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('success', true);
    });

    it('should handle updateContent operation (headless mode)', async () => {
      const notebookPath = path.join(testDir, 'op-update.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [
          { cell_type: 'code', source: ['old content'], metadata: { nebula_id: 'cell-1' }, outputs: [] },
        ],
        metadata: { nebula: { agent_created: true } },
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const agentId = 'test-agent-update';

      // Start agent session first
      await app.inject({
        method: 'POST',
        url: '/api/notebook/operation',
        payload: {
          type: 'startAgentSession',
          notebookPath,
          agentId,
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/operation',
        payload: {
          type: 'updateContent',
          notebookPath,
          agentId,
          cellId: 'cell-1',
          content: 'new content',
        },
      });
      const body = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(body).toHaveProperty('success', true);
    });
  });
});

describe('Notebook Routes - Response Format Parity', () => {
  let app: FastifyInstance;
  let testDir: string;

  beforeAll(async () => {
    app = Fastify();
    await app.register(notebookRoutes, { prefix: '/api' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notebook-format-test-'));
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Agent status response format', () => {
    it('should use snake_case field names', async () => {
      const notebookPath = path.join(testDir, 'format-test.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await app.inject({
        method: 'GET',
        url: `/api/notebook/agent-status?path=${encodeURIComponent(notebookPath)}`,
      });
      const body = JSON.parse(response.body);

      // Verify snake_case
      expect(body).toHaveProperty('notebook_path');
      expect(body).toHaveProperty('agent_created');
      expect(body).toHaveProperty('agent_permitted');
      expect(body).toHaveProperty('has_history');
      expect(body).toHaveProperty('can_agent_modify');

      // Verify NO camelCase
      expect(body).not.toHaveProperty('notebookPath');
      expect(body).not.toHaveProperty('agentCreated');
      expect(body).not.toHaveProperty('agentPermitted');
      expect(body).not.toHaveProperty('hasHistory');
      expect(body).not.toHaveProperty('canAgentModify');
    });
  });

  describe('Permit agent response format', () => {
    it('should use snake_case field names', async () => {
      const notebookPath = path.join(testDir, 'permit-format.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {},
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await app.inject({
        method: 'POST',
        url: '/api/notebook/permit-agent',
        payload: { notebook_path: notebookPath, permitted: true },
      });
      const body = JSON.parse(response.body);

      expect(body).toHaveProperty('notebook_path');
      expect(body).toHaveProperty('agent_permitted');
      expect(body).toHaveProperty('agent_created');
      expect(body).toHaveProperty('has_history');
      expect(body).toHaveProperty('can_agent_modify');
    });
  });
});
