/**
 * File Service - Real filesystem operations via backend API
 */
import { Cell, NotebookMetadata } from '../types';
import { TimestampedOperation } from '../hooks/useUndoRedo';

const API_BASE = '/api';

export interface FileItem {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  size: string;
  sizeBytes: number;
  modified: number;
  extension: string;
  fileType: 'folder' | 'notebook' | 'code' | 'data' | 'image' | 'document' | 'file';
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  mtime: number;
  items: FileItem[];
}

export interface DirectoryMtime {
  path: string;
  mtime: number;
}

export interface FileMtime {
  path: string;
  mtime: number;
}

export interface NotebookData {
  cells: Cell[];
  mtime: number;
}

export interface SaveResult {
  success: boolean;
  mtime: number;
}

export interface RootDirectoryResponse {
  root: string;
}

interface CellJsonCacheEntry {
  ref: Cell;
  json: string;
}

// Storage keys for local state
const STORAGE_ACTIVE_PATH = 'nebula-active-path';

let cellJsonCache = new Map<string, CellJsonCacheEntry>();

const getShadowSerializeConfig = () => {
  if (typeof window === 'undefined') {
    return { enabled: false, logMatches: false, sample: 1 };
  }
  const globals = window as typeof window & {
    __NEBULA_SERIALIZE_SHADOW__?: boolean;
    __NEBULA_SERIALIZE_SHADOW_LOG__?: boolean;
    __NEBULA_SERIALIZE_SHADOW_SAMPLE__?: number;
  };
  return {
    enabled: globals.__NEBULA_SERIALIZE_SHADOW__ ?? true,
    logMatches: globals.__NEBULA_SERIALIZE_SHADOW_LOG__ ?? true,
    sample: globals.__NEBULA_SERIALIZE_SHADOW_SAMPLE__ ?? 1,
  };
};

const shouldRunShadowSerialize = (sample: number) => {
  if (!Number.isFinite(sample) || sample <= 0) return false;
  if (sample === 1) return true;
  if (sample < 1) return Math.random() < sample;
  return Math.random() < 1 / sample;
};

const buildShadowPayload = (
  path: string,
  cells: Cell[],
  kernelName?: string,
  history?: TimestampedOperation[]
) => {
  let reused = 0;
  let updated = 0;
  const nextCache = new Map<string, CellJsonCacheEntry>();
  const cellJson = cells.map(cell => {
    const cached = cellJsonCache.get(cell.id);
    if (cached && cached.ref === cell) {
      reused += 1;
      nextCache.set(cell.id, cached);
      return cached.json;
    }
    updated += 1;
    const json = JSON.stringify(cell);
    nextCache.set(cell.id, { ref: cell, json });
    return json;
  });

  cellJsonCache = nextCache;

  let payload = `{\"path\":${JSON.stringify(path)},\"cells\":[${cellJson.join(',')}]`;
  if (kernelName !== undefined) {
    payload += `,\"kernel_name\":${JSON.stringify(kernelName)}`;
  }
  if (history !== undefined) {
    payload += `,\"history\":${JSON.stringify(history)}`;
  }
  payload += '}';

  return { payload, reused, updated };
};

/**
 * List contents of a directory
 */
export const listDirectory = async (path: string = '~'): Promise<DirectoryListing> => {
  const response = await fetch(`${API_BASE}/fs/list?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to list directory');
  }

  return response.json();
};

/**
 * Get server root directory
 */
export const getRootDirectory = async (): Promise<string> => {
  const response = await fetch(`${API_BASE}/fs/root`);
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to get root directory');
  }
  const data = await response.json() as RootDirectoryResponse;
  return data.root;
};

/**
 * Set server root directory
 */
export const setRootDirectory = async (root: string): Promise<string> => {
  const response = await fetch(`${API_BASE}/fs/root`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to set root directory');
  }

  const data = await response.json() as RootDirectoryResponse;
  return data.root;
};

/**
 * Get directory modification time (lightweight change detection)
 */
export const getDirectoryMtime = async (path: string = '~'): Promise<DirectoryMtime> => {
  const response = await fetch(`${API_BASE}/fs/mtime?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to get directory mtime');
  }

  return response.json();
};

