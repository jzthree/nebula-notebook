/**
 * Filesystem Service Types
 */

export interface FileInfo {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modified: number;
  extension: string;
}

export interface FileInfoResponse {
  id: string;
  name: string;
  path: string;
  isDirectory: boolean;
  size: string; // formatted size like "1.2KB"
  sizeBytes: number;
  modified: number;
  extension: string;
  fileType: FileType;
}

export type FileType = 'folder' | 'notebook' | 'code' | 'data' | 'image' | 'document' | 'file';

export interface DirectoryListing {
  path: string;
  parent: string | null;
  mtime: number;
  items: FileInfoResponse[];
}

export interface MtimeResponse {
  path: string;
  mtime: number;
}

export interface ReadFileResponse {
  path: string;
  type: 'notebook' | 'text' | 'binary';
  content: unknown; // notebook object, text string, or null for binary
  message?: string;
}

export interface WriteFileOptions {
  path: string;
  content: unknown;
  fileType?: 'text' | 'notebook';
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type OutputType = 'stdout' | 'stderr' | 'image' | 'html' | 'error' | 'display_data';
export type MimeBundle = Record<string, JsonValue>;

// Notebook cell output types (matching frontend types)
export interface CellOutput {
  id?: string;  // Optional - frontend uses this, API doesn't
  type: OutputType;
  content: string;
  timestamp?: number;  // Optional - frontend uses this, API doesn't
  mimeBundle?: MimeBundle;
  metadata?: Record<string, JsonValue>;
  preferredMimeType?: string;
}

// API-compatible output format (matches Python backend)
export interface ApiCellOutput {
  type: OutputType;
  content: string;
  mimeBundle?: MimeBundle;
  metadata?: Record<string, JsonValue>;
  preferredMimeType?: string;
}

// Internal cell format used by Nebula
export interface NebulaCell {
  id: string;
  type: 'code' | 'markdown';
  content: string;
  outputs: CellOutput[];
  isExecuting: boolean;
  pendingOutputReset?: boolean; // transient: hide previous-run outputs from read_output until fresh output arrives
  executionCount: number | null;
  scrolled?: boolean;
  scrolledHeight?: number;
  _metadata?: Record<string, unknown>; // preserved unknown metadata
}

export interface NotebookCellsResponse {
  cells: NebulaCell[];
  kernelspec: string;
  kernelspecSource?: 'metadata' | 'default' | 'env-default';
  mtime: number;
}

export interface SaveNotebookResult {
  success: boolean;
  mtime: number;
}

// Jupyter .ipynb format types
export interface JupyterCellMetadata {
  nebula_id?: string;
  scrolled?: boolean;
  scrolled_height?: number;
  [key: string]: unknown;
}

export interface JupyterCell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: string | string[];
  metadata: JupyterCellMetadata;
  outputs?: JupyterOutput[];
  execution_count?: number | null;
}

export interface JupyterOutput {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string; // for stream
  text?: string | string[]; // for stream
  data?: Record<string, unknown>; // for execute_result/display_data
  metadata?: Record<string, unknown>;
  ename?: string; // for error
  evalue?: string; // for error
  traceback?: string[]; // for error
}

export interface JupyterNotebook {
  cells: JupyterCell[];
  metadata: {
    kernelspec?: {
      display_name: string;
      language: string;
      name: string;
    };
    language_info?: Record<string, unknown>;
    nebula?: {
      agent_created?: boolean;
      agent_permitted?: boolean;
    };
    [key: string]: unknown;
  };
  nbformat: number;
  nbformat_minor: number;
}

// Config file type
export interface NebulaConfig {
  rootDirectory?: string;
}
