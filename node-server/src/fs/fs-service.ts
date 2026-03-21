/**
 * Filesystem Service - Real filesystem operations
 *
 * Node.js port of the Python FilesystemService.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
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
import { getDefaultKernelName } from '../kernel/default-kernel';
import { buildDisplayOutput, convertMimeBundleToJupyter } from '../output/display-data';

const NEBULA_DIR = path.join(os.homedir(), '.nebula');
const USER_CONFIG_PATH = path.join(NEBULA_DIR, 'config.json');
const PROJECT_CONFIG_PATH = path.join(__dirname, '..', '..', '..', '.nebula-config.json');
const NOTEBOOK_METADATA_FAST_PATH_BYTES = 64 * 1024;
const NOTEBOOK_METADATA_FALLBACK_PARSE_BYTES = 8 * 1024 * 1024;

function readJsonString(source: string, startIndex: number): { value: string; endIndex: number } | null {
  if (source[startIndex] !== '"') {
    return null;
  }

  let i = startIndex + 1;
  let escaped = false;
  while (i < source.length) {
    const ch = source[i];
    if (escaped) {
      escaped = false;
      i++;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      i++;
      continue;
    }
    if (ch === '"') {
      try {
        return {
          value: JSON.parse(source.slice(startIndex, i + 1)) as string,
          endIndex: i + 1,
        };
      } catch {
        return null;
      }
    }
    i++;
  }

  return null;
}

function findMatchingJsonObjectEnd(source: string, startIndex: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = startIndex; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }

  return -1;
}

function extractTopLevelObjectField(source: string, fieldName: string): Record<string, unknown> | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      if (depth !== 1) {
        inString = true;
        continue;
      }

      const key = readJsonString(source, i);
      if (!key) {
        return null;
      }

      let j = key.endIndex;
      while (j < source.length && /\s/.test(source[j])) {
        j++;
      }

      if (source[j] !== ':') {
        i = key.endIndex - 1;
        continue;
      }

      if (key.value !== fieldName) {
        i = key.endIndex - 1;
        continue;
      }

      j++;
      while (j < source.length && /\s/.test(source[j])) {
        j++;
      }

      if (source[j] !== '{') {
        return null;
      }

      const endIndex = findMatchingJsonObjectEnd(source, j);
      if (endIndex === -1) {
        return null;
      }

      try {
        return JSON.parse(source.slice(j, endIndex + 1)) as Record<string, unknown>;
      } catch {
        return null;
      }
    }

    if (ch === '{' || ch === '[') {
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
    }
  }

  return null;
}

/**
 * Load root directory from config files if they exist.
 * Priority: env -> user config -> project config.
 */
function loadNebulaConfig(): string | null {
  const envRoot = process.env.NEBULA_WORKDIR || process.env.NEBULA_ROOT;
  if (envRoot) {
    return envRoot;
  }

  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const config: NebulaConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, 'utf-8'));
      if (config.rootDirectory) {
        return config.rootDirectory;
      }
    }
  } catch {
    // Ignore user config errors
  }

  try {
    if (fs.existsSync(PROJECT_CONFIG_PATH)) {
      const config: NebulaConfig = JSON.parse(fs.readFileSync(PROJECT_CONFIG_PATH, 'utf-8'));
      if (config.rootDirectory) {
        return config.rootDirectory;
      }
    }
  } catch {
    // Ignore project config errors
  }

  return null;
}

interface CommitJournal {
  version: 1;
  txId: string;
  notebookPath: string;
  status: 'begin' | 'commit';
  startedAt: number;
  committedAt?: number;
  files: {
    notebook: string;
    history?: string;
    session?: string;
  };
}

export class FilesystemService {
  private writeLocks: Map<string, Promise<void>> = new Map();
  private defaultRoot: string;

  constructor(defaultRoot?: string) {
    // Priority: explicit arg > config file > home directory
    const configuredRoot = defaultRoot || loadNebulaConfig() || os.homedir();
    this.defaultRoot = this.expandRootDirectory(configuredRoot);
  }

  /**
   * Get the server root directory.
   */
  getRootDirectory(): string {
    return this.defaultRoot;
  }

  /**
   * Set the server root directory and persist it.
   */
  setRootDirectory(rootDirectory: string, options?: { persist?: boolean }): string {
    const resolved = this.expandRootDirectory(rootDirectory);
    if (!fs.existsSync(resolved)) {
      throw new Error(`Root directory not found: ${resolved}`);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      throw new Error(`Root directory is not a folder: ${resolved}`);
    }

    this.defaultRoot = resolved;
    if (options?.persist !== false) {
      this.saveRootDirectory(resolved);
    }
    return this.defaultRoot;
  }

