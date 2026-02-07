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
import { fsService } from '../fs/fs-service';
import { operationRouter } from '../notebook/operation-router';
import {
  isProxiedSession,
  parseSessionId,
  startRemoteKernel,
  interruptRemoteKernel,
  restartRemoteKernel,
  shutdownRemoteKernel,
  getRemoteKernelStatus,
  getRemoteKernels,
  getRemoteKernelSessions,
  getRemoteDeadKernelSessions,
  cleanupRemoteDeadKernelSessions,
  createProxiedSessionId,
  createWebSocketProxy,
} from '../cluster/kernel-proxy';
import { serverRegistry } from '../cluster/server-registry';

const router = Router();

// Track all WebSocket connections per kernel session for broadcasting
const sessionWebSockets: Map<string, Set<WebSocket>> = new Map();
// Only send streaming outputs to sockets after they've performed an initial output sync.
// This prevents a race where live `output` messages arrive before `sync_outputs`, causing
// the frontend to advance its seq watermark and skip replayed outputs on refresh/reconnect.
const outputSubscribedSockets: WeakSet<WebSocket> = new WeakSet();

type OutputDrainState = { timer: NodeJS.Timeout | null; running: boolean };
const outputDrain: Map<string, OutputDrainState> = new Map();

// Delay before starting persistence after UI disappears (prevents thrash on quick refresh/reconnect).
// NOTE: This is intentionally long because a browser refresh can easily take a few seconds
// to reload JS + reconnect websockets. Writing outputs to the notebook file during that
// window causes spurious mtime conflicts and can force the UI to reload.
const OUTPUT_DRAIN_GRACE_MS = 15000;
// While running, persist at most once per interval.
const OUTPUT_DRAIN_INTERVAL_MS = 1000;
// Cap outputs per persistence batch to avoid huge writes for very chatty cells.
const OUTPUT_DRAIN_MAX_BATCH = 200;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function hasKernelClients(sessionId: string): boolean {
  const sockets = sessionWebSockets.get(sessionId);
  if (!sockets || sockets.size === 0) return false;
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN) return true;
  }
  return false;
}

// Shared kernel service instance - exported for use by headless handler
const kernelService = new KernelService();

// Initialize kernel service on module load
kernelService.initialize().catch(err => {
  console.error('Failed to initialize kernel service:', err);
});

async function persistBufferedOutputsIfNoUI(sessionId: string): Promise<number> {
  const notebookPath = kernelService.getSessionFilePath(sessionId);
  if (!notebookPath) return 0;
  if (operationRouter.hasUI(notebookPath)) return 0;
  if (hasKernelClients(sessionId)) return 0;

  const { outputs } = kernelService.getBufferedOutputs(sessionId, 0);
  if (outputs.length === 0) return 0;

  let ackSeq = 0;
  const kernelName = kernelService.getSessionKernelName(sessionId) || undefined;

  const { cells } = fsService.getNotebookCells(notebookPath);
  const byId = new Map(cells.map(c => [c.id, c]));

  let applied = 0;
  for (const entry of outputs) {
    if (applied >= OUTPUT_DRAIN_MAX_BATCH) break;
    const cellId = entry.cellId ?? null;
    if (!cellId) break;
    const cell = byId.get(cellId);
    if (!cell) break;
    cell.outputs.push({ type: entry.output.type, content: entry.output.content });
    ackSeq = entry.seq;
    applied += 1;
  }

  if (ackSeq === 0) return 0;

  // Re-check right before commit. The UI may have reconnected while we were preparing
  // the write, and in that case we prefer to leave output buffered for replay and let
  // the UI autosave, avoiding unnecessary file churn + conflicts.
  if (operationRouter.hasUI(notebookPath)) return 0;
  if (hasKernelClients(sessionId)) return 0;

  // Persist using the bundle API to get the write lock + atomic commit.
  await fsService.saveNotebookBundle(notebookPath, cells, kernelName);
  return ackSeq;
}

