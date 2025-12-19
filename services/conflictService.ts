/**
 * Conflict Detection Service
 *
 * Pure functions for detecting file conflicts via mtime comparison
 * and serializing cells for content comparison.
 */
import { Cell } from '../types';
import { getFileMtime } from './fileService';

export interface ConflictCheckResult {
  hasConflict: boolean;
  localMtime: number | null;
  remoteMtime: number | null;
}

/**
 * Check if a remote file has been modified since we last loaded/saved it.
 *
 * @param fileId - Path to the file
 * @param lastKnownMtime - The mtime we have on record (from last load or save)
 * @returns ConflictCheckResult indicating if there's a conflict
 *
 * Note: This function "fails open" - if we can't check the remote mtime
 * (network error, file deleted, etc.), we return no conflict and let
 * the save proceed. This is intentional to avoid blocking the user.
 */
export async function checkForConflict(
  fileId: string,
  lastKnownMtime: number | null
): Promise<ConflictCheckResult> {
  // If we don't have a baseline mtime, we can't detect conflicts
  if (lastKnownMtime === null) {
    return {
      hasConflict: false,
      localMtime: null,
      remoteMtime: null,
    };
  }

  try {
    const remote = await getFileMtime(fileId);
    const hasConflict = remote.mtime > lastKnownMtime;

    return {
      hasConflict,
      localMtime: lastKnownMtime,
      remoteMtime: remote.mtime,
    };
  } catch (error) {
    // Network error, file not found, permission error, etc.
    // Fail open - allow the save to proceed
    console.warn('Could not check remote mtime:', error);
    return {
      hasConflict: false,
      localMtime: lastKnownMtime,
      remoteMtime: null,
    };
  }
}

/**
 * Serialize cells for content comparison.
 *
 * This function creates a stable JSON representation of cells that:
 * - Includes: id, type, content, outputs (id, type, content)
 * - Excludes: isExecuting, executionCount, output timestamps
 *
 * The exclusions ensure we don't trigger unnecessary saves for
 * transient state changes that don't represent actual content changes.
 *
 * @param cells - Array of cells to serialize
 * @returns JSON string suitable for comparison
 */
export function serializeCellsForComparison(cells: Cell[]): string {
  return JSON.stringify(
    cells.map((c) => ({
      id: c.id,
      type: c.type,
      content: c.content,
      // Include outputs but exclude timestamp (not content-relevant)
      outputs: c.outputs?.map((o) => ({
        id: o.id,
        type: o.type,
        content: o.content,
      })),
    }))
  );
}

/**
 * Check if cells have changed compared to last saved content.
 *
 * @param currentCells - Current cell state
 * @param lastSavedContent - Serialized content from last save
 * @returns true if there are unsaved changes
 */
export function haveCellsChanged(
  currentCells: Cell[],
  lastSavedContent: string
): boolean {
  return serializeCellsForComparison(currentCells) !== lastSavedContent;
}
