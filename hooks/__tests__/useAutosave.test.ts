/**
 * Tests for useAutosave hook
 *
 * Tests the autosave functionality including:
 * - State transitions (idle -> checking -> waiting -> saving -> idle)
 * - Debouncing behavior
 * - Manual save
 * - Error handling and retry
 * - Backup save/clear behavior
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { Cell } from '../../types';
import { useAutosave } from '../useAutosave';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => { store[key] = value; }),
    removeItem: vi.fn((key: string) => { delete store[key]; }),
    clear: vi.fn(() => { store = {}; }),
  };
})();
Object.defineProperty(global, 'localStorage', { value: localStorageMock });

describe('useAutosave', () => {
  const createCell = (id: string, content: string): Cell => ({
    id,
    type: 'code',
    content,
    outputs: [],
    isExecuting: false,
  });

  let mockOnSave: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    localStorageMock.clear();
    mockOnSave = vi.fn().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('returns expected hook interface', () => {
      const { result } = renderHook(() =>
        useAutosave({
          fileId: '/test.ipynb',
          cells: [createCell('1', 'x = 1')],
          onSave: mockOnSave,
        })
      );

      // Verify the hook returns the expected interface
      expect(result.current.status).toBeDefined();
      expect(typeof result.current.saveNow).toBe('function');
      expect(typeof result.current.hasUnsavedChanges).toBe('function');
      expect(typeof result.current.getBackup).toBe('function');
      expect(typeof result.current.clearBackup).toBe('function');
    });

    it('has lastSaved set after initialization', async () => {
      const { result } = renderHook(() =>
        useAutosave({
          fileId: '/test.ipynb',
          cells: [createCell('1', 'x = 1')],
          onSave: mockOnSave,
        })
      );

      // Wait for the fileId effect to run
      await act(async () => {
        vi.advanceTimersByTime(0);
      });

      // After fileId is set, lastSaved should be populated
      expect(result.current.status.lastSaved).not.toBeNull();
    });

  });

  describe('cells change triggers save cycle', () => {
    it('sets status to unsaved when cells change', () => {
      const initialCells = [createCell('1', 'x = 1')];
      const { result, rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: initialCells } }
      );

      // Change cells
      const newCells = [createCell('1', 'x = 2')];
      rerender({ cells: newCells });

      // Should be unsaved immediately
      expect(result.current.status.status).toBe('unsaved');
    });

    it('saves after debounce delay', async () => {
      const initialCells = [createCell('1', 'x = 1')];
      const { result, rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: initialCells } }
      );

      // Change cells
      const newCells = [createCell('1', 'x = 2')];
      rerender({ cells: newCells });

      // Advance past check delay (300ms) + save delay (1000ms for small files)
      await act(async () => {
        vi.advanceTimersByTime(300); // Check delay
      });
      await act(async () => {
        vi.advanceTimersByTime(1500); // Save delay
        await Promise.resolve(); // Flush promises
      });

      expect(mockOnSave).toHaveBeenCalledTimes(1);
      expect(mockOnSave).toHaveBeenCalledWith('/test.ipynb', newCells);
    });

    it('transitions to saved status after successful save', async () => {
      const initialCells = [createCell('1', 'x = 1')];
      const { result, rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: initialCells } }
      );

      const newCells = [createCell('1', 'x = 2')];
      rerender({ cells: newCells });

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(result.current.status.status).toBe('saved');
    });

    it('restarts debounce when cells change during wait', async () => {
      const { rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      // First change
      rerender({ cells: [createCell('1', 'x = 2')] });

      // Wait partial time
      await act(async () => {
        vi.advanceTimersByTime(500);
      });

      // Second change before save
      rerender({ cells: [createCell('1', 'x = 3')] });

      // Wait past original save time (should not have saved yet)
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });

      expect(mockOnSave).not.toHaveBeenCalled();

      // Wait for restart debounce to complete
      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      // Should only save once with final content
      expect(mockOnSave).toHaveBeenCalledTimes(1);
      expect(mockOnSave).toHaveBeenCalledWith('/test.ipynb', [createCell('1', 'x = 3')]);
    });
  });

  describe('manual save', () => {
    it('saveNow triggers immediate save', async () => {
      const { result, rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      rerender({ cells: [createCell('1', 'x = 2')] });

      await act(async () => {
        await result.current.saveNow();
      });

      expect(mockOnSave).toHaveBeenCalled();
    });

    it('saveNow does not save when no changes', async () => {
      const { result } = renderHook(() =>
        useAutosave({
          fileId: '/test.ipynb',
          cells: [createCell('1', 'x = 1')],
          onSave: mockOnSave,
        })
      );

      await act(async () => {
        await result.current.saveNow();
      });

      // Should not call onSave since there are no changes
      expect(mockOnSave).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('transitions to error status on save failure', async () => {
      mockOnSave.mockRejectedValueOnce(new Error('Network error'));

      const { result, rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      rerender({ cells: [createCell('1', 'x = 2')] });

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(result.current.status.status).toBe('error');
    });
  });

  describe('backup behavior', () => {
    it('saves backup before attempting save', async () => {
      const { rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      rerender({ cells: [createCell('1', 'x = 2')] });

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'nebula-backup-/test.ipynb',
        expect.any(String)
      );
    });

    it('clears backup after successful save', async () => {
      const { rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      rerender({ cells: [createCell('1', 'x = 2')] });

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('nebula-backup-/test.ipynb');
    });
  });

  describe('hasUnsavedChanges', () => {
    it('returns false initially', () => {
      const { result } = renderHook(() =>
        useAutosave({
          fileId: '/test.ipynb',
          cells: [createCell('1', 'x = 1')],
          onSave: mockOnSave,
        })
      );

      expect(result.current.hasUnsavedChanges()).toBe(false);
    });

    it('returns true after cells change', () => {
      const { result, rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      rerender({ cells: [createCell('1', 'x = 2')] });

      expect(result.current.hasUnsavedChanges()).toBe(true);
    });

    it('returns false after save completes', async () => {
      const { result, rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      rerender({ cells: [createCell('1', 'x = 2')] });

      await act(async () => {
        vi.advanceTimersByTime(2000);
        await Promise.resolve();
      });

      expect(result.current.hasUnsavedChanges()).toBe(false);
    });
  });

  describe('getBackup and clearBackup', () => {
    it('getBackup returns null when no backup exists', () => {
      const { result } = renderHook(() =>
        useAutosave({
          fileId: '/test.ipynb',
          cells: [createCell('1', 'x = 1')],
          onSave: mockOnSave,
        })
      );

      expect(result.current.getBackup('/test.ipynb')).toBeNull();
    });

    it('clearBackup removes backup from localStorage', () => {
      const { result } = renderHook(() =>
        useAutosave({
          fileId: '/test.ipynb',
          cells: [createCell('1', 'x = 1')],
          onSave: mockOnSave,
        })
      );

      result.current.clearBackup('/test.ipynb');

      expect(localStorageMock.removeItem).toHaveBeenCalledWith('nebula-backup-/test.ipynb');
      expect(localStorageMock.removeItem).toHaveBeenCalledWith('nebula-backup-timestamp-/test.ipynb');
    });
  });

  describe('disabled state', () => {
    it('does not save when disabled', async () => {
      const { rerender } = renderHook(
        ({ cells, enabled }) => useAutosave({ fileId: '/test.ipynb', cells, onSave: mockOnSave, enabled }),
        { initialProps: { cells: [createCell('1', 'x = 1')], enabled: false } }
      );

      rerender({ cells: [createCell('1', 'x = 2')], enabled: false });

      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockOnSave).not.toHaveBeenCalled();
    });
  });

  describe('no fileId', () => {
    it('does not save when fileId is null', async () => {
      const { rerender } = renderHook(
        ({ cells }) => useAutosave({ fileId: null, cells, onSave: mockOnSave }),
        { initialProps: { cells: [createCell('1', 'x = 1')] } }
      );

      rerender({ cells: [createCell('1', 'x = 2')] });

      await act(async () => {
        vi.advanceTimersByTime(5000);
        await Promise.resolve();
      });

      expect(mockOnSave).not.toHaveBeenCalled();
    });
  });
});
