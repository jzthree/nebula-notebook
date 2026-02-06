/**
 * Notebook API Routes
 */

import { Router, Request, Response } from 'express';
import { fsService } from '../fs/fs-service';
import { NebulaCell } from '../fs/types';
import { operationRouter } from '../notebook/operation-router';
import { HeadlessOperationHandler } from '../notebook/headless-handler';
import { kernelService } from './kernel';

const router = Router();
// Initialize headless handler with kernel service for cell execution
const headlessHandler = new HeadlessOperationHandler(fsService, operationRouter, kernelService);
operationRouter.setHeadlessHandler(headlessHandler);

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
router.get('/notebook/cells', async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
      return;
    }
    const result = await fsService.getNotebookCellsWithKernel(filePath);
    res.json({
      path: filePath,
      cells: result.cells,
      kernelspec: result.kernelspec,
      mtime: result.mtime,
    });
  } catch (err) {
    if (err instanceof Error && err.message.includes('not found')) {
      res.status(404).json({ detail: err.message });
    } else {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
  }
});

/**
 * Save notebook cells
 */
router.post('/notebook/save', async (req: Request, res: Response) => {
  try {
    const { path: filePath, cells, kernel_name, history, session_id, kernel_output_seq } = req.body;
    if (!filePath) {
      res.status(400).json({ detail: 'path is required' });
      return;
    }
    if (!cells) {
      res.status(400).json({ detail: 'cells is required' });
      return;
    }

    const result = await fsService.saveNotebookBundle(
      filePath,
      cells as NebulaCell[],
      kernel_name,
      history
    );

    // Prune kernel output buffer only after a successful atomic save.
    // This prevents losing output on UI refresh/disconnect before persistence.
    const sessionId = typeof session_id === 'string'
      ? session_id
      : kernelService.getSessionIdForFile(filePath);
    const seq = Number(kernel_output_seq);
    if (sessionId && Number.isFinite(seq) && seq > 0) {
      const { latestSeq } = kernelService.getBufferedOutputs(sessionId, 0);
      kernelService.ackOutputs(sessionId, Math.min(seq, latestSeq));
    }

    res.json({ status: 'ok', path: filePath, mtime: result.mtime });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Load operation history for a notebook
 */
router.get('/notebook/history', (req: Request, res: Response) => {
  try {
    const notebookPath = req.query.notebook_path as string;
    if (!notebookPath) {
      res.status(400).json({ detail: 'notebook_path query parameter is required' });
      return;
    }
    const history = fsService.loadHistory(notebookPath);
    res.json({ notebook_path: notebookPath, history });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Save operation history for a notebook
 */
router.post('/notebook/history', async (req: Request, res: Response) => {
  try {
    const { notebook_path, history } = req.body;
    if (!notebook_path) {
      res.status(400).json({ detail: 'notebook_path is required' });
      return;
    }
    await fsService.saveHistory(notebook_path, history || []);
    res.json({ status: 'ok', notebook_path });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Load session state for a notebook
 */
router.get('/notebook/session', (req: Request, res: Response) => {
  try {
    const notebookPath = req.query.notebook_path as string;
    if (!notebookPath) {
      res.status(400).json({ detail: 'notebook_path query parameter is required' });
      return;
    }
    const session = fsService.loadSession(notebookPath);
    res.json({ notebook_path: notebookPath, session });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Save session state for a notebook
 */
router.post('/notebook/session', async (req: Request, res: Response) => {
  try {
    const { notebook_path, session } = req.body;
    if (!notebook_path) {
      res.status(400).json({ detail: 'notebook_path is required' });
      return;
    }
    await fsService.saveSession(notebook_path, session || {});
    res.json({ status: 'ok', notebook_path });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Grant or revoke agent permission to modify a notebook
 */
router.post('/notebook/permit-agent', (req: Request, res: Response) => {
  try {
    const { notebook_path, permitted = true } = req.body;
    if (!notebook_path) {
      res.status(400).json({ detail: 'notebook_path is required' });
      return;
    }

    const result = fsService.updateNotebookMetadata(notebook_path, {
      nebula: { agent_permitted: permitted },
    });

    if (!result.success) {
      res.status(400).json({ detail: result.error || 'Failed to update notebook' });
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
    res.status(500).json({ detail: message });
  }
});

/**
 * Get agent permission status for a notebook
 */
router.get('/notebook/agent-status', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
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
    res.status(500).json({ detail: message });
  }
});

/**
 * Read notebook via operation router
 *
 * Supports output truncation for large outputs.
 * When include_outputs=true (default), outputs are truncated with defaults.
 *
 * Uses operation router to get live state from UI if connected,
 * otherwise reads from file.
 */
router.get('/notebook/read', async (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
      return;
    }

    const includeOutputs = req.query.include_outputs !== 'false';
    const maxLines = req.query.max_lines ? parseInt(req.query.max_lines as string, 10) : undefined;
    const maxChars = req.query.max_chars ? parseInt(req.query.max_chars as string, 10) : undefined;
    const maxLinesError = req.query.max_lines_error ? parseInt(req.query.max_lines_error as string, 10) : undefined;
    const maxCharsError = req.query.max_chars_error ? parseInt(req.query.max_chars_error as string, 10) : undefined;

    // Use operation router to get state from UI if connected, otherwise from file
    const result = await operationRouter.readNotebook(
      filePath,
      includeOutputs,
      maxLines,
      maxChars,
      maxLinesError,
      maxCharsError
    );

    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.json({ success: false, error: message });
  }
});

/**
 * Check if UI is connected for a notebook
 */
router.get('/notebook/has-ui', (req: Request, res: Response) => {
  const filePath = req.query.path as string;
  if (!filePath) {
    res.status(400).json({ detail: 'path query parameter is required' });
    return;
  }
  const hasUI = operationRouter.hasUI(filePath);
  res.json({ hasUI, path: filePath });
});

/**
 * Apply a notebook operation
 *
 * Routes to UI if connected, otherwise uses headless handler.
 */
router.post('/notebook/operation', async (req: Request, res: Response) => {
  try {
    // Python uses {operation: {...}} wrapper via NotebookOperationRequest model
    const operation = req.body.operation || req.body;
    if (!operation || !operation.type) {
      res.status(400).json({ detail: 'Operation with type is required' });
      return;
    }

    const result = await operationRouter.applyOperation(operation);
    res.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.json({ success: false, error: message });
  }
});

/**
 * Get notebook settings (nebula metadata)
 */
router.get('/notebook/settings', (req: Request, res: Response) => {
  try {
    const filePath = req.query.path as string;
    if (!filePath) {
      res.status(400).json({ detail: 'path query parameter is required' });
      return;
    }

    const metadata = fsService.getNotebookMetadata(filePath);
    const nebula = (metadata.nebula || {}) as Record<string, unknown>;

    res.json({
      notebook_path: filePath,
      output_logging: nebula.output_logging || 'minimal',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Update notebook settings (nebula metadata)
 */
router.post('/notebook/settings', (req: Request, res: Response) => {
  try {
    const { path: filePath, output_logging } = req.body;
    if (!filePath) {
      res.status(400).json({ detail: 'path is required' });
      return;
    }

    // Validate output_logging value
    if (output_logging !== undefined && output_logging !== 'minimal' && output_logging !== 'full') {
      res.status(400).json({ detail: 'output_logging must be "minimal" or "full"' });
      return;
    }

    // Get existing metadata
    const metadata = fsService.getNotebookMetadata(filePath);
    const nebula = (metadata.nebula || {}) as Record<string, unknown>;

    // Update settings
    if (output_logging !== undefined) {
      nebula.output_logging = output_logging;
    }

    // Save back
    const updateResult = fsService.updateNotebookMetadata(filePath, { nebula });
    if (!updateResult.success) {
      res.status(500).json({ detail: updateResult.error || 'Failed to update notebook metadata' });
      return;
    }

    res.json({
      status: 'ok',
      notebook_path: filePath,
      output_logging: nebula.output_logging || 'minimal',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

export { fsService, operationRouter, headlessHandler };
export default router;
