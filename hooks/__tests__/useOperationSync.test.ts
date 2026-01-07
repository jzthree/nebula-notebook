/**
 * Tests for useOperationSync hook
 *
 * Verifies:
 * 1. Operation application logic (insert, delete, update, etc.)
 * 2. ID conflict resolution
 * 3. WebSocket message handling
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Mock WebSocket
class MockWebSocket {
  // WebSocket state constants (must match real WebSocket)
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];
  url: string;
  readyState: number = MockWebSocket.CONNECTING;
  onopen: ((event: any) => void) | null = null;
  onmessage: ((event: any) => void) | null = null;
  onerror: ((event: any) => void) | null = null;
  onclose: ((event: any) => void) | null = null;
  sentMessages: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    // Simulate async connection
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      if (this.onopen) this.onopen({});
    }, 10);
  }

  send(data: string) {
    this.sentMessages.push(data);
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
    if (this.onclose) this.onclose({});
  }

  // Helper to simulate receiving a message
  receiveMessage(data: any) {
    if (this.onmessage) {
      this.onmessage({ data: JSON.stringify(data) });
    }
  }

  static reset() {
    MockWebSocket.instances = [];
  }
}

// Store original WebSocket
const originalWebSocket = global.WebSocket;

// Import after WebSocket mock is set up
import { useOperationSync, NotebookOperation, OperationResult } from '../useOperationSync';
import { Cell, CellType } from '../../types';

describe('useOperationSync', () => {
  // Mock callbacks
  let mockInsertCell: ReturnType<typeof vi.fn>;
  let mockDeleteCell: ReturnType<typeof vi.fn>;
  let mockMoveCell: ReturnType<typeof vi.fn>;
  let mockUpdateContent: ReturnType<typeof vi.fn>;
  let mockUpdateContentAI: ReturnType<typeof vi.fn>;
  let mockChangeType: ReturnType<typeof vi.fn>;
  let mockSetCellOutputs: ReturnType<typeof vi.fn>;

  // Initial cells
  let initialCells: Cell[];

  beforeEach(() => {
    // Reset WebSocket mock
    MockWebSocket.reset();
    (global as any).WebSocket = MockWebSocket;

    // Reset mock functions
    mockInsertCell = vi.fn();
    mockDeleteCell = vi.fn();
    mockMoveCell = vi.fn();
    mockUpdateContent = vi.fn();
    mockUpdateContentAI = vi.fn();
    mockChangeType = vi.fn();
    mockSetCellOutputs = vi.fn();

    // Initial cells state
    initialCells = [
      { id: 'cell-1', type: 'code', content: 'print("hello")', outputs: [], isExecuting: false },
      { id: 'cell-2', type: 'code', content: 'x = 1', outputs: [], isExecuting: false },
      { id: 'cell-3', type: 'markdown', content: '# Heading', outputs: [], isExecuting: false },
    ];
  });

  afterEach(() => {
    // Restore original WebSocket
    (global as any).WebSocket = originalWebSocket;
    vi.clearAllTimers();
  });

  const renderOperationSync = (cells: Cell[] = initialCells, filePath: string | null = '/test/notebook.ipynb') => {
    return renderHook(() =>
      useOperationSync({
        filePath,
        cells,
        insertCell: mockInsertCell,
        deleteCell: mockDeleteCell,
        moveCell: mockMoveCell,
        updateContent: mockUpdateContent,
        updateContentAI: mockUpdateContentAI,
        changeType: mockChangeType,
        setCellOutputs: mockSetCellOutputs,
      })
    );
  };

  describe('Connection Management', () => {
    it('should not connect when filePath is null', async () => {
      renderOperationSync(initialCells, null);

      // Wait for potential connection attempt
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(MockWebSocket.instances.length).toBe(0);
    });

    it('should connect when filePath is provided', async () => {
      renderOperationSync();

      // Wait for connection
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(MockWebSocket.instances.length).toBe(1);
      expect(MockWebSocket.instances[0].url).toContain('/api/notebook/');
    });

    it('should disconnect when unmounted', async () => {
      const { unmount } = renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];
      unmount();

      expect(ws.readyState).toBe(3); // CLOSED
    });
  });

  describe('Insert Cell Operation', () => {
    it('should apply insertCell operation', async () => {
      const { result } = renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      // Simulate incoming operation
      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'insertCell',
            notebookPath: '/test/notebook.ipynb',
            index: 1,
            cell: {
              id: 'new-cell',
              type: 'code',
              content: 'new content',
            },
          },
        });
      });

      expect(mockInsertCell).toHaveBeenCalledWith(1, expect.objectContaining({
        id: 'new-cell',
        type: 'code',
        content: 'new content',
      }));

      // Check response was sent
      const responses = ws.sentMessages.filter(m => m.includes('operationResult'));
      expect(responses.length).toBe(1);

      const response = JSON.parse(responses[0]);
      expect(response.result.success).toBe(true);
      expect(response.result.cellId).toBe('new-cell');
    });

    it('should auto-fix duplicate cell ID', async () => {
      const { result } = renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      // Try to insert cell with existing ID
      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'insertCell',
            notebookPath: '/test/notebook.ipynb',
            index: -1,
            cell: {
              id: 'cell-1', // Already exists!
              type: 'code',
              content: 'duplicate',
            },
          },
        });
      });

      // Should have auto-fixed the ID
      expect(mockInsertCell).toHaveBeenCalledWith(3, expect.objectContaining({
        id: 'cell-1-2', // Auto-fixed
      }));

      const responses = ws.sentMessages.filter(m => m.includes('operationResult'));
      const response = JSON.parse(responses[0]);
      expect(response.result.cellId).toBe('cell-1-2');
      expect(response.result.idModified).toBe(true);
    });
  });

  describe('Delete Cell Operation', () => {
    it('should delete cell by index', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'deleteCell',
            notebookPath: '/test/notebook.ipynb',
            cellIndex: 1,
          },
        });
      });

      expect(mockDeleteCell).toHaveBeenCalledWith(1);
    });

    it('should delete cell by ID', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'deleteCell',
            notebookPath: '/test/notebook.ipynb',
            cellId: 'cell-2',
          },
        });
      });

      expect(mockDeleteCell).toHaveBeenCalledWith(1); // cell-2 is at index 1
    });

    it('should return error for non-existent cell ID', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'deleteCell',
            notebookPath: '/test/notebook.ipynb',
            cellId: 'non-existent',
          },
        });
      });

      expect(mockDeleteCell).not.toHaveBeenCalled();

      const responses = ws.sentMessages.filter(m => m.includes('operationResult'));
      const response = JSON.parse(responses[0]);
      expect(response.result.success).toBe(false);
      expect(response.result.error).toContain('not found');
    });
  });

  describe('Update Content Operation', () => {
    it('should update cell content using AI callback', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'updateContent',
            notebookPath: '/test/notebook.ipynb',
            cellId: 'cell-1',
            content: 'updated content',
          },
        });
      });

      // Should use AI callback if available
      expect(mockUpdateContentAI).toHaveBeenCalledWith('cell-1', 'updated content');
    });

    it('should fall back to regular update if AI callback not provided', async () => {
      const { result } = renderHook(() =>
        useOperationSync({
          filePath: '/test/notebook.ipynb',
          cells: initialCells,
          insertCell: mockInsertCell,
          deleteCell: mockDeleteCell,
          moveCell: mockMoveCell,
          updateContent: mockUpdateContent,
          // No updateContentAI
          changeType: mockChangeType,
          setCellOutputs: mockSetCellOutputs,
        })
      );

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'updateContent',
            notebookPath: '/test/notebook.ipynb',
            cellId: 'cell-1',
            content: 'updated content',
          },
        });
      });

      expect(mockUpdateContent).toHaveBeenCalledWith('cell-1', 'updated content');
    });
  });

  describe('Move Cell Operation', () => {
    it('should move cell from one position to another', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'moveCell',
            notebookPath: '/test/notebook.ipynb',
            fromIndex: 0,
            toIndex: 2,
          },
        });
      });

      expect(mockMoveCell).toHaveBeenCalledWith(0, 2);
    });

    it('should return error for invalid indices', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'moveCell',
            notebookPath: '/test/notebook.ipynb',
            fromIndex: 0,
            toIndex: 10, // Out of range
          },
        });
      });

      expect(mockMoveCell).not.toHaveBeenCalled();

      const responses = ws.sentMessages.filter(m => m.includes('operationResult'));
      const response = JSON.parse(responses[0]);
      expect(response.result.success).toBe(false);
    });
  });

  describe('Duplicate Cell Operation', () => {
    it('should duplicate cell', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'duplicateCell',
            notebookPath: '/test/notebook.ipynb',
            cellIndex: 0,
            newCellId: 'cell-1-copy',
          },
        });
      });

      expect(mockInsertCell).toHaveBeenCalledWith(1, expect.objectContaining({
        id: 'cell-1-copy',
        type: 'code',
        content: 'print("hello")',
      }));
    });

    it('should auto-fix duplicate ID on duplicate', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'duplicateCell',
            notebookPath: '/test/notebook.ipynb',
            cellIndex: 0,
            newCellId: 'cell-2', // Already exists!
          },
        });
      });

      expect(mockInsertCell).toHaveBeenCalledWith(1, expect.objectContaining({
        id: 'cell-2-2', // Auto-fixed
      }));
    });
  });

  describe('Update Metadata Operation', () => {
    it('should change cell type', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'updateMetadata',
            notebookPath: '/test/notebook.ipynb',
            cellId: 'cell-1',
            changes: { type: 'markdown' },
          },
        });
      });

      expect(mockChangeType).toHaveBeenCalledWith('cell-1', 'markdown');
    });
  });

  describe('Update Outputs Operation', () => {
    it('should update cell outputs', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'operation',
          requestId: 'req-1',
          operation: {
            type: 'updateOutputs',
            notebookPath: '/test/notebook.ipynb',
            cellId: 'cell-1',
            outputs: [
              { type: 'stdout', content: 'hello\n' },
            ],
            executionCount: 1,
          },
        });
      });

      expect(mockSetCellOutputs).toHaveBeenCalled();
      const [cellId, outputs, execCount] = mockSetCellOutputs.mock.calls[0];
      expect(cellId).toBe('cell-1');
      expect(outputs.length).toBe(1);
      expect(outputs[0].type).toBe('stdout');
      expect(outputs[0].content).toBe('hello\n');
      expect(execCount).toBe(1);
    });
  });

  describe('Read Notebook Request', () => {
    it('should respond to readNotebook request', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      act(() => {
        ws.receiveMessage({
          type: 'readNotebook',
          requestId: 'req-1',
        });
      });

      const responses = ws.sentMessages.filter(m => m.includes('notebookData'));
      expect(responses.length).toBe(1);

      const response = JSON.parse(responses[0]);
      expect(response.result.success).toBe(true);
      expect(response.result.data.cells.length).toBe(3);
      expect(response.result.data.cells[0].id).toBe('cell-1');
    });
  });

  describe('Keep-Alive', () => {
    it('should respond to pong', async () => {
      renderOperationSync();

      await new Promise(resolve => setTimeout(resolve, 50));

      const ws = MockWebSocket.instances[0];

      // Should not throw on pong message
      act(() => {
        ws.receiveMessage({ type: 'pong' });
      });

      // No response should be sent for pong
      const responses = ws.sentMessages.filter(m => m.includes('pong'));
      expect(responses.length).toBe(0);
    });
  });
});
