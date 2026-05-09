/**
 * Nebula MCP Server - Entry Point
 *
 * Exposes Nebula Notebook functionality via Model Context Protocol
 * for use with Claude Desktop, Cursor, and other MCP clients.
 */

import { NebulaMCPServer } from './server.js';

const server = new NebulaMCPServer();
server.start().catch((error) => {
  console.error('Failed to start Nebula MCP server:', error);
  process.exit(1);
});