async function runOutputDrain(sessionId: string): Promise<void> {
  const state = outputDrain.get(sessionId);
  if (!state || state.running) return;

  state.running = true;
  try {
    while (true) {
      const notebookPath = kernelService.getSessionFilePath(sessionId);
      if (!notebookPath) break;
      if (operationRouter.hasUI(notebookPath)) break;
      if (hasKernelClients(sessionId)) break;

      let ackSeq = 0;
      try {
        ackSeq = await persistBufferedOutputsIfNoUI(sessionId);
      } catch (err) {
        console.warn(`[Kernel WS] Output drain persist failed for ${sessionId}:`, err);
      }

      if (ackSeq > 0) {
        kernelService.ackOutputs(sessionId, ackSeq);
      }

      const executingCellId = kernelService.getExecutingCellId(sessionId);
      const { outputs } = kernelService.getBufferedOutputs(sessionId, 0);
      if (outputs.length === 0 && executingCellId == null) {
        break;
      }

      await sleep(OUTPUT_DRAIN_INTERVAL_MS);
    }
  } finally {
    state.running = false;
    if (!state.timer) {
      outputDrain.delete(sessionId);
    }
  }
}

function scheduleOutputDrain(sessionId: string): void {
  const state = outputDrain.get(sessionId) || { timer: null, running: false };

  if (state.timer || state.running) {
    outputDrain.set(sessionId, state);
    return;
  }

  state.timer = setTimeout(() => {
    state.timer = null;
    void runOutputDrain(sessionId);
  }, OUTPUT_DRAIN_GRACE_MS);

  outputDrain.set(sessionId, state);
}

/**
 * List available kernelspecs
 * Transforms to snake_case to match Python API format expected by frontend
 */
