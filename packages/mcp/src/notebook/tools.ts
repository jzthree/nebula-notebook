/**
 * Notebook tools for agent integration
 */

import type { NebulaClient, WriteCellResult } from './client.js';
import type { ToolResult, NotebookCell, Notebook } from '../types.js';

// ===========================================================================
// Tool: Read Notebook Cells
// ===========================================================================

export interface ReadCellsParams {
  /** Path to the notebook */
  notebookPath: string;
  /** Specific cell indices to read (0-indexed). If omitted, reads all cells. */
  cellIndices?: number[];
  /** Include cell outputs */
  includeOutputs?: boolean;
}

export interface ReadCellsResult {
  cells: NotebookCell[];
  totalCells: number;
}

export async function readNotebookCells(
  params: ReadCellsParams,
  client: NebulaClient
): Promise<ToolResult<ReadCellsResult>> {
  const result = await client.readNotebookViaRouter(params.notebookPath);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const notebook = result.data!;
  let cells = notebook.cells;

  if (params.cellIndices) {
    cells = params.cellIndices
      .filter((i: number) => i >= 0 && i < notebook.cells.length)
      .map((i: number) => notebook.cells[i]);
  }

  if (!params.includeOutputs) {
    cells = cells.map((c: NotebookCell) => ({ ...c, outputs: undefined }));
  }

  return {
    success: true,
    data: {
      cells,
      totalCells: notebook.cells.length,
    },
  };
}

// ===========================================================================
// Tool: Write/Update Cell
// ===========================================================================

export interface WriteCellParams {
  /** Path to the notebook */
  notebookPath: string;
  /** Cell index to update (0-indexed), or -1 to append */
  cellIndex: number;
  /** Cell content */
  content: string;
  /** Cell type (default: code) */
  cellType?: 'code' | 'markdown';
}

// WriteCellResult is imported from client.ts (no re-export to avoid conflicts)

export async function writeNotebookCell(
  params: WriteCellParams,
  client: NebulaClient
): Promise<ToolResult<WriteCellResult>> {
  const cellType = params.cellType || 'code';

  if (params.cellIndex === -1) {
    // Append new cell
    const newCell = {
      id: `cell-${Date.now()}`,
      type: cellType,
      content: params.content,
    };
    const insertResult = await client.insertCellOp(params.notebookPath, -1, newCell);
    if (!insertResult.success) {
      return { success: false, error: insertResult.error };
    }

    // Get total cell count
    const notebookResult = await client.readNotebookViaRouter(params.notebookPath);
    const totalCells = notebookResult.success ? notebookResult.data!.cells.length : insertResult.data!.cellIndex + 1;

    return {
      success: true,
      data: {
        cellIndex: insertResult.data!.cellIndex,
        cellId: insertResult.data!.cellId,
        totalCells,
      },
    };
  } else {
    // Update existing cell - first read to get cell id and validate index
    const readResult = await client.readCellOp(params.notebookPath, { cellIndex: params.cellIndex });
    if (!readResult.success) {
      return { success: false, error: readResult.error || `Invalid cell index: ${params.cellIndex}` };
    }

    const cellId = readResult.data!.cell.id;

    // Update content
    const contentResult = await client.updateContentOp(params.notebookPath, cellId, params.content);
    if (!contentResult.success) {
      return { success: false, error: contentResult.error };
    }

    // Update type if different
    if (cellType !== readResult.data!.cell.type) {
      const metaResult = await client.updateMetadataOp(params.notebookPath, cellId, { type: cellType });
      if (!metaResult.success) {
        return { success: false, error: metaResult.error };
      }
    }

    // Get total cell count
    const notebookResult = await client.readNotebookViaRouter(params.notebookPath);
    const totalCells = notebookResult.success ? notebookResult.data!.cells.length : params.cellIndex + 1;

    return {
      success: true,
      data: {
        cellIndex: params.cellIndex,
        cellId,
        totalCells,
      },
    };
  }
}

// ===========================================================================
// Tool: Execute Cell
// ===========================================================================

