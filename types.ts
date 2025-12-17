export type CellType = 'code' | 'markdown';

export interface CellOutput {
  id: string;
  type: 'stdout' | 'stderr' | 'image' | 'html' | 'error';
  content: string;
  timestamp: number;
}

export interface Cell {
  id: string;
  type: CellType;
  content: string;
  outputs: CellOutput[];
  isExecuting: boolean;
  executionCount?: number;
}

export interface NotebookMetadata {
  id: string;
  name: string;
  lastModified: number;
  fileType?: 'notebook' | 'file';
  extension?: string;
  size?: string;
}

// Kernel types are now in services/kernelService.ts

// Tab types for multi-notebook support
export interface Tab {
  id: string;              // Unique tab ID (UUID)
  fileId: string;          // Path to the notebook file
  title: string;           // Display name (filename without .ipynb)
  isDirty: boolean;        // Has unsaved changes
  isLoading: boolean;      // Loading state
}

export type KernelStatus = 'idle' | 'busy' | 'starting' | 'disconnected';

// Per-notebook state - everything needed to manage a notebook's context
export interface NotebookState {
  tabId: string;
  fileId: string;
  cells: Cell[];
  activeCellId: string | null;
  kernelSessionId: string | null;
  kernelStatus: KernelStatus;
  kernelName: string;
  executionQueue: string[];
}