import { describe, it, expect } from 'vitest';
import { classifyFileView, INLINE_VIEWABLE_EXTS } from '../fileViewer';

describe('classifyFileView', () => {
  it('routes notebooks to the notebook view', () => {
    expect(classifyFileView('/x/a.ipynb')).toBe('notebook');
    expect(classifyFileView('/x/a.qmd')).toBe('notebook');
  });

  it('routes source/plaintext/csv to the inline text editor', () => {
    for (const p of ['a.py', 'a.txt', 'a.csv', 'a.log', 'a.md', 'a.json', 'a.tsv', 'a.yaml']) {
      expect(classifyFileView('/x/' + p)).toBe('text');
    }
  });

  it('routes HTML to the (trust-gated) html view', () => {
    expect(classifyFileView('/x/report.html')).toBe('html');
    expect(classifyFileView('/x/report.HTM')).toBe('html');
  });

  it('routes memory-risky binaries (pdf, media, images) to a new browser tab', () => {
    for (const p of ['a.pdf', 'a.png', 'a.jpg', 'a.svg', 'a.mp4', 'a.webm', 'a.mov', 'a.mp3', 'a.wav']) {
      expect(classifyFileView('/x/' + p)).toBe('newtab');
    }
  });

  it('falls back to download for unknown/binary types', () => {
    for (const p of ['a.bin', 'a.pkl', 'a.parquet', 'a.zip', 'a.xlsx']) {
      expect(classifyFileView('/x/' + p)).toBe('download');
    }
  });

  it('is case-insensitive and tolerant of no extension', () => {
    expect(classifyFileView('/x/A.PDF')).toBe('newtab');
    expect(classifyFileView('/x/Makefile')).toBe('download');
  });

  it('every newtab type is on the server inline allowlist', () => {
    for (const ext of ['.pdf', '.png', '.svg', '.mp4', '.mp3']) {
      expect(INLINE_VIEWABLE_EXTS.has(ext)).toBe(true);
    }
    // HTML must NOT be inline-served same-origin (token-theft risk)
    expect(INLINE_VIEWABLE_EXTS.has('.html')).toBe(false);
  });
});
