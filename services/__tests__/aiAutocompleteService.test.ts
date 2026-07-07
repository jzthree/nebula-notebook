// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAiGhostTextFetcher,
  isAiAutocompleteDecided,
  isAiAutocompleteEnabled,
  setAiAutocomplete,
  SETTINGS_CHANGED_EVENT,
} from '../aiAutocompleteService';

const SETTINGS_KEY = 'nebula-settings';

function sseResponse(events: object[]): Response {
  const body = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

beforeEach(() => {
  localStorage.clear();
});

describe('aiAutocomplete settings', () => {
  it('is undecided and disabled by default', () => {
    expect(isAiAutocompleteDecided()).toBe(false);
    expect(isAiAutocompleteEnabled()).toBe(false);
  });

  it('setAiAutocomplete persists the choice and backend', () => {
    setAiAutocomplete(true, 'codex');
    expect(isAiAutocompleteDecided()).toBe(true);
    expect(isAiAutocompleteEnabled()).toBe(true);
    expect(JSON.parse(localStorage.getItem(SETTINGS_KEY)!)).toMatchObject({
      aiAutocomplete: true,
      aiAutocompleteBackend: 'codex',
    });
  });

  it('"not now" is decided but disabled', () => {
    setAiAutocomplete(false);
    expect(isAiAutocompleteDecided()).toBe(true);
    expect(isAiAutocompleteEnabled()).toBe(false);
  });

  it('dispatches the settings-changed event', () => {
    const listener = vi.fn();
    window.addEventListener(SETTINGS_CHANGED_EVENT, listener);
    setAiAutocomplete(true);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener(SETTINGS_CHANGED_EVENT, listener);
  });
});

describe('createAiGhostTextFetcher', () => {
  it('posts cursor context, cells, backend, and sessionKey; returns the text', async () => {
    setAiAutocomplete(true, 'claude');
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = String(input);
      // The fetcher checks the environment first (local vs remote server).
      if (url === '/api/health') {
        return Promise.resolve(new Response(JSON.stringify({ environment: { kind: 'local' } }), {
          status: 200, headers: { 'content-type': 'application/json' },
        }));
      }
      return Promise.resolve(sseResponse([
        { type: 'chunk', text: 'a + b' },
        { type: 'done', text: 'a + b', backend: 'claude', fromCache: false, ttfbMs: 1, totalMs: 2 },
      ]));
    });

    const cellsRef = {
      current: [
        { type: 'markdown', content: 'Sum helper' },
        { type: 'code', content: 'def add(a, b):\n    return ' },
      ],
    } as React.RefObject<Array<{ type: string; content: string }>>;

    const fetcher = createAiGhostTextFetcher(cellsRef, 'cell-42');
    const chunks: string[] = [];
    const text = await fetcher(
      { prefix: 'def add(a, b):\n    return ', suffix: '', state: {} as never },
      { signal: new AbortController().signal, onChunk: (t) => chunks.push(t) },
    );

    expect(text).toBe('a + b');
    expect(chunks).toEqual(['a + b']);
    const acCall = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/autocomplete')!;
    expect(acCall).toBeDefined();
    const payload = JSON.parse((acCall[1] as RequestInit).body as string);
    expect(payload).toMatchObject({
      prefix: 'def add(a, b):\n    return ',
      backend: 'claude',
      sessionKey: 'cell-42',
      activeCellIndex: 1, // matched the cell whose content equals prefix+suffix
    });
    // No hardcoded language — hints only (none set in this test).
    expect(payload.language).toBeUndefined();
    expect(payload.cells).toHaveLength(2);
    expect(payload.cells[0]).toEqual({ type: 'markdown', content: 'Sum helper' });
    fetchMock.mockRestore();
  });
});
