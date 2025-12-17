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