router.get('/kernels', async (_req: Request, res: Response) => {
  const serverId = _req.query.server_id as string | undefined;
  const localServerId = serverRegistry.getLocalServerId();
  if (serverId && serverId !== localServerId && serverId !== 'local') {
    try {
      const data = await getRemoteKernels(serverId);
      res.json(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
    return;
  }

  const kernels = kernelService.getAvailableKernels().map(k => ({
    name: k.name,
    display_name: k.displayName,
    language: k.language,
    path: k.path,
    python_path: k.argv?.[0] || null, // First element of argv is typically the Python executable
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
  const serverId = _req.query.server_id as string | undefined;
  const localServerId = serverRegistry.getLocalServerId();
  if (serverId && serverId !== localServerId && serverId !== 'local') {
    try {
      const data = await getRemoteKernelSessions(serverId);
      const sessions = (data.sessions || []).map((session: any) => ({
        ...session,
        id: createProxiedSessionId(serverId, session.id),
      }));
      res.json({ sessions });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
    return;
  }

  const allSessions = await kernelService.getAllSessions();
  const sessions = allSessions.map(s => ({
    id: s.id,
    kernel_name: s.kernelName,
    file_path: s.filePath,
    status: s.status,
    execution_count: s.executionCount,
    memory_mb: s.memoryMb,
    pid: s.pid,
    created_at: s.createdAt,
  }));
  res.json({ sessions });
});

/**
 * Get dead (orphaned/terminated) kernel sessions that can be cleaned up
 * These are sessions from previous server runs that failed to reattach
 */
router.get('/kernels/dead', (_req: Request, res: Response) => {
  const serverId = _req.query.server_id as string | undefined;
  const localServerId = serverRegistry.getLocalServerId();
  if (serverId && serverId !== localServerId && serverId !== 'local') {
    getRemoteDeadKernelSessions(serverId)
      .then(data => res.json(data))
      .catch(err => {
        const message = err instanceof Error ? err.message : 'Unknown error';
        res.status(500).json({ detail: message });
      });
    return;
  }

  const deadSessions = kernelService.getDeadSessions();
  const sessions = deadSessions.map(s => ({
    session_id: s.sessionId,
    kernel_name: s.kernelName,
    file_path: s.filePath,
    status: s.status,
    last_heartbeat: s.lastHeartbeat,
  }));
  res.json({ sessions });
});

/**
 * Cleanup dead kernel sessions
 * If session_ids provided, only those are cleaned up
 * Otherwise all dead sessions are cleaned up
 */
router.post('/kernels/dead/cleanup', async (req: Request, res: Response) => {
  try {
    const { session_ids, server_id } = req.body;
    const serverId = server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();
    if (serverId && serverId !== localServerId && serverId !== 'local') {
      const result = await cleanupRemoteDeadKernelSessions(serverId, session_ids);
      res.json(result);
      return;
    }

    const deleted = await kernelService.cleanupDeadSessions(session_ids);
    res.json({ deleted });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Start a new kernel session
 * If server_id is provided and not local, starts on remote server
 */
router.post('/kernels/start', async (req: Request, res: Response) => {
  try {
    const { kernel_name = 'python3', cwd, file_path, server_id } = req.body;

    const localServerId = serverRegistry.getLocalServerId();
    // Check if we should start on a remote server
    if (server_id && server_id !== localServerId && server_id !== 'local') {
      // Start on remote server
      const result = await startRemoteKernel(server_id, kernel_name, file_path);
      if (file_path) {
        kernelService.saveNotebookKernelPreference(file_path, kernel_name, server_id);
      }
      res.json({ session_id: result.sessionId, kernel_name, server_id });
      return;
    }

    // Start locally
    const sessionId = await kernelService.startKernel({
      kernelName: kernel_name,
      cwd,
      filePath: file_path,
    });
    if (file_path) {
      kernelService.saveNotebookKernelPreference(file_path, kernel_name, localServerId);
    }
    res.json({ session_id: sessionId, kernel_name, server_id: localServerId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ detail: message });
  }
});

/**
 * Get stored kernel preference for a notebook file.
 */
router.get('/kernels/preference', async (req: Request, res: Response) => {
  const filePath = req.query.file_path as string;
  if (!filePath) {
    res.status(400).json({ detail: 'file_path query parameter is required' });
    return;
  }

  const preference = kernelService.getNotebookKernelPreference(filePath);
  if (!preference) {
    res.json({ kernel_name: null, server_id: null });
    return;
  }
  res.json({
    kernel_name: preference.kernelName,
    server_id: preference.serverId,
    updated_at: preference.updatedAt,
  });
});

/**
 * Get or create kernel for a notebook file
 * If server_id is provided and not local, starts on remote server
 */
router.post('/kernels/for-file', async (req: Request, res: Response) => {
  try {
    const { file_path, kernel_name = 'python3', server_id } = req.body;
    if (!file_path) {
      res.status(400).json({ detail: 'file_path is required' });
      return;
    }

    const normalizedFilePath = kernelService.normalizeNotebookPath(file_path);
    let effectiveKernelName = kernel_name;
    let effectiveServerId = server_id as string | undefined;
    const localServerId = serverRegistry.getLocalServerId();

    if (!effectiveServerId) {
      const preference = kernelService.getNotebookKernelPreference(normalizedFilePath);
      if (preference?.kernelName) {
        effectiveKernelName = preference.kernelName;
      }
      if (preference?.serverId) {
        const preferredServerId = preference.serverId;
        const isLocalPreference = preferredServerId === localServerId || preferredServerId === 'local';
        const hasServer = !!serverRegistry.getServer(preferredServerId);
        if (isLocalPreference || hasServer) {
          effectiveServerId = preferredServerId;
        }
      }
    }

    // Check if we should start on a remote server
    if (effectiveServerId && effectiveServerId !== localServerId && effectiveServerId !== 'local') {
      // Start on remote server
      const result = await startRemoteKernel(effectiveServerId, effectiveKernelName, file_path);
      kernelService.saveNotebookKernelPreference(normalizedFilePath, effectiveKernelName, effectiveServerId);
      res.json({
        session_id: result.sessionId,
        kernel_name: effectiveKernelName,
        file_path,
        server_id: effectiveServerId,
        created: result.created ?? false,
        created_at: result.createdAt,
      });
      return;
    }

    // Start locally
    const { sessionId, created } = await kernelService.getOrCreateKernel(normalizedFilePath, effectiveKernelName);
    const sessionInfo = await kernelService.getSessionStatus(sessionId);
    kernelService.saveNotebookKernelPreference(normalizedFilePath, effectiveKernelName, localServerId);
    res.json({
      session_id: sessionId,
      kernel_name: effectiveKernelName,
      file_path,
      server_id: localServerId,
      created,
      created_at: sessionInfo?.createdAt,
    });
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
    const { sessionId } = req.params;

    // Check if this is a proxied session
    if (isProxiedSession(sessionId)) {
      await shutdownRemoteKernel(sessionId);
      res.json({ status: 'ok' });
      return;
    }

    const success = await kernelService.stopKernel(sessionId);
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
    const { sessionId } = req.params;

    // Check if this is a proxied session
    if (isProxiedSession(sessionId)) {
      await interruptRemoteKernel(sessionId);
      res.json({ status: 'ok' });
      return;
    }

    const success = await kernelService.interruptKernel(sessionId);
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
    const { sessionId } = req.params;

    // Check if this is a proxied session
    if (isProxiedSession(sessionId)) {
      await restartRemoteKernel(sessionId);
      res.json({ status: 'ok' });
      return;
    }

    const success = await kernelService.restartKernel(sessionId);
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
  const { sessionId } = req.params;

  // Check if this is a proxied session
  if (isProxiedSession(sessionId)) {
    try {
      const remoteStatus = await getRemoteKernelStatus(sessionId);
      res.json(remoteStatus);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      res.status(500).json({ detail: message });
    }
    return;
  }

  const status = await kernelService.getSessionStatus(sessionId);
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
  wss.on('connection', (ws: WebSocket, req) => {
    // Extract session ID from URL path: /api/kernels/{sessionId}/ws
    const url = req.url || '';
    const match = url.match(/\/api\/kernels\/([^/]+)\/ws/);
    if (!match) {
      ws.close(1008, 'Invalid path');
      return;
    }

    const sessionId = decodeURIComponent(match[1]);

    // Check if this is a proxied session
    if (isProxiedSession(sessionId)) {
      console.log(`[Kernel WS] Creating proxy for remote session ${sessionId}`);
      const remoteWs = createWebSocketProxy(sessionId, ws);
      if (!remoteWs) {
        ws.send(JSON.stringify({ type: 'error', error: 'Failed to connect to remote server' }));
        ws.close(1008, 'Failed to connect to remote server');
      }
      return;
    }

    ws.on('error', (err) => {
      console.error(`[Kernel WS] WebSocket error for session ${sessionId}:`, err);
    });

    // Validate session exists and register socket before handling any messages.
    // Use a fast session snapshot here to avoid `ps`/memory lookups blocking the
    // initial `sync_outputs` handshake on refresh/reconnect.
    const session = kernelService.getSessionStatusFast(sessionId);
    if (!session) {
      console.log(`[Kernel WS] Session ${sessionId} not found, closing connection`);
      ws.send(JSON.stringify({ type: 'error', error: 'Session not found' }));
      ws.close(1008, 'Session not found');
      return;
    }

    console.log(`[Kernel WS] Connected for session ${sessionId} (kernel: ${session.kernelName}, status: ${session.status})`);

    // Track this WebSocket for broadcasting
    if (!sessionWebSockets.has(sessionId)) {
      sessionWebSockets.set(sessionId, new Set());
    }
    sessionWebSockets.get(sessionId)!.add(ws);

    // Send initial status so frontend knows the kernel state immediately
    const executingCellId = kernelService.getExecutingCellId(sessionId);
    ws.send(JSON.stringify({ type: 'status', status: session.status, ...(executingCellId != null && { cell_id: executingCellId }) }));

    const handleMessage = async (raw: string) => {
      try {
        const message = JSON.parse(raw);

        if (message.type === 'execute') {
          const code = message.code || '';
          const cellId = message.cell_id || null;

          // Broadcast helper: send to all connected WebSockets for this session
          const broadcast = (msg: string, options?: { outputsOnly?: boolean }) => {
            const outputsOnly = options?.outputsOnly ?? false;
            const sockets = sessionWebSockets.get(sessionId);
            if (sockets) {
              for (const socket of sockets) {
                if (socket.readyState === WebSocket.OPEN) {
                  if (outputsOnly && !outputSubscribedSockets.has(socket)) continue;
                  socket.send(msg);
                }
              }
            }
          };

          // Send busy status to all clients
          broadcast(JSON.stringify({ type: 'status', status: 'busy', ...(cellId != null && { cell_id: cellId }) }));

          // Execute code with streaming output broadcast to all clients
          const result = await kernelService.executeCode(
            sessionId,
            code,
            async (entry) => {
              broadcast(JSON.stringify({
                type: 'output',
                output: entry.output,
                seq: entry.seq,
                cell_id: entry.cellId ?? null,
              }), { outputsOnly: true });

              const notebookPath = kernelService.getSessionFilePath(sessionId);
              if (notebookPath && !operationRouter.hasUI(notebookPath)) {
                scheduleOutputDrain(sessionId);
              }
            },
            undefined,
            cellId
          );

          // Broadcast result and idle status to all clients
          broadcast(JSON.stringify({ type: 'result', result }));
          broadcast(JSON.stringify({ type: 'status', status: 'idle' }));
        } else if (message.type === 'sync_outputs') {
          const since = Number(message.since ?? 0);
          const { outputs, latestSeq } = kernelService.getBufferedOutputs(sessionId, since);
          const normalized = outputs.map(entry => ({
            seq: entry.seq,
            output: entry.output,
            cell_id: entry.cellId ?? null,
          }));
          ws.send(JSON.stringify({ type: 'sync_outputs', outputs: normalized, latest_seq: latestSeq }));

          // Only start streaming outputs after the client has performed an initial sync.
          outputSubscribedSockets.add(ws);

          // Defensive catch-up: if new outputs arrived after we took the snapshot but before
          // the socket was marked subscribed, push them as streaming output now.
          const { outputs: tail } = kernelService.getBufferedOutputs(sessionId, latestSeq);
          for (const entry of tail) {
            if (ws.readyState !== WebSocket.OPEN) break;
            ws.send(JSON.stringify({
              type: 'output',
              output: entry.output,
              seq: entry.seq,
              cell_id: entry.cellId ?? null,
            }));
          }
        } else if (message.type === 'ack_outputs') {
          const upToSeq = Number(message.up_to ?? message.seq ?? 0);
          kernelService.ackOutputs(sessionId, upToSeq);
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
    };

    ws.on('message', (data) => {
      void handleMessage(data.toString());
    });

    ws.on('close', () => {
      console.log(`[Kernel WS] Disconnected for session ${sessionId}`);
      const sockets = sessionWebSockets.get(sessionId);
      if (sockets) {
        sockets.delete(ws);
        if (sockets.size === 0) {
          sessionWebSockets.delete(sessionId);
          const notebookPath = kernelService.getSessionFilePath(sessionId);
          if (notebookPath && !operationRouter.hasUI(notebookPath)) {
            scheduleOutputDrain(sessionId);
          }
        }
      }
    });
  });
}

export { kernelService };
export default router;
