/**
 * Comprehensive Tests for Consolidated Tools Module
 *
 * Tests tool definitions, type safety, and utility functions.
 * Does not require a running server.
 */

import { describe, it, expect } from 'vitest';
import {
  // Tool collections
  allTools,
  toolsByName,
  toolCategories,
  notebookTools,
  kernelTools,
  executionTools,
  fileTools,
  computeTools,

  // Tool utilities
  getToolDefinitions,
  getTool,
  hasTool,
  getToolNamesByCategory,

  // Individual tools for type checking
  readNotebookTool,
  readCellTool,
  readOutputTool,
  insertCellTool,
  updateCellTool,
  deleteCellTool,
  clearNotebookTool,
  moveCellTool,
  duplicateCellTool,
  searchCellsTool,
  updateMetadataTool,
  connectServerTool,
  startAgentSessionTool,
  endAgentSessionTool,
  listKernelsTool,
  kernelStartTool,
  kernelStopTool,
  kernelRestartTool,
  kernelInterruptTool,
  executeCellTool,
} from '../tools/index.js';

// =============================================================================
// Tool Collection Tests
// =============================================================================
describe('Tool Collections', () => {
  describe('allTools', () => {
    it('should contain all tools from all categories', () => {
      const expectedCount =
        notebookTools.length +
        kernelTools.length +
        executionTools.length +
        fileTools.length +
        computeTools.length;

      expect(allTools.length).toBe(expectedCount);
    });

    it('should contain 37 total tools', () => {
      // 18 notebook + 5 kernel + 1 execution + 7 files + 6 compute = 37
      expect(allTools.length).toBe(37);
    });

    it('should have unique tool names', () => {
      const names = allTools.map(t => t.definition.name);
      const uniqueNames = new Set(names);
      expect(uniqueNames.size).toBe(names.length);
    });
  });

  describe('toolsByName', () => {
    it('should be a Map with all tools', () => {
      expect(toolsByName).toBeInstanceOf(Map);
      expect(toolsByName.size).toBe(allTools.length);
    });

    it('should allow lookup by name', () => {
      expect(toolsByName.get('read_notebook')).toBe(readNotebookTool);
      expect(toolsByName.get('kernel_start')).toBe(kernelStartTool);
      expect(toolsByName.get('execute_cell')).toBe(executeCellTool);
    });

    it('should return undefined for unknown tools', () => {
      expect(toolsByName.get('nonexistent_tool')).toBeUndefined();
    });
  });

  describe('toolCategories', () => {
    it('should have all category keys', () => {
      expect(Object.keys(toolCategories)).toEqual([
        'notebook',
        'kernel',
        'execution',
        'files',
        'compute',
      ]);
    });

    it('should map to correct tool arrays', () => {
      expect(toolCategories.notebook).toBe(notebookTools);
      expect(toolCategories.kernel).toBe(kernelTools);
      expect(toolCategories.execution).toBe(executionTools);
      expect(toolCategories.files).toBe(fileTools);
      expect(toolCategories.compute).toBe(computeTools);
    });
  });

  describe('Individual Tool Arrays', () => {
    it('notebookTools should have 18 tools', () => {
      expect(notebookTools.length).toBe(18);
    });

    it('kernelTools should have 5 tools', () => {
      expect(kernelTools.length).toBe(5);
    });

    it('executionTools should have 1 tool', () => {
      expect(executionTools.length).toBe(1);
    });

    it('fileTools should have 7 tools', () => {
      expect(fileTools.length).toBe(7);
    });

    it('computeTools should have 6 tools', () => {
      expect(computeTools.length).toBe(6);
    });
  });
});

