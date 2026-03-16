/**
 * Terminal Server - Routes and WebSocket setup for PTY management
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { Server as HttpServer } from 'http';
import { ptyManager } from './pty-manager';
import { fsService } from '../fs/fs-service';
import {
  CreateTerminalRequest,
  ResizeTerminalRequest,
  ClientMessage,
  ServerMessage,
} from './types';

// Get configured root directory for terminals
function getDefaultCwd(): string {
  return fsService.normalizePath('~');
}

// Track WebSocket connections by terminal ID
const wsConnections = new Map<string, Set<WebSocket>>();

/**
 * Setup terminal REST routes as a Fastify plugin
 */
export async function setupTerminalRoutes(fastify: FastifyInstance): Promise<void> {
  // Terminal health check (includes terminal count)
  fastify.get('/api/terminals/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ status: 'ok', terminals: ptyManager.list().length });
  });

  // List all terminals
  fastify.get('/api/terminals', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send(ptyManager.list());
  });

  // Create a new terminal
  fastify.post('/api/terminals', async (request: FastifyRequest, reply: FastifyReply) => {
    const options: CreateTerminalRequest = (request.body as any) || {};
    // Use configured root directory as default cwd
    const finalOptions = { cwd: getDefaultCwd(), ...options };

    try {
      const terminal = ptyManager.create(finalOptions);
      console.log(`[Terminal] Created terminal ${terminal.id} (PID: ${terminal.pid})`);
      return reply.code(201).send(terminal);
    } catch (error) {
      console.error('[Terminal] Failed to create terminal:', error);
      return reply.code(500).send({
        error: 'Failed to create terminal',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get or create a named terminal (for persistent terminals via URL)
  fastify.post('/api/terminals/named/:name', async (request: FastifyRequest, reply: FastifyReply) => {
    const { name } = request.params as any;
    const options: CreateTerminalRequest = (request.body as any) || {};
    // Use configured root directory as default cwd
    const finalOptions = { cwd: getDefaultCwd(), ...options };

    try {
      const terminal = ptyManager.getOrCreate(name, finalOptions);
      console.log(`[Terminal] Get/create named terminal '${name}' -> ${terminal.id}`);
      return reply.send(terminal);
    } catch (error) {
      console.error('[Terminal] Failed to get/create named terminal:', error);
      return reply.code(500).send({
        error: 'Failed to get/create terminal',
        message: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Get terminal info
  fastify.get('/api/terminals/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const terminal = ptyManager.getTerminalInfo((request.params as any).id);

    if (!terminal) {
      return reply.code(404).send({ error: 'Terminal not found' });
    }

    return reply.send(terminal);
  });

  // Delete/close a terminal
  fastify.delete('/api/terminals/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const success = ptyManager.kill((request.params as any).id);

    if (!success) {
      return reply.code(404).send({ error: 'Terminal not found' });
    }

    console.log(`[Terminal] Closed terminal ${(request.params as any).id}`);
    return reply.send({ status: 'ok' });
  });

  // Resize terminal
  fastify.post('/api/terminals/:id/resize', async (request: FastifyRequest, reply: FastifyReply) => {
    const { cols, rows }: ResizeTerminalRequest = request.body as any;

    if (!cols || !rows) {
      return reply.code(400).send({ error: 'cols and rows are required' });
    }

    const success = ptyManager.resize((request.params as any).id, cols, rows);

    if (!success) {
      return reply.code(404).send({ error: 'Terminal not found' });
    }

    return reply.send({ status: 'ok', cols, rows });
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
    const connections = wsConnections.get(terminalId)!;
    connections.add(ws);

    // Send buffered output for reconnection
    const buffer = ptyManager.getOutputBuffer(terminalId);
    if (buffer) {
      const replayMsg: ServerMessage = { type: 'replay', data: buffer };
      ws.send(JSON.stringify(replayMsg));
    }

    // Collaborative mode: broadcast output to ALL connected clients
    const broadcastOutput = (data: string) => {
      const msg: ServerMessage = { type: 'output', data };
      const msgStr = JSON.stringify(msg);
      for (const conn of connections) {
        if (conn.readyState === WebSocket.OPEN) {
          conn.send(msgStr);
        }
      }
    };
    ptyManager.setOnData(terminalId, broadcastOutput);

    // Set up exit listener - broadcast to all connections
    ptyManager.setOnExit(terminalId, (code: number) => {
      const msg: ServerMessage = { type: 'exit', code };
      const msgStr = JSON.stringify(msg);
      for (const conn of connections) {
        if (conn.readyState === WebSocket.OPEN) {
          conn.send(msgStr);
        }
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
