/**
 * Notebook Routes Tests
 *
 * Tests for all /api/notebook/* endpoints to ensure functional parity
 * with the Python backend.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import routes
import notebookRoutes from '../routes/notebook';

describe('Notebook Routes', () => {
  let app: Express;
  let testDir: string;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', notebookRoutes);
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
      const response = await request(app).get('/api/cell/metadata-schema');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('id');
      expect(response.body).toHaveProperty('type');
      expect(response.body).toHaveProperty('scrolled');
      expect(response.body).toHaveProperty('scrolledHeight');
    });

    it('should have agentMutable property on all fields', async () => {
      const response = await request(app).get('/api/cell/metadata-schema');

      expect(response.body.id.agentMutable).toBe(true);
      expect(response.body.type.agentMutable).toBe(true);
      expect(response.body.scrolled.agentMutable).toBe(true);
      expect(response.body.scrolledHeight.agentMutable).toBe(true);
    });

    it('should have correct type definitions', async () => {
      const response = await request(app).get('/api/cell/metadata-schema');

      expect(response.body.id.type).toBe('string');
      expect(response.body.type.type).toBe('enum');
      expect(response.body.type.values).toEqual(['code', 'markdown']);
      expect(response.body.scrolled.type).toBe('boolean');
      expect(response.body.scrolledHeight.type).toBe('number');
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
        metadata: { kernelspec: { name: 'python3', display_name: 'Python 3' } },
        nbformat: 4,
        nbformat_minor: 5,
      };
      fs.writeFileSync(notebookPath, JSON.stringify(notebook));

      const response = await request(app)
        .get('/api/notebook/cells')
        .query({ path: notebookPath });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('cells');
      expect(response.body).toHaveProperty('kernelspec');
      expect(response.body).toHaveProperty('mtime');
      expect(Array.isArray(response.body.cells)).toBe(true);
    });

    it('should return 400 if path is missing', async () => {
      const response = await request(app).get('/api/notebook/cells');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
    });

    it('should return 404 for non-existent notebook', async () => {
      const response = await request(app)
        .get('/api/notebook/cells')
        .query({ path: '/nonexistent/path.ipynb' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .post('/api/notebook/save')
        .send({ path: notebookPath, cells, kernel_name: 'python3' });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('path');
      expect(response.body).toHaveProperty('mtime');
    });

    it('should return 400 if path is missing', async () => {
      const response = await request(app)
        .post('/api/notebook/save')
        .send({ cells: [] });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
    });

    it('should return 400 if cells is missing', async () => {
      const response = await request(app)
        .post('/api/notebook/save')
        .send({ path: '/some/path.ipynb' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .get('/api/notebook/history')
        .query({ notebook_path: notebookPath });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('notebook_path');
      expect(response.body).toHaveProperty('history');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await request(app).get('/api/notebook/history');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .post('/api/notebook/history')
        .send({ notebook_path: notebookPath, history });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('notebook_path');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await request(app)
        .post('/api/notebook/history')
        .send({ history: [] });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .get('/api/notebook/session')
        .query({ notebook_path: notebookPath });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('notebook_path');
      expect(response.body).toHaveProperty('session');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await request(app).get('/api/notebook/session');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .post('/api/notebook/session')
        .send({ notebook_path: notebookPath, session });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('notebook_path');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await request(app)
        .post('/api/notebook/session')
        .send({ session: {} });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .post('/api/notebook/permit-agent')
        .send({ notebook_path: notebookPath, permitted: true });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('status', 'ok');
      expect(response.body).toHaveProperty('notebook_path');
      expect(response.body).toHaveProperty('agent_permitted');
      expect(response.body).toHaveProperty('agent_created');
      expect(response.body).toHaveProperty('has_history');
      expect(response.body).toHaveProperty('can_agent_modify');
    });

    it('should return 400 if notebook_path is missing', async () => {
      const response = await request(app)
        .post('/api/notebook/permit-agent')
        .send({ permitted: true });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .get('/api/notebook/agent-status')
        .query({ path: notebookPath });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('notebook_path');
      expect(response.body).toHaveProperty('agent_created');
      expect(response.body).toHaveProperty('agent_permitted');
      expect(response.body).toHaveProperty('has_history');
      expect(response.body).toHaveProperty('can_agent_modify');
      expect(response.body).toHaveProperty('reason');
    });

    it('should return 400 if path is missing', async () => {
      const response = await request(app).get('/api/notebook/agent-status');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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

      const response = await request(app)
        .get('/api/notebook/read')
        .query({ path: notebookPath });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(response.body).toHaveProperty('data');
      expect(response.body.data).toHaveProperty('cells');
      expect(response.body.data).toHaveProperty('path');
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

      const response = await request(app)
        .get('/api/notebook/read')
        .query({ path: notebookPath, include_outputs: 'false' });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data.cells[0].outputs).toEqual([]);
    });

    it('should return 400 if path is missing', async () => {
      const response = await request(app).get('/api/notebook/read');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
    });
  });

  describe('GET /api/notebook/has-ui', () => {
    it('should return hasUI status', async () => {
      const notebookPath = path.join(testDir, 'has-ui.ipynb');

      const response = await request(app)
        .get('/api/notebook/has-ui')
        .query({ path: notebookPath });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('hasUI');
      expect(response.body).toHaveProperty('path');
      expect(response.body.hasUI).toBe(false); // No UI connected in tests
    });

    it('should return 400 if path is missing', async () => {
      const response = await request(app).get('/api/notebook/has-ui');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
    });
  });

  describe('POST /api/notebook/operation', () => {
    it('should return 400 if operation type is missing', async () => {
      const response = await request(app)
        .post('/api/notebook/operation')
        .send({ notebookPath: '/some/path.ipynb' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
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
      await request(app)
        .post('/api/notebook/operation')
        .send({
          type: 'startAgentSession',
          notebookPath,
          agentId,
        });

      const response = await request(app)
        .post('/api/notebook/operation')
        .send({
          type: 'insertCell',
          notebookPath,
          agentId,
          index: 0,
          cell: { id: 'new-cell', type: 'code', content: 'print("hello")' },
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
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
      await request(app)
        .post('/api/notebook/operation')
        .send({
          type: 'startAgentSession',
          notebookPath,
          agentId,
        });

      const response = await request(app)
        .post('/api/notebook/operation')
        .send({
          type: 'deleteCell',
          notebookPath,
          agentId,
          cellId: 'cell-to-delete',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
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
      await request(app)
        .post('/api/notebook/operation')
        .send({
          type: 'startAgentSession',
          notebookPath,
          agentId,
        });

      const response = await request(app)
        .post('/api/notebook/operation')
        .send({
          type: 'updateContent',
          notebookPath,
          agentId,
          cellId: 'cell-1',
          content: 'new content',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
    });
  });
});

describe('Notebook Routes - Response Format Parity', () => {
  let app: Express;
  let testDir: string;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', notebookRoutes);
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

      const response = await request(app)
        .get('/api/notebook/agent-status')
        .query({ path: notebookPath });

      // Verify snake_case
      expect(response.body).toHaveProperty('notebook_path');
      expect(response.body).toHaveProperty('agent_created');
      expect(response.body).toHaveProperty('agent_permitted');
      expect(response.body).toHaveProperty('has_history');
      expect(response.body).toHaveProperty('can_agent_modify');

      // Verify NO camelCase
      expect(response.body).not.toHaveProperty('notebookPath');
      expect(response.body).not.toHaveProperty('agentCreated');
      expect(response.body).not.toHaveProperty('agentPermitted');
      expect(response.body).not.toHaveProperty('hasHistory');
      expect(response.body).not.toHaveProperty('canAgentModify');
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

      const response = await request(app)
        .post('/api/notebook/permit-agent')
        .send({ notebook_path: notebookPath, permitted: true });

      expect(response.body).toHaveProperty('notebook_path');
      expect(response.body).toHaveProperty('agent_permitted');
      expect(response.body).toHaveProperty('agent_created');
      expect(response.body).toHaveProperty('has_history');
      expect(response.body).toHaveProperty('can_agent_modify');
    });
  });
});