export interface ExecuteCellParams {
  /** Kernel session ID */
  sessionId: string;
  /** Code to execute */
  code: string;
}

export interface ExecuteCellResult {
  outputs: Array<{ type: string; content: string }>;
  success: boolean;
  error?: string;
}

export async function executeCell(
  params: ExecuteCellParams,
  client: NebulaClient
): Promise<ToolResult<ExecuteCellResult>> {
  const result = await client.executeCode(params.sessionId, params.code);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    data: {
      outputs: result.data!.outputs,
      success: result.data!.success,
      error: result.data!.error,
    },
  };
}

// ===========================================================================
// Tool: Search Cells (for RAG)
// ===========================================================================

export interface SearchCellsParams {
  /** Path to the notebook */
  notebookPath: string;
  /** Search query */
  query: string;
  /** Maximum number of cells to return */
  limit?: number;
  /** Include cell outputs in results */
  includeOutputs?: boolean;
}

export interface SearchCellsResult {
  cells: Array<NotebookCell & { index: number; score: number }>;
  totalCells: number;
}

/**
 * Simple keyword-based cell search (can be enhanced with embeddings later)
 */
export async function searchNotebookCells(
  params: SearchCellsParams,
  client: NebulaClient
): Promise<ToolResult<SearchCellsResult>> {
  const result = await client.readNotebookViaRouter(params.notebookPath);
  if (!result.success) {
    return { success: false, error: result.error };
  }

  const notebook = result.data!;
  const limit = params.limit || 5;
  const queryLower = params.query.toLowerCase();
  const queryTerms = queryLower.split(/\s+/).filter((t: string) => t.length > 2);

  // Score each cell by keyword overlap
  const scored = notebook.cells.map((cell: NotebookCell, index: number) => {
    const contentLower = cell.content.toLowerCase();
    const outputText = (cell.outputs || [])
      .map((o: { content: string }) => o.content)
      .join(' ')
      .toLowerCase();
    const fullText = contentLower + ' ' + outputText;

    // Simple TF-based scoring
    let score = 0;
    for (const term of queryTerms) {
      const matches = (fullText.match(new RegExp(term, 'g')) || []).length;
      score += matches;
    }

    // Boost exact phrase match
    if (fullText.includes(queryLower)) {
      score += 10;
    }

    return {
      ...cell,
      index,
      score,
      outputs: params.includeOutputs ? cell.outputs : undefined,
    };
  });

  // Sort by score descending, filter out zero scores
  const results = scored
    .filter((c: { score: number }) => c.score > 0)
    .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
    .slice(0, limit);

  return {
    success: true,
    data: {
      cells: results,
      totalCells: notebook.cells.length,
    },
  };
}

// ===========================================================================
// Tool Definitions
// ===========================================================================

export const readCellsToolDefinition = {
  name: 'notebook_read_cells',
  description: 'Read cells from a Jupyter notebook',
  parameters: {
    type: 'object' as const,
    properties: {
      notebookPath: { type: 'string', description: 'Path to the notebook file' },
      cellIndices: { type: 'array', description: 'Specific cell indices to read (0-indexed)', items: { type: 'number' } },
      includeOutputs: { type: 'boolean', description: 'Include cell outputs (default: false)' },
    },
    required: ['notebookPath'],
  },
};

export const writeCellToolDefinition = {
  name: 'notebook_write_cell',
  description: 'Write or update a cell in a Jupyter notebook',
  parameters: {
    type: 'object' as const,
    properties: {
      notebookPath: { type: 'string', description: 'Path to the notebook file' },
      cellIndex: { type: 'number', description: 'Cell index to update (0-indexed), or -1 to append' },
      content: { type: 'string', description: 'Cell content' },
      cellType: { type: 'string', description: 'Cell type: "code" or "markdown"' },
    },
    required: ['notebookPath', 'cellIndex', 'content'],
  },
};

