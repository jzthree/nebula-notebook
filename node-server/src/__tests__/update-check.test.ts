import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../update-check';

describe('isNewerVersion', () => {
  it('detects newer versions', () => {
    expect(isNewerVersion('0.2.0', '0.1.1')).toBe(true);
    expect(isNewerVersion('1.0.0', '0.9.9')).toBe(true);
    expect(isNewerVersion('0.1.2', '0.1.1')).toBe(true);
  });
  it('rejects same or older', () => {
    expect(isNewerVersion('0.1.1', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.1.0', '0.1.1')).toBe(false);
    expect(isNewerVersion('0.0.9', '1.0.0')).toBe(false);
  });
  it('handles v-prefix and prerelease tags', () => {
    expect(isNewerVersion('v0.2.0', '0.1.9')).toBe(true);
    expect(isNewerVersion('0.2.0-beta.1', '0.1.9')).toBe(true);
  });
});
