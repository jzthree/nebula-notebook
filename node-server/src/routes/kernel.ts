/**
 * Kernel API Routes
 */

import { Router, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { KernelService } from '../kernel/kernel-service';

const router = Router();
const kernelService = new KernelService();

// Initialize kernel service on module load
kernelService.initialize().catch(err => {
  console.error('Failed to initialize kernel service:', err);
});

/**
 * List available kernelspecs
 */
router.get('/kernels', (_req: Request, res: Response) => {
  const kernels = kernelService.getAvailableKernels();
  res.json({ kernels });
});

/**
 * List all active kernel sessions
 */
router.get('/kernels/sessions', (_req: Request, res: Response) => {
  const sessions = kernelService.getAllSessions();
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
    res.status(500).json({ error: message });
  }
});

/**
 * Get or create kernel for a notebook file
 */
router.post('/kernels/for-file', async (req: Request, res: Response) => {
  try {
    const { file_path, kernel_name = 'python3' } = req.body;
    if (!file_path) {
      res.status(400).json({ error: 'file_path is required' });
      return;
    }
    const sessionId = await kernelService.getOrCreateKernel(file_path, kernel_name);
    res.json({ session_id: sessionId, kernel_name, file_path });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Check if a kernel exists for a file
 */
router.get('/kernels/for-file', (req: Request, res: Response) => {
  const filePath = req.query.file_path as string;
  if (!filePath) {
    res.status(400).json({ error: 'file_path query parameter is required' });
    return;
  }
  // We don't have a direct method, so check sessions
  const sessions = kernelService.getAllSessions();
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
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
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
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
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
      res.status(404).json({ error: 'Session not found' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: message });
  }
});

/**
 * Get kernel session status
 */
router.get('/kernels/:sessionId/status', (req: Request, res: Response) => {
  const status = kernelService.getSessionStatus(req.params.sessionId);
  if (status) {
    res.json(status);
  } else {
    res.status(404).json({ error: 'Session not found' });
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
    console.log(`[Kernel WS] Connected for session ${sessionId}`);

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
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        console.error('[Kernel WS] Error:', message);
        ws.send(JSON.stringify({ type: 'error', error: message }));
      }
    });

    ws.on('close', () => {
      console.log(`[Kernel WS] Disconnected for session ${sessionId}`);
    });
  });
}

export { kernelService };
export default router;
