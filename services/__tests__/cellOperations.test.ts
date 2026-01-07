/**
 * Tests for cell-level CRUD API client functions.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  updateCell,
  insertCell,
  deleteCellApi,
  UpdateCellParams,
  InsertCellParams,
  DeleteCellParams,
} from '../fileService';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('Cell Operations API', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('updateCell', () => {
    it('sends PATCH request with correct body', async () => {
      const mockResponse = {
        cell_id: 'cell-1',
        cell_index: 0,
        mtime: 1234567890.123,
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const params: UpdateCellParams = {
        path: '/path/to/notebook.ipynb',
        cellId: 'cell-1',
        content: 'updated content',
      };

      const result = await updateCell(params);

      expect(mockFetch).toHaveBeenCalledWith('/api/notebook/cell', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/path/to/notebook.ipynb',
          cell_id: 'cell-1',
          cell_index: undefined,
          content: 'updated content',
          cell_type: undefined,
          metadata: undefined,
        }),
      });

      expect(result).toEqual(mockResponse);
    });

    it('sends cellIndex when provided', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ cell_id: 'cell-1', cell_index: 2, mtime: 123 }),
      });

      await updateCell({
        path: '/notebook.ipynb',
        cellIndex: 2,
        content: 'new content',
      });

      const callArgs = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callArgs.cell_index).toBe(2);
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ detail: 'Cell not found' }),
      });

      await expect(updateCell({
        path: '/notebook.ipynb',
        cellId: 'nonexistent',
        content: 'test',
      })).rejects.toThrow('Cell not found');
    });
  });

  describe('insertCell', () => {
    it('sends POST request with correct body', async () => {
      const mockResponse = {
        cell_id: 'new-cell-id',
        cell_index: 1,
        total_cells: 4,
        mtime: 1234567890.123,
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const params: InsertCellParams = {
        path: '/path/to/notebook.ipynb',
        index: 1,
        cellType: 'code',
        content: 'new cell content',
      };

      const result = await insertCell(params);

      expect(mockFetch).toHaveBeenCalledWith('/api/notebook/cell', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/path/to/notebook.ipynb',
          index: 1,
          cell_type: 'code',
          content: 'new cell content',
          cell_id: undefined,
          metadata: undefined,
        }),
      });

      expect(result).toEqual(mockResponse);
    });

    it('defaults cellType to code and content to empty string', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ cell_id: 'id', cell_index: 0, total_cells: 1, mtime: 123 }),
      });

      await insertCell({
        path: '/notebook.ipynb',
        index: 0,
      });

      const callArgs = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callArgs.cell_type).toBe('code');
      expect(callArgs.content).toBe('');
    });

    it('supports append with index=-1', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ cell_id: 'id', cell_index: 5, total_cells: 6, mtime: 123 }),
      });

      await insertCell({
        path: '/notebook.ipynb',
        index: -1,
        content: 'appended',
      });

      const callArgs = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callArgs.index).toBe(-1);
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ detail: 'Invalid index' }),
      });

      await expect(insertCell({
        path: '/notebook.ipynb',
        index: 999,
      })).rejects.toThrow('Invalid index');
    });
  });

  describe('deleteCellApi', () => {
    it('sends DELETE request with cell_id', async () => {
      const mockResponse = {
        deleted_cell_id: 'cell-2',
        total_cells: 2,
        mtime: 1234567890.123,
      };
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      });

      const params: DeleteCellParams = {
        path: '/path/to/notebook.ipynb',
        cellId: 'cell-2',
      };

      const result = await deleteCellApi(params);

      expect(mockFetch).toHaveBeenCalledWith('/api/notebook/cell', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          path: '/path/to/notebook.ipynb',
          cell_id: 'cell-2',
          cell_index: undefined,
        }),
      });

      expect(result).toEqual(mockResponse);
    });

    it('sends DELETE request with cell_index', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ deleted_cell_id: 'cell-1', total_cells: 2, mtime: 123 }),
      });

      await deleteCellApi({
        path: '/notebook.ipynb',
        cellIndex: 0,
      });

      const callArgs = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callArgs.cell_index).toBe(0);
    });

    it('throws on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ detail: 'Cell not found' }),
      });

      await expect(deleteCellApi({
        path: '/notebook.ipynb',
        cellId: 'nonexistent',
      })).rejects.toThrow('Cell not found');
    });
  });
});
