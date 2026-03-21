/**
 * Notebook Operations WebSocket
 *
 * Handles real-time communication between UI and backend for notebook operations.
 * Path: /api/notebook/{notebook_path}/ws
 */

import { WebSocket, WebSocketServer } from 'ws';
import { Server as HttpServer, IncomingMessage } from 'http';
import { parse as parseUrl } from 'url';
import { operationRouter } from './operation-router';

/**
 * Setup notebook operations WebSocket handler
 */
export function setupNotebookWebSocket(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
  });

  // Handle upgrade requests for /api/notebook/{path}/ws
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const parsedUrl = parseUrl(request.url || '', true);
    const pathname = parsedUrl.pathname || '';

    // Match /api/notebook/{encoded_path}/ws
    const match = pathname.match(/^\/api\/notebook\/(.+)\/ws$/);
    if (match) {
      // Authenticate WebSocket connection
      const { authWebSocketMiddleware } = require('../auth');
      if (!authWebSocketMiddleware(request)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    }
    // Don't destroy socket for non-matching paths
  });

  wss.on('connection', async (ws: WebSocket, req: IncomingMessage) => {
    const parsedUrl = parseUrl(req.url || '', true);
    const pathname = parsedUrl.pathname || '';
    const match = pathname.match(/^\/api\/notebook\/(.+)\/ws$/);

    if (!match) {
      ws.close(1008, 'Invalid path');
      return;
    }

    // Decode the notebook path
    const encodedPath = match[1];
    const notebookPath = decodeURIComponent(encodedPath);

    console.log(`[Notebook WS] Connected for notebook: ${notebookPath}`);

    // Register UI connection
    await operationRouter.registerUI(ws, notebookPath);

    const heartbeatInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.ping();
        } catch {
          // Ignore ping failures; close/error handlers will clean up.
        }
      }
    }, 15000);

    ws.on('error', (err) => {
      console.error(`[Notebook WS] WebSocket error for ${notebookPath}:`, err);
    });

    ws.on('pong', () => {
      operationRouter.markUIActivity(ws, notebookPath);
    });

    ws.on('message', async (data) => {
      operationRouter.markUIActivity(ws, notebookPath);
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'operationResult') {
          // UI is responding to an operation request
          operationRouter.handleUIResponse(notebookPath, message);
        } else if (message.type === 'notebookData') {
          // UI is responding to a readNotebook request
          // Pass message directly like Python does - it contains { requestId, result: { success, data } }
          operationRouter.handleUIResponse(notebookPath, message);
        } else if (message.type === 'ping') {
          // Respond to keep-alive ping with pong
          ws.send(JSON.stringify({ type: 'pong' }));
        } else {
          console.warn(`[Notebook WS] Unknown message type:`, message.type);
        }
      } catch (err) {
        console.error('[Notebook WS] Error parsing message:', err);
      }
    });

    ws.on('close', () => {
      clearInterval(heartbeatInterval);
      console.log(`[Notebook WS] Disconnected for notebook: ${notebookPath}`);
      operationRouter.unregisterUI(ws, notebookPath);
    });
  });

  return wss;
}