// =============================================================================
// Tool Definition Tests
// =============================================================================
describe('Tool Definitions', () => {
  describe('Structure Validation', () => {
    it('all tools should have required definition properties', () => {
      for (const tool of allTools) {
        expect(tool.definition).toBeDefined();
        expect(tool.definition.name).toBeDefined();
        expect(typeof tool.definition.name).toBe('string');
        expect(tool.definition.description).toBeDefined();
        expect(typeof tool.definition.description).toBe('string');
        expect(tool.definition.inputSchema).toBeDefined();
        expect(tool.definition.inputSchema.type).toBe('object');
        expect(tool.definition.inputSchema.properties).toBeDefined();
      }
    });

    it('all tools should have execute function', () => {
      for (const tool of allTools) {
        expect(tool.execute).toBeDefined();
        expect(typeof tool.execute).toBe('function');
      }
    });

    it('all tools should have formatForMCP function', () => {
      for (const tool of allTools) {
        expect(tool.formatForMCP).toBeDefined();
        expect(typeof tool.formatForMCP).toBe('function');
      }
    });
  });

  describe('Annotations', () => {
    const readOnlyTools = [
      'read_notebook',
      'read_cell',
      'read_output',
      'search_cells',
      'list_kernels',
    ];

    const destructiveTools = [
      'insert_cell',
      'update_cell',
      'delete_cell',
      'clear_notebook',
      'move_cell',
      'duplicate_cell',
      'update_metadata',
      'start_agent_session',
      'kernel_stop',
      'kernel_restart',
      'execute_cell',
    ];

    it('should mark read-only tools correctly', () => {
      for (const name of readOnlyTools) {
        const tool = toolsByName.get(name);
        expect(tool, `Tool ${name} should exist`).toBeDefined();
        expect(
          tool!.definition.annotations?.readOnlyHint,
          `Tool ${name} should have readOnlyHint=true`
        ).toBe(true);
      }
    });

    it('should mark destructive tools correctly', () => {
      for (const name of destructiveTools) {
        const tool = toolsByName.get(name);
        expect(tool, `Tool ${name} should exist`).toBeDefined();
        expect(
          tool!.definition.annotations?.destructiveHint,
          `Tool ${name} should have destructiveHint=true`
        ).toBe(true);
      }
    });
  });

  describe('Notebook Tools', () => {
    it('read_notebook should have correct schema', () => {
      const def = readNotebookTool.definition;
      expect(def.name).toBe('read_notebook');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.properties.include_outputs).toBeDefined();
      expect(def.inputSchema.properties.format).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
    });

    it('read_cell should have correct schema', () => {
      const def = readCellTool.definition;
      expect(def.name).toBe('read_cell');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.properties.cell_index).toBeDefined();
      expect(def.inputSchema.properties.cell_id).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
    });

    it('insert_cell should have correct schema', () => {
      const def = insertCellTool.definition;
      expect(def.name).toBe('insert_cell');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.properties.cell_id).toBeDefined();
      expect(def.inputSchema.properties.content).toBeDefined();
      expect(def.inputSchema.properties.position).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
      expect(def.inputSchema.required).toContain('cell_id');
      expect(def.inputSchema.required).toContain('content');
    });

    it('update_cell should have correct schema', () => {
      const def = updateCellTool.definition;
      expect(def.name).toBe('update_cell');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.properties.cell_id).toBeDefined();
      expect(def.inputSchema.properties.content).toBeDefined();
      expect(def.inputSchema.properties.cell_type).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
      expect(def.inputSchema.required).toContain('cell_id');
    });

    it('clear_notebook should have correct schema', () => {
      const def = clearNotebookTool.definition;
      expect(def.name).toBe('clear_notebook');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
    });

    it('search_cells should have correct schema', () => {
      const def = searchCellsTool.definition;
      expect(def.name).toBe('search_cells');
      expect(def.inputSchema.required).toContain('path');
      expect(def.inputSchema.required).toContain('query');
    });

    it('read_output should have correct schema', () => {
      const def = readOutputTool.definition;
      expect(def.name).toBe('read_output');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.properties.cell_index).toBeDefined();
      expect(def.inputSchema.properties.cell_id).toBeDefined();
      expect(def.inputSchema.properties.output_offset).toBeDefined();
      expect(def.inputSchema.properties.max_wait).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
    });

    it('update_metadata should have correct schema', () => {
      const def = updateMetadataTool.definition;
      expect(def.name).toBe('update_metadata');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.properties.cell_id).toBeDefined();
      expect(def.inputSchema.properties.changes).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
      expect(def.inputSchema.required).toContain('cell_id');
      expect(def.inputSchema.required).toContain('changes');
    });

    it('connect_server should have correct schema', () => {
      const def = connectServerTool.definition;
      expect(def.name).toBe('connect_server');
      expect(def.inputSchema.properties.base_url).toBeDefined();
      expect(def.inputSchema.required).toContain('base_url');
    });

    it('start_agent_session should have correct schema', () => {
      const def = startAgentSessionTool.definition;
      expect(def.name).toBe('start_agent_session');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
    });

    it('end_agent_session should have correct schema', () => {
      const def = endAgentSessionTool.definition;
      expect(def.name).toBe('end_agent_session');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
    });
  });

  describe('Kernel Tools', () => {
    it('list_kernels should have no required params', () => {
      const def = listKernelsTool.definition;
      expect(def.name).toBe('list_kernels');
      expect(def.inputSchema.required ?? []).toEqual([]);
    });

    it('kernel_start should have optional params', () => {
      const def = kernelStartTool.definition;
      expect(def.name).toBe('kernel_start');
      expect(def.inputSchema.properties.kernel_name).toBeDefined();
      expect(def.inputSchema.required ?? []).toEqual([]);
    });

    it('kernel_stop should have no required params', () => {
      const def = kernelStopTool.definition;
      expect(def.name).toBe('kernel_stop');
      expect(def.inputSchema.required ?? []).toEqual([]);
    });
  });

  describe('Execution Tools', () => {
    it('execute_cell should have correct schema', () => {
      const def = executeCellTool.definition;
      expect(def.name).toBe('execute_cell');
      expect(def.inputSchema.properties.path).toBeDefined();
      expect(def.inputSchema.properties.cell_index).toBeDefined();
      expect(def.inputSchema.properties.cell_id).toBeDefined();
      expect(def.inputSchema.properties.session_id).toBeDefined();
      expect(def.inputSchema.properties.max_wait).toBeDefined();
      expect(def.inputSchema.required).toContain('path');
    });
  });
});

