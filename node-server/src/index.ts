/**
 * Nebula Node Server - Main Entry Point
 *
 * Unified Node.js server for:
 * - Terminal PTY management
 * - (Future) Undo/redo state management
 */

import { createServer } from 'http';
import { createApp } from './app';
import { setupTerminalRoutes, setupTerminalWebSocket, cleanupTerminals } from './terminal/server';

const PORT = process.env.NODE_SERVER_PORT || process.env.TERMINAL_PORT || 3001;

// Create Express app with shared middleware
const app = createApp();

// Setup terminal routes
setupTerminalRoutes(app);

// Create HTTP server
const server = createServer(app);

// Setup terminal WebSocket
setupTerminalWebSocket(server);

// Future: Setup undo WebSocket
// setupUndoWebSocket(server);

// Cleanup on shutdown
process.on('SIGINT', () => {
  console.log('\n[NodeServer] Shutting down...');
  cleanupTerminals();
  server.close(() => {
    console.log('[NodeServer] Server closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n[NodeServer] Received SIGTERM, shutting down...');
  cleanupTerminals();
  server.close(() => {
    process.exit(0);
  });
});

// Start server
server.listen(PORT, () => {
  console.log(`[NodeServer] Running on http://localhost:${PORT}`);
  console.log(`[NodeServer] Terminal WebSocket at ws://localhost:${PORT}/ws?id=<terminal-id>`);
});
