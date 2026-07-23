/**
 * Minimal, dependency-free delimited-text parsing for the CSV/TSV viewer.
 * Handles the generic cases the notebook's pandas HTML tables gloss over:
 * unknown delimiter, quoted fields (with embedded delimiters / newlines /
 * doubled quotes), ragged rows, and the pandas-index header convention.
 */

export const CANDIDATE_DELIMITERS = [',', '\t', ';', '|'] as const;
export type Delimiter = string;

/**
 * Pick the delimiter that yields the most CONSISTENT column count across the
 * sampled lines (not merely the most frequent character) — so commas inside
 * quoted fields don't beat a real tab delimiter.
 */
export function detectDelimiter(sample: string): Delimiter {
  const lines = sample.split(/\r?\n/).filter((l) => l.length > 0).slice(0, 20);
  if (lines.length === 0) return ',';
  let best: Delimiter = ',';
  let bestScore = -Infinity;
  for (const d of CANDIDATE_DELIMITERS) {
    const counts = lines.map((l) => parseLine(l, d).length);
    const cols = counts.filter((c) => c > 1);
    if (cols.length === 0) continue;
    // Score: reward more columns, penalize variance in column count.
    const mean = cols.reduce((a, b) => a + b, 0) / cols.length;
    const variance = cols.reduce((a, b) => a + (b - mean) ** 2, 0) / cols.length;
    const score = mean - variance * 2;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

/** Parse a single line's fields (no embedded newlines) for delimiter sniffing. */
function parseLine(line: string, delim: Delimiter): string[] {
  const out: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      out.push(field); field = '';
    } else field += ch;
  }
  out.push(field);
  return out;
}

/**
 * Full RFC-4180-ish parse: quoted fields may span the delimiter AND newlines.
 * Ragged rows are kept as-is (never throws) — the viewer pads/marks them.
 */
export function parseDelimited(text: string, delim: Delimiter): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      pushField();
    } else if (ch === '\n') {
      pushRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++;
      pushRow();
    } else field += ch;
  }
  // Flush the final field/row unless the text ended exactly on a row boundary.
  if (field.length > 0 || row.length > 0) pushRow();
  return rows;
}

const NUMERIC_RE = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/;

/**
 * Guess whether the first row is a header: it's a header if the first row is
 * all-non-numeric while later rows contain numeric cells — including the
 * pandas convention where the header has one fewer column than the data
 * (the unnamed index column).
 */
export function inferHeader(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const first = rows[0];
  const rest = rows.slice(1, 20);
  const firstNumeric = first.some((c) => NUMERIC_RE.test(c.trim()));
  if (firstNumeric) return false;
  const laterHasNumeric = rest.some((r) => r.some((c) => NUMERIC_RE.test(c.trim())));
  const raggedIndex = rest.every((r) => r.length === first.length + 1);
  return laterHasNumeric || raggedIndex;
}
