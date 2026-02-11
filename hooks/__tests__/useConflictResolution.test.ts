/**
 * Tests for useConflictResolution hook
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock the conflictService
vi.mock('../../services/conflictService', () => ({
  saveWithConflictCheck: vi.fn(),
  forceSaveLocal: vi.fn(),
  loadRemoteVersion: vi.fn()
}));

// Mock the fileService
vi.mock('../../services/fileService', () => ({
  updateNotebookMetadata: vi.fn()
}));

import { useConflictResolution } from '../useConflictResolution';
import {
  saveWithConflictCheck,
  forceSaveLocal,
  loadRemoteVersion
} from '../../services/conflictService';

const mockSaveWithConflictCheck = vi.mocked(saveWithConflictCheck);
const mockForceSaveLocal = vi.mocked(forceSaveLocal);
const mockLoadRemoteVersion = vi.mocked(loadRemoteVersion);

describe('useConflictResolution', () => {
  const mockOnMtimeUpdate = vi.fn();
  const mockOnCellsReset = vi.fn();

  const mockCells = [
    { id: '1', type: 'code' as const, content: 'print(1)', outputs: [], isExecuting: false }
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('should start with no conflict dialog', () => {
      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      expect(result.current.conflictDialog).toBeNull();
    });
  });

  describe('saveWithCheck', () => {
    it('should save successfully when no conflict', async () => {
      mockSaveWithConflictCheck.mockResolvedValue({
        success: true,
        newMtime: 1001
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveWithCheck(
          '/test/file.ipynb',
          mockCells,
          1000,
          'python3'
        );
      });

      expect(saveResult.success).toBe(true);
      expect(saveResult.needsResolution).toBe(false);
      expect(saveResult.newMtime).toBe(1001);
      expect(mockOnMtimeUpdate).toHaveBeenCalledWith(1001);
      expect(result.current.conflictDialog).toBeNull();
    });

    it('should show conflict dialog when conflict detected', async () => {
      mockSaveWithConflictCheck.mockResolvedValue({
        success: false,
        newMtime: null,
        conflict: { remoteMtime: 2000 }
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveWithCheck(
          '/test/file.ipynb',
          mockCells,
          1000,
          'python3'
        );
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.needsResolution).toBe(true);
      expect(result.current.conflictDialog).not.toBeNull();
      expect(result.current.conflictDialog?.show).toBe(true);
      expect(result.current.conflictDialog?.remoteMtime).toBe(2000);
      expect(result.current.conflictDialog?.fileId).toBe('/test/file.ipynb');
    });

    it('should return error when save fails without conflict', async () => {
      mockSaveWithConflictCheck.mockResolvedValue({
        success: false,
        newMtime: null,
        error: 'Network error'
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      let saveResult: any;
      await act(async () => {
        saveResult = await result.current.saveWithCheck(
          '/test/file.ipynb',
          mockCells,
          1000,
          'python3'
        );
      });

      expect(saveResult.success).toBe(false);
      expect(saveResult.needsResolution).toBe(false);
      expect(saveResult.error).toBe('Network error');
      expect(result.current.conflictDialog).toBeNull();
    });
  });

  describe('keepLocal', () => {
    it('should force save local version and close dialog', async () => {
      // First trigger a conflict
      mockSaveWithConflictCheck.mockResolvedValue({
        success: false,
        newMtime: null,
        conflict: { remoteMtime: 2000 }
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      await act(async () => {
        await result.current.saveWithCheck(
          '/test/file.ipynb',
          mockCells,
          1000,
          'python3'
        );
      });

      expect(result.current.conflictDialog).not.toBeNull();

      // Now resolve by keeping local
      mockForceSaveLocal.mockResolvedValue({
        success: true,
        newMtime: 3000
      });

      await act(async () => {
        await result.current.keepLocal();
      });

      expect(mockForceSaveLocal).toHaveBeenCalledWith(
        '/test/file.ipynb',
        mockCells,
        'python3',
        undefined, // history
      );
      expect(mockOnMtimeUpdate).toHaveBeenCalledWith(3000);
      expect(result.current.conflictDialog).toBeNull();
    });

    it('should return failure when no conflict dialog is active', async () => {
      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      let keepResult: any;
      await act(async () => {
        keepResult = await result.current.keepLocal();
      });

      expect(keepResult.success).toBe(false);
      expect(keepResult.newMtime).toBeNull();
      expect(mockForceSaveLocal).not.toHaveBeenCalled();
    });
  });

  describe('loadRemote', () => {
    it('should load remote version and close dialog', async () => {
      // First trigger a conflict
      mockSaveWithConflictCheck.mockResolvedValue({
        success: false,
        newMtime: null,
        conflict: { remoteMtime: 2000 }
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      await act(async () => {
        await result.current.saveWithCheck(
          '/test/file.ipynb',
          mockCells,
          1000,
          'python3'
        );
      });

      expect(result.current.conflictDialog).not.toBeNull();

      // Now resolve by loading remote
      const remoteCells = [
        { id: 'remote-1', type: 'code' as const, content: 'remote', outputs: [], isExecuting: false }
      ];
      mockLoadRemoteVersion.mockResolvedValue({
        success: true,
        cells: remoteCells,
        mtime: 2000
      });

      await act(async () => {
        await result.current.loadRemote();
      });

      expect(mockLoadRemoteVersion).toHaveBeenCalledWith('/test/file.ipynb');
      expect(mockOnCellsReset).toHaveBeenCalledWith(remoteCells);
      expect(mockOnMtimeUpdate).toHaveBeenCalledWith(2000);
      expect(result.current.conflictDialog).toBeNull();
    });

    it('should return failure when no conflict dialog is active', async () => {
      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      let loadResult: any;
      await act(async () => {
        loadResult = await result.current.loadRemote();
      });

      expect(loadResult.success).toBe(false);
      expect(loadResult.cells).toBeNull();
      expect(loadResult.mtime).toBeNull();
      expect(mockLoadRemoteVersion).not.toHaveBeenCalled();
    });
  });

  describe('dismissDialog', () => {
    it('should close the conflict dialog', async () => {
      // First trigger a conflict
      mockSaveWithConflictCheck.mockResolvedValue({
        success: false,
        newMtime: null,
        conflict: { remoteMtime: 2000 }
      });

      const { result } = renderHook(() =>
        useConflictResolution(mockOnMtimeUpdate, mockOnCellsReset)
      );

      await act(async () => {
        await result.current.saveWithCheck(
          '/test/file.ipynb',
          mockCells,
          1000,
          'python3'
        );
      });

      expect(result.current.conflictDialog).not.toBeNull();

      act(() => {
        result.current.dismissDialog();
      });

      expect(result.current.conflictDialog).toBeNull();
    });
  });
});
