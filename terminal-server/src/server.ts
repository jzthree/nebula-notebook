/**
 * Terminal Server - Express + WebSocket server for PTY management
 */

import express, { Request, Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { ptyManager } from './pty-manager';
import {
  CreateTerminalRequest,
  ResizeTerminalRequest,
  ClientMessage,
  ServerMessage,
} from './types';

const app = express();
const PORT = process.env.TERMINAL_PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
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

// Create HTTP server
const server = createServer(app);

// WebSocket server for terminal I/O
const wss = new WebSocketServer({ server, path: '/ws' });

// Track WebSocket connections by terminal ID
const wsConnections = new Map<string, Set<WebSocket>>();

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

// Cleanup on shutdown
process.on('SIGINT', () => {
  console.log('\n[Terminal] Shutting down...');
  ptyManager.killAll();
  server.close(() => {
    console.log('[Terminal] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[Terminal] Received SIGTERM, shutting down...');
  ptyManager.killAll();
  server.close(() => {
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`[Terminal] Server running on http://localhost:${PORT}`);
  console.log(`[Terminal] WebSocket available at ws://localhost:${PORT}/ws?id=<terminal-id>`);
});
