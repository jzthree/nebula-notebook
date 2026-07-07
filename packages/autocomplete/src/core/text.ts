/**
 * Does a Claude Code project-transcript directory name belong to a workspace
 * carrying `token`? Claude munges the cwd into the dir name by replacing
 * non-alphanumerics, so we compare alphanumeric-only forms — munge-algorithm
 * independent, and a UUID token cannot collide with a real project path.
 */
export function transcriptDirMatchesToken(dirName: string, token: string): boolean {
  const norm = (s: string) => s.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const needle = norm(token);
  return needle.length > 0 && norm(dirName).includes(needle);
}

/** Strip a wrapping markdown code fence, if present. */
export function stripFences(text: string): string {
  let t = text.trim();
  const open = t.match(/^```[a-zA-Z0-9_-]*\n?/);
  if (open) {
    t = t.slice(open[0].length);
    t = t.replace(/\n?```\s*$/, "");
  }
  return t;
}

/**
 * Models sometimes echo the tail of the prefix (e.g. the current line) before
 * continuing. Trim the longest suffix-of-prefix that the completion starts
 * with, so accepting the suggestion never duplicates typed text.
 */
export function trimPrefixOverlap(prefix: string, completion: string): string {
  const tail = prefix.slice(-200);
  for (let n = Math.min(tail.length, completion.length); n > 0; n--) {
    if (completion.startsWith(tail.slice(-n))) {
      return completion.slice(n);
    }
  }
  return completion;
}

/**
 * Models also often close constructs that the suffix already closes (quotes,
 * brackets, parens). Trim the longest head-of-suffix that the completion ends
 * with, so accepted text composes with what follows the cursor.
 */
export function trimSuffixOverlap(suffix: string, completion: string): string {
  const head = suffix.slice(0, 200);
  for (let n = Math.min(head.length, completion.length); n > 0; n--) {
    if (completion.endsWith(head.slice(0, n))) {
      return completion.slice(0, completion.length - n);
    }
  }
  return completion;
}