// =============================================================================
// Utility Function Tests
// =============================================================================
describe('Tool Utility Functions', () => {
  describe('getToolDefinitions', () => {
    it('should return array of all tool definitions', () => {
      const definitions = getToolDefinitions();
      expect(Array.isArray(definitions)).toBe(true);
      expect(definitions.length).toBe(allTools.length);
    });

    it('should return definitions in MCP-compatible format', () => {
      const definitions = getToolDefinitions();
      for (const def of definitions) {
        expect(def.name).toBeDefined();
        expect(def.description).toBeDefined();
        expect(def.inputSchema).toBeDefined();
        expect(def.inputSchema.type).toBe('object');
      }
    });
  });

  describe('getTool', () => {
    it('should return tool by name', () => {
      const tool = getTool('read_notebook');
      expect(tool).toBe(readNotebookTool);
    });

    it('should return undefined for unknown tool', () => {
      const tool = getTool('nonexistent');
      expect(tool).toBeUndefined();
    });
  });

  describe('hasTool', () => {
    it('should return true for existing tools', () => {
      expect(hasTool('read_notebook')).toBe(true);
      expect(hasTool('insert_cell')).toBe(true);
      expect(hasTool('update_cell')).toBe(true);
      expect(hasTool('clear_notebook')).toBe(true);
      expect(hasTool('kernel_start')).toBe(true);
      expect(hasTool('execute_cell')).toBe(true);
      expect(hasTool('list_kernels')).toBe(true);
    });

    it('should return false for non-existing tools', () => {
      expect(hasTool('nonexistent')).toBe(false);
      expect(hasTool('')).toBe(false);
      expect(hasTool('READ_NOTEBOOK')).toBe(false); // Case sensitive
    });

    it('should return false for removed tools', () => {
      expect(hasTool('execute_code')).toBe(false);
      expect(hasTool('list_files')).toBe(false);
      expect(hasTool('list_sessions')).toBe(false);
      expect(hasTool('list_python_environments')).toBe(false);
      expect(hasTool('write_cell')).toBe(false); // Replaced by insert_cell and update_cell
    });
  });

  describe('getToolNamesByCategory', () => {
    it('should return tool names organized by category', () => {
      const byCategory = getToolNamesByCategory();

      expect(byCategory.notebook).toContain('read_notebook');
      expect(byCategory.notebook).toContain('read_cell');
      expect(byCategory.notebook).toContain('insert_cell');
      expect(byCategory.notebook).toContain('update_cell');
      expect(byCategory.notebook).toContain('clear_notebook');
      expect(byCategory.notebook).toContain('read_output');
      expect(byCategory.notebook).toContain('update_metadata');
      expect(byCategory.notebook).toContain('connect_server');
      expect(byCategory.notebook).toContain('start_agent_session');
      expect(byCategory.notebook).toContain('end_agent_session');

      expect(byCategory.kernel).toContain('list_kernels');
      expect(byCategory.kernel).toContain('kernel_start');

      expect(byCategory.execution).toContain('execute_cell');
    });

    it('should have correct counts per category', () => {
      const byCategory = getToolNamesByCategory();

      expect(byCategory.notebook.length).toBe(18);
      expect(byCategory.kernel.length).toBe(5);
      expect(byCategory.execution.length).toBe(1);
      expect(byCategory.files.length).toBe(7);
      expect(byCategory.compute.length).toBe(6);
    });
  });
});