/**
 * Get file modification time (lightweight change detection)
 */
export const getFileMtime = async (path: string): Promise<FileMtime> => {
  const response = await fetch(`${API_BASE}/fs/file-mtime?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to get file mtime');
  }

  return response.json();
};

/**
 * Read a file's contents
 */
export const readFile = async (path: string): Promise<{ path: string; type: string; content: any }> => {
  const response = await fetch(`${API_BASE}/fs/read?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to read file');
  }

  return response.json();
};

/**
 * Download a file to the user's computer
 */
export const downloadFile = async (path: string, filename: string): Promise<void> => {
  // Use dedicated download endpoint that streams raw file content
  const response = await fetch(`${API_BASE}/fs/download?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to download file');
  }

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/**
 * Write content to a file
 */
export const writeFile = async (path: string, content: any, fileType: string = 'text'): Promise<void> => {
  const response = await fetch(`${API_BASE}/fs/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, content, file_type: fileType })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to write file');
  }
};

/**
 * Create a new file or directory
 */
export const createFile = async (path: string, isDirectory: boolean = false): Promise<FileItem> => {
  const response = await fetch(`${API_BASE}/fs/create`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, is_directory: isDirectory })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to create file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Create a new folder (convenience wrapper for createFile)
 */
export const createFolder = async (parentDir: string, name: string): Promise<FileItem> => {
  const folderPath = parentDir.endsWith('/') ? `${parentDir}${name}` : `${parentDir}/${name}`;
  return createFile(folderPath, true);
};

/**
 * Delete a file or directory
 */
export const deleteFile = async (path: string): Promise<void> => {
  const response = await fetch(`${API_BASE}/fs/delete?path=${encodeURIComponent(path)}`, {
    method: 'DELETE'
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to delete file');
  }
};

/**
 * Rename/move a file or directory
 */
export const renameFile = async (oldPath: string, newPath: string): Promise<FileItem> => {
  const response = await fetch(`${API_BASE}/fs/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ old_path: oldPath, new_path: newPath })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to rename file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Duplicate a file
 */
export const duplicateFile = async (sourcePath: string): Promise<FileItem> => {
  const response = await fetch(`${API_BASE}/fs/duplicate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: sourcePath })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to duplicate file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Upload a file to a directory
 */
export const uploadFile = async (directory: string, file: File): Promise<FileItem> => {
  const formData = new FormData();
  formData.append('file', file);
  formData.append('path', directory);

  const response = await fetch(`${API_BASE}/fs/upload`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to upload file');
  }

  const data = await response.json();
  return data.file;
};

/**
 * Notebook data including cells and metadata
 */
export interface NotebookData {
  cells: Cell[];
  kernelspec: string;  // kernel name from notebook metadata
  mtime: number;       // modification time for conflict detection
}

/**
 * Get notebook cells from a .ipynb file
 * @deprecated Use getNotebookData instead to get kernelspec and mtime
 */
export const getNotebookCells = async (path: string): Promise<Cell[]> => {
  const data = await getNotebookData(path);
  return data.cells;
};

/**
 * Get notebook data including cells, kernelspec, and mtime
 */
export const getNotebookData = async (path: string): Promise<NotebookData> => {
  const response = await fetch(`${API_BASE}/notebook/cells?path=${encodeURIComponent(path)}`);

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to read notebook');
  }

  const data = await response.json();
  return {
    cells: data.cells,
    kernelspec: data.kernelspec || 'python3',
    mtime: data.mtime
  };
};

/**
 * Save cells to a notebook file
 * @param path - Path to the notebook file
 * @param cells - Cells to save
 * @param kernelName - Optional kernel name to persist in notebook metadata
 * @returns SaveResult with success status and new mtime for conflict detection
 */
