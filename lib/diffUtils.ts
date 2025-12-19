/**
 * Diff Utilities for efficient history storage
 *
 * Uses diff-match-patch (Google's library, same as Google Docs)
 * for character-level diffs that handle text editing well.
 */

import DiffMatchPatch from 'diff-match-patch';

const dmp = new DiffMatchPatch();

// Diff format: array of [operation, text] tuples
// operation: -1 = delete, 0 = equal, 1 = insert
export type Diff = [number, string][];

// Patch format for storage (more compact than raw diffs)
export type Patch = string;

/**
 * Create a diff between two strings
 */
export function createDiff(oldText: string, newText: string): Diff {
  const diffs = dmp.diff_main(oldText, newText);
  dmp.diff_cleanupSemantic(diffs); // Make diffs more human-readable
  return diffs;
}

/**
 * Apply a diff to transform oldText into newText
 */
export function applyDiff(oldText: string, diff: Diff): string {
  let result = '';
  let index = 0;

  for (const [op, text] of diff) {
    if (op === 0) {
      // Equal - copy from original
      result += text;
      index += text.length;
    } else if (op === -1) {
      // Delete - skip in original
      index += text.length;
    } else if (op === 1) {
      // Insert - add new text
      result += text;
    }
  }

  return result;
}

/**
 * Reverse a diff (for undo)
 * Swaps inserts and deletes
 */
export function reverseDiff(diff: Diff): Diff {
  return diff.map(([op, text]) => [-op as -1 | 0 | 1, text]);
}

/**
 * Convert diff to a compact patch string for storage
 */
export function diffToPatch(oldText: string, diff: Diff): Patch {
  const patches = dmp.patch_make(oldText, diff);
  return dmp.patch_toText(patches);
}

/**
 * Apply a patch string to text
 */
export function applyPatch(text: string, patch: Patch): { result: string; success: boolean } {
  const patches = dmp.patch_fromText(patch);
  const [result, results] = dmp.patch_apply(patches, text);
  const success = results.every(r => r);
  return { result, success };
}

/**
 * Reverse a patch (for undo)
 * Note: We recreate the patch from the reversed diff rather than trying to
 * manipulate patch objects directly (which has typing issues)
 */
export function reversePatch(patch: Patch): Patch {
  // Parse the patch to understand what it does
  const patches = dmp.patch_fromText(patch);
  if (patches.length === 0) return '';

  // Reconstruct by reversing the diffs in each patch
  // This is a simplified approach - create patches from reversed diffs
  // Note: We cast to any because @types/diff-match-patch has incorrect typings
  // (returns constructor type instead of instance type)
  const allReversedDiffs: Diff = [];
  for (const p of patches as unknown as { diffs: Diff }[]) {
    allReversedDiffs.push(...reverseDiff(p.diffs));
  }

  // Create new patches from the reversed diffs
  // We need dummy text to make patches, so use the diffs directly
  const reversedPatches = dmp.patch_make(allReversedDiffs);
  return dmp.patch_toText(reversedPatches);
}

/**
 * Check if a patch can be applied cleanly to text
 */
export function canApplyPatch(text: string, patch: Patch): boolean {
  const patches = dmp.patch_fromText(patch);
  const [, results] = dmp.patch_apply(patches, text);
  return results.every(r => r);
}

/**
 * Compute a hash of text for integrity checking
 * Simple but effective for detecting changes
 */
export function hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(16);
}

/**
 * Compute a hash of notebook state for integrity checking
 */
export function hashNotebookState(cells: { id: string; content: string; type: string }[]): string {
  const stateString = cells
    .map(c => `${c.id}:${c.type}:${hashText(c.content)}`)
    .join('|');
  return hashText(stateString);
}
