/**
 * Execution Tools
 *
 * Tools for executing code in kernel sessions with streaming output.
 *
 * Truncation is handled by the backend (Python) for consistency with
 * read_notebook and read_output tools. After execution, outputs are
 * read back via readCellOutputOp which applies backend truncation.
 */

import type { Tool, ToolResult, MCPContent } from './types.js';
import type { NebulaClient } from '../notebook/client.js';
import type { CellOutput } from '../types.js';
import { resizeImageIfNeeded } from '../utils/imageResize.js';

// =============================================================================
// Shared Types (matches backend truncation metadata)
// =============================================================================

interface TruncatedOutput extends CellOutput {
  truncated?: boolean;
  truncation_reason?: string | null;
  total_lines?: number;
  total_chars?: number;
}

async function formatOutputs(outputs: TruncatedOutput[]): Promise<MCPContent> {
  const results: MCPContent = [];
  for (const o of outputs) {
    if (o.type === 'image') {
      // Resize images to fit Claude API limits (2000px max dimension)
      const resizedData = await resizeImageIfNeeded(o.content);
      results.push({ type: 'image' as const, data: resizedData, mimeType: 'image/png' });
    } else {
      const prefix = o.type === 'error' ? '[ERROR] ' : '';
      let text = prefix + o.content;

      // Add truncation info if applicable
      if (o.truncated) {
        text += `\n--- [TRUNCATED: ${o.truncation_reason}] ${o.total_lines} total lines, ${o.total_chars} total chars ---`;
      }

      results.push({ type: 'text' as const, text });
    }
  }
  return results;
}

// =============================================================================
// execute_cell
// =============================================================================

export interface ExecuteCellParams {
  path: string;
  cell_index?: number;
  cell_id?: string;
  session_id?: string;
  max_wait?: number;
  save_outputs?: boolean;
  // Truncation parameters (passed to backend)
  max_lines?: number;
  max_chars?: number;
}

export interface ExecuteCellResult {
  cellId: string;
  outputs: TruncatedOutput[];
  elapsed: number;
  saved: boolean;
  status?: 'idle' | 'busy' | 'error';
}

export const executeCellTool: Tool<ExecuteCellParams, ExecuteCellResult> = {
  definition: {
    name: 'execute_cell',
    description: `Execute a notebook cell and return its output. Outputs are truncated by default (100 lines, 10000 chars). Outputs are saved incrementally during execution. Requires an active kernel session.

For long-running cells: If execution exceeds max_wait, returns with status="busy" and partial output. Use read_output with max_wait to poll for more output. Set max_wait=0 for immediate "background" execution (returns right away, poll with read_output).`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the notebook file' },
        cell_index: { type: 'number', description: 'Cell index to execute (0-based). Use this OR cell_id.' },
        cell_id: { type: 'string', description: 'Stable cell ID. Use this OR cell_index.' },
        session_id: { type: 'string', description: 'Kernel session ID. If not provided, will try to get/create one.' },
        max_wait: { type: 'number', description: 'Max seconds to wait for completion (default: 10). Use 0 for background execution.' },
        save_outputs: { type: 'boolean', description: 'Save outputs back to the notebook (default: true)' },
        max_lines: { type: 'number', description: 'Max lines per output (default: 100)' },
        max_chars: { type: 'number', description: 'Max chars per output (default: 10000)' },
      },
      required: ['path'],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    if (params.cell_index === undefined && !params.cell_id) {
      return { success: false, error: 'Must provide either cell_index or cell_id' };
    }

    const maxWait = params.max_wait ?? 10;
    const saveOutputs = params.save_outputs ?? true;

    // Execute via operation router (routes to UI if connected, else headless)
    // This ensures UI shows running indicator when connected
    const result = await client.executeCellOp(params.path, {
      cellId: params.cell_id,
      cellIndex: params.cell_index,
      sessionId: params.session_id,
      maxWait,
      saveOutputs,
    });

    if (!result.success) {
      return { success: false, error: result.error };
    }

    const { cellId, executionStatus, executionTime, outputs } = result.data!;
    const elapsed = (executionTime ?? 0) / 1000;

    // Read outputs via backend with truncation applied
    // This ensures truncation is consistent with read_notebook and read_output
    const outputResult = await client.readCellOutputOp(params.path, {
      cellId,
      maxLines: params.max_lines,
      maxChars: params.max_chars,
    });

    const truncatedOutputs = outputResult.success
      ? outputResult.data?.outputs ?? outputs
      : outputs;

    return {
      success: true,
      data: {
        cellId,
        outputs: truncatedOutputs as TruncatedOutput[],
        elapsed,
        saved: saveOutputs,
        status: executionStatus,
      },
    };
  },

  async formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { cellId, outputs, elapsed, saved, status } = result.data!;
    const savedMsg = saved ? ' (outputs saved)' : '';
    const statusMsg = status === 'busy' ? ' [still running - use read_output to poll]' : '';

    if (outputs.length === 0) {
      return [{ type: 'text', text: `Cell ${cellId} executed in ${elapsed.toFixed(1)}s${savedMsg}${statusMsg} (no output)` }];
    }

    return [
      { type: 'text', text: `Cell ${cellId} executed in ${elapsed.toFixed(1)}s${savedMsg}${statusMsg}:\n` },
      ...(await formatOutputs(outputs)),
    ];
  },
};

// =============================================================================
// Export all execution tools
// =============================================================================

export const executionTools = [
  executeCellTool,
];
