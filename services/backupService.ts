/**
 * Backup Service
 *
 * Manages localStorage backups for crash recovery.
 * Backups are created before each save attempt and cleared on success.
 */
import { Cell } from '../types';

export const BACKUP_KEY_PREFIX = 'nebula-backup-';
export const BACKUP_TIMESTAMP_KEY_PREFIX = 'nebula-backup-timestamp-';
export const BACKUP_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

export interface BackupData {
  cells: Cell[];
  timestamp: number;
}

export interface BackupCheckResult {
  hasBackup: boolean;
  backup: BackupData | null;
  isStale: boolean;
  contentsDiffer: boolean;
}

/**
 * Save a backup of cells to localStorage.
 *
 * @param fileId - Path to the notebook file (used as key)
 * @param cells - Current cell state to backup
 * @returns true if backup was saved successfully
 */
export function saveBackup(fileId: string, cells: Cell[]): boolean {
  try {
    const backupKey = BACKUP_KEY_PREFIX + fileId;
    const timestampKey = BACKUP_TIMESTAMP_KEY_PREFIX + fileId;
    localStorage.setItem(backupKey, JSON.stringify(cells));
    localStorage.setItem(timestampKey, Date.now().toString());
    return true;
  } catch (e) {
    console.warn('Failed to save backup to localStorage:', e);
    return false;
  }
}

/**
 * Get a backup from localStorage.
 *
 * @param fileId - Path to the notebook file
 * @returns BackupData if backup exists and is valid, null otherwise
 */
export function getBackup(fileId: string): BackupData | null {
  try {
    const backupKey = BACKUP_KEY_PREFIX + fileId;
    const timestampKey = BACKUP_TIMESTAMP_KEY_PREFIX + fileId;
    const backup = localStorage.getItem(backupKey);
    const timestamp = localStorage.getItem(timestampKey);

    if (backup && timestamp) {
      return {
        cells: JSON.parse(backup),
        timestamp: parseInt(timestamp, 10),
      };
    }
  } catch (e) {
    console.warn('Failed to read backup from localStorage:', e);
  }
  return null;
}

/**
 * Clear a backup from localStorage.
 *
 * @param fileId - Path to the notebook file
 */
export function clearBackup(fileId: string): void {
  try {
    localStorage.removeItem(BACKUP_KEY_PREFIX + fileId);
    localStorage.removeItem(BACKUP_TIMESTAMP_KEY_PREFIX + fileId);
  } catch (e) {
    // Silently ignore errors - clearing backup is not critical
  }
}

/**
 * Check if a backup exists and should be shown for recovery.
 *
 * This function:
 * 1. Checks if a backup exists
 * 2. Verifies the backup is not stale (> 1 hour old)
 * 3. Compares backup content to loaded content using provided serializer
 *
 * If the backup is stale, it is automatically cleared.
 *
 * @param fileId - Path to the notebook file
 * @param loadedCells - Cells loaded from the file
 * @param serializeFn - Function to serialize cells for comparison
 * @returns BackupCheckResult with backup status and data
 */
export function checkBackupForRecovery(
  fileId: string,
  loadedCells: Cell[],
  serializeFn: (cells: Cell[]) => string
): BackupCheckResult {
  const backup = getBackup(fileId);

  if (!backup) {
    return {
      hasBackup: false,
      backup: null,
      isStale: false,
      contentsDiffer: false,
    };
  }

  const age = Date.now() - backup.timestamp;
  const isStale = age >= BACKUP_MAX_AGE_MS;

  if (isStale) {
    // Clear stale backups
    clearBackup(fileId);
    return {
      hasBackup: false,
      backup: null,
      isStale: true,
      contentsDiffer: false,
    };
  }

  // Compare content using provided serializer
  const backupContent = serializeFn(backup.cells);
  const loadedContent = serializeFn(loadedCells);
  const contentsDiffer = backupContent !== loadedContent;

  return {
    hasBackup: true,
    backup,
    isStale: false,
    contentsDiffer,
  };
}