export const saveNotebookCells = async (
  path: string,
  cells: Cell[],
  kernelName?: string,
  history?: any[]
): Promise<SaveResult> => {
  const shadowConfig = getShadowSerializeConfig();
  const payload = { path, cells, kernel_name: kernelName, history };
  const body = JSON.stringify(payload);

  if (shadowConfig.enabled && shouldRunShadowSerialize(shadowConfig.sample)) {
    const shadow = buildShadowPayload(path, cells, kernelName, history);
    if (shadow.payload !== body) {
      console.warn('[Autosave] Shadow serialization mismatch', {
        path,
        reused: shadow.reused,
        updated: shadow.updated
      });
    } else if (shadowConfig.logMatches) {
      console.info('[Autosave] Shadow serialization match', {
        path,
        reused: shadow.reused,
        updated: shadow.updated
      });
    }
  }

  const response = await fetch(`${API_BASE}/notebook/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to save notebook');
  }

  const data = await response.json();
  return { success: true, mtime: data.mtime };
};

// --- Compatibility layer for existing code ---

/**
 * Get files - for backward compatibility
 * Now returns notebooks from current directory
 */
export const getFiles = async (): Promise<NotebookMetadata[]> => {
  try {
    const listing = await listDirectory('~');
    return listing.items
      .filter(item => item.extension === '.ipynb')
      .map(item => ({
        id: item.path,
        name: item.name.replace('.ipynb', ''),
        lastModified: item.modified * 1000,
        fileType: 'notebook' as const,
        extension: '.ipynb',
        size: item.size
      }));
  } catch (e) {
    console.error('Failed to list files:', e);
    return [];
  }
};

/**
 * Get file content with mtime - for conflict detection
 */
export const getFileContentWithMtime = async (id: string): Promise<NotebookData | null> => {
  try {
    return await getNotebookData(id);
  } catch (e) {
    console.error('Failed to get file content:', e);
    return null;
  }
};

/**
 * Get file content - for backward compatibility (without mtime)
 */
export const getFileContent = async (id: string): Promise<Cell[] | null> => {
  try {
    const result = await getNotebookData(id);
    return result.cells;
  } catch (e) {
    console.error('Failed to get file content:', e);
    return null;
  }
};

/**
 * Save file content with mtime - for conflict detection
 */
export const saveFileContentWithMtime = async (
  id: string,
  cells: Cell[],
  kernelName?: string,
  history?: any[]
): Promise<SaveResult | null> => {
  try {
    return await saveNotebookCells(id, cells, kernelName, history);
  } catch (e) {
    console.error('Failed to save file content:', e);
    return null;
  }
};

/**
 * Save file content - for backward compatibility (without mtime)
 */
export const saveFileContent = async (id: string, cells: Cell[]): Promise<boolean> => {
  try {
    await saveNotebookCells(id, cells);
    return true;
  } catch (e) {
    console.error('Failed to save file content:', e);
    return false;
  }
};

/**
 * Create a new notebook
 */
export const createNotebook = async (name: string, initialCells: Cell[], directory?: string): Promise<NotebookMetadata> => {
  const dir = directory || '~';

  // Expand ~ if present
  const fullPath = dir.startsWith('~') ? `${dir}/${name}.ipynb` : `${dir}/${name}.ipynb`;

  await createFile(fullPath);
  await saveNotebookCells(fullPath, initialCells);

  return {
    id: fullPath,
    name,
    lastModified: Date.now(),
    fileType: 'notebook',
    extension: '.ipynb',
    size: '1KB'
  };
};

/**
 * Delete a notebook
 */
export const deleteNotebook = async (id: string): Promise<void> => {
  await deleteFile(id);
};

/**
 * Update notebook metadata (rename)
 */
export const updateNotebookMetadata = async (id: string, updates: Partial<NotebookMetadata>): Promise<void> => {
  if (updates.name) {
    const dir = id.substring(0, id.lastIndexOf('/'));
    const newPath = `${dir}/${updates.name}.ipynb`;
    await renameFile(id, newPath);
  }
};

/**
 * Save active file path
 */
export const saveActiveFileId = (path: string): void => {
  localStorage.setItem(STORAGE_ACTIVE_PATH, path);
};

/**
 * Get active file path
 */
export const getActiveFileId = (): string | null => {
  return localStorage.getItem(STORAGE_ACTIVE_PATH);
};

/**
 * Initialize file system - compatibility function
 */
export const initFileSystem = async (defaultCells: Cell[]): Promise<void> => {
  // Check if we have any saved state
  const activePath = getActiveFileId();
  if (activePath) {
    try {
      // Verify the file still exists
      await readFile(activePath);
      return;
    } catch {
      // File doesn't exist, clear the active path
      localStorage.removeItem(STORAGE_ACTIVE_PATH);
    }
  }

  // No active file, user will need to create or open one
};

// --- History Persistence ---

/**
 * Load operation history for a notebook from .nebula directory
 */
export const loadNotebookHistory = async (notebookPath: string): Promise<TimestampedOperation[]> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/history?notebook_path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to load history:', await response.text());
      return [];
    }

    const data = await response.json();
    return data.history || [];
  } catch (error) {
    console.warn('Failed to load notebook history:', error);
    return [];
  }
};

/**
 * Save operation history for a notebook to .nebula directory
 */
export const saveNotebookHistory = async (
  notebookPath: string,
  history: TimestampedOperation[]
): Promise<boolean> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/history`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_path: notebookPath,
        history
      })
    });

    if (!response.ok) {
      console.warn('Failed to save history:', await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.warn('Failed to save notebook history:', error);
    return false;
  }
};

