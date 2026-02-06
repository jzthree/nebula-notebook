/**
 * Conflict Service
 *
 * Pure functions for detecting and handling file conflicts.
 * A conflict occurs when the server's file has been modified
 * since we last loaded/saved it (detected via mtime comparison).
 */
import { getFileMtime, getFileContentWithMtime, saveFileContentWithMtime } from './fileService';
import { Cell } from '../types';
import { MTIME_TOLERANCE_SECONDS } from '../config';

export interface ConflictCheckResult {
  hasConflict: boolean;
  remoteMtime: number | null;
  error?: string;
}

export interface SaveWithConflictCheckResult {
  success: boolean;
  newMtime: number | null;
  conflict?: {
    remoteMtime: number;
  };
  error?: string;
}

/**
 * Check if the remote file has been modified since our last known mtime.
 *
 * @param fileId - Path to the notebook file
 * @param lastKnownMtime - The mtime we last saw (from load or save)
 * @returns ConflictCheckResult indicating if there's a conflict
 */
export async function checkForConflict(
  fileId: string,
  lastKnownMtime: number | null
): Promise<ConflictCheckResult> {
  // If we don't have a baseline mtime, we can't detect conflicts
  if (lastKnownMtime === null) {
    return { hasConflict: false, remoteMtime: null };
  }

  try {
    const remoteMtimeData = await getFileMtime(fileId);
    // Use tolerance to avoid false positives from floating-point precision issues
    const mtimeDiff = remoteMtimeData.mtime - lastKnownMtime;
    const hasConflict = mtimeDiff > MTIME_TOLERANCE_SECONDS;

    // Log for debugging false positives
    if (hasConflict) {
      console.warn(`Conflict detected: remote=${remoteMtimeData.mtime}, local=${lastKnownMtime}, diff=${mtimeDiff.toFixed(3)}s`);
    }

    return {
      hasConflict,
      remoteMtime: remoteMtimeData.mtime
    };
  } catch (error) {
    // Network error or file doesn't exist - can't check for conflict
    console.warn('Could not check remote mtime:', error);
    return {
      hasConflict: false,
      remoteMtime: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Save cells to file, checking for conflicts first.
 * Returns conflict info if detected, otherwise saves and returns new mtime.
 *
 * @param fileId - Path to the notebook file
 * @param cells - Cells to save
 * @param lastKnownMtime - The mtime we last saw
 * @param kernelName - Optional kernel name to persist
 * @param history - Optional history to save alongside
 * @returns SaveWithConflictCheckResult
 */
export async function saveWithConflictCheck(
  fileId: string,
  cells: Cell[],
  lastKnownMtime: number | null,
  kernelName?: string,
  history?: any[],
  options?: { sessionId?: string | null; kernelOutputSeq?: number | null }
): Promise<SaveWithConflictCheckResult> {
  // Check for conflict first
  const conflictCheck = await checkForConflict(fileId, lastKnownMtime);

  if (conflictCheck.hasConflict && conflictCheck.remoteMtime !== null) {
    return {
      success: false,
      newMtime: null,
      conflict: {
        remoteMtime: conflictCheck.remoteMtime
      }
    };
  }

  // No conflict - proceed with save
  try {
    const result = await saveFileContentWithMtime(fileId, cells, kernelName, history, options);
    if (result) {
      return {
        success: true,
        newMtime: result.mtime
      };
    }
    return {
      success: false,
      newMtime: null,
      error: 'Save returned no result'
    };
  } catch (error) {
    return {
      success: false,
      newMtime: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Force save local version, ignoring any conflicts.
 * Use this when user explicitly chooses to overwrite remote.
 */
export async function forceSaveLocal(
  fileId: string,
  cells: Cell[],
  kernelName?: string,
  history?: any[],
  options?: { sessionId?: string | null; kernelOutputSeq?: number | null }
): Promise<{ success: boolean; newMtime: number | null; error?: string }> {
  try {
    const result = await saveFileContentWithMtime(fileId, cells, kernelName, history, options);
    if (result) {
      return { success: true, newMtime: result.mtime };
    }
    return { success: false, newMtime: null, error: 'Save returned no result' };
  } catch (error) {
    return {
      success: false,
      newMtime: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}

/**
 * Load remote version, discarding local changes.
 * Use this when user explicitly chooses to reload from server.
 */
export async function loadRemoteVersion(
  fileId: string
): Promise<{ success: boolean; cells: Cell[] | null; mtime: number | null; error?: string }> {
  try {
    const result = await getFileContentWithMtime(fileId);
    if (result) {
      return {
        success: true,
        cells: result.cells,
        mtime: result.mtime
      };
    }
    return { success: false, cells: null, mtime: null, error: 'Load returned no result' };
  } catch (error) {
    return {
      success: false,
      cells: null,
      mtime: null,
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }
}
