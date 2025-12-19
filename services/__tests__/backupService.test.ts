/**
 * Tests for backupService - localStorage backup management for crash recovery
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Cell } from '../../types';

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] || null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: vi.fn(() => {
      store = {};
    }),
    get length() {
      return Object.keys(store).length;
    },
    key: vi.fn((index: number) => Object.keys(store)[index] || null),
  };
})();

Object.defineProperty(global, 'localStorage', {
  value: localStorageMock,
});

import {
  saveBackup,
  getBackup,
  clearBackup,
  checkBackupForRecovery,
  BACKUP_KEY_PREFIX,
  BACKUP_TIMESTAMP_KEY_PREFIX,
  BACKUP_MAX_AGE_MS,
  BackupData,
  BackupCheckResult,
} from '../backupService';

describe('backupService', () => {
  beforeEach(() => {
    localStorageMock.clear();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T12:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const createTestCell = (id: string, content: string): Cell => ({
    id,
    type: 'code',
    content,
    outputs: [],
    isExecuting: false,
  });

  describe('saveBackup', () => {
    it('saves cells and timestamp to localStorage', () => {
      const cells = [createTestCell('1', 'x = 1')];
      const result = saveBackup('/test.ipynb', cells);

      expect(result).toBe(true);
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        BACKUP_KEY_PREFIX + '/test.ipynb',
        JSON.stringify(cells)
      );
      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        BACKUP_TIMESTAMP_KEY_PREFIX + '/test.ipynb',
        expect.any(String)
      );
    });

    it('returns false when localStorage throws', () => {
      const cells = [createTestCell('1', 'x = 1')];
      localStorageMock.setItem.mockImplementationOnce(() => {
        throw new Error('QuotaExceededError');
      });
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = saveBackup('/test.ipynb', cells);

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });

    it('stores current timestamp', () => {
      const cells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', cells);

      const timestampCall = localStorageMock.setItem.mock.calls.find(
        (call) => call[0] === BACKUP_TIMESTAMP_KEY_PREFIX + '/test.ipynb'
      );

      expect(timestampCall).toBeDefined();
      expect(parseInt(timestampCall![1], 10)).toBe(Date.now());
    });
  });

  describe('getBackup', () => {
    it('returns null when no backup exists', () => {
      const result = getBackup('/nonexistent.ipynb');
      expect(result).toBeNull();
    });

    it('returns backup data when exists', () => {
      const cells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', cells);

      const backup = getBackup('/test.ipynb');

      expect(backup).not.toBeNull();
      expect(backup?.cells).toEqual(cells);
      expect(backup?.timestamp).toBe(Date.now());
    });

    it('returns null when only cells exist but no timestamp', () => {
      localStorageMock.setItem(BACKUP_KEY_PREFIX + '/test.ipynb', JSON.stringify([]));
      // No timestamp set

      const result = getBackup('/test.ipynb');
      expect(result).toBeNull();
    });

    it('returns null when only timestamp exists but no cells', () => {
      localStorageMock.setItem(BACKUP_TIMESTAMP_KEY_PREFIX + '/test.ipynb', Date.now().toString());
      // No cells set

      const result = getBackup('/test.ipynb');
      expect(result).toBeNull();
    });

    it('returns null and warns when JSON is invalid', () => {
      localStorageMock.setItem(BACKUP_KEY_PREFIX + '/test.ipynb', 'not valid json');
      localStorageMock.setItem(BACKUP_TIMESTAMP_KEY_PREFIX + '/test.ipynb', Date.now().toString());
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = getBackup('/test.ipynb');

      expect(result).toBeNull();
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('clearBackup', () => {
    it('removes backup from localStorage', () => {
      const cells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', cells);

      clearBackup('/test.ipynb');

      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        BACKUP_KEY_PREFIX + '/test.ipynb'
      );
      expect(localStorageMock.removeItem).toHaveBeenCalledWith(
        BACKUP_TIMESTAMP_KEY_PREFIX + '/test.ipynb'
      );
      expect(getBackup('/test.ipynb')).toBeNull();
    });

    it('does not throw when backup does not exist', () => {
      expect(() => clearBackup('/nonexistent.ipynb')).not.toThrow();
    });

    it('silently handles localStorage errors', () => {
      localStorageMock.removeItem.mockImplementationOnce(() => {
        throw new Error('Storage error');
      });

      expect(() => clearBackup('/test.ipynb')).not.toThrow();
    });
  });

  describe('checkBackupForRecovery', () => {
    const serializeFn = (cells: Cell[]) =>
      JSON.stringify(cells.map((c) => ({ id: c.id, content: c.content })));

    it('returns hasBackup false when no backup exists', () => {
      const loadedCells = [createTestCell('1', 'x = 1')];

      const result = checkBackupForRecovery('/test.ipynb', loadedCells, serializeFn);

      expect(result.hasBackup).toBe(false);
      expect(result.backup).toBeNull();
      expect(result.isStale).toBe(false);
      expect(result.contentsDiffer).toBe(false);
    });

    it('returns isStale true and clears backup when older than max age', () => {
      const cells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', cells);

      // Advance time past max age (1 hour)
      vi.advanceTimersByTime(BACKUP_MAX_AGE_MS + 1000);

      const result = checkBackupForRecovery('/test.ipynb', [], serializeFn);

      expect(result.isStale).toBe(true);
      expect(result.hasBackup).toBe(false);
      // Backup should be cleared
      expect(getBackup('/test.ipynb')).toBeNull();
    });

    it('returns hasBackup true when backup is fresh', () => {
      const cells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', cells);

      // Advance time but stay within max age
      vi.advanceTimersByTime(BACKUP_MAX_AGE_MS - 1000);

      const result = checkBackupForRecovery('/test.ipynb', [], serializeFn);

      expect(result.hasBackup).toBe(true);
      expect(result.isStale).toBe(false);
    });

    it('detects when backup differs from loaded content', () => {
      const backupCells = [createTestCell('1', 'x = 1')];
      const loadedCells = [createTestCell('1', 'x = 2')]; // Different content
      saveBackup('/test.ipynb', backupCells);

      const result = checkBackupForRecovery('/test.ipynb', loadedCells, serializeFn);

      expect(result.hasBackup).toBe(true);
      expect(result.contentsDiffer).toBe(true);
      expect(result.backup?.cells).toEqual(backupCells);
    });

    it('detects when backup matches loaded content', () => {
      const cells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', cells);

      const result = checkBackupForRecovery('/test.ipynb', cells, serializeFn);

      expect(result.hasBackup).toBe(true);
      expect(result.contentsDiffer).toBe(false);
    });

    it('returns backup data with correct timestamp', () => {
      const cells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', cells);
      const savedTime = Date.now();

      // Advance time a bit
      vi.advanceTimersByTime(5000);

      const result = checkBackupForRecovery('/test.ipynb', [], serializeFn);

      expect(result.backup?.timestamp).toBe(savedTime);
    });

    it('uses provided serialize function for comparison', () => {
      const cells1 = [createTestCell('1', 'x = 1')];
      const cells2 = [createTestCell('1', 'x = 1')]; // Same content but different object
      saveBackup('/test.ipynb', cells1);

      // Custom serializer that only looks at content
      const customSerialize = (cells: Cell[]) => cells.map((c) => c.content).join('|');

      const result = checkBackupForRecovery('/test.ipynb', cells2, customSerialize);

      expect(result.contentsDiffer).toBe(false);
    });

    it('handles backup with more cells than loaded', () => {
      const backupCells = [
        createTestCell('1', 'x = 1'),
        createTestCell('2', 'y = 2'),
      ];
      const loadedCells = [createTestCell('1', 'x = 1')];
      saveBackup('/test.ipynb', backupCells);

      const result = checkBackupForRecovery('/test.ipynb', loadedCells, serializeFn);

      expect(result.contentsDiffer).toBe(true);
    });

    it('handles backup with fewer cells than loaded', () => {
      const backupCells = [createTestCell('1', 'x = 1')];
      const loadedCells = [
        createTestCell('1', 'x = 1'),
        createTestCell('2', 'y = 2'),
      ];
      saveBackup('/test.ipynb', backupCells);

      const result = checkBackupForRecovery('/test.ipynb', loadedCells, serializeFn);

      expect(result.contentsDiffer).toBe(true);
    });
  });

  describe('constants', () => {
    it('BACKUP_MAX_AGE_MS is 1 hour', () => {
      expect(BACKUP_MAX_AGE_MS).toBe(60 * 60 * 1000);
    });

    it('BACKUP_KEY_PREFIX is correct', () => {
      expect(BACKUP_KEY_PREFIX).toBe('nebula-backup-');
    });

    it('BACKUP_TIMESTAMP_KEY_PREFIX is correct', () => {
      expect(BACKUP_TIMESTAMP_KEY_PREFIX).toBe('nebula-backup-timestamp-');
    });
  });
});
