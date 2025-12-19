/**
 * File Service - Real filesystem operations via backend API
 */
import { Cell, NotebookMetadata } from '../types';
import { getSettings, saveSettings } from './llmService';
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

// Storage keys for local state
const STORAGE_ACTIVE_PATH = 'nebula-active-path';

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
 * Notebook data including cells and metadata
 */
export interface NotebookData {
  cells: Cell[];
  kernelspec: string;  // kernel name from notebook metadata
}

/**
 * Get notebook cells from a .ipynb file
 * @deprecated Use getNotebookData instead to get kernelspec
 */
export const getNotebookCells = async (path: string): Promise<Cell[]> => {
  const data = await getNotebookData(path);
  return data.cells;
};

/**
 * Get notebook data including cells and kernelspec
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
    kernelspec: data.kernelspec || 'python3'
  };
};

/**
 * Save cells to a notebook file
 * @param path - Path to the notebook file
 * @param cells - Cells to save
 * @param kernelName - Optional kernel name to persist in notebook metadata
 */
export const saveNotebookCells = async (path: string, cells: Cell[], kernelName?: string): Promise<void> => {
  const response = await fetch(`${API_BASE}/notebook/save`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path, cells, kernel_name: kernelName })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to save notebook');
  }
};

// --- Compatibility layer for existing code ---

/**
 * Get files - for backward compatibility
 * Now returns notebooks from current directory
 */
export const getFiles = async (): Promise<NotebookMetadata[]> => {
  const settings = getSettings();
  try {
    const listing = await listDirectory(settings.rootDirectory);
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
 * Get file content - for backward compatibility
 */
export const getFileContent = async (id: string): Promise<Cell[] | null> => {
  try {
    return await getNotebookCells(id);
  } catch (e) {
    console.error('Failed to get file content:', e);
    return null;
  }
};

/**
 * Save file content - for backward compatibility
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
  const settings = getSettings();
  const dir = directory || settings.rootDirectory;
  const path = `${dir}/${name}.ipynb`.replace('~', '');

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