  private expandRootDirectory(rootDirectory: string): string {
    const trimmed = rootDirectory.trim();
    if (trimmed === '' || trimmed === '~') {
      return os.homedir();
    }
    if (trimmed.startsWith('~/')) {
      return path.join(os.homedir(), trimmed.slice(2));
    }
    return path.resolve(trimmed);
  }

  private saveRootDirectory(rootDirectory: string): void {
    if (!fs.existsSync(NEBULA_DIR)) {
      fs.mkdirSync(NEBULA_DIR, { recursive: true, mode: 0o700 });
    }
    const config: NebulaConfig = { rootDirectory };
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
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
   * Serialize write operations per notebook to avoid interleaving writes.
   */
  private async withWriteLock<T>(notebookPath: string, fn: () => Promise<T>): Promise<T> {
    const key = this.normalizePath(notebookPath);
    const previous = this.writeLocks.get(key) || Promise.resolve();
    let release: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.then(() => current);
    this.writeLocks.set(key, next);

    await previous;
    try {
      return await fn();
    } finally {
      release!();
      if (this.writeLocks.get(key) === next) {
        this.writeLocks.delete(key);
      }
    }
  }

  /**
   * Atomically write a file (write temp, fsync, rename, fsync dir).
   * Prevents partial/corrupt files on interruption.
   */
  private atomicWriteFileSync(targetPath: string, data: string): void {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpName = `.${path.basename(targetPath)}.${process.pid}.${Date.now()}.${crypto.randomUUID()}.tmp`;
    const tmpPath = path.join(dir, tmpName);
    const fd = fs.openSync(tmpPath, 'w', 0o600);
    try {
      fs.writeFileSync(fd, data, 'utf-8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    fs.renameSync(tmpPath, targetPath);

    // Best-effort directory fsync
    try {
      const dirFd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Ignore fsync errors on directory handles
    }
  }

  private writeJsonAtomicSync(targetPath: string, payload: unknown): void {
    this.atomicWriteFileSync(targetPath, JSON.stringify(payload, null, 2));
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
        this.writeJsonAtomicSync(normalizedPath, notebook);
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
    const { nebulaDir, nameWithoutExt } = this.getNebulaPaths(notebookPath);
    return path.join(nebulaDir, `${nameWithoutExt}.history.json`);
  }

  /**
   * Get the session state file path for a notebook
   */
  private getSessionPath(notebookPath: string): string {
    const { nebulaDir, nameWithoutExt } = this.getNebulaPaths(notebookPath);
    return path.join(nebulaDir, `${nameWithoutExt}.session.json`);
  }

  /**
   * Get the journal file path for a notebook (used for crash-safe commits)
   */
  private getJournalPath(notebookPath: string): string {
    const { nebulaDir, nameWithoutExt } = this.getNebulaPaths(notebookPath);
    return path.join(nebulaDir, `${nameWithoutExt}.commit.json`);
  }

  private readJournal(notebookPath: string): CommitJournal | null {
    const journalPath = this.getJournalPath(notebookPath);
    if (!fs.existsSync(journalPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as CommitJournal;
    } catch {
      return null;
    }
  }

  private hasPendingCommit(notebookPath: string): boolean {
    const journal = this.readJournal(notebookPath);
    if (!journal) return false;
    return journal.status === 'begin';
  }

  private getNebulaPaths(notebookPath: string): { nebulaDir: string; nameWithoutExt: string } {
    const normalizedPath = this.normalizePath(notebookPath);
    const parentDir = path.dirname(normalizedPath);
    const notebookName = path.basename(normalizedPath);
    const nameWithoutExt = path.basename(notebookName, path.extname(notebookName));
    const nebulaDir = path.join(parentDir, '.nebula');

    return { nebulaDir, nameWithoutExt };
  }

  /**
   * Delete notebook-related metadata files (history, session)
   */
  private deleteNotebookMetadata(notebookPath: string): void {
    const historyPath = this.getHistoryPath(notebookPath);
    const sessionPath = this.getSessionPath(notebookPath);
    const journalPath = this.getJournalPath(notebookPath);

    if (fs.existsSync(historyPath)) {
      fs.unlinkSync(historyPath);
    }
    if (fs.existsSync(sessionPath)) {
      fs.unlinkSync(sessionPath);
    }
    if (fs.existsSync(journalPath)) {
      fs.unlinkSync(journalPath);
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
    const oldJournal = this.getJournalPath(oldPath);
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
    if (fs.existsSync(oldJournal)) {
      // Journal files are ephemeral; remove any stale commit record on rename
      fs.unlinkSync(oldJournal);
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
        if (entry.name.endsWith('.commit.json')) {
          continue;
        }
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
        const normalizedOutput = buildDisplayOutput(output.data || {}, output.metadata);
        if (normalizedOutput) {
          result.push({
            id: `output-${cellIndex}-${result.length}`,
            type: normalizedOutput.type,
            content: normalizedOutput.content,
            timestamp,
            mimeBundle: normalizedOutput.mimeBundle,
            metadata: normalizedOutput.metadata,
            preferredMimeType: normalizedOutput.preferredMimeType,
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
      if (output.type !== 'stdout' && output.type !== 'stderr' && output.type !== 'error' && output.mimeBundle) {
        result.push({
          output_type: 'display_data',
          data: convertMimeBundleToJupyter(output.mimeBundle),
          metadata: output.metadata || {},
        });
        continue;
      }

      if (output.type === 'stdout' || output.type === 'stderr') {
        // Coalesce consecutive same-name streams into one entry (matches Jupyter behavior).
        // This prevents tqdm progress bars from creating hundreds of output entries.
        const prev = result[result.length - 1];
        if (prev && prev.output_type === 'stream' && prev.name === output.type) {
          // Append text to existing stream entry
          const prevText = Array.isArray(prev.text) ? prev.text.join('') : (prev.text as string);
          prev.text = this.stringToSource(prevText + output.content);
        } else {
          result.push({
            output_type: 'stream',
            name: output.type,
            text: this.stringToSource(output.content),
          });
        }
      } else if (output.type === 'image') {
        result.push({
          output_type: 'display_data',
          data: { 'image/png': output.content },
          metadata: output.metadata || {},
        });
      } else if (output.type === 'html') {
        result.push({
          output_type: 'display_data',
          data: { 'text/html': output.content },
          metadata: output.metadata || {},
        });
      } else if (output.type === 'display_data') {
        result.push({
          output_type: 'display_data',
          data: { 'text/plain': output.content },
          metadata: output.metadata || {},
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

    const metadataKernel = notebook.metadata?.kernelspec?.name;
    const kernelspec = metadataKernel || 'python3';

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
      kernelspecSource: metadataKernel ? 'metadata' : 'default',
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * Read a notebook and convert to internal cell format, resolving default kernel if needed
   */
  async getNotebookCellsWithKernel(notebookPath: string): Promise<NotebookCellsResponse> {
    const result = this.getNotebookCells(notebookPath);
    if (result.kernelspecSource === 'metadata') {
      return result;
    }

    try {
      const defaultKernel = await getDefaultKernelName();
      if (defaultKernel) {
        return {
          ...result,
          kernelspec: defaultKernel,
          kernelspecSource: 'env-default',
        };
      }
    } catch (err) {
      console.warn('[FilesystemService] Failed to resolve default kernel:', err);
    }

    return result;
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

    // Load existing notebook metadata if file exists.
    // Prefer a fast scan for the top-level metadata object so we avoid
    // parsing the full notebook on every save. Fall back to full JSON
    // parsing only for smaller notebooks when the fast path cannot find it.
    let existingMetadata: JupyterNotebook['metadata'] = {};
    if (fs.existsSync(normalizedPath)) {
      try {
        const stat = fs.statSync(normalizedPath);
        const fd = fs.openSync(normalizedPath, 'r');
        const buf = Buffer.alloc(NOTEBOOK_METADATA_FAST_PATH_BYTES);
        const bytesRead = fs.readSync(fd, buf, 0, NOTEBOOK_METADATA_FAST_PATH_BYTES, 0);
        fs.closeSync(fd);
        const head = buf.toString('utf-8', 0, bytesRead);

        const extractedMetadata = extractTopLevelObjectField(head, 'metadata');
        if (extractedMetadata) {
          existingMetadata = extractedMetadata;
        } else if (stat.size <= NOTEBOOK_METADATA_FALLBACK_PARSE_BYTES) {
          const notebook = JSON.parse(fs.readFileSync(normalizedPath, 'utf-8')) as JupyterNotebook;
          existingMetadata = notebook.metadata || {};
        }
      } catch {
        // Start fresh — metadata extraction failed
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
      metadata: finalMetadata,
      nbformat: 4,
      nbformat_minor: 5,
      cells: nbCells,
    };

    // Create parent directory if needed
    const parentDir = path.dirname(normalizedPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    this.writeJsonAtomicSync(normalizedPath, notebook);

    const stat = fs.statSync(normalizedPath);
    return {
      success: true,
      mtime: stat.mtimeMs / 1000,
    };
  }

  /**
   * Save notebook cells and history in a single crash-safe commit.
   * Uses a small journal + atomic writes to avoid partial files.
   */
  async saveNotebookBundle(
    notebookPath: string,
    cells: NebulaCell[],
    kernelName?: string,
    history?: unknown[],
    session?: Record<string, unknown>,
    notebookMetadata?: Record<string, unknown>
  ): Promise<SaveNotebookResult> {
    return await this.withWriteLock(notebookPath, async () => {
      const normalizedPath = this.normalizePath(notebookPath);
      const historyPath = history ? this.getHistoryPath(notebookPath) : undefined;
      const sessionPath = session ? this.getSessionPath(notebookPath) : undefined;
      const journalPath = this.getJournalPath(notebookPath);
      const txId = crypto.randomUUID();

      const journal: CommitJournal = {
        version: 1,
        txId,
        notebookPath: normalizedPath,
        status: 'begin',
        startedAt: Date.now(),
        files: {
          notebook: normalizedPath,
          ...(historyPath ? { history: historyPath } : {}),
          ...(sessionPath ? { session: sessionPath } : {}),
        },
      };

      // Ensure .nebula directory exists for journal/history/session
      const { nebulaDir } = this.getNebulaPaths(notebookPath);
      if (!fs.existsSync(nebulaDir)) {
        fs.mkdirSync(nebulaDir, { recursive: true });
      }

      this.writeJsonAtomicSync(journalPath, journal);

      if (historyPath) {
        this.writeJsonAtomicSync(historyPath, history || []);
      }

      if (sessionPath) {
        this.writeJsonAtomicSync(sessionPath, session || {});
      }

      const result = this.saveNotebookCells(notebookPath, cells, kernelName, notebookMetadata);

      const committedJournal: CommitJournal = {
        ...journal,
        status: 'commit',
        committedAt: Date.now(),
      };

      this.writeJsonAtomicSync(journalPath, committedJournal);

      try {
        fs.unlinkSync(journalPath);
      } catch {
        // Ignore cleanup errors; journal can be inspected if needed
      }

      return result;
    });
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
      this.writeJsonAtomicSync(normalizedPath, notebook);

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
  async saveHistory(notebookPath: string, history: unknown[]): Promise<boolean> {
    const historyPath = this.getHistoryPath(notebookPath);

    // Create .nebula directory if needed
    const nebulaDir = path.dirname(historyPath);
    if (!fs.existsSync(nebulaDir)) {
      fs.mkdirSync(nebulaDir, { recursive: true });
    }

    await this.withWriteLock(notebookPath, async () => {
      this.writeJsonAtomicSync(historyPath, history);
    });
    return true;
  }

  /**
   * Load operation history for a notebook
   */
  loadHistory(notebookPath: string): unknown[] {
    const historyPath = this.getHistoryPath(notebookPath);

    if (this.hasPendingCommit(notebookPath)) {
      console.warn(`[FilesystemService] Pending commit detected for ${notebookPath}; skipping history load.`);
      return [];
    }

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
  async saveSession(notebookPath: string, session: Record<string, unknown>): Promise<boolean> {
    const sessionPath = this.getSessionPath(notebookPath);

    // Create .nebula directory if needed
    const nebulaDir = path.dirname(sessionPath);
    if (!fs.existsSync(nebulaDir)) {
      fs.mkdirSync(nebulaDir, { recursive: true });
    }

    await this.withWriteLock(notebookPath, async () => {
      this.writeJsonAtomicSync(sessionPath, session);
    });
    return true;
  }

  /**
   * Load session state for a notebook
   */
  loadSession(notebookPath: string): Record<string, unknown> {
    const sessionPath = this.getSessionPath(notebookPath);

    if (this.hasPendingCommit(notebookPath)) {
      console.warn(`[FilesystemService] Pending commit detected for ${notebookPath}; skipping session load.`);
      return {};
    }

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
