import { describe, it, expect } from 'vitest';
import { detectDelimiter, parseDelimited, inferHeader } from '../csvTable';

describe('detectDelimiter', () => {
  it('detects comma, tab, semicolon, pipe from a sample', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
    expect(detectDelimiter('a|b|c\n1|2|3')).toBe('|');
  });
  it('picks the delimiter with the most CONSISTENT column count, not just the most frequent', () => {
    // commas appear inside quoted fields but tab is the real delimiter
    expect(detectDelimiter('name\tnote\nAda\t"a, b, c"\nBob\t"x, y"')).toBe('\t');
  });
  it('falls back to comma when nothing else fits', () => {
    expect(detectDelimiter('singlecolumn\nvalue')).toBe(',');
  });
});

describe('parseDelimited', () => {
  it('parses simple rows', () => {
    expect(parseDelimited('a,b\n1,2\n3,4', ',')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('handles quoted fields containing the delimiter and newlines', () => {
    const rows = parseDelimited('name,note\nAda,"a, b\nc"\nBob,plain', ',');
    expect(rows).toEqual([['name', 'note'], ['Ada', 'a, b\nc'], ['Bob', 'plain']]);
  });
  it('unescapes doubled quotes inside quoted fields', () => {
    expect(parseDelimited('x\n"she said ""hi"""', ',')).toEqual([['x'], ['she said "hi"']]);
  });
  it('tolerates ragged rows without throwing', () => {
    expect(parseDelimited('a,b,c\n1,2\n3,4,5,6', ',')).toEqual([['a', 'b', 'c'], ['1', '2'], ['3', '4', '5', '6']]);
  });
  it('ignores a trailing newline', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('inferHeader', () => {
  it('flags a header when the first row is non-numeric and later rows are numeric', () => {
    expect(inferHeader([['id', 'value'], ['1', '2.5'], ['2', '3.1']])).toBe(true);
  });
  it('does not flag a header when the first row looks like data', () => {
    expect(inferHeader([['1', '2'], ['3', '4']])).toBe(false);
  });
  it('handles the ragged-header convention (header has one fewer column than data)', () => {
    // classic pandas index CSV: header row omits the index column name
    expect(inferHeader([['colA', 'colB'], ['row1', '5', '6'], ['row2', '7', '8']])).toBe(true);
  });
  it('empty or single-row input is not a header', () => {
    expect(inferHeader([])).toBe(false);
    expect(inferHeader([['a', 'b']])).toBe(false);
  });
});
