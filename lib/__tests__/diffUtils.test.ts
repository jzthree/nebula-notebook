/**
 * Tests for diff utilities
 *
 * Verifies that diff-match-patch based operations work correctly
 * for efficient storage and reconstruction of edit history.
 */

import { describe, it, expect } from 'vitest';
import {
  createDiff,
  applyDiff,
  reverseDiff,
  diffToPatch,
  applyPatch,
  reversePatch,
  canApplyPatch,
  hashText,
  hashNotebookState,
} from '../diffUtils';

describe('diffUtils', () => {
  describe('createDiff and applyDiff', () => {
    it('should create and apply a simple diff', () => {
      const oldText = 'hello world';
      const newText = 'hello universe';

      const diff = createDiff(oldText, newText);
      const result = applyDiff(oldText, diff);

      expect(result).toBe(newText);
    });

    it('should handle empty strings', () => {
      const oldText = '';
      const newText = 'new content';

      const diff = createDiff(oldText, newText);
      const result = applyDiff(oldText, diff);

      expect(result).toBe(newText);
    });

    it('should handle identical strings', () => {
      const text = 'same content';

      const diff = createDiff(text, text);
      const result = applyDiff(text, diff);

      expect(result).toBe(text);
    });

    it('should handle complete replacement', () => {
      const oldText = 'old content';
      const newText = 'completely different';

      const diff = createDiff(oldText, newText);
      const result = applyDiff(oldText, diff);

      expect(result).toBe(newText);
    });

    it('should handle multiline code changes', () => {
      const oldText = `import pandas as pd
df = pd.read_csv('data.csv')
print(df.head())`;

      const newText = `import pandas as pd
import numpy as np

df = pd.read_csv('data.csv')
df['new_col'] = np.sqrt(df['value'])
print(df.head())`;

      const diff = createDiff(oldText, newText);
      const result = applyDiff(oldText, diff);

      expect(result).toBe(newText);
    });
  });

  describe('reverseDiff', () => {
    it('should reverse a diff to undo changes', () => {
      const oldText = 'hello world';
      const newText = 'hello universe';

      const diff = createDiff(oldText, newText);
      const reversed = reverseDiff(diff);

      // Apply reversed diff to newText should give oldText
      const result = applyDiff(newText, reversed);
      expect(result).toBe(oldText);
    });

    it('should handle insert reversal (becomes delete)', () => {
      const oldText = 'ab';
      const newText = 'axb';

      const diff = createDiff(oldText, newText);
      const reversed = reverseDiff(diff);
      const result = applyDiff(newText, reversed);

      expect(result).toBe(oldText);
    });

    it('should handle delete reversal (becomes insert)', () => {
      const oldText = 'abc';
      const newText = 'ac';

      const diff = createDiff(oldText, newText);
      const reversed = reverseDiff(diff);
      const result = applyDiff(newText, reversed);

      expect(result).toBe(oldText);
    });
  });

  describe('diffToPatch and applyPatch', () => {
    it('should create and apply a patch', () => {
      const oldText = 'hello world';
      const newText = 'hello universe';

      const diff = createDiff(oldText, newText);
      const patch = diffToPatch(oldText, diff);

      expect(typeof patch).toBe('string');
      expect(patch.length).toBeGreaterThan(0);

      const { result, success } = applyPatch(oldText, patch);
      expect(success).toBe(true);
      expect(result).toBe(newText);
    });

    it('should handle fuzzy matching', () => {
      // Patches can sometimes apply even with slight context changes
      const oldText = 'the quick brown fox';
      const newText = 'the slow brown fox';

      const diff = createDiff(oldText, newText);
      const patch = diffToPatch(oldText, diff);

      const { result, success } = applyPatch(oldText, patch);
      expect(success).toBe(true);
      expect(result).toBe(newText);
    });
  });

  describe('reversePatch', () => {
    it('should reverse a patch for undo', () => {
      const oldText = 'hello world';
      const newText = 'hello universe';

      const diff = createDiff(oldText, newText);
      const patch = diffToPatch(oldText, diff);

      // Apply patch forward
      const { result: forwardResult } = applyPatch(oldText, patch);
      expect(forwardResult).toBe(newText);

      // Reverse and apply
      const reversed = reversePatch(patch);
      const { result: backwardResult } = applyPatch(newText, reversed);

      // Should get back to original
      expect(backwardResult).toBe(oldText);
    });

    it('should handle empty patch', () => {
      const reversed = reversePatch('');
      expect(reversed).toBe('');
    });

    it('should reverse complex patches', () => {
      const oldText = `def calculate():
    x = 10
    return x`;

      const newText = `def calculate(y):
    x = 10 + y
    z = x * 2
    return z`;

      const diff = createDiff(oldText, newText);
      const patch = diffToPatch(oldText, diff);

      // Forward
      const { result: forward } = applyPatch(oldText, patch);
      expect(forward).toBe(newText);

      // Backward
      const reversed = reversePatch(patch);
      const { result: backward } = applyPatch(newText, reversed);
      expect(backward).toBe(oldText);
    });
  });

  describe('canApplyPatch', () => {
    it('should return true for applicable patch', () => {
      const oldText = 'hello world';
      const newText = 'hello universe';

      const diff = createDiff(oldText, newText);
      const patch = diffToPatch(oldText, diff);

      expect(canApplyPatch(oldText, patch)).toBe(true);
    });

    it('should handle empty patch', () => {
      expect(canApplyPatch('any text', '')).toBe(true);
    });
  });

  describe('hashText', () => {
    it('should produce consistent hashes', () => {
      const text = 'hello world';
      const hash1 = hashText(text);
      const hash2 = hashText(text);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different text', () => {
      const hash1 = hashText('hello');
      const hash2 = hashText('world');

      expect(hash1).not.toBe(hash2);
    });

    it('should handle empty string', () => {
      const hash = hashText('');
      expect(hash).toBe('0');
    });
  });

  describe('hashNotebookState', () => {
    it('should hash notebook state consistently', () => {
      const cells = [
        { id: 'cell1', content: 'print("hello")', type: 'code' },
        { id: 'cell2', content: '# Note', type: 'markdown' },
      ];

      const hash1 = hashNotebookState(cells);
      const hash2 = hashNotebookState(cells);

      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different states', () => {
      const cells1 = [{ id: 'cell1', content: 'a', type: 'code' }];
      const cells2 = [{ id: 'cell1', content: 'b', type: 'code' }];

      const hash1 = hashNotebookState(cells1);
      const hash2 = hashNotebookState(cells2);

      expect(hash1).not.toBe(hash2);
    });

    it('should detect cell order changes', () => {
      const cells1 = [
        { id: 'cell1', content: 'a', type: 'code' },
        { id: 'cell2', content: 'b', type: 'code' },
      ];
      const cells2 = [
        { id: 'cell2', content: 'b', type: 'code' },
        { id: 'cell1', content: 'a', type: 'code' },
      ];

      const hash1 = hashNotebookState(cells1);
      const hash2 = hashNotebookState(cells2);

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle incremental code edits efficiently', () => {
      // Simulate typical code editing session
      const versions = [
        'x = 1',
        'x = 10',
        'x = 10\ny = 20',
        'x = 10\ny = 20\nz = x + y',
        'x = 10\ny = 20\nresult = x + y',
      ];

      // Create patches between consecutive versions
      const patches: string[] = [];
      for (let i = 0; i < versions.length - 1; i++) {
        const diff = createDiff(versions[i], versions[i + 1]);
        patches.push(diffToPatch(versions[i], diff));
      }

      // Verify we can reconstruct forward
      let current = versions[0];
      for (let i = 0; i < patches.length; i++) {
        const { result, success } = applyPatch(current, patches[i]);
        expect(success).toBe(true);
        expect(result).toBe(versions[i + 1]);
        current = result;
      }

      // Verify we can reconstruct backward
      current = versions[versions.length - 1];
      for (let i = patches.length - 1; i >= 0; i--) {
        const reversed = reversePatch(patches[i]);
        const { result } = applyPatch(current, reversed);
        expect(result).toBe(versions[i]);
        current = result;
      }
    });

    it('should handle typical notebook cell content', () => {
      const cellV1 = `# Data Analysis
import pandas as pd
df = pd.read_csv('data.csv')`;

      const cellV2 = `# Data Analysis
import pandas as pd
import matplotlib.pyplot as plt

df = pd.read_csv('data.csv')
print(df.shape)`;

      const cellV3 = `# Data Analysis Pipeline
import pandas as pd
import matplotlib.pyplot as plt
import seaborn as sns

df = pd.read_csv('data.csv')
print(f"Shape: {df.shape}")
df.head()`;

      // V1 -> V2
      const diff12 = createDiff(cellV1, cellV2);
      const patch12 = diffToPatch(cellV1, diff12);

      // V2 -> V3
      const diff23 = createDiff(cellV2, cellV3);
      const patch23 = diffToPatch(cellV2, diff23);

      // Forward reconstruction
      let result = applyPatch(cellV1, patch12);
      expect(result.result).toBe(cellV2);

      result = applyPatch(cellV2, patch23);
      expect(result.result).toBe(cellV3);

      // Backward reconstruction
      const revPatch23 = reversePatch(patch23);
      result = applyPatch(cellV3, revPatch23);
      expect(result.result).toBe(cellV2);

      const revPatch12 = reversePatch(patch12);
      result = applyPatch(cellV2, revPatch12);
      expect(result.result).toBe(cellV1);
    });
  });
});
