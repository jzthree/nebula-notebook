// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { privateTmpDir } from '../private-tmp';

describe('privateTmpDir', () => {
  it('creates a per-user 0700 directory under tmp and reuses it', () => {
    const dir = privateTmpDir('kernels');
    expect(fs.existsSync(dir)).toBe(true);
    expect(dir).toContain(`nebula-`);
    expect(dir.startsWith(os.tmpdir())).toBe(true);
    // root dir is owner-only
    const root = path.dirname(dir);
    if (process.platform !== 'win32') {
      expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    }
    // second call: same path, no throw
    expect(privateTmpDir('kernels')).toBe(dir);
  });

  it('separates segments', () => {
    expect(privateTmpDir('outputs')).not.toBe(privateTmpDir('kernels'));
  });
});
