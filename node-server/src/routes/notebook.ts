/**
 * Notebook API Routes
 */

import { Router, Request, Response } from 'express';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell } from '../fs/types';

const router = Router();
const fsService = new FilesystemService();

/**
 * Get cell metadata schema
 */
router.get('/cell/metadata-schema', (_req: Request, res: Response) => {
  res.json({
    id: {
      type: 'string',
      description: 'Unique cell identifier. Agent-created cells should use human-readable IDs.',
      agentMutable: true,
    },
    type: {
      type: 'enum',
      values: ['code', 'markdown'],
      description: 'Cell type: code for executable cells, markdown for documentation.',
      agentMutable: true,
    },
    scrolled: {
      type: 'boolean',
      description: 'Whether cell output is collapsed (Jupyter standard).',
      agentMutable: true,
      default: false,
    },
    scrolledHeight: {
      type: 'number',
      description: 'Height in pixels when output is collapsed.',
      agentMutable: true,
    },
  });
});

/**
 * Get notebook cells in internal format
 */
router.get('/notebook/cells', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }
    const result = fsService.getNotebookCells(filePath);
    res.json({
      path: filePath,
      cells: result.cells,
      kernelspec: result.kernelspec,
      mtime: result.mtime,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ error: err.message });
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }
});

/**
 * Save notebook cells
 */
router.post('/notebook/save', (req: Request, res: Response) => {
  try {
    const { path: filePath, cells, kernel_name, history } = req.body;
    if (!filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    if (!cells) {
      res.status(400).json({ error: 'cells is required' });
      return;
    }

    const result = fsService.saveNotebookCells(filePath, cells as NebulaCell[], kernel_name);

    // Save history if provided
    if (history) {
      fsService.saveHistory(filePath, history);
    }

    res.json({ status: 'ok', path: filePath, mtime: result.mtime });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Load operation history for a notebook
 */
router.get('/notebook/history', (req: Request, res: Response) => {
  try {
    const notebookPath = req.query.notebook_path as string;
    if (!notebookPath) {
      res.status(400).json({ error: 'notebook_path query parameter is required' });
      return;
    }
    const history = fsService.loadHistory(notebookPath);
    res.json({ notebook_path: notebookPath, history });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Save operation history for a notebook
 */
router.post('/notebook/history', (req: Request, res: Response) => {
  try {
    const { notebook_path, history } = req.body;
    if (!notebook_path) {
      res.status(400).json({ error: 'notebook_path is required' });
      return;
    }
    fsService.saveHistory(notebook_path, history || []);
    res.json({ status: 'ok', notebook_path });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Load session state for a notebook
 */
router.get('/notebook/session', (req: Request, res: Response) => {
  try {
    const notebookPath = req.query.notebook_path as string;
    if (!notebookPath) {
      res.status(400).json({ error: 'notebook_path query parameter is required' });
      return;
    }
    const session = fsService.loadSession(notebookPath);
    res.json({ notebook_path: notebookPath, session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Save session state for a notebook
 */
router.post('/notebook/session', (req: Request, res: Response) => {
  try {
    const { notebook_path, session } = req.body;
    if (!notebook_path) {
      res.status(400).json({ error: 'notebook_path is required' });
      return;
    }
    fsService.saveSession(notebook_path, session || {});
    res.json({ status: 'ok', notebook_path });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Grant or revoke agent permission to modify a notebook
 */
router.post('/notebook/permit-agent', (req: Request, res: Response) => {
  try {
    const { notebook_path, permitted = true } = req.body;
    if (!notebook_path) {
      res.status(400).json({ error: 'notebook_path is required' });
      return;
    }

    const result = fsService.updateNotebookMetadata(notebook_path, {
      nebula: { agent_permitted: permitted },
    });

    if (!result.success) {
      res.status(400).json({ error: result.error || 'Failed to update notebook' });
      return;
    }

    // Return current permission status
    const metadata = fsService.getNotebookMetadata(notebook_path);
    const nebula = (metadata.nebula || {}) as Record<string, unknown>;
    const hasHistory = fsService.hasHistory(notebook_path);

    res.json({
      status: 'ok',
      notebook_path,
      agent_permitted: nebula.agent_permitted || false,
      agent_created: nebula.agent_created || false,
      has_history: hasHistory,
      can_agent_modify: nebula.agent_created || (nebula.agent_permitted && hasHistory),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Get agent permission status for a notebook
 */
router.get('/notebook/agent-status', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const metadata = fsService.getNotebookMetadata(filePath);
    const nebula = (metadata.nebula || {}) as Record<string, unknown>;
    const hasHistory = fsService.hasHistory(filePath);

    const agentCreated = nebula.agent_created || false;
    const agentPermitted = nebula.agent_permitted || false;
    const canModify = agentCreated || (agentPermitted && hasHistory);

    res.json({
      notebook_path: filePath,
      agent_created: agentCreated,
      agent_permitted: agentPermitted,
      has_history: hasHistory,
      can_agent_modify: canModify,
      reason: agentCreated
        ? 'Agent created this notebook'
        : canModify
          ? 'User permitted and history enabled'
          : agentPermitted
            ? 'User permitted but history not enabled'
            : 'Not permitted for agent modifications',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Read notebook via operation router (simplified version - just reads from file)
 */
router.get('/notebook/read', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ error: 'path query parameter is required' });
      return;
    }

    const result = fsService.getNotebookCells(filePath);
    res.json({
      success: true,
      cells: result.cells,
      kernelspec: result.kernelspec,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.json({ success: false, error: message });
  }
});

/**
 * Check if UI is connected for a notebook (stub - always false for now)
 */
router.get('/notebook/has-ui', (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  // In the Python version, this checks if a WebSocket is connected
  // For now, we'll return false
  res.json({ hasUI: false, path: filePath });
});

export { fsService };
export default router;
