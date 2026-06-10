/**
 * Tests for MCP Server JSON-RPC handling
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NebulaMCPServer } from '../mcp/server.js';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

const NEBULA_URL = process.env.NEBULA_URL || 'http://localhost:3000';

describe('MCP Server', () => {
  let serverProcess: ChildProcess;
  let rl: readline.Interface;
  let responsePromises: Map<number | string, { resolve: (value: any) => void; reject: (error: any) => void }>;
  let requestId = 0;

  function sendRequest(method: string, params: Record<string, unknown> = {}): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      responsePromises.set(id, { resolve, reject });

      const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });
      serverProcess.stdin!.write(request + '\n');

      // Timeout after 10 seconds
      setTimeout(() => {
        if (responsePromises.has(id)) {
          responsePromises.delete(id);
          reject(new Error(`Request ${method} timed out`));
        }
      }, 10000);
    });
  }

  beforeAll(async () => {
    responsePromises = new Map();

    // Start the MCP server process
    serverProcess = spawn('node', ['dist/mcp/index.js'], {
      cwd: process.cwd().replace('/src/__tests__', ''),
      env: { ...process.env, NEBULA_URL: process.env.NEBULA_URL || 'http://localhost:3000' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Set up readline to parse responses
    rl = readline.createInterface({
      input: serverProcess.stdout!,
      crlfDelay: Infinity,
    });

    rl.on('line', (line) => {
      try {
        const response = JSON.parse(line);
        const promise = responsePromises.get(response.id);
        if (promise) {
          responsePromises.delete(response.id);
          if (response.error) {
            promise.reject(response.error);
          } else {
            promise.resolve(response.result);
          }
        }
      } catch (e) {
        // Ignore non-JSON lines (like startup message)
      }
    });

    // Wait for server to start
    await new Promise(resolve => setTimeout(resolve, 1000));
  });

  afterAll(() => {
    if (serverProcess) {
      serverProcess.kill();
    }
    if (rl) {
      rl.close();
    }
  });

  describe('Protocol', () => {
    it('should respond to initialize', async () => {
      const result = await sendRequest('initialize', {});
      expect(result).toBeDefined();
      expect(result.protocolVersion).toBe('2024-11-05');
      expect(result.serverInfo.name).toBe('nebula-mcp');
      expect(result.serverInfo.version).toBe('0.1.0');
      expect(result.capabilities.tools).toBeDefined();
    });

    it('should respond to tools/list', async () => {
      const result = await sendRequest('tools/list', {});
      expect(result).toBeDefined();
      expect(result.tools).toBeDefined();
      expect(Array.isArray(result.tools)).toBe(true);
      expect(result.tools.length).toBe(38); // 18 notebook + 5 kernel + 1 execution + 7 file + 7 writer
    });

    it('should have correct tool definitions', async () => {
      const result = await sendRequest('tools/list', {});

      // Check kernel tools
      const listKernels = result.tools.find((t: any) => t.name === 'list_kernels');
      expect(listKernels).toBeDefined();
      expect(listKernels.description).toContain('kernel');

      // Check notebook tools
      const readNotebook = result.tools.find((t: any) => t.name === 'read_notebook');
      expect(readNotebook).toBeDefined();
      expect(readNotebook.inputSchema.properties.path).toBeDefined();
      expect(readNotebook.inputSchema.required).toContain('path');

      // Check execution tools
      const executeCell = result.tools.find((t: any) => t.name === 'execute_cell');
      expect(executeCell).toBeDefined();
      expect(executeCell.inputSchema.properties.session_id).toBeDefined();
      expect(executeCell.inputSchema.properties.path).toBeDefined();

      // Check connection tool
      const connectServer = result.tools.find((t: any) => t.name === 'connect_server');
      expect(connectServer).toBeDefined();
      expect(connectServer.inputSchema.properties.base_url).toBeDefined();
      expect(connectServer.inputSchema.required).toContain('base_url');
    });

    it('should handle tools/call for list_kernels', async () => {
      await sendRequest('tools/call', {
        name: 'connect_server',
        arguments: { base_url: NEBULA_URL },
      });
      const testPath = `/tmp/mcp-server-kernel-test-${Date.now()}-${Math.random().toString(16).slice(2)}.ipynb`;
      await sendRequest('tools/call', {
        name: 'create_notebook',
        arguments: { path: testPath, overwrite: true },
      });
      await sendRequest('tools/call', {
        name: 'start_agent_session',
        arguments: { path: testPath },
      });
      const result = await sendRequest('tools/call', {
        name: 'list_kernels',
        arguments: {},
      });

      expect(result).toBeDefined();
      expect(result.content).toBeDefined();
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('kernels');
    }, 15000);

    it('should handle tools/call for connect_server', async () => {
      const result = await sendRequest('tools/call', {
        name: 'connect_server',
        arguments: { base_url: 'http://localhost:8000' },
      });

      expect(result).toBeDefined();
      expect(result.content[0].type).toBe('text');
      expect(result.content[0].text).toContain('Connected to');
    });

    it('should return error for unknown method', async () => {
      try {
        await sendRequest('unknown/method', {});
        expect.fail('Should have thrown');
      } catch (error: any) {
        expect(error.code).toBe(-32601);
        expect(error.message).toContain('Method not found');
      }
    });

    it('should return error for unknown tool', async () => {
      await sendRequest('tools/call', {
        name: 'connect_server',
        arguments: { base_url: NEBULA_URL },
      });
      const result = await sendRequest('tools/call', {
        name: 'unknown_tool_xyz',
        arguments: {},
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Unknown tool');
    });
  });
});
