/**
 * useConflictResolution Hook
 *
 * Manages conflict detection and resolution UI state.
 * A conflict occurs when the server file has been modified
 * while the user was editing locally.
 */
import { useState, useCallback } from 'react';
import { Cell } from '../types';
import {
  saveWithConflictCheck,
  forceSaveLocal,
  loadRemoteVersion,
  SaveWithConflictCheckResult
} from '../services/conflictService';
import { updateNotebookMetadata } from '../services/fileService';

export interface ConflictDialogState {
  show: boolean;
  fileId: string;
  remoteMtime: number;
  localCells: Cell[];
  kernelName?: string;
  history?: any[];
}

export interface UseConflictResolutionResult {
  /** Current conflict dialog state, null if no conflict */
  conflictDialog: ConflictDialogState | null;

  /**
   * Save cells with conflict checking.
   * If conflict detected, shows dialog and returns { needsResolution: true }.
   * If no conflict, saves and returns { success: true, newMtime }.
   */
  saveWithCheck: (
    fileId: string,
    cells: Cell[],
    lastKnownMtime: number | null,
    kernelName?: string,
    history?: any[]
  ) => Promise<{
    success: boolean;
    needsResolution: boolean;
    newMtime: number | null;
    error?: string;
  }>;

  /**
   * Resolve conflict by keeping local version (overwrite server).
   * Returns the new mtime after save.
   */
  keepLocal: () => Promise<{ success: boolean; newMtime: number | null }>;

  /**
   * Resolve conflict by loading remote version (discard local).
   * Returns the loaded cells and mtime.
   */
  loadRemote: () => Promise<{ success: boolean; cells: Cell[] | null; mtime: number | null }>;

  /** Dismiss conflict dialog without action */
  dismissDialog: () => void;
}

/**
 * Hook for managing conflict detection and resolution.
 *
 * @param onMtimeUpdate - Callback when mtime changes (after save or load)
 * @param onCellsReset - Callback when cells should be reset (after loading remote)
 */
export function useConflictResolution(
  onMtimeUpdate: (mtime: number) => void,
  onCellsReset: (cells: Cell[]) => void
): UseConflictResolutionResult {
  const [conflictDialog, setConflictDialog] = useState<ConflictDialogState | null>(null);

  const saveWithCheck = useCallback(async (
    fileId: string,
    cells: Cell[],
    lastKnownMtime: number | null,
    kernelName?: string,
    history?: any[]
  ): Promise<{
    success: boolean;
    needsResolution: boolean;
    newMtime: number | null;
    error?: string;
  }> => {
    const result = await saveWithConflictCheck(
      fileId,
      cells,
      lastKnownMtime,
      kernelName,
      history
    );

    if (result.conflict) {
      // Conflict detected - show dialog
      setConflictDialog({
        show: true,
        fileId,
        remoteMtime: result.conflict.remoteMtime,
        localCells: cells,
        kernelName,
        history
      });

      return {
        success: false,
        needsResolution: true,
        newMtime: null
      };
    }

    if (result.success && result.newMtime !== null) {
      onMtimeUpdate(result.newMtime);
      return {
        success: true,
        needsResolution: false,
        newMtime: result.newMtime
      };
    }

    return {
      success: false,
      needsResolution: false,
      newMtime: null,
      error: result.error
    };
  }, [onMtimeUpdate]);

  const keepLocal = useCallback(async (): Promise<{ success: boolean; newMtime: number | null }> => {
    if (!conflictDialog) {
      return { success: false, newMtime: null };
    }

    const { fileId, localCells, kernelName, history } = conflictDialog;

    const result = await forceSaveLocal(fileId, localCells, kernelName, history);

    if (result.success && result.newMtime !== null) {
      onMtimeUpdate(result.newMtime);
      await updateNotebookMetadata(fileId, {});
    }

    setConflictDialog(null);
    return { success: result.success, newMtime: result.newMtime };
  }, [conflictDialog, onMtimeUpdate]);

  const loadRemote = useCallback(async (): Promise<{
    success: boolean;
    cells: Cell[] | null;
    mtime: number | null;
  }> => {
    if (!conflictDialog) {
      return { success: false, cells: null, mtime: null };
    }

    const { fileId } = conflictDialog;

    const result = await loadRemoteVersion(fileId);

    if (result.success && result.cells && result.mtime !== null) {
      onCellsReset(result.cells);
      onMtimeUpdate(result.mtime);
    }

    setConflictDialog(null);
    return {
      success: result.success,
      cells: result.cells,
      mtime: result.mtime
    };
  }, [conflictDialog, onCellsReset, onMtimeUpdate]);

  const dismissDialog = useCallback(() => {
    setConflictDialog(null);
  }, []);

  return {
    conflictDialog,
    saveWithCheck,
    keepLocal,
    loadRemote,
    dismissDialog
  };
}
