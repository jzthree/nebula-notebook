/**
 * useConflictResolution Hook
 *
 * Manages conflict detection and resolution for file saves.
 * Extracts conflict logic from Notebook.tsx into a reusable hook.
 */
import { useState, useCallback } from 'react';
import { Cell } from '../types';
import { checkForConflict } from '../services/conflictService';
import { getFileContentWithMtime, saveFileContentWithMtime } from '../services/fileService';

export interface ConflictDialogState {
  isOpen: boolean;
  remoteMtime: number | null;
  fileId: string | null;
}

export interface SaveResult {
  success: boolean;
  mtime?: number;
  needsResolution?: boolean;
}

export interface UseConflictResolutionResult {
  conflictDialog: ConflictDialogState;
  checkAndSave: (
    fileId: string,
    cells: Cell[],
    lastKnownMtime: number | null
  ) => Promise<SaveResult>;
  keepLocal: () => Promise<void>;
  loadRemote: () => Promise<Cell[] | null>;
  dismiss: () => void;
}

/**
 * Hook for managing conflict detection and resolution.
 *
 * @param onMtimeUpdate - Callback when mtime is updated after save/load
 * @param onCellsReset - Callback when cells should be reset (after loading remote)
 * @param currentKernel - Current kernel name for save operations
 */
export function useConflictResolution(
  onMtimeUpdate: (mtime: number) => void,
  onCellsReset: (cells: Cell[]) => void,
  currentKernel: string
): UseConflictResolutionResult {
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState>({
    isOpen: false,
    remoteMtime: null,
    fileId: null,
  });

  // Store pending save data for resolution
  const [pendingSave, setPendingSave] = useState<{
    fileId: string;
    cells: Cell[];
  } | null>(null);

  /**
   * Check for conflicts and save if none exist.
   * Opens conflict dialog if remote file has changed.
   */
  const checkAndSave = useCallback(
    async (
      fileId: string,
      cells: Cell[],
      lastKnownMtime: number | null
    ): Promise<SaveResult> => {
      // Check for conflict
      const conflictResult = await checkForConflict(fileId, lastKnownMtime);

      if (conflictResult.hasConflict) {
        // Store pending save and show dialog
        setPendingSave({ fileId, cells });
        setConflictDialog({
          isOpen: true,
          remoteMtime: conflictResult.remoteMtime,
          fileId,
        });
        return { success: false, needsResolution: true };
      }

      // No conflict, proceed with save
      const result = await saveFileContentWithMtime(fileId, cells, currentKernel);
      if (result) {
        onMtimeUpdate(result.mtime);
        return { success: true, mtime: result.mtime };
      }
      return { success: false };
    },
    [currentKernel, onMtimeUpdate]
  );

  /**
   * Keep local changes - force save pending cells.
   */
  const keepLocal = useCallback(async (): Promise<void> => {
    if (!pendingSave) return;

    const result = await saveFileContentWithMtime(
      pendingSave.fileId,
      pendingSave.cells,
      currentKernel
    );
    if (result) {
      onMtimeUpdate(result.mtime);
    }

    setConflictDialog({ isOpen: false, remoteMtime: null, fileId: null });
    setPendingSave(null);
  }, [pendingSave, currentKernel, onMtimeUpdate]);

  /**
   * Load remote version - fetch and reset cells.
   */
  const loadRemote = useCallback(async (): Promise<Cell[] | null> => {
    if (!conflictDialog.fileId) return null;

    const content = await getFileContentWithMtime(conflictDialog.fileId);
    if (content) {
      onMtimeUpdate(content.mtime);
      onCellsReset(content.cells);
      setConflictDialog({ isOpen: false, remoteMtime: null, fileId: null });
      setPendingSave(null);
      return content.cells;
    }
    return null;
  }, [conflictDialog.fileId, onMtimeUpdate, onCellsReset]);

  /**
   * Dismiss the conflict dialog without taking action.
   */
  const dismiss = useCallback(() => {
    setConflictDialog({ isOpen: false, remoteMtime: null, fileId: null });
    setPendingSave(null);
  }, []);

  return {
    conflictDialog,
    checkAndSave,
    keepLocal,
    loadRemote,
    dismiss,
  };
}
