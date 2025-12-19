/**
 * Tests for useConflictResolution hook
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Cell } from '../../types';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

// Mock file service
vi.mock('../../services/fileService', () => ({
  getFileMtime: vi.fn(),
  getFileContentWithMtime: vi.fn(),
  saveFileContentWithMtime: vi.fn(),
}));

// Mock conflict service
vi.mock('../../services/conflictService', () => ({
  checkForConflict: vi.fn(),
}));

import { useConflictResolution } from '../useConflictResolution';
import * as conflictService from '../../services/conflictService';
import * as fileService from '../../services/fileService';

describe('useConflictResolution', () => {
  const mockOnMtimeUpdate = vi.fn();
  const mockOnCellsReset = vi.fn();
  const currentKernel = 'python3';

  const createTestCell = (id: string, content: string): Cell => ({
    id,
    type: 'code',
    content,
    outputs: [],
    isExecuting: false,
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('starts with dialog closed', () => {
      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      expect(result.current.conflictDialog.isOpen).toBe(false);
      expect(result.current.conflictDialog.remoteMtime).toBeNull();
      expect(result.current.conflictDialog.fileId).toBeNull();
    });
  });

  describe('checkAndSave', () => {
    it('saves directly when no conflict exists', async () => {
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: false,
        localMtime: 1000,
        remoteMtime: 1000,
      });
      vi.mocked(fileService.saveFileContentWithMtime).mockResolvedValue({
        success: true,
        mtime: 1001,
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      const cells = [createTestCell('1', 'x = 1')];

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.checkAndSave('/test.ipynb', cells, 1000);
      });

      expect(saveResult.success).toBe(true);
      expect(saveResult.mtime).toBe(1001);
      expect(result.current.conflictDialog.isOpen).toBe(false);
      expect(mockOnMtimeUpdate).toHaveBeenCalledWith(1001);
    });

    it('opens dialog when conflict is detected', async () => {
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: true,
        localMtime: 1000,
        remoteMtime: 2000,
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      const cells = [createTestCell('1', 'x = 1')];

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.checkAndSave('/test.ipynb', cells, 1000);
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.needsResolution).toBe(true);
      expect(result.current.conflictDialog.isOpen).toBe(true);
      expect(result.current.conflictDialog.remoteMtime).toBe(2000);
      expect(result.current.conflictDialog.fileId).toBe('/test.ipynb');
    });

    it('handles save failure', async () => {
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: false,
        localMtime: 1000,
        remoteMtime: 1000,
      });
      vi.mocked(fileService.saveFileContentWithMtime).mockResolvedValue(null);

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      const cells = [createTestCell('1', 'x = 1')];

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.checkAndSave('/test.ipynb', cells, 1000);
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.needsResolution).toBeFalsy();
    });

    it('saves without conflict check when lastKnownMtime is null', async () => {
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: false,
        localMtime: null,
        remoteMtime: null,
      });
      vi.mocked(fileService.saveFileContentWithMtime).mockResolvedValue({
        success: true,
        mtime: 1000,
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      const cells = [createTestCell('1', 'x = 1')];

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.checkAndSave('/test.ipynb', cells, null);
      });

      expect(saveResult.success).toBe(true);
      expect(conflictService.checkForConflict).toHaveBeenCalledWith('/test.ipynb', null);
    });
  });

  describe('keepLocal', () => {
    it('saves pending cells and closes dialog', async () => {
      // First trigger a conflict
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: true,
        localMtime: 1000,
        remoteMtime: 2000,
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      const cells = [createTestCell('1', 'x = 1')];

      await act(async () => {
        await result.current.checkAndSave('/test.ipynb', cells, 1000);
      });

      expect(result.current.conflictDialog.isOpen).toBe(true);

      // Now resolve by keeping local
      vi.mocked(fileService.saveFileContentWithMtime).mockResolvedValue({
        success: true,
        mtime: 2001,
      });

      await act(async () => {
        await result.current.keepLocal();
      });

      expect(result.current.conflictDialog.isOpen).toBe(false);
      expect(mockOnMtimeUpdate).toHaveBeenCalledWith(2001);
      expect(fileService.saveFileContentWithMtime).toHaveBeenCalledWith(
        '/test.ipynb',
        cells,
        currentKernel
      );
    });

    it('does nothing when no pending save', async () => {
      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      await act(async () => {
        await result.current.keepLocal();
      });

      expect(fileService.saveFileContentWithMtime).not.toHaveBeenCalled();
    });
  });

  describe('loadRemote', () => {
    it('fetches remote content and resets cells', async () => {
      // First trigger a conflict
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: true,
        localMtime: 1000,
        remoteMtime: 2000,
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      const localCells = [createTestCell('1', 'x = 1')];

      await act(async () => {
        await result.current.checkAndSave('/test.ipynb', localCells, 1000);
      });

      expect(result.current.conflictDialog.isOpen).toBe(true);

      // Now resolve by loading remote
      const remoteCells = [createTestCell('2', 'y = 2')];
      vi.mocked(fileService.getFileContentWithMtime).mockResolvedValue({
        cells: remoteCells,
        mtime: 2000,
        kernelspec: 'python3',
      });

      let loadedCells: Cell[] | null;
      await act(async () => {
        loadedCells = await result.current.loadRemote();
      });

      expect(result.current.conflictDialog.isOpen).toBe(false);
      expect(mockOnCellsReset).toHaveBeenCalledWith(remoteCells);
      expect(mockOnMtimeUpdate).toHaveBeenCalledWith(2000);
      expect(loadedCells!).toEqual(remoteCells);
    });

    it('returns null when no conflict dialog fileId', async () => {
      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      let loadedCells: Cell[] | null;
      await act(async () => {
        loadedCells = await result.current.loadRemote();
      });

      expect(loadedCells!).toBeNull();
      expect(fileService.getFileContentWithMtime).not.toHaveBeenCalled();
    });

    it('returns null when fetch fails', async () => {
      // First trigger a conflict
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: true,
        localMtime: 1000,
        remoteMtime: 2000,
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      await act(async () => {
        await result.current.checkAndSave('/test.ipynb', [], 1000);
      });

      vi.mocked(fileService.getFileContentWithMtime).mockResolvedValue(null);

      let loadedCells: Cell[] | null;
      await act(async () => {
        loadedCells = await result.current.loadRemote();
      });

      expect(loadedCells!).toBeNull();
      // Dialog should still be open since load failed
      expect(result.current.conflictDialog.isOpen).toBe(true);
    });
  });

  describe('dismiss', () => {
    it('closes dialog and clears pending save', async () => {
      // First trigger a conflict
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: true,
        localMtime: 1000,
        remoteMtime: 2000,
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      await act(async () => {
        await result.current.checkAndSave('/test.ipynb', [], 1000);
      });

      expect(result.current.conflictDialog.isOpen).toBe(true);

      act(() => {
        result.current.dismiss();
      });

      expect(result.current.conflictDialog.isOpen).toBe(false);
      expect(result.current.conflictDialog.remoteMtime).toBeNull();
      expect(result.current.conflictDialog.fileId).toBeNull();
    });
  });

  describe('multiple conflicts', () => {
    it('handles sequential conflicts correctly', async () => {
      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset, currentKernel)
      );

      // First conflict
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: true,
        localMtime: 1000,
        remoteMtime: 2000,
      });

      await act(async () => {
        await result.current.checkAndSave('/test1.ipynb', [], 1000);
      });

      expect(result.current.conflictDialog.fileId).toBe('/test1.ipynb');

      // Dismiss first
      act(() => {
        result.current.dismiss();
      });

      // Second conflict on different file
      vi.mocked(conflictService.checkForConflict).mockResolvedValue({
        hasConflict: true,
        localMtime: 3000,
        remoteMtime: 4000,
      });

      await act(async () => {
        await result.current.checkAndSave('/test2.ipynb', [], 3000);
      });

      expect(result.current.conflictDialog.fileId).toBe('/test2.ipynb');
      expect(result.current.conflictDialog.remoteMtime).toBe(4000);
    });
  });
});
