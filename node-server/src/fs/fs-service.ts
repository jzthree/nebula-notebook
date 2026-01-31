/**
 * Filesystem Service - Real filesystem operations
 *
 * Node.js port of the Python FilesystemService.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  FileInfo,
  FileInfoResponse,
  FileType,
  DirectoryListing,
  MtimeResponse,
  ReadFileResponse,
  NebulaCell,
  CellOutput,
  NotebookCellsResponse,
  SaveNotebookResult,
  JupyterNotebook,
  JupyterCell,
  JupyterOutput,
  NebulaConfig,
} from './types';

/**
 * Load root directory from .nebula-config.json if it exists
 */
function loadNebulaConfig(): string | null {
  try {
    const configPath = path.join(__dirname, '..', '..', '..', '.nebula-config.json');
    if (fs.existsSync(configPath)) {
      const config: NebulaConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return config.rootDirectory || null;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

export class FilesystemService {
  private defaultRoot: string;

  constructor(defaultRoot?: string) {
    // Priority: explicit arg > config file > home directory
    this.defaultRoot = defaultRoot || loadNebulaConfig() || os.homedir();
  }

  /**
   * Normalize and expand path
   */
  normalizePath(filePath: string): string {
    if (filePath === '~' || filePath === '') {
      return this.defaultRoot;
    }
    if (filePath.startsWith('~/')) {
      return path.join(this.defaultRoot, filePath.slice(2));
    }
    if (filePath.startsWith('~')) {
      // Handle ~user paths (rare in practice)
      return path.resolve(os.homedir(), '..', filePath.slice(1));
    }
    return path.resolve(filePath);
  }

  /**
   * Format file size for display
   */
  formatSize(size: number): string {
    if (size < 1024) {
      return `${size}B`;
    } else if (size < 1024 * 1024) {
      return `${(size / 1024).toFixed(1)}KB`;
    } else if (size < 1024 * 1024 * 1024) {
      return `${(size / (1024 * 1024)).toFixed(1)}MB`;
    } else {
      return `${(size / (1024 * 1024 * 1024)).toFixed(1)}GB`;
    }
  }

  /**
   * Determine file type from extension
   */
  getFileType(extension: string): FileType {
    const ext = extension.toLowerCase();
    if (ext === '.ipynb') {
      return 'notebook';
    } else if (['.py', '.js', '.ts', '.tsx', '.jsx', '.json', '.yaml', '.yml', '.toml', '.md', '.txt'].includes(ext)) {
      return 'code';
    } else if (['.csv', '.tsv', '.xlsx', '.xls'].includes(ext)) {
      return 'data';
    } else if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) {
      return 'image';
    } else if (ext === '.pdf') {
      return 'document';
    }
    return 'file';
  }

  /**
   * Get file info for a path
   */
  private getFileInfo(filePath: string): FileInfo {
    const stat = fs.statSync(filePath);
    const name = path.basename(filePath);
    const isDir = stat.isDirectory();

    return {
      name,
      path: filePath,
      isDirectory: isDir,
      size: isDir ? 0 : stat.size,
      modified: stat.mtimeMs / 1000, // Convert to seconds
      extension: isDir ? '' : path.extname(name),
    };
  }

  /**
   * Convert FileInfo to FileInfoResponse for API
   */
  private toFileInfoResponse(info: FileInfo): FileInfoResponse {
    return {
      id: info.path,
      name: info.name,
      path: info.path,
      isDirectory: info.isDirectory,
      size: this.formatSize(info.size),
      sizeBytes: info.size,
      modified: info.modified,
      extension: info.extension,
      fileType: info.isDirectory ? 'folder' : this.getFileType(info.extension),
    };
  }

  /**
   * Get directory modification time (lightweight check for changes)
   */
  getDirectoryMtime(dirPath: string): MtimeResponse {
    const normalizedPath = this.normalizePath(dirPath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Path not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    return {
      path: normalizedPath,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * Get file modification time
   */
  getFileMtime(filePath: string): MtimeResponse {
    const normalizedPath = this.normalizePath(filePath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    return {
      path: normalizedPath,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * List contents of a directory
   */
  listDirectory(dirPath: string): DirectoryListing {
    const normalizedPath = this.normalizePath(dirPath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Path not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    const items: FileInfoResponse[] = [];
    const entries = fs.readdirSync(normalizedPath);

    for (const name of entries) {
      // Skip hidden files
      if (name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(normalizedPath, name);
      try {
        const info = this.getFileInfo(fullPath);
        items.push(this.toFileInfoResponse(info));
      } catch {
        // Skip files we can't access
        continue;
      }
    }

    // Sort: directories first, then by name
    items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    });

    return {
      path: normalizedPath,
      parent: normalizedPath === '/' ? null : path.dirname(normalizedPath),
      mtime: stat.mtimeMs / 1000,
      items,
    };
  }

  /**
   * Read a file's contents
   */
  readFile(filePath: string): ReadFileResponse {
    const normalizedPath = this.normalizePath(filePath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${normalizedPath}`);
    }

    const extension = path.extname(normalizedPath).toLowerCase();

    if (extension === '.ipynb') {
      const content = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));
      return {
        path: normalizedPath,
        type: 'notebook',
        content,
      };
    }

    // Try to read as text
    try {
      const content = fs.readFileSync(normalizedPath, 'utf-8');
      return {
        path: normalizedPath,
        type: 'text',
        content,
      };
    } catch {
      // Binary file
      return {
        path: normalizedPath,
        type: 'binary',
        content: null,
        message: 'Binary file cannot be displayed',
      };
    }
  }

  /**
   * Write content to a file
   */
  writeFile(filePath: string, content: unknown, fileType: 'text' | 'notebook' = 'text'): boolean {
    const normalizedPath = this.normalizePath(filePath);

    // Create parent directories if needed
    const parentDir = path.dirname(normalizedPath);
    if (parentDir && !fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    if (fileType === 'notebook') {
      fs.writeFileSync(normalizedPath, JSON.stringify(content, null, 2), 'utf-8');
    } else {
      fs.writeFileSync(normalizedPath, content as string, 'utf-8');
    }

    return true;
  }

  /**
   * Create a new file or directory
   */
  createFile(filePath: string, isDirectory: boolean = false): FileInfo & { is_directory: boolean } {
    const normalizedPath = this.normalizePath(filePath);

    if (fs.existsSync(normalizedPath)) {
      throw new Error(`Path already exists: ${normalizedPath}`);
    }

    if (isDirectory) {
      fs.mkdirSync(normalizedPath, { recursive: true });
    } else {
      // Create parent directories if needed
      const parentDir = path.dirname(normalizedPath);
      if (parentDir && !fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
      }

      const extension = path.extname(normalizedPath).toLowerCase();
      if (extension === '.ipynb') {
        // Create empty notebook
        const notebook: JupyterNotebook = {
          cells: [],
          metadata: {
            kernelspec: {
              display_name: 'Python 3',
              language: 'python',
              name: 'python3',
            },
          },
          nbformat: 4,
          nbformat_minor: 5,
        };
        fs.writeFileSync(normalizedPath, JSON.stringify(notebook, null, 2), 'utf-8');
      } else {
        // Create empty file
        fs.writeFileSync(normalizedPath, '', 'utf-8');
      }
    }

    const info = this.getFileInfo(normalizedPath);
    return { ...info, is_directory: info.isDirectory };
  }

  /**
   * Get the history file path for a notebook
   */
  private getHistoryPath(notebookPath: string): string {
    const normalizedPath = this.normalizePath(notebookPath);
    const parentDir = path.dirname(normalizedPath);
    const notebookName = path.basename(normalizedPath);
    const nameWithoutExt = path.basename(notebookName, path.extname(notebookName));

    return path.join(parentDir, '.nebula', `${nameWithoutExt}.history.json`);
  }

  /**
   * Get the session state file path for a notebook
   */
  private getSessionPath(notebookPath: string): string {
    const normalizedPath = this.normalizePath(notebookPath);
    const parentDir = path.dirname(normalizedPath);
    const notebookName = path.basename(normalizedPath);
    const nameWithoutExt = path.basename(notebookName, path.extname(notebookName));

    return path.join(parentDir, '.nebula', `${nameWithoutExt}.session.json`);
  }

  /**
   * Delete notebook-related metadata files (history, session)
   */
  private deleteNotebookMetadata(notebookPath: string): void {
    const historyPath = this.getHistoryPath(notebookPath);
    const sessionPath = this.getSessionPath(notebookPath);

    if (fs.existsSync(historyPath)) {
      fs.unlinkSync(historyPath);
    }
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
  }

  /**
   * Delete a file or directory
   */
  deleteFile(filePath: string): boolean {
    const normalizedPath = this.normalizePath(filePath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Path not found: ${normalizedPath}`);
    }

    // For notebooks, also delete history and session files
    const ext = path.extname(normalizedPath).toLowerCase();
    const stat = fs.statSync(normalizedPath);
    if (ext === '.ipynb' && !stat.isDirectory()) {
      this.deleteNotebookMetadata(normalizedPath);
    }

    if (stat.isDirectory()) {
      fs.rmSync(normalizedPath, { recursive: true, force: true });
    } else {
      fs.unlinkSync(normalizedPath);
    }

    return true;
  }

  /**
   * Rename notebook-related metadata files
   */
  private renameNotebookMetadata(oldPath: string, newPath: string): void {
    const oldHistory = this.getHistoryPath(oldPath);
    const oldSession = this.getSessionPath(oldPath);
    const newHistory = this.getHistoryPath(newPath);
    const newSession = this.getSessionPath(newPath);

    // Create destination .nebula directory if needed
    const newNebulaDir = path.dirname(newHistory);
    if (!fs.existsSync(newNebulaDir)) {
      fs.mkdirSync(newNebulaDir, { recursive: true });
    }

    if (fs.existsSync(oldHistory)) {
      fs.renameSync(oldHistory, newHistory);
    }
    if (fs.existsSync(oldSession)) {
      fs.renameSync(oldSession, newSession);
    }
  }

  /**
   * Rename/move a file or directory
   */
  renameFile(oldPath: string, newPath: string): FileInfo {
    const normalizedOld = this.normalizePath(oldPath);
    const normalizedNew = this.normalizePath(newPath);

    if (!fs.existsSync(normalizedOld)) {
      throw new Error(`Path not found: ${normalizedOld}`);
    }

    if (fs.existsSync(normalizedNew)) {
      throw new Error(`Destination already exists: ${normalizedNew}`);
    }

    // For notebooks, also rename history and session files
    const ext = path.extname(normalizedOld).toLowerCase();
    if (ext === '.ipynb') {
      this.renameNotebookMetadata(normalizedOld, normalizedNew);
    }

    fs.renameSync(normalizedOld, normalizedNew);

    return this.getFileInfo(normalizedNew);
  }

  /**
   * Duplicate notebook-related metadata files
   */
  private duplicateNotebookMetadata(srcPath: string, destPath: string): void {
    const srcHistory = this.getHistoryPath(srcPath);
    const destHistory = this.getHistoryPath(destPath);
    const srcSession = this.getSessionPath(srcPath);
    const destSession = this.getSessionPath(destPath);

    // Create destination .nebula directory if needed
    const destNebulaDir = path.dirname(destHistory);
    if (!fs.existsSync(destNebulaDir)) {
      fs.mkdirSync(destNebulaDir, { recursive: true });
    }

    if (fs.existsSync(srcHistory)) {
      fs.copyFileSync(srcHistory, destHistory);
    }
    if (fs.existsSync(srcSession)) {
      fs.copyFileSync(srcSession, destSession);
    }
  }

  /**
   * Recursively copy a directory
   */
  private copyDirectoryRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true });
    const entries = fs.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        this.copyDirectoryRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
        // For notebooks, also duplicate history and session files
        if (entry.name.toLowerCase().endsWith('.ipynb')) {
          this.duplicateNotebookMetadata(srcPath, destPath);
        }
      }
    }
  }

  /**
   * Duplicate a file or directory with _copy suffix
   */
  duplicateFile(filePath: string): FileInfoResponse {
    const normalizedPath = this.normalizePath(filePath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`File not found: ${normalizedPath}`);
    }

    const stat = fs.statSync(normalizedPath);
    const isDirectory = stat.isDirectory();

    const parentDir = path.dirname(normalizedPath);
    const ext = isDirectory ? '' : path.extname(normalizedPath);
    const name = path.basename(normalizedPath, ext);

    // Find a unique name
    let newName = `${name}_copy${ext}`;
    let newPath = path.join(parentDir, newName);
    let counter = 2;
    while (fs.existsSync(newPath)) {
      newName = `${name}_copy_${counter}${ext}`;
      newPath = path.join(parentDir, newName);
      counter++;
    }

    if (isDirectory) {
      // Recursively copy directory
      this.copyDirectoryRecursive(normalizedPath, newPath);
    } else {
      // Copy the file
      fs.copyFileSync(normalizedPath, newPath);

      // For notebooks, also duplicate history and session files
      if (ext.toLowerCase() === '.ipynb') {
        this.duplicateNotebookMetadata(normalizedPath, newPath);
      }
    }

    return this.toFileInfoResponse(this.getFileInfo(newPath));
  }

  /**
   * Upload a file to a directory
   */
  async uploadFile(destDir: string, tempFilePath: string, originalName: string): Promise<FileInfoResponse> {
    const normalizedDir = this.normalizePath(destDir);

    if (!fs.existsSync(normalizedDir)) {
      throw new Error(`Directory not found: ${normalizedDir}`);
    }

    const stat = fs.statSync(normalizedDir);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedDir}`);
    }

    // Determine final path
    let finalPath = path.join(normalizedDir, originalName);

    // If file exists, find unique name
    if (fs.existsSync(finalPath)) {
      const ext = path.extname(originalName);
      const name = path.basename(originalName, ext);
      let counter = 1;
      while (fs.existsSync(finalPath)) {
        finalPath = path.join(normalizedDir, `${name}_${counter}${ext}`);
        counter++;
      }
    }

    // Move temp file to final destination
    fs.copyFileSync(tempFilePath, finalPath);
    fs.unlinkSync(tempFilePath);

    return this.toFileInfoResponse(this.getFileInfo(finalPath));
  }

  /**
   * Convert Jupyter source to string
   */
  private sourceToString(source: string | string[]): string {
    if (Array.isArray(source)) {
      return source.join('');
    }
    return source;
  }

  /**
   * Convert string to Jupyter source format (array of lines)
   */
  private stringToSource(content: string): string[] {
    if (!content) {
      return [];
    }
    const lines = content.split('\n');
    // Add \n back to all lines except the last
    return lines.map((line, i) => (i < lines.length - 1 ? line + '\n' : line));
  }

  /**
   * Convert Jupyter outputs to Nebula format
   */
  private convertOutputs(outputs: JupyterOutput[] | undefined, cellIndex: number): CellOutput[] {
    if (!outputs) return [];

    const result: CellOutput[] = [];
    const timestamp = Date.now();

    for (let i = 0; i < outputs.length; i++) {
      const output = outputs[i];

      if (output.output_type === 'stream') {
        const streamName = output.name || 'stdout';
        const text = this.sourceToString(output.text || '');
        result.push({
          id: `output-${cellIndex}-${result.length}`,
          type: streamName === 'stderr' ? 'stderr' : 'stdout',
          content: text,
          timestamp,
        });
      } else if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
        const data = output.data || {};

        if (data['image/png']) {
          result.push({
            id: `output-${cellIndex}-${result.length}`,
            type: 'image',
            content: this.sourceToString(data['image/png']),
            timestamp,
          });
        } else if (data['text/html']) {
          result.push({
            id: `output-${cellIndex}-${result.length}`,
            type: 'html',
            content: this.sourceToString(data['text/html']),
            timestamp,
          });
        } else if (data['text/plain']) {
          result.push({
            id: `output-${cellIndex}-${result.length}`,
            type: 'stdout',
            content: this.sourceToString(data['text/plain']),
            timestamp,
          });
        }
      } else if (output.output_type === 'error') {
        const traceback = output.traceback || [];
        result.push({
          id: `output-${cellIndex}-${result.length}`,
          type: 'error',
          content: traceback.join(''),
          timestamp,
        });
      }
    }

    return result;
  }

  /**
   * Convert Nebula outputs back to Jupyter format
   */
  private convertOutputsToJupyter(outputs: CellOutput[]): JupyterOutput[] {
    const result: JupyterOutput[] = [];

    for (const output of outputs) {
      if (output.type === 'stdout' || output.type === 'stderr') {
        result.push({
          output_type: 'stream',
          name: output.type,
          text: this.stringToSource(output.content),
        });
      } else if (output.type === 'image') {
        result.push({
          output_type: 'display_data',
          data: { 'image/png': output.content },
          metadata: {},
        });
      } else if (output.type === 'html') {
        result.push({
          output_type: 'display_data',
          data: { 'text/html': output.content },
          metadata: {},
        });
      } else if (output.type === 'error') {
        result.push({
          output_type: 'error',
          ename: 'Error',
          evalue: '',
          traceback: this.stringToSource(output.content),
        });
      }
    }

    return result;
  }

  /**
   * Read a notebook and convert to internal cell format
   */
  getNotebookCells(notebookPath: string): NotebookCellsResponse {
    const normalizedPath = this.normalizePath(notebookPath);

    if (!fs.existsSync(normalizedPath)) {
      throw new Error(`Notebook not found: ${normalizedPath}`);
    }

    const notebook: JupyterNotebook = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));

    const kernelspec = notebook.metadata?.kernelspec?.name || 'python3';

    const cells: NebulaCell[] = notebook.cells.map((nbCell, i) => {
      let cellType: 'code' | 'markdown' = nbCell.cell_type === 'markdown' ? 'markdown' : 'code';

      const content = this.sourceToString(nbCell.source);
      const cellId = nbCell.metadata?.nebula_id || (nbCell as { id?: string }).id || `cell-${i}`;
      const outputs = this.convertOutputs(nbCell.outputs, i);

      const cell: NebulaCell = {
        id: cellId,
        type: cellType,
        content,
        outputs,
        isExecuting: false,
        executionCount: nbCell.execution_count ?? null,
      };

      // Preserve scrolled state if set
      if (nbCell.metadata?.scrolled !== undefined) {
        cell.scrolled = nbCell.metadata.scrolled;
      }
      if (nbCell.metadata?.scrolled_height !== undefined) {
        cell.scrolledHeight = nbCell.metadata.scrolled_height;
      }

      // Preserve unknown metadata
      const unknownMetadata: Record<string, unknown> = {};
      for (const key of Object.keys(nbCell.metadata || {})) {
        if (!['nebula_id', 'scrolled', 'scrolled_height'].includes(key)) {
          unknownMetadata[key] = nbCell.metadata[key];
        }
      }
      if (Object.keys(unknownMetadata).length > 0) {
        cell._metadata = unknownMetadata;
      }

      return cell;
    });

    const stat = fs.statSync(normalizedPath);

    return {
      cells,
      kernelspec,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * Save cells to a notebook file
   */
  saveNotebookCells(
    notebookPath: string,
    cells: NebulaCell[],
    kernelName?: string,
    notebookMetadata?: Record<string, unknown>
  ): SaveNotebookResult {
    const normalizedPath = this.normalizePath(notebookPath);

    // Load existing notebook metadata if file exists
    let existingMetadata: JupyterNotebook['metadata'] = {};
    if (fs.existsSync(normalizedPath)) {
      try {
        const existing: JupyterNotebook = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));
        existingMetadata = existing.metadata || {};
      } catch {
        // Start fresh
      }
    }

    kernelName = kernelName || 'python3';
    const displayName = kernelName === 'python3' ? 'Python 3' : kernelName.replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

    const nbCells: JupyterCell[] = cells.map((cell) => {
      const preservedMetadata = cell._metadata || {};
      const cellMetadata: JupyterCell['metadata'] = {
        ...preservedMetadata,
        nebula_id: cell.id,
      };

      if (cell.scrolled !== undefined) {
        cellMetadata.scrolled = cell.scrolled;
      }
      if (cell.scrolledHeight !== undefined) {
        cellMetadata.scrolled_height = cell.scrolledHeight;
      }

      const nbCell: JupyterCell = {
        cell_type: cell.type,
        source: this.stringToSource(cell.content),
        metadata: cellMetadata,
      };

      if (cell.type === 'code') {
        nbCell.outputs = this.convertOutputsToJupyter(cell.outputs);
        nbCell.execution_count = cell.executionCount;
      }

      return nbCell;
    });

    // Build final metadata
    const finalMetadata: JupyterNotebook['metadata'] = {
      ...existingMetadata,
      kernelspec: {
        display_name: displayName,
        language: 'python',
        name: kernelName,
      },
      language_info: {
        name: 'python',
        version: '3.11',
      },
    };

    // Merge custom notebook metadata
    if (notebookMetadata) {
      for (const [key, value] of Object.entries(notebookMetadata)) {
        if (typeof value === 'object' && value !== null && typeof finalMetadata[key] === 'object' && finalMetadata[key] !== null) {
          // Deep merge for dict values
          finalMetadata[key] = { ...(finalMetadata[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
          finalMetadata[key] = value;
        }
      }
    }

    const notebook: JupyterNotebook = {
      cells: nbCells,
      metadata: finalMetadata,
      nbformat: 4,
      nbformat_minor: 5,
    };

    // Create parent directory if needed
    const parentDir = path.dirname(normalizedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    fs.writeFileSync(normalizedPath, JSON.stringify(notebook, null, 2), 'utf-8');

    const stat = fs.statSync(normalizedPath);
    return {
      success: true,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * Get notebook-level metadata
   */
  getNotebookMetadata(notebookPath: string): Record<string, unknown> {
    const normalizedPath = this.normalizePath(notebookPath);

    if (!fs.existsSync(normalizedPath)) {
      return {};
    }

    try {
      const notebook: JupyterNotebook = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));
      return notebook.metadata || {};
    } catch {
      return {};
    }
  }

  /**
   * Update notebook-level metadata without modifying cells
   */
  updateNotebookMetadata(notebookPath: string, metadataUpdates: Record<string, unknown>): { success: boolean; error?: string } {
    const normalizedPath = this.normalizePath(notebookPath);

    if (!fs.existsSync(normalizedPath)) {
      return { success: false, error: `Notebook not found: ${normalizedPath}` };
    }

    try {
      const notebook: JupyterNotebook = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8'));

      const existingMetadata = notebook.metadata || {};
      for (const [key, value] of Object.entries(metadataUpdates)) {
        if (typeof value === 'object' && value !== null && typeof existingMetadata[key] === 'object' && existingMetadata[key] !== null) {
          existingMetadata[key] = { ...(existingMetadata[key] as Record<string, unknown>), ...(value as Record<string, unknown>) };
        } else {
          existingMetadata[key] = value;
        }
      }

      notebook.metadata = existingMetadata;
      fs.writeFileSync(normalizedPath, JSON.stringify(notebook, null, 2), 'utf-8');

      return { success: true };
    } catch (e) {
      return { success: false, error: `Failed to update notebook: ${e}` };
    }
  }

  /**
   * Check if a notebook is permitted for agent modifications
   */
  isAgentPermitted(notebookPath: string): boolean {
    const metadata = this.getNotebookMetadata(notebookPath);
    const nebula = (metadata.nebula || {}) as Record<string, unknown>;
    return Boolean(nebula.agent_created) || Boolean(nebula.agent_permitted);
  }

  /**
   * Check if a notebook has history tracking enabled
   */
  hasHistory(notebookPath: string): boolean {
    const historyPath = this.getHistoryPath(notebookPath);
    if (!fs.existsSync(historyPath)) {
      return false;
    }
    try {
      const history = JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
      return Array.isArray(history) && history.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Save operation history for a notebook
   */
  saveHistory(notebookPath: string, history: unknown[]): boolean {
    const historyPath = this.getHistoryPath(notebookPath);

    // Create .nebula directory if needed
    const nebulaDir = path.dirname(historyPath);
    if (!fs.existsSync(nebulaDir)) {
      fs.mkdirSync(nebulaDir, { recursive: true });
    }

    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2), 'utf-8');
    return true;
  }

  /**
   * Load operation history for a notebook
   */
  loadHistory(notebookPath: string): unknown[] {
    const historyPath = this.getHistoryPath(notebookPath);

    if (!fs.existsSync(historyPath)) {
      return [];
    }

    try {
      return JSON.parse(fs.readFileSync(historyPath, 'utf-8'));
    } catch {
      return [];
    }
  }

  /**
   * Save session state for a notebook
   */
  saveSession(notebookPath: string, session: Record<string, unknown>): boolean {
    const sessionPath = this.getSessionPath(notebookPath);

    // Create .nebula directory if needed
    const nebulaDir = path.dirname(sessionPath);
    if (!fs.existsSync(nebulaDir)) {
      fs.mkdirSync(nebulaDir, { recursive: true });
    }

    fs.writeFileSync(sessionPath, JSON.stringify(session, null, 2), 'utf-8');
    return true;
  }

  /**
   * Load session state for a notebook
   */
  loadSession(notebookPath: string): Record<string, unknown> {
    const sessionPath = this.getSessionPath(notebookPath);

    if (!fs.existsSync(sessionPath)) {
      return {};
    }

    try {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));
    } catch {
      return {};
    }
  }
}

// Global instance with default configuration
export const fsService = new FilesystemService();
