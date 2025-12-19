/**
 * useRecoveryBanner Hook
 *
 * Manages crash recovery banner state.
 * Extracts recovery logic from Notebook.tsx into a reusable hook.
 */
import { useState, useCallback } from 'react';
import { Cell } from '../types';
import {
  checkBackupForRecovery,
  clearBackup,
  BackupData,
} from '../services/backupService';
import { serializeCellsForComparison } from '../services/conflictService';

export interface UseRecoveryBannerResult {
  showBanner: boolean;
  recoveryData: BackupData | null;
  checkForRecovery: (fileId: string, loadedCells: Cell[]) => void;
  recoverChanges: () => Cell[] | null;
  discardRecovery: () => void;
}

/**
 * Hook for managing crash recovery UI state.
 *
 * @param currentFileId - Current file being edited (null if no file)
 * @param onRecover - Callback when user chooses to recover changes
 */
export function useRecoveryBanner(
  currentFileId: string | null,
  onRecover: (cells: Cell[]) => void
): UseRecoveryBannerResult {
  const [showBanner, setShowBanner] = useState(false);
  const [recoveryData, setRecoveryData] = useState<BackupData | null>(null);

  /**
   * Check if there's a backup that should be shown for recovery.
   */
  const checkForRecovery = useCallback(
    (fileId: string, loadedCells: Cell[]) => {
      const result = checkBackupForRecovery(
        fileId,
        loadedCells,
        serializeCellsForComparison
      );

      if (result.hasBackup && result.contentsDiffer && result.backup) {
        setRecoveryData(result.backup);
        setShowBanner(true);
      } else {
        setShowBanner(false);
        setRecoveryData(null);
      }
    },
    []
  );

  /**
   * Recover changes from backup.
   * Returns the recovered cells, or null if no recovery data.
   */
  const recoverChanges = useCallback((): Cell[] | null => {
    if (!recoveryData || !currentFileId) return null;

    onRecover(recoveryData.cells);
    clearBackup(currentFileId);
    setShowBanner(false);
    setRecoveryData(null);

    return recoveryData.cells;
  }, [recoveryData, currentFileId, onRecover]);

  /**
   * Discard recovery - clear backup and hide banner.
   */
  const discardRecovery = useCallback(() => {
    if (currentFileId) {
      clearBackup(currentFileId);
    }
    setShowBanner(false);
    setRecoveryData(null);
  }, [currentFileId]);

  return {
    showBanner,
    recoveryData,
    checkForRecovery,
    recoverChanges,
    discardRecovery,
  };
}