// --- Session State Persistence ---

/**
 * Session state structure for restoring user's editing context
 */
export interface SessionState {
  unflushedEdit?: {
    cellId: string;
    lastFlushedContent: string;
  };
  activeCellId?: string; // Last focused cell - scroll here on refresh
}

/**
 * Load session state for a notebook from .nebula directory
 */
export const loadNotebookSession = async (notebookPath: string): Promise<SessionState> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/session?notebook_path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to load session:', await response.text());
      return {};
    }

    const data = await response.json();
    return data.session || {};
  } catch (error) {
    console.warn('Failed to load notebook session:', error);
    return {};
  }
};

/**
 * Save session state for a notebook to .nebula directory
 */
export const saveNotebookSession = async (
  notebookPath: string,
  session: SessionState
): Promise<boolean> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_path: notebookPath,
        session
      })
    });

    if (!response.ok) {
      console.warn('Failed to save session:', await response.text());
      return false;
    }

    return true;
  } catch (error) {
    console.warn('Failed to save notebook session:', error);
    return false;
  }
};

// --- Agent Permission API ---

export interface AgentPermissionStatus {
  notebook_path: string;
  agent_created: boolean;
  agent_permitted: boolean;
  has_history: boolean;
  can_agent_modify: boolean;
  reason: string;
}

/**
 * Get agent permission status for a notebook
 */
export const getAgentPermissionStatus = async (
  notebookPath: string
): Promise<AgentPermissionStatus | null> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/agent-status?path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to get agent status:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to get agent permission status:', error);
    return null;
  }
};

/**
 * Grant or revoke agent permission for a notebook
 */
export const setAgentPermission = async (
  notebookPath: string,
  permitted: boolean
): Promise<AgentPermissionStatus | null> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/permit-agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        notebook_path: notebookPath,
        permitted
      })
    });

    if (!response.ok) {
      console.warn('Failed to set agent permission:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to set agent permission:', error);
    return null;
  }
};

// --- Notebook Settings API ---

export type OutputLoggingMode = 'minimal' | 'full';

export interface NotebookSettings {
  notebook_path: string;
  output_logging: OutputLoggingMode;
}

/**
 * Get notebook settings (output logging mode, etc.)
 */
export const getNotebookSettings = async (
  notebookPath: string
): Promise<NotebookSettings | null> => {
  try {
    const response = await fetch(
      `${API_BASE}/notebook/settings?path=${encodeURIComponent(notebookPath)}`
    );

    if (!response.ok) {
      console.warn('Failed to get notebook settings:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to get notebook settings:', error);
    return null;
  }
};

/**
 * Update notebook settings
 */
export const updateNotebookSettings = async (
  notebookPath: string,
  settings: { output_logging?: OutputLoggingMode }
): Promise<NotebookSettings | null> => {
  try {
    const response = await fetch(`${API_BASE}/notebook/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: notebookPath,
        ...settings
      })
    });

    if (!response.ok) {
      console.warn('Failed to update notebook settings:', await response.text());
      return null;
    }

    return await response.json();
  } catch (error) {
    console.warn('Failed to update notebook settings:', error);
    return null;
  }
};
