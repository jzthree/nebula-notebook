/**
 * Terminal Server - Routes and WebSocket setup for PTY management
 */

import { Express, Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { ptyManager } from './pty-manager';
import {
  CreateTerminalRequest,
  ResizeTerminalRequest,
  ClientMessage,
  ServerMessage,
} from './types';

// Track WebSocket connections by terminal ID
const wsConnections = new Map<string, Set<WebSocket>>();

/**
 * Setup terminal REST routes on the Express app
 */
export function setupTerminalRoutes(app: Express): void {
  // Terminal health check (includes terminal count)
  app.get('/api/terminals/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok', terminals: ptyManager.list().length });
  });

  // List all terminals
  app.get('/api/terminals', (_req: Request, res: Response) => {
    res.json(ptyManager.list());
  });

  // Create a new terminal
  app.post('/api/terminals', (req: Request, res: Response) => {
    const options: CreateTerminalRequest = req.body || {};

    try {
      const terminal = ptyManager.create(options);
      console.log(`[Terminal] Created terminal ${terminal.id} (PID: ${terminal.pid})`);
      res.status(201).json(terminal);
    } catch (error) {
      console.error('[Terminal] Failed to create terminal:', error);
      res.status(500).json({
        error: 'Failed to create terminal',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get or create a named terminal (for persistent terminals via URL)
  app.post('/api/terminals/named/:name', (req: Request, res: Response) => {
    const { name } = req.params;
    const options: CreateTerminalRequest = req.body || {};

    try {
      const terminal = ptyManager.getOrCreate(name, options);
      console.log(`[Terminal] Get/create named terminal '${name}' -> ${terminal.id}`);
      res.json(terminal);
    } catch (error) {
      console.error('[Terminal] Failed to get/create named terminal:', error);
      res.status(500).json({
        error: 'Failed to get/create terminal',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get terminal info
  app.get('/api/terminals/:id', (req: Request, res: Response) => {
    const terminal = ptyManager.getTerminalInfo(req.params.id);

    if (!terminal) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    res.json(terminal);
  });

  // Delete/close a terminal
  app.delete('/api/terminals/:id', (req: Request, res: Response) => {
    const success = ptyManager.kill(req.params.id);

    if (!success) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    console.log(`[Terminal] Closed terminal ${req.params.id}`);
    res.json({ status: 'ok' });
  });

  // Resize terminal
  app.post('/api/terminals/:id/resize', (req: Request, res: Response) => {
    const { cols, rows }: ResizeTerminalRequest = req.body;

    if (!cols || !rows) {
      res.status(400).json({ error: 'cols and rows are required' });
      return;
    }

    const success = ptyManager.resize(req.params.id, cols, rows);

    if (!success) {
      res.status(404).json({ error: 'Terminal not found' });
      return;
    }

    res.json({ status: 'ok', cols, rows });
  });
}

/**
 * Setup terminal WebSocket server with noServer mode
 * Returns the WSS so the upgrade can be handled externally
 */
export function setupTerminalWebSocket(server: HttpServer): WebSocketServer {
  // Use noServer mode to avoid conflicts with kernel WebSocket
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,  // Disable compression
  });

  // Handle upgrade requests for /ws path
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/ws') {
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
    // Don't destroy socket for non-matching paths - let other handlers deal with it
  });

  wss.on('connection', (ws: WebSocket, req) => {
    // Extract terminal ID from URL query
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const terminalId = url.searchParams.get('id');

    if (!terminalId) {
      ws.close(4000, 'Terminal ID required');
      return;
    }

    const session = ptyManager.get(terminalId);
    if (!session) {
      ws.close(4004, 'Terminal not found');
      return;
    }

    console.log(`[Terminal] WebSocket connected to terminal ${terminalId}`);

    // Track this connection
    if (!wsConnections.has(terminalId)) {
      wsConnections.set(terminalId, new Set());
    }
    wsConnections.get(terminalId)!.add(ws);

    // Send buffered output for reconnection
    const buffer = ptyManager.getOutputBuffer(terminalId);
    if (buffer) {
      const replayMsg: ServerMessage = { type: 'replay', data: buffer };
      ws.send(JSON.stringify(replayMsg));
    }

    // Set up data listener
    const sendOutput = (data: string) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ServerMessage = { type: 'output', data };
        ws.send(JSON.stringify(msg));
      }
    };
    ptyManager.setOnData(terminalId, sendOutput);

    // Set up exit listener
    ptyManager.setOnExit(terminalId, (code: number) => {
      if (ws.readyState === WebSocket.OPEN) {
        const msg: ServerMessage = { type: 'exit', code };
        ws.send(JSON.stringify(msg));
      }
    });

    // Handle incoming messages
    ws.on('message', (rawData) => {
      try {
        const message: ClientMessage = JSON.parse(rawData.toString());

        switch (message.type) {
          case 'input':
            ptyManager.write(terminalId, message.data);
            break;

          case 'resize':
            ptyManager.resize(terminalId, message.cols, message.rows);
            break;

          default:
            console.warn(`[Terminal] Unknown message type:`, message);
        }
      } catch (error) {
        console.error('[Terminal] Failed to parse message:', error);
      }
    });

    // Handle disconnection
    ws.on('close', () => {
      console.log(`[Terminal] WebSocket disconnected from terminal ${terminalId}`);

      const connections = wsConnections.get(terminalId);
      if (connections) {
        connections.delete(ws);
        if (connections.size === 0) {
          wsConnections.delete(terminalId);
          // Clear the data listener when no connections
          ptyManager.setOnData(terminalId, null);
        }
      }
    });

    ws.on('error', (error) => {
      console.error(`[Terminal] WebSocket error for terminal ${terminalId}:`, error);
    });
  });

  return wss;
}

/**
 * Cleanup all terminals (call on shutdown)
 */
export function cleanupTerminals(): void {
  ptyManager.killAll();
}