// =============================================================================
// formatForMCP Tests (with mock results)
// =============================================================================
describe('formatForMCP Functions', () => {
  describe('Success Formatting', () => {
    it('read_notebook should format cell list', async () => {
      const result = await readNotebookTool.formatForMCP!({
        success: true,
        data: {
          path: '/test.ipynb',
          cells: [
            { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [] },
            { id: 'cell-2', type: 'markdown', content: '# Title', outputs: [] },
          ],
          totalCells: 2,
        },
      });

      expect(result.length).toBeGreaterThan(0);
      expect(result[0].type).toBe('text');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('Notebook: /test.ipynb');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('2 cells');
    });

    it('read_cell should format cell content', async () => {
      const result = await readCellTool.formatForMCP!({
        success: true,
        data: {
          cell: { id: 'test-cell', type: 'code', content: 'x = 1', outputs: [], executionCount: 5 },
          cellIndex: 0,
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('#1 [code]');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('execution [5]');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('x = 1');
    });

    it('list_kernels should format kernel list with display names', async () => {
      const result = await listKernelsTool.formatForMCP!({
        success: true,
        data: {
          kernels: [
            { name: 'python3', displayName: 'Python 3.10.12', language: 'python' },
            { name: 'ir', displayName: 'R 4.2', language: 'r' },
          ],
        },
      });

      expect(result).toHaveLength(1);
      expect(result[0].type).toBe('text');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('Available kernels');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('python3');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('Python 3.10.12');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('[python]');
    });
  });

  describe('Error Formatting', () => {
    it('should format errors consistently', async () => {
      const tools = [
        readNotebookTool,
        readCellTool,
        insertCellTool,
        updateCellTool,
        clearNotebookTool,
        listKernelsTool,
        executeCellTool,
      ];

      for (const tool of tools) {
        const result = await tool.formatForMCP!({
          success: false,
          error: 'Test error message',
        });

        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('text');
        expect((result[0] as { type: 'text'; text: string }).text).toContain('Error:');
        expect((result[0] as { type: 'text'; text: string }).text).toContain('Test error message');
      }
    });
  });

  describe('Empty Results', () => {
    it('search_cells should handle no results', async () => {
      const result = await searchCellsTool.formatForMCP!({
        success: true,
        data: { query: 'nonexistent', matches: [], matchCount: 0, hasMore: false },
      });

      expect(result[0].type).toBe('text');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('No matching cells');
    });

    it('list_kernels should handle empty list', async () => {
      const result = await listKernelsTool.formatForMCP!({
        success: true,
        data: { kernels: [] },
      });

      expect(result[0].type).toBe('text');
      expect((result[0] as { type: 'text'; text: string }).text).toContain('No kernels');
    });
  });
});
