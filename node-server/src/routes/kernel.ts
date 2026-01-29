/**
 * Kernel API Routes
 */

import { Router, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { KernelService } from '../kernel/kernel-service';
import { getKernelSearchPaths } from '../kernel/kernelspec';

const router = Router();

// Shared kernel service instance - exported for use by headless handler
const kernelService = new KernelService();

// Initialize kernel service on module load
kernelService.initialize().catch(err => {
  console.error('Failed to initialize kernel service:', err);
});

/**
 * List available kernelspecs
 * Transforms to snake_case to match Python API format expected by frontend
 */
router.get('/kernels', (_req: Request, res: Response) => {
  const kernels = kernelService.getAvailableKernels().map(k => ({
    name: k.name,
    display_name: k.displayName,
    language: k.language,
    path: k.path,
  }));
  res.json({ kernels });
});

/**
 * Debug endpoint to show kernel discovery paths and environment
 */
router.get('/kernels/debug', (_req: Request, res: Response) => {
  const searchPaths = getKernelSearchPaths();

  // Check common kernel locations
  const commonPaths = [
    path.join(os.homedir(), '.local', 'share', 'jupyter', 'kernels'),
    '/usr/local/share/jupyter/kernels',
    '/usr/share/jupyter/kernels',
  ];

  const condaPrefix = process.env.CONDA_PREFIX;
  if (condaPrefix) {
    commonPaths.push(path.join(condaPrefix, 'share', 'jupyter', 'kernels'));
  }

  const pathStatus: Record<string, { exists: boolean; kernels?: string[]; error?: string }> = {};

  for (const p of commonPaths) {
    if (fs.existsSync(p)) {
      try {
        const entries = fs.readdirSync(p, { withFileTypes: true });
        const kernels = entries
          .filter(e => e.isDirectory() && fs.existsSync(path.join(p, e.name, 'kernel.json')))
          .map(e => e.name);
        pathStatus[p] = { exists: true, kernels };
      } catch (err) {
        pathStatus[p] = { exists: true, error: String(err) };
      }
    } else {
      pathStatus[p] = { exists: false };
    }
  }

  res.json({
    node_executable: process.execPath,
    jupyter_data_paths: searchPaths,
    common_paths: pathStatus,
    env: {
      JUPYTER_PATH: process.env.JUPYTER_PATH || '(not set)',
      CONDA_PREFIX: process.env.CONDA_PREFIX || '(not set)',
      HOME: process.env.HOME || '(not set)',
    },
    discovered_kernels: kernelService.getAvailableKernels().map(k => ({
      name: k.name,
      display_name: k.displayName,
      language: k.language,
      path: k.path,
    })),
  });
});

/**
 * List all active kernel sessions
 * Transforms to snake_case to match Python API format expected by frontend
 */
router.get('/kernels/sessions', async (_req: Request, res: Response) => {
  const allSessions = await kernelService.getAllSessions();
  const sessions = allSessions.map(s => ({
    id: s.id,
    kernel_name: s.kernelName,
    file_path: s.filePath,
    status: s.status,
    execution_count: s.executionCount,
    memory_mb: s.memoryMb,
    pid: s.pid,
  }));
  res.json({ sessions });
});

/**
 * Start a new kernel session
 */
router.post('/kernels/start', async (req: Request, res: Response) => {
  try {
    const { kernel_name = 'python3', cwd, file_path } = req.body;
    const sessionId = await kernelService.startKernel({
      kernelName: kernel_name,
      cwd,
      filePath: file_path,
    });
    res.json({ session_id: sessionId, kernel_name });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Get or create kernel for a notebook file
 */
router.post('/kernels/for-file', async (req: Request, res: Response) => {
  try {
    const { file_path, kernel_name = 'python3' } = req.body;
    if (!file_path) {
      res.status(400).json({ detail: 'file_path is required' });
      return;
    }
    const sessionId = await kernelService.getOrCreateKernel(file_path, kernel_name);
    res.json({ session_id: sessionId, kernel_name, file_path });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Check if a kernel exists for a file
 */
router.get('/kernels/for-file', async (req: Request, res: Response) => {
  const filePath = req.query.file_path as string;
  if (!filePath) {
    res.status(400).json({ detail: 'file_path query parameter is required' });
    return;
  }
  // We don't have a direct method, so check sessions
  const sessions = await kernelService.getAllSessions();
  const session = sessions.find(s => s.filePath === filePath);
  if (session) {
    res.json({ session_id: session.id, exists: true });
  } else {
    res.json({ session_id: null, exists: false });
  }
});

/**
 * Stop a kernel session
 */
router.delete('/kernels/:sessionId', async (req: Request, res: Response) => {
  try {
    const success = await kernelService.stopKernel(req.params.sessionId);
    if (success) {
      res.json({ status: 'ok' });
    } else {
      res.status(404).json({ detail: 'Session not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Interrupt kernel execution
 */
router.post('/kernels/:sessionId/interrupt', async (req: Request, res: Response) => {
  try {
    const success = await kernelService.interruptKernel(req.params.sessionId);
    if (success) {
      res.json({ status: 'ok' });
    } else {
      res.status(404).json({ detail: 'Session not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Restart a kernel
 */
router.post('/kernels/:sessionId/restart', async (req: Request, res: Response) => {
  try {
    const success = await kernelService.restartKernel(req.params.sessionId);
    if (success) {
      res.json({ status: 'ok' });
    } else {
      res.status(404).json({ detail: 'Session not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Get kernel session status
 */
router.get('/kernels/:sessionId/status', async (req: Request, res: Response) => {
  const status = await kernelService.getSessionStatus(req.params.sessionId);
  if (status) {
    // Convert to snake_case for frontend compatibility
    res.json({
      id: status.id,
      kernel_name: status.kernelName,
      file_path: status.filePath,
      status: status.status,
      execution_count: status.executionCount,
      memory_mb: status.memoryMb,
      pid: status.pid,
    });
  } else {
    res.status(404).json({ detail: 'Session not found' });
  }
});

/**
 * Setup WebSocket handler for kernel execution
 */
export function setupKernelWebSocket(wss: WebSocketServer): void {
  wss.on('connection', async (ws: WebSocket, req) => {
    // Extract session ID from URL path: /api/kernels/{sessionId}/ws
    const url = req.url || '';
    const match = url.match(/\/api\/kernels\/([^/]+)\/ws/);
    if (!match) {
      ws.close(1008, 'Invalid path');
      return;
    }

    const sessionId = match[1];

    // Validate session exists
    const session = await kernelService.getSessionStatus(sessionId);
    if (!session) {
      console.log(`[Kernel WS] Session ${sessionId} not found, closing connection`);
      ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
      ws.close(1008, 'Session not found');
      return;
    }

    console.log(`[Kernel WS] Connected for session ${sessionId} (kernel: ${session.kernelName}, status: ${session.status})`);

    // Send initial status so frontend knows the kernel state immediately
    ws.send(JSON.stringify({ type: 'status', status: session.status }));

    ws.on('error', (err) => {
      console.error(`[Kernel WS] WebSocket error for session ${sessionId}:`, err);
    });

    ws.on('message', async (data) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'execute') {
          const code = message.code || '';

          // Send busy status
          ws.send(JSON.stringify({ type: 'status', status: 'busy' }));

          // Execute code with streaming output
          const result = await kernelService.executeCode(
            sessionId,
            code,
            async (output) => {
              ws.send(JSON.stringify({ type: 'output', output }));
            }
          );

          // Send result and idle status
          ws.send(JSON.stringify({ type: 'result', result }));
          ws.send(JSON.stringify({ type: 'status', status: 'idle' }));
        } else if (message.type === 'complete') {
          const code = message.code || '';
          const cursorPos = message.cursor_pos ?? code.length;

          const result = await kernelService.complete(sessionId, code, cursorPos);
          ws.send(JSON.stringify({ type: 'complete_reply', result }));
        }
      } catch (err) {
        const errMessage = err instanceof Error ? err.message : 'Unknown error';
        console.error('[Kernel WS] Error:', errMessage);
        ws.send(JSON.stringify({ type: 'error', error: errMessage }));
      }
    });

    ws.on('close', () => {
      console.log(`[Kernel WS] Disconnected for session ${sessionId}`);
    });
  });
}

export { kernelService };
export default router;
