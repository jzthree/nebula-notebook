// @vitest-environment node
/**
 * Error Format Tests
 *
 * Tests to verify that HTTP error responses use the 'detail' field
 * to match FastAPI's HTTPException format.
 *
 * This is critical for frontend compatibility since the frontend
 * expects error.detail for error messages.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from 'vitest';
import express, { Express } from 'express';
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Server } from 'http';

// Import routes
import kernelRoutes from '../routes/kernel';
import fsRoutes from '../routes/fs';
import notebookRoutes from '../routes/notebook';
import pythonRoutes from '../routes/python';
import llmRoutes from '../routes/llm';

describe('Error Format - FastAPI Parity', () => {
  let app: Express;
  let server: Server;
  let testDir: string;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', kernelRoutes);
    app.use('/api', fsRoutes);
    app.use('/api', notebookRoutes);
    app.use('/api', pythonRoutes);
    app.use('/api', llmRoutes);
    server = app.listen(0);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'error-format-test-'));
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Kernel Routes Error Format', () => {
    it('should use detail field for missing file_path in /api/kernels/for-file', async () => {
      const response = await request(server)
        .post('/api/kernels/for-file')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing file_path query param', async () => {
      const response = await request(server).get('/api/kernels/for-file');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing file_path in /api/kernels/preference', async () => {
      const response = await request(server).get('/api/kernels/preference');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for non-existent session', async () => {
      const response = await request(server).delete('/api/kernels/non-existent-session');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for interrupt on non-existent session', async () => {
      const response = await request(server).post('/api/kernels/non-existent/interrupt');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for restart on non-existent session', async () => {
      const response = await request(server).post('/api/kernels/non-existent/restart');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for status on non-existent session', async () => {
      const response = await request(server).get('/api/kernels/non-existent/status');

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });
  });

  describe('Filesystem Routes Error Format', () => {
    it('should use detail field for non-existent directory', async () => {
      const response = await request(server)
        .get('/api/fs/list')
        .query({ path: '/non/existent/path/that/does/not/exist' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for non-existent file mtime', async () => {
      const response = await request(server)
        .get('/api/fs/mtime')
        .query({ path: '/non/existent/path' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in file-mtime', async () => {
      const response = await request(server).get('/api/fs/file-mtime');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for non-existent file read', async () => {
      const response = await request(server)
        .get('/api/fs/read')
        .query({ path: '/non/existent/file.txt' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in read', async () => {
      const response = await request(server).get('/api/fs/read');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in write', async () => {
      const response = await request(server)
        .post('/api/fs/write')
        .send({ content: 'test' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in create', async () => {
      const response = await request(server)
        .post('/api/fs/create')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    }, 15000);

    it('should use detail field for file already exists in create', async () => {
      const existingFile = path.join(testDir, 'existing.txt');
      fs.writeFileSync(existingFile, 'content');

      const response = await request(server)
        .post('/api/fs/create')
        .send({ path: existingFile });

      expect(response.status).toBe(409);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in delete', async () => {
      const response = await request(server).delete('/api/fs/delete');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for non-existent file delete', async () => {
      const response = await request(server)
        .delete('/api/fs/delete')
        .query({ path: '/non/existent/file.txt' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing paths in rename', async () => {
      const response = await request(server)
        .post('/api/fs/rename')
        .send({ old_path: '/some/path' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in duplicate', async () => {
      const response = await request(server)
        .post('/api/fs/duplicate')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in upload', async () => {
      const response = await request(server)
        .post('/api/fs/upload')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });
  });

  describe('Notebook Routes Error Format', () => {
    it('should use detail field for missing path in /api/notebook/cells', async () => {
      const response = await request(server).get('/api/notebook/cells');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for non-existent notebook in /api/notebook/cells', async () => {
      const response = await request(server)
        .get('/api/notebook/cells')
        .query({ path: '/non/existent/notebook.ipynb' });

      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in /api/notebook/save', async () => {
      const response = await request(server)
        .post('/api/notebook/save')
        .send({ cells: [] });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing cells in /api/notebook/save', async () => {
      const response = await request(server)
        .post('/api/notebook/save')
        .send({ path: '/some/path.ipynb' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing notebook_path in /api/notebook/history', async () => {
      const response = await request(server).get('/api/notebook/history');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing notebook_path in POST /api/notebook/history', async () => {
      const response = await request(server)
        .post('/api/notebook/history')
        .send({ history: [] });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing notebook_path in /api/notebook/session', async () => {
      const response = await request(server).get('/api/notebook/session');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing notebook_path in POST /api/notebook/session', async () => {
      const response = await request(server)
        .post('/api/notebook/session')
        .send({ session: {} });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing notebook_path in /api/notebook/permit-agent', async () => {
      const response = await request(server)
        .post('/api/notebook/permit-agent')
        .send({ permitted: true });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in /api/notebook/agent-status', async () => {
      const response = await request(server).get('/api/notebook/agent-status');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in /api/notebook/read', async () => {
      const response = await request(server).get('/api/notebook/read');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing path in /api/notebook/has-ui', async () => {
      const response = await request(server).get('/api/notebook/has-ui');

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });

    it('should use detail field for missing operation type', async () => {
      const response = await request(server)
        .post('/api/notebook/operation')
        .send({ notebookPath: '/some/path.ipynb' });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });
  });

  describe('Python Routes Error Format', () => {
    it('should use detail field for missing python_path in install-kernel', async () => {
      const response = await request(server)
        .post('/api/python/install-kernel')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('detail');
      expect(response.body).not.toHaveProperty('error');
    });
  });

  describe('Error Field Contents', () => {
    it('should have descriptive error messages in detail field', async () => {
      const response = await request(server).get('/api/notebook/cells');

      expect(response.status).toBe(400);
      expect(response.body.detail).toBeTruthy();
      expect(typeof response.body.detail).toBe('string');
      expect(response.body.detail.length).toBeGreaterThan(0);
    });

    it('should include relevant context in error messages', async () => {
      const response = await request(server)
        .get('/api/notebook/cells')
        .query({ path: '/non/existent/notebook.ipynb' });

      expect(response.status).toBe(404);
      expect(response.body.detail).toContain('not found');
    });
  });
});

describe('Operation Result Error Format', () => {
  let app: Express;
  let server: Server;
  let testDir: string;

  beforeAll(() => {
    app = express();
    app.use(express.json());
    app.use('/api', notebookRoutes);
    server = app.listen(0);
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'op-error-test-'));
  });

  afterEach(() => {
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Operation Result Error Format (200 status)', () => {
    it('should use error field in operation results (not detail)', async () => {
      // Operation results with success: false use 'error' field (not 'detail')
      // This is different from HTTP error responses
      const notebookPath = path.join(testDir, 'not-permitted.ipynb');
      fs.writeFileSync(notebookPath, JSON.stringify({
        cells: [],
        metadata: {}, // No agent_created or agent_permitted
        nbformat: 4,
        nbformat_minor: 5,
      }));

      const response = await request(server)
        .post('/api/notebook/operation')
        .send({
          type: 'insertCell',
          notebookPath,
          position: 0,
          cellId: 'new-cell',
          cellType: 'code',
          content: 'x=1',
        });

      // Operation results are 200 OK with success: false in body
      expect(response.status).toBe(200);
      expect(response.body.success).toBe(false);
      expect(response.body).toHaveProperty('error'); // Operations use 'error'
      expect(response.body).not.toHaveProperty('detail'); // Not 'detail'
    });
  });
});
