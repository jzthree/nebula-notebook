// @vitest-environment node
/**
 * Terminal binding tests
 *
 * A notebook has exactly one binding per plane (shell/agent) that names the
 * pty its panel attaches to. Scopes: server-shared (srv-main), project,
 * notebook-private, custom-named. Bindings persist server-side.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  TerminalBindingStore,
  resolveBindingName,
  SHARED_SHELL_NAME,
} from '../terminal/binding-store';

describe('resolveBindingName', () => {
  const nb = '/home/u/proj/analysis.ipynb';

  it('server scope resolves to the well-known shared name', () => {
    expect(resolveBindingName('shell', 'server', nb)).toBe(SHARED_SHELL_NAME);
  });

  it('notebook scope matches the legacy per-notebook shell naming (grandfathering)', () => {
    // Same scheme TerminalPanel has always used: nb-<hex6>-<plane>-<slug>
    const name = resolveBindingName('shell', 'notebook', nb);
    expect(name).toMatch(/^nb-[0-9a-f]{6}-shell-analysis$/);
    // Deterministic
    expect(resolveBindingName('shell', 'notebook', nb)).toBe(name);
    // Distinct notebooks get distinct names
    expect(resolveBindingName('shell', 'notebook', '/home/u/other/analysis.ipynb')).not.toBe(name);
  });

  it('project scope derives from the notebook directory, shared by siblings', () => {
    const a = resolveBindingName('shell', 'project', '/home/u/proj/a.ipynb');
    const b = resolveBindingName('shell', 'project', '/home/u/proj/b.ipynb');
    expect(a).toBe(b);
    expect(a).toMatch(/^proj-[0-9a-f]{6}-proj/);
  });

  it('named scope normalizes the custom name like the pty manager does', () => {
    expect(resolveBindingName('shell', 'named', nb, 'My GPU Box!')).toBe('my-gpu-box');
  });

  it('named scope without a name throws', () => {
    expect(() => resolveBindingName('shell', 'named', nb)).toThrow();
  });
});

describe('TerminalBindingStore', () => {
  let tmp: string;
  let store: TerminalBindingStore;

  beforeEach(() => {
    tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-binding-')));
    store = new TerminalBindingStore(path.join(tmp, 'bindings.json'));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('returns null for an unbound notebook (caller applies the plane default)', () => {
    expect(store.get('/x/nb.ipynb', 'shell')).toBeNull();
  });

  it('stores and resolves a binding, persisting across instances', () => {
    const b = store.set('/x/nb.ipynb', 'shell', 'named', 'gpu');
    expect(b.name).toBe('gpu');
    expect(b.scope).toBe('named');

    const store2 = new TerminalBindingStore(path.join(tmp, 'bindings.json'));
    expect(store2.get('/x/nb.ipynb', 'shell')?.name).toBe('gpu');
  });

  it('keeps shell and agent planes independent', () => {
    store.set('/x/nb.ipynb', 'shell', 'server');
    store.set('/x/nb.ipynb', 'agent', 'notebook');
    expect(store.get('/x/nb.ipynb', 'shell')?.scope).toBe('server');
    expect(store.get('/x/nb.ipynb', 'agent')?.scope).toBe('notebook');
  });

  it('delete resets to unbound', () => {
    store.set('/x/nb.ipynb', 'shell', 'server');
    store.delete('/x/nb.ipynb', 'shell');
    expect(store.get('/x/nb.ipynb', 'shell')).toBeNull();
  });
});
