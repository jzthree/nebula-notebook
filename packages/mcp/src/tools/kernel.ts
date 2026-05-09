/**
 * Kernel Tools
 *
 * Tools for managing Jupyter kernel sessions.
 */

import type { Tool, ToolResult, MCPContent } from './types.js';
import type { NebulaClient } from '../notebook/client.js';

async function resolveKernelSessionId(
  client: NebulaClient,
  notebookPath: string
): Promise<ToolResult<{ sessionId: string }>> {
  return client.resolveKernelSessionIdForNotebook(notebookPath, { createIfMissing: false });
}

// =============================================================================
// list_kernels
// =============================================================================

export interface ListKernelsParams {
  // No parameters needed
}

export interface KernelInfo {
  name: string;
  displayName: string;
  language: string;
}

export interface ListKernelsResult {
  kernels: KernelInfo[];
}

export const listKernelsTool: Tool<ListKernelsParams, ListKernelsResult> = {
  definition: {
    name: 'list_kernels',
    description: 'List available kernel specifications with display names (includes version info)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { readOnlyHint: true },
  },

  async execute(_params, client) {
    const result = await client.listKernels();
    if (!result.success) {
      return { success: false, error: result.error };
    }
    return { success: true, data: { kernels: result.data || [] } };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { kernels } = result.data!;
    if (kernels.length === 0) {
      return [{ type: 'text', text: 'No kernels available' }];
    }
    const lines = kernels.map(k => `  - ${k.name}: ${k.displayName} [${k.language}]`);
    return [{ type: 'text', text: `Available kernels:\n${lines.join('\n')}` }];
  },
};

// =============================================================================
// kernel_start
// =============================================================================

export interface KernelStartParams {
  kernel_name?: string;
}

export interface KernelStartResult {
  sessionId: string;
  kernelName: string;
}

export const kernelStartTool: Tool<KernelStartParams, KernelStartResult> = {
  definition: {
    name: 'kernel_start',
    description: 'Start a new kernel session for the active notebook (requires start_agent_session)',
    inputSchema: {
      type: 'object',
      properties: {
        kernel_name: { type: 'string', description: 'Kernel name (e.g., python3). Default: python3.' },
      },
      required: [],
    },
    annotations: { destructiveHint: false },
  },

  async execute(params, client) {
    const notebookPath = client.getActiveNotebookPath();
    if (!notebookPath) {
      return { success: false, error: 'No active agent session. Call start_agent_session first.' };
    }
    const kernelName = params.kernel_name || 'python3';
    const result = await client.getOrCreateKernelForFile(notebookPath, kernelName);
    if (!result.success) return { success: false, error: result.error };
    return {
      success: true,
      data: {
        sessionId: result.data!.sessionId,
        kernelName: result.data!.kernelName || kernelName,
      },
    };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    const { sessionId, kernelName } = result.data!;
    return [{ type: 'text', text: `Kernel started: ${sessionId} (${kernelName})` }];
  },
};

// =============================================================================
// kernel_stop
// =============================================================================

export interface KernelStopParams {
}

export const kernelStopTool: Tool<KernelStopParams, void> = {
  definition: {
    name: 'kernel_stop',
    description: 'Stop and shutdown the active notebook kernel (requires start_agent_session)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    const notebookPath = client.getActiveNotebookPath();
    if (!notebookPath) {
      return { success: false, error: 'No active agent session. Call start_agent_session first.' };
    }
    const session = await resolveKernelSessionId(client, notebookPath);
    if (!session.success) return { success: false, error: session.error };
    const result = await client.shutdownKernel(session.data!.sessionId);
    return result.success ? { success: true } : { success: false, error: result.error };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: 'Kernel stopped' }];
  },
};

// =============================================================================
// kernel_restart
// =============================================================================

export interface KernelRestartParams {
}

export const kernelRestartTool: Tool<KernelRestartParams, void> = {
  definition: {
    name: 'kernel_restart',
    description: 'Restart the active notebook kernel (clears all variables, requires start_agent_session)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { destructiveHint: true },
  },

  async execute(params, client) {
    const notebookPath = client.getActiveNotebookPath();
    if (!notebookPath) {
      return { success: false, error: 'No active agent session. Call start_agent_session first.' };
    }
    // Prefer a robust restart over the direct restart endpoint, which can be flaky
    // depending on backend implementation. Shutdown (best effort), then start a new
    // session for this file.
    const existing = await resolveKernelSessionId(client, notebookPath);
    if (existing.success) {
      const stopped = await client.shutdownKernel(existing.data!.sessionId);
      // Ignore not-found errors: the session may have already been cleaned up.
      if (!stopped.success && !stopped.error?.includes('not found')) {
        return { success: false, error: stopped.error };
      }
    }

    const started = await client.getOrCreateKernelForFile(notebookPath, 'python3');
    return started.success ? { success: true } : { success: false, error: started.error };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: 'Kernel restarted' }];
  },
};

// =============================================================================
// kernel_interrupt
// =============================================================================

export interface KernelInterruptParams {
}

export const kernelInterruptTool: Tool<KernelInterruptParams, void> = {
  definition: {
    name: 'kernel_interrupt',
    description: 'Interrupt execution in the active notebook kernel (requires start_agent_session)',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
    annotations: { destructiveHint: false },
  },

  async execute(params, client) {
    const notebookPath = client.getActiveNotebookPath();
    if (!notebookPath) {
      return { success: false, error: 'No active agent session. Call start_agent_session first.' };
    }
    const session = await resolveKernelSessionId(client, notebookPath);
    if (!session.success) return { success: false, error: session.error };
    const result = await client.interruptKernel(session.data!.sessionId);
    return result.success ? { success: true } : { success: false, error: result.error };
  },

  formatForMCP(result) {
    if (!result.success) {
      return [{ type: 'text', text: `Error: ${result.error}` }];
    }
    return [{ type: 'text', text: 'Kernel interrupted' }];
  },
};

// =============================================================================
// Export all kernel tools
// =============================================================================

export const kernelTools = [
  listKernelsTool,
  kernelStartTool,
  kernelStopTool,
  kernelRestartTool,
  kernelInterruptTool,
];
