/**
 * Headless Operation Handler
 *
 * Handles notebook operations when no UI is connected to Nebula.
 * Mirrors useOperationHandler (React) but operates on files instead of UI state.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { v4 as uuidv4 } from 'uuid';
import { FilesystemService } from '../fs/fs-service';
import { NebulaCell, CellOutput } from '../fs/types';
import { validateMetadataValue } from './cell-metadata';

// Helper to create a CellOutput (API-compatible format matching Python)
function createCellOutput(type: CellOutput['type'], content: string): CellOutput {
  return {
    type,
    content,
  };
}

// Output truncation defaults
const OUTPUT_DEFAULT_MAX_LINES = 100;
const OUTPUT_DEFAULT_MAX_CHARS = 10000;
const OUTPUT_DEFAULT_MAX_LINES_ERROR = 200;
const OUTPUT_DEFAULT_MAX_CHARS_ERROR = 20000;

interface NotebookCache {
  cells: NebulaCell[];
  metadata: Record<string, unknown>;
  dirty: boolean;
}

interface OperationResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

interface TruncationMetadata {
  truncated: boolean;
  truncation_reason?: string | null;
  total_lines: number;
  total_chars: number;
  returned_range: {
    start_line: number;
    end_line: number;
    char_count: number;
  };
}

export class HeadlessOperationHandler {
  private fsService: FilesystemService;
  private operationRouter: { startAgentSession: (path: string) => void; endAgentSession: (path: string) => void } | null;
  private cache: Map<string, NotebookCache> = new Map();
  private writeLocks: Map<string, Promise<void>> = new Map();

  constructor(
    fsService: FilesystemService,
    operationRouter?: { startAgentSession: (path: string) => void; endAgentSession: (path: string) => void }
  ) {
    this.fsService = fsService;
    this.operationRouter = operationRouter || null;
  }

  /**
   * Get notebook from cache, loading from disk if needed.
   */
  private getCachedNotebook(notebookPath: string): NotebookCache {
    if (!this.cache.has(notebookPath)) {
      const result = this.fsService.getNotebookCells(notebookPath);
      this.cache.set(notebookPath, {
        cells: result.cells || [],
        metadata: typeof result.kernelspec === 'string' ? { name: result.kernelspec } : (result.kernelspec as Record<string, unknown>) || {},
        dirty: false,
      });
    }
    return this.cache.get(notebookPath)!;
  }

  private getCells(notebookPath: string): NebulaCell[] {
    return this.getCachedNotebook(notebookPath).cells;
  }

  private saveCells(notebookPath: string, cells: NebulaCell[]): void {
    const notebook = this.getCachedNotebook(notebookPath);
    notebook.cells = cells;
    notebook.dirty = true;
  }

  /**
   * Persist dirty notebooks to disk.
   */
  async flush(notebookPath?: string): Promise<void> {
    const paths = notebookPath ? [notebookPath] : Array.from(this.cache.keys());

    for (const p of paths) {
      const notebook = this.cache.get(p);
      if (notebook?.dirty) {
        await this.asyncPersist(p);
      }
    }
  }

  private async asyncPersist(notebookPath: string): Promise<void> {
    const notebook = this.cache.get(notebookPath);
    if (!notebook) return;

    // Keep writing while dirty
    while (notebook.dirty) {
      const cells = JSON.parse(JSON.stringify(notebook.cells));
      notebook.dirty = false;
      this.fsService.saveNotebookCells(notebookPath, cells);
    }
  }

  private schedulePersist(notebookPath: string): void {
    // Schedule async persist
    this.asyncPersist(notebookPath).catch(err => {
      console.error(`[HeadlessHandler] Failed to persist ${notebookPath}:`, err);
    });
  }

  /**
   * Invalidate cache for a notebook.
   */
  invalidate(notebookPath?: string): void {
    if (notebookPath) {
      this.cache.delete(notebookPath);
    } else {
      this.cache.clear();
    }
  }

  /**
   * Check if notebook has unsaved changes.
   */
  isDirty(notebookPath: string): boolean {
    return this.cache.get(notebookPath)?.dirty || false;
  }

  /**
   * Check if agent has permission to modify this notebook.
   */
  private checkAgentPermission(notebookPath: string, _operationType: string): OperationResult | null {
    if (this.fsService.isAgentPermitted(notebookPath)) {
      const metadata = this.fsService.getNotebookMetadata(notebookPath);
      const nebula = (metadata.nebula || {}) as Record<string, unknown>;

      if (nebula.agent_created) {
        return null; // Agent-created notebooks are always modifiable
      }

      if (!this.fsService.hasHistory(notebookPath)) {
        return {
          success: false,
          error: `Agent cannot modify "${notebookPath}": notebook is user-permitted but history is not enabled. Open the notebook in the UI first to enable history tracking, or the agent can create a new notebook.`,
        };
      }
      return null;
    }

    return {
      success: false,
      error: `Agent cannot modify "${notebookPath}": notebook is not agent-permitted. Either open the notebook in Nebula UI and grant agent permission, or the agent can create a new notebook which will be automatically permitted.`,
    };
  }

  /**
   * Apply a notebook operation.
   */
  async applyOperation(operation: Record<string, unknown>): Promise<OperationResult> {
    const opType = operation.type as string;
    const notebookPath = (operation.notebookPath as string) || '';

    // Read-only operations
    const readOnlyOps = new Set(['readCell', 'readCellOutput', 'searchCells', 'startAgentSession', 'endAgentSession']);
    const permissionExemptOps = new Set(['createNotebook', 'readCell', 'readCellOutput', 'searchCells', 'startAgentSession', 'endAgentSession']);

    // Check permission for write operations
    if (!permissionExemptOps.has(opType) && notebookPath) {
      const permissionError = this.checkAgentPermission(notebookPath, opType);
      if (permissionError) {
        return permissionError;
      }
    }

    try {
      let result: OperationResult;

      switch (opType) {
        case 'insertCell':
          result = await this.insertCell(operation);
          break;
        case 'deleteCell':
          result = await this.deleteCell(operation);
          break;
        case 'updateContent':
          result = await this.updateContent(operation);
          break;
        case 'updateMetadata':
          result = await this.updateMetadata(operation);
          break;
        case 'moveCell':
          result = await this.moveCell(operation);
          break;
        case 'duplicateCell':
          result = await this.duplicateCell(operation);
          break;
        case 'updateOutputs':
          result = await this.updateOutputs(operation);
          break;
        case 'createNotebook':
          result = await this.createNotebook(operation);
          break;
        case 'readCell':
          result = await this.readCell(operation);
          break;
        case 'readCellOutput':
          result = await this.readCellOutput(operation);
          break;
        case 'clearNotebook':
          result = await this.clearNotebook(operation);
          break;
        case 'deleteCells':
          result = await this.deleteCells(operation);
          break;
        case 'insertCells':
          result = await this.insertCells(operation);
          break;
        case 'searchCells':
          result = await this.searchCells(operation);
          break;
        case 'clearOutputs':
          result = await this.clearOutputs(operation);
          break;
        case 'executeCell':
          // Node.js server doesn't have kernel support - execution requires Python backend
          return {
            success: false,
            error: 'Cell execution requires the Python backend with kernel support. The Node.js server does not support kernel execution.',
          };
        case 'startAgentSession':
          if (this.operationRouter) {
            this.operationRouter.startAgentSession(notebookPath);
          }
          result = { success: true };
          break;
        case 'endAgentSession':
          if (this.operationRouter) {
            this.operationRouter.endAgentSession(notebookPath);
          }
          result = { success: true };
          break;
        case 'undo':
          return { success: false, error: 'Undo requires the notebook to be open in the browser. Undo state is maintained in the UI.' };
        case 'redo':
          return { success: false, error: 'Redo requires the notebook to be open in the browser. Redo state is maintained in the UI.' };
        default:
          return { success: false, error: `Unknown operation type: ${opType}` };
      }

      // Schedule persist for write operations
      if (result.success && !readOnlyOps.has(opType) && notebookPath) {
        this.schedulePersist(notebookPath);
      }

      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Read notebook from cache with optional output truncation.
   */
  async readNotebook(
    notebookPath: string,
    includeOutputs = true,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): Promise<OperationResult> {
    try {
      const notebook = this.getCachedNotebook(notebookPath);
      let cells = notebook.cells;

      if (includeOutputs) {
        const effectiveMaxLines = maxLines ?? OUTPUT_DEFAULT_MAX_LINES;
        const effectiveMaxChars = maxChars ?? OUTPUT_DEFAULT_MAX_CHARS;
        const effectiveMaxLinesError = maxLinesError ?? OUTPUT_DEFAULT_MAX_LINES_ERROR;
        const effectiveMaxCharsError = maxCharsError ?? OUTPUT_DEFAULT_MAX_CHARS_ERROR;
        cells = this.truncateCellOutputs(cells, effectiveMaxLines, effectiveMaxChars, effectiveMaxLinesError, effectiveMaxCharsError);
      } else {
        cells = cells.map(cell => ({ ...cell, outputs: [] }));
      }

      return {
        success: true,
        data: {
          path: notebookPath,
          cells,
          metadata: notebook.metadata,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  private truncateCellOutputs(
    cells: NebulaCell[],
    maxLines: number,
    maxChars: number,
    maxLinesError: number,
    maxCharsError: number
  ): NebulaCell[] {
    return cells.map(cell => ({
      ...cell,
      outputs: (cell.outputs || []).map(output => {
        const outputType = output.type || 'stdout';
        const content = output.content || '';

        // Skip truncation for binary/image outputs
        if (outputType === 'image' || outputType === 'html') {
          return output;
        }

        // Use separate limits for error outputs
        const linesLimit = outputType === 'error' ? maxLinesError : maxLines;
        const charsLimit = outputType === 'error' ? maxCharsError : maxChars;

        const { truncatedContent } = this.truncateOutput(content, linesLimit, charsLimit, 0);

        return {
          ...output,
          content: truncatedContent,
        };
      }),
    }));
  }

  private truncateOutput(
    content: string,
    maxLines: number,
    maxChars: number,
    lineOffset = 0
  ): { truncatedContent: string; metadata: TruncationMetadata } {
    const lines = content.split('\n');
    const totalLines = lines.length;
    const totalChars = content.length;

    const offsetLines = lines.slice(lineOffset);
    const startLine = lineOffset;
    let endLine = startLine;
    let charCount = 0;
    let truncated = false;
    let truncationReason: string | null = null;
    const resultLines: string[] = [];

    for (let i = 0; i < offsetLines.length; i++) {
      const line = offsetLines[i];
      const newCharCount = charCount + line.length + (i > 0 ? 1 : 0);

      if (i >= maxLines) {
        truncated = true;
        truncationReason = 'lines';
        break;
      }

      if (newCharCount > maxChars && i > 0) {
        truncated = true;
        truncationReason = 'chars';
        break;
      }

      resultLines.push(line);
      charCount = newCharCount;
      endLine = startLine + i + 1;
    }

    const truncatedContent = resultLines.join('\n');

    return {
      truncatedContent,
      metadata: {
        truncated,
        truncation_reason: truncationReason,
        total_lines: totalLines,
        total_chars: totalChars,
        returned_range: {
          start_line: startLine,
          end_line: endLine,
          char_count: truncatedContent.length,
        },
      },
    };
  }

  // Operation implementations

  private async insertCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const index = operation.index as number;
    const cellData = operation.cell as Record<string, unknown>;

    const cells = this.getCells(notebookPath);
    let cellId = cellData.id as string;
    const existingIds = new Set(cells.map(c => c.id));
    const originalId = cellId;
    let idModified = false;

    if (existingIds.has(cellId)) {
      let counter = 2;
      while (existingIds.has(`${originalId}-${counter}`)) {
        counter++;
      }
      cellId = `${originalId}-${counter}`;
      idModified = true;
    }

    const newCell: NebulaCell = {
      id: cellId,
      type: (cellData.type as 'code' | 'markdown') || 'code',
      content: (cellData.content as string) || '',
      outputs: [],
      isExecuting: false,
      executionCount: null,
    };

    let actualIndex: number;
    if (index === -1 || index >= cells.length) {
      cells.push(newCell);
      actualIndex = cells.length - 1;
    } else {
      cells.splice(index, 0, newCell);
      actualIndex = index;
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId,
      cellIndex: actualIndex,
      idModified,
      requestedId: idModified ? originalId : null,
      totalCells: cells.length,
    };
  }

  private async deleteCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    const cellIndex = operation.cellIndex as number | undefined;

    const cells = this.getCells(notebookPath);

    let targetIndex: number | null = null;
    if (cellId) {
      targetIndex = cells.findIndex(c => c.id === cellId);
      if (targetIndex === -1) targetIndex = null;
    } else if (cellIndex !== undefined) {
      targetIndex = cellIndex;
    }

    if (targetIndex === null || targetIndex >= cells.length) {
      return { success: false, error: 'Cell not found' };
    }

    cells.splice(targetIndex, 1);
    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellIndex: targetIndex,
      totalCells: cells.length,
    };
  }

  private async updateContent(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string;
    const content = operation.content as string;

    const cells = this.getCells(notebookPath);
    const targetIndex = cells.findIndex(c => c.id === cellId);

    if (targetIndex === -1) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    cells[targetIndex].content = content;
    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId,
      cellIndex: targetIndex,
    };
  }

  private async updateMetadata(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string;
    const changes = operation.changes as Record<string, unknown>;

    // Validate all changes
    const errors: string[] = [];
    for (const [key, value] of Object.entries(changes)) {
      const validation = validateMetadataValue(key, value);
      if (!validation.valid) {
        errors.push(validation.error || `Invalid field: ${key}`);
      }
    }
    if (errors.length > 0) {
      return { success: false, error: errors.join('; ') };
    }

    const cells = this.getCells(notebookPath);
    const targetIndex = cells.findIndex(c => c.id === cellId);

    if (targetIndex === -1) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    const cell = cells[targetIndex];
    const oldValues: Record<string, unknown> = {};

    // Handle ID change specially
    if ('id' in changes) {
      const newId = changes.id as string;
      const existingIds = new Set(cells.map(c => c.id));
      existingIds.delete(cellId);

      let actualNewId = newId;
      let idModified = false;

      if (existingIds.has(newId)) {
        let counter = 2;
        while (existingIds.has(`${newId}-${counter}`)) {
          counter++;
        }
        actualNewId = `${newId}-${counter}`;
        idModified = true;
      }

      oldValues.id = cellId;
      cell.id = actualNewId;
    }

    // Apply other changes
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'id') continue;
      oldValues[key] = (cell as unknown as Record<string, unknown>)[key];
      (cell as unknown as Record<string, unknown>)[key] = value;
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId: cell.id,
      cellIndex: targetIndex,
      changes: Object.fromEntries(
        Object.entries(changes).map(([k, v]) => [k, { old: oldValues[k], new: v }])
      ),
    };
  }

  private async moveCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    let fromIndex = operation.fromIndex as number | undefined;
    let toIndex = operation.toIndex as number | undefined;
    const afterCellId = operation.afterCellId as string | undefined;

    const cells = this.getCells(notebookPath);

    // Determine source
    if (cellId) {
      fromIndex = cells.findIndex(c => c.id === cellId);
      if (fromIndex === -1) {
        return { success: false, error: `Cell with ID "${cellId}" not found` };
      }
    } else if (fromIndex === undefined) {
      return { success: false, error: 'Must provide cellId or fromIndex' };
    }

    if (fromIndex < 0 || fromIndex >= cells.length) {
      return { success: false, error: 'Invalid fromIndex' };
    }

    // Determine target
    if (afterCellId) {
      const afterIndex = cells.findIndex(c => c.id === afterCellId);
      if (afterIndex === -1) {
        return { success: false, error: `Cell with ID "${afterCellId}" not found` };
      }
      toIndex = afterIndex + 1;
      if (fromIndex < toIndex) {
        toIndex--;
      }
    } else if (toIndex === -1) {
      toIndex = 0;
    } else if (toIndex === undefined) {
      return { success: false, error: 'Must provide afterCellId or toIndex' };
    }

    if (toIndex < 0 || toIndex >= cells.length) {
      return { success: false, error: 'Invalid toIndex' };
    }

    // Perform move
    const [cell] = cells.splice(fromIndex, 1);
    cells.splice(toIndex, 0, cell);
    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId: cell.id,
      fromIndex,
      toIndex,
    };
  }

  private async duplicateCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellIndex = operation.cellIndex as number;
    const newCellId = operation.newCellId as string;

    const cells = this.getCells(notebookPath);

    if (cellIndex < 0 || cellIndex >= cells.length) {
      return { success: false, error: 'Invalid cellIndex' };
    }

    const originalCell = cells[cellIndex];
    const existingIds = new Set(cells.map(c => c.id));

    let actualId = newCellId;
    let idModified = false;

    if (existingIds.has(newCellId)) {
      let counter = 2;
      while (existingIds.has(`${newCellId}-${counter}`)) {
        counter++;
      }
      actualId = `${newCellId}-${counter}`;
      idModified = true;
    }

    const newCell: NebulaCell = {
      ...JSON.parse(JSON.stringify(originalCell)),
      id: actualId,
      outputs: [],
      isExecuting: false,
      executionCount: null,
    };

    cells.splice(cellIndex + 1, 0, newCell);
    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId: actualId,
      cellIndex: cellIndex + 1,
      idModified,
      totalCells: cells.length,
    };
  }

  private async updateOutputs(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string;
    const outputs = operation.outputs as CellOutput[];
    const executionCount = operation.executionCount as number | undefined;

    const cells = this.getCells(notebookPath);
    const targetIndex = cells.findIndex(c => c.id === cellId);

    if (targetIndex === -1) {
      return { success: false, error: `Cell with ID "${cellId}" not found` };
    }

    cells[targetIndex].outputs = outputs.map(o => createCellOutput(
      (o.type || 'stdout') as CellOutput['type'],
      o.content || ''
    ));

    if (executionCount !== undefined) {
      cells[targetIndex].executionCount = executionCount;
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      cellId,
      cellIndex: targetIndex,
    };
  }

  private async createNotebook(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const overwrite = (operation.overwrite as boolean) || false;
    const kernelName = (operation.kernelName as string) || 'python3';
    const kernelDisplayName = (operation.kernelDisplayName as string) || 'Python 3';

    const normalizedPath = this.fsService.normalizePath(notebookPath);

    if (fs.existsSync(normalizedPath) && !overwrite) {
      return {
        success: false,
        error: `Notebook already exists: ${notebookPath}. Use overwrite=true to replace.`,
      };
    }

    const notebook = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: {
          name: kernelName,
          display_name: kernelDisplayName,
        },
        language_info: {
          name: 'python',
        },
        nebula: {
          agent_created: true,
          agent_permitted: true,
        },
      },
      cells: [],
    };

    const dir = path.dirname(normalizedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(normalizedPath, JSON.stringify(notebook, null, 2), 'utf-8');

    this.invalidate(notebookPath);

    const mtime = fs.statSync(normalizedPath).mtimeMs / 1000; // Convert to seconds like Python

    return {
      success: true,
      path: notebookPath,
      mtime,
    };
  }

  private async readCell(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    const cellIndex = operation.cellIndex as number | undefined;

    const cells = this.getCells(notebookPath);

    let targetIndex: number | null = null;
    let cell: NebulaCell | null = null;

    if (cellId) {
      targetIndex = cells.findIndex(c => c.id === cellId);
      if (targetIndex === -1) {
        return { success: false, error: `Cell with ID "${cellId}" not found` };
      }
      cell = cells[targetIndex];
    } else if (cellIndex !== undefined) {
      if (cellIndex < 0 || cellIndex >= cells.length) {
        return { success: false, error: `Cell index ${cellIndex} out of range` };
      }
      targetIndex = cellIndex;
      cell = cells[cellIndex];
    } else {
      return { success: false, error: 'Must provide cellId or cellIndex' };
    }

    return {
      success: true,
      cellId: cell.id,
      cellIndex: targetIndex,
      cell: {
        id: cell.id,
        type: cell.type,
        content: cell.content || '',
        outputs: (cell.outputs || []).map(o => ({ type: o.type, content: o.content || '' })),
        executionCount: cell.executionCount,
        metadata: {
          scrolled: cell.scrolled,
          scrolledHeight: cell.scrolledHeight,
        },
      },
    };
  }

  private async readCellOutput(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    const cellIndex = operation.cellIndex as number | undefined;
    const maxLines = (operation.max_lines as number) ?? OUTPUT_DEFAULT_MAX_LINES;
    const maxChars = (operation.max_chars as number) ?? OUTPUT_DEFAULT_MAX_CHARS;
    const maxLinesError = (operation.max_lines_error as number) ?? OUTPUT_DEFAULT_MAX_LINES_ERROR;
    const maxCharsError = (operation.max_chars_error as number) ?? OUTPUT_DEFAULT_MAX_CHARS_ERROR;
    const lineOffset = (operation.line_offset as number) ?? 0;
    const saveToFile = (operation.save_to_file as boolean) ?? false;

    const cells = this.getCells(notebookPath);

    let targetIndex: number | null = null;
    let cell: NebulaCell | null = null;

    if (cellId) {
      targetIndex = cells.findIndex(c => c.id === cellId);
      if (targetIndex === -1) {
        return { success: false, error: `Cell with ID "${cellId}" not found` };
      }
      cell = cells[targetIndex];
    } else if (cellIndex !== undefined) {
      if (cellIndex < 0 || cellIndex >= cells.length) {
        return { success: false, error: `Cell index ${cellIndex} out of range` };
      }
      targetIndex = cellIndex;
      cell = cells[cellIndex];
    } else {
      return { success: false, error: 'Must provide cellId or cellIndex' };
    }

    const processedOutputs: Record<string, unknown>[] = [];
    const tempFiles: string[] = [];

    for (const output of cell.outputs || []) {
      const outputType = output.type || 'stdout';
      const content = output.content || '';

      // Images are returned as-is
      if (outputType === 'image') {
        processedOutputs.push({
          type: outputType,
          content,
          truncated: false,
          is_binary: true,
        });
        continue;
      }

      // Save to temp file if requested
      let tempFilePath: string | undefined;
      if (saveToFile && content) {
        tempFilePath = this.saveOutputToTempFile(content, cell.id);
        tempFiles.push(tempFilePath);
      }

      // Use separate limits for errors
      const linesLimit = outputType === 'error' ? maxLinesError : maxLines;
      const charsLimit = outputType === 'error' ? maxCharsError : maxChars;

      const { truncatedContent, metadata } = this.truncateOutput(content, linesLimit, charsLimit, lineOffset);

      const processedOutput: Record<string, unknown> = {
        type: outputType,
        content: truncatedContent,
        ...metadata,
      };

      if (tempFilePath) {
        processedOutput.temp_file = tempFilePath;
        processedOutput.temp_file_size = content.length;
      }

      processedOutputs.push(processedOutput);
    }

    return {
      success: true,
      cellId: cell.id,
      cellIndex: targetIndex,
      outputs: processedOutputs,
      executionCount: cell.executionCount,
      output_count: processedOutputs.length,
      temp_files: tempFiles.length > 0 ? tempFiles : null,
    };
  }

  private saveOutputToTempFile(content: string, cellId: string): string {
    const tempDir = path.join(os.tmpdir(), 'nebula', 'outputs');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const filename = `cell_output_${cellId}_${uuidv4().slice(0, 8)}.txt`;
    const filepath = path.join(tempDir, filename);

    fs.writeFileSync(filepath, content, 'utf-8');
    return filepath;
  }

  private async clearNotebook(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;

    const cells = this.getCells(notebookPath);
    const deletedCount = cells.length;

    this.saveCells(notebookPath, []);

    return {
      success: true,
      deletedCount,
      totalCells: 0,
    };
  }

  private async deleteCells(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellIds = (operation.cellIds as string[]) || [];

    if (cellIds.length === 0) {
      return { success: false, error: 'No cell IDs provided' };
    }

    const cells = this.getCells(notebookPath);
    const deletedIds: string[] = [];
    const notFound: string[] = [];

    const indicesToDelete: number[] = [];
    for (const cellId of cellIds) {
      const idx = cells.findIndex(c => c.id === cellId);
      if (idx !== -1) {
        indicesToDelete.push(idx);
        deletedIds.push(cellId);
      } else {
        notFound.push(cellId);
      }
    }

    // Delete in reverse order
    for (const idx of indicesToDelete.sort((a, b) => b - a)) {
      cells.splice(idx, 1);
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      deletedCount: deletedIds.length,
      deletedIds,
      notFound: notFound.length > 0 ? notFound : null,
      totalCells: cells.length,
    };
  }

  private async insertCells(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const position = (operation.position as number) ?? -1;
    const newCells = (operation.cells as Record<string, unknown>[]) || [];

    if (newCells.length === 0) {
      return { success: false, error: 'No cells provided' };
    }

    const cells = this.getCells(notebookPath);
    const insertedCells: NebulaCell[] = [];

    for (let i = 0; i < newCells.length; i++) {
      const cellData = newCells[i];
      const cellId = (cellData.id as string) || `cell-${cells.length + i}-${Date.now()}`;
      insertedCells.push({
        id: cellId,
        type: (cellData.type as 'code' | 'markdown') || 'code',
        content: (cellData.content as string) || '',
        outputs: (cellData.outputs as CellOutput[]) || [],
        isExecuting: false,
        executionCount: (cellData.executionCount as number | null) ?? null,
      });
    }

    let insertIndex: number;
    if (position < 0 || position >= cells.length) {
      insertIndex = cells.length;
      cells.push(...insertedCells);
    } else {
      insertIndex = position;
      cells.splice(position, 0, ...insertedCells);
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      insertedCount: insertedCells.length,
      insertedIds: insertedCells.map(c => c.id),
      startIndex: insertIndex,
      totalCells: cells.length,
    };
  }

  private async searchCells(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const query = (operation.query as string) || '';
    const includeOutputs = (operation.includeOutputs as boolean) ?? false;
    const limit = (operation.limit as number) ?? 10;

    if (!query) {
      return { success: false, error: 'No search query provided' };
    }

    const cells = this.getCells(notebookPath);
    const queryLower = query.toLowerCase();
    const matches: Record<string, unknown>[] = [];

    for (let i = 0; i < cells.length && matches.length < limit; i++) {
      const cell = cells[i];
      const content = cell.content || '';

      // Search in source
      if (content.toLowerCase().includes(queryLower)) {
        const lines = content.split('\n');
        let matchLine: number | null = null;
        for (let j = 0; j < lines.length; j++) {
          if (lines[j].toLowerCase().includes(queryLower)) {
            matchLine = j;
            break;
          }
        }

        matches.push({
          cellId: cell.id,
          cellIndex: i,
          matchLocation: 'source',
          matchLine,
          preview: content.slice(0, 200) + (content.length > 200 ? '...' : ''),
        });
      }

      // Search in outputs
      if (includeOutputs) {
        for (let j = 0; j < (cell.outputs || []).length; j++) {
          const output = cell.outputs![j];
          const outContent = output.content || '';

          if (outContent.toLowerCase().includes(queryLower)) {
            matches.push({
              cellId: cell.id,
              cellIndex: i,
              matchLocation: 'output',
              outputIndex: j,
              outputType: output.type || 'unknown',
              preview: outContent.slice(0, 200) + (outContent.length > 200 ? '...' : ''),
            });
          }
        }
      }
    }

    return {
      success: true,
      query,
      matchCount: matches.length,
      matches: matches.slice(0, limit),
      hasMore: matches.length > limit,
    };
  }

  private async clearOutputs(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = operation.notebookPath as string;
    const cellId = operation.cellId as string | undefined;
    const cellIds = (operation.cellIds as string[]) || [];

    // Support both single ID and list
    const targetIds = cellId && cellIds.length === 0 ? [cellId] : cellIds;

    const cells = this.getCells(notebookPath);
    const clearedIds: string[] = [];
    const notFound: string[] = [];

    if (targetIds.length === 0) {
      // Clear all cells
      for (const cell of cells) {
        if (cell.outputs && cell.outputs.length > 0) {
          cell.outputs = [];
          cell.executionCount = null;
          clearedIds.push(cell.id);
        }
      }
    } else {
      // Clear specific cells
      for (const id of targetIds) {
        const cell = cells.find(c => c.id === id);
        if (cell) {
          cell.outputs = [];
          cell.executionCount = null;
          clearedIds.push(id);
        } else {
          notFound.push(id);
        }
      }
    }

    this.saveCells(notebookPath, cells);

    return {
      success: true,
      clearedCount: clearedIds.length,
      clearedIds,
      notFound: notFound.length > 0 ? notFound : null,
    };
  }
}