export const executeCellToolDefinition = {
  name: 'notebook_execute',
  description: 'Execute code in a notebook kernel session',
  parameters: {
    type: 'object' as const,
    properties: {
      sessionId: { type: 'string', description: 'Kernel session ID' },
      code: { type: 'string', description: 'Code to execute' },
    },
    required: ['sessionId', 'code'],
  },
};

export const searchCellsToolDefinition = {
  name: 'notebook_search',
  description: 'Search notebook cells by keyword (for finding relevant context)',
  parameters: {
    type: 'object' as const,
    properties: {
      notebookPath: { type: 'string', description: 'Path to the notebook file' },
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default: 5)' },
      includeOutputs: { type: 'boolean', description: 'Include cell outputs' },
    },
    required: ['notebookPath', 'query'],
  },
};

// ===========================================================================
// Tool: Read Single Cell
// ===========================================================================

export interface ReadCellParams {
  /** Path to the notebook */
  notebookPath: string;
  /** Cell ID to read */
  cellId?: string;
  /** Cell index to read (0-indexed) */
  cellIndex?: number;
}

export interface ReadCellResult {
  cell: NotebookCell;
  cellIndex: number;
}

/**
 * Read a single cell from a notebook.
 * More efficient than reading the entire notebook when you only need one cell.
 */
export async function readCell(
  params: ReadCellParams,
  client: NebulaClient
): Promise<ToolResult<ReadCellResult>> {
  if (!params.cellId && params.cellIndex === undefined) {
    return { success: false, error: 'Must provide cellId or cellIndex' };
  }

  const result = await client.readCellOp(params.notebookPath, {
    cellId: params.cellId,
    cellIndex: params.cellIndex,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    data: {
      cell: result.data!.cell,
      cellIndex: result.data!.cellIndex,
    },
  };
}

export const readCellToolDefinition = {
  name: 'notebook_read_cell',
  description: 'Read a single cell from a notebook by ID or index. More efficient than reading the entire notebook.',
  parameters: {
    type: 'object' as const,
    properties: {
      notebookPath: { type: 'string', description: 'Path to the notebook file' },
      cellId: { type: 'string', description: 'Cell ID to read' },
      cellIndex: { type: 'number', description: 'Cell index to read (0-indexed)' },
    },
    required: ['notebookPath'],
  },
};

// ===========================================================================
// Tool: Read Cell Output
// ===========================================================================

export interface ReadCellOutputParams {
  /** Path to the notebook */
  notebookPath: string;
  /** Cell ID to read outputs from */
  cellId?: string;
  /** Cell index to read outputs from (0-indexed) */
  cellIndex?: number;
}

export interface ReadCellOutputResult {
  cellId: string;
  cellIndex: number;
  outputs: Array<{ type: string; content: string }>;
  executionCount?: number;
}

/**
 * Read outputs from a single cell.
 * More efficient than reading the entire notebook when you only need cell outputs.
 */
export async function readCellOutput(
  params: ReadCellOutputParams,
  client: NebulaClient
): Promise<ToolResult<ReadCellOutputResult>> {
  if (!params.cellId && params.cellIndex === undefined) {
    return { success: false, error: 'Must provide cellId or cellIndex' };
  }

  const result = await client.readCellOutputOp(params.notebookPath, {
    cellId: params.cellId,
    cellIndex: params.cellIndex,
  });

  if (!result.success) {
    return { success: false, error: result.error };
  }

  return {
    success: true,
    data: {
      cellId: result.data!.cellId,
      cellIndex: result.data!.cellIndex,
      outputs: result.data!.outputs,
      executionCount: result.data!.executionCount,
    },
  };
}

export const readCellOutputToolDefinition = {
  name: 'notebook_read_cell_output',
  description: 'Read outputs from a single cell by ID or index. More efficient than reading the entire notebook.',
  parameters: {
    type: 'object' as const,
    properties: {
      notebookPath: { type: 'string', description: 'Path to the notebook file' },
      cellId: { type: 'string', description: 'Cell ID to read outputs from' },
      cellIndex: { type: 'number', description: 'Cell index to read outputs from (0-indexed)' },
    },
    required: ['notebookPath'],
  },
};
