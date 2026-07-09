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

const OPEN_TAG = "<completion>";
const CLOSE_TAG = "</completion>";

/**
 * Extract the tag-wrapped completion, whitespace preserved VERBATIM.
 *
 * Why tags: models structurally avoid beginning a message with whitespace, so
 * a completion that must START with "\n" (cursor at the end of a finished
 * comment like `# fibonacci`) loses its newline when asked for raw output —
 * verified empirically; no prompt wording fixed it. Inside a tag pair the
 * leading newline survives generation. Returns null when the reply isn't
 * tag-wrapped (fall back to the fence-stripping pipeline).
 */
export function extractCompletionTag(text: string): string | null {
  const start = text.indexOf(OPEN_TAG);
  if (start === -1) return null;
  const inner = text.slice(start + OPEN_TAG.length);
  const end = inner.indexOf(CLOSE_TAG);
  return end === -1 ? inner : inner.slice(0, end);
}

/**
 * Streaming variant: wraps an onChunk callback so tag delimiters never leak
 * into streamed ghost text, while the inner text (leading whitespace included)
 * streams through as it arrives. If no opening tag shows up within the first
 * 64 chars, assumes an untagged reply and passes everything through.
 */
export function createTagStreamFilter(emit: (t: string) => void): (t: string) => void {
  let state: "seeking" | "inside" | "done" | "passthrough" = "seeking";
  let buf = "";
  return (chunk: string) => {
    if (state === "done") return;
    if (state === "passthrough") return emit(chunk);
    buf += chunk;
    if (state === "seeking") {
      const at = buf.indexOf(OPEN_TAG);
      if (at !== -1) {
        state = "inside";
        buf = buf.slice(at + OPEN_TAG.length);
      } else if (buf.length > 64 && !OPEN_TAG.startsWith(buf.slice(-OPEN_TAG.length))) {
        state = "passthrough";
        emit(buf);
        buf = "";
        return;
      } else {
        return; // keep buffering — the tag may still be arriving
      }
    }
    // inside: emit everything except a possible partial close tag at the tail
    const close = buf.indexOf(CLOSE_TAG);
    if (close !== -1) {
      if (close > 0) emit(buf.slice(0, close));
      state = "done";
      buf = "";
      return;
    }
    // Hold back the longest suffix that could be the start of the close tag.
    let hold = 0;
    for (let n = Math.min(CLOSE_TAG.length - 1, buf.length); n > 0; n--) {
      if (CLOSE_TAG.startsWith(buf.slice(-n))) { hold = n; break; }
    }
    const emittable = buf.slice(0, buf.length - hold);
    if (emittable) emit(emittable);
    buf = buf.slice(buf.length - hold);
  };
}

/**
 * Strip a wrapping markdown code fence, if present. Leading whitespace of an
 * UNFENCED completion is preserved verbatim — it is often meaningful: with
 * the cursor at the end of `# fibonacci` the completion must START with "\n"
 * to put code on the next line, and indentation after `if x:` matters too.
 * (A blanket .trim() here silently glued completions onto comments.)
 */
export function stripFences(text: string): string {
  const t = text.trim();
  const open = t.match(/^```[a-zA-Z0-9_-]*\n?/);
  if (open) {
    return t.slice(open[0].length).replace(/\n?```\s*$/, "");
  }
  // No fence: keep leading whitespace, drop only trailing whitespace.
  return text.replace(/\s+$/, "");
}

/**
 * Streaming variant of trimPrefixOverlap: emits the completion as it streams,
 * holding back ONLY while the text so far could still be the beginning of a
 * longer prefix-echo. Without this the ghost text visibly "snaps" when the
 * done event applies the trim that streaming skipped (echo shown, then
 * removed). For non-echo completions the hold is typically zero characters.
 */
export function createPrefixTrimStreamFilter(
  prefix: string,
  emit: (t: string) => void,
): (t: string) => void {
  const tail = prefix.slice(-200);
  let buf = "";
  let settled = false;
  return (chunk: string) => {
    if (settled) return emit(chunk);
    buf += chunk;
    // Could buf still grow into a LONGER echo of the prefix tail?
    let couldExtend = false;
    for (let n = buf.length + 1; n <= tail.length; n++) {
      if (tail.slice(-n).startsWith(buf)) { couldExtend = true; break; }
    }
    if (couldExtend) return; // hold — echo still possible
    // Settle: strip the longest confirmed echo, stream the rest.
    let confirmed = 0;
    for (let n = Math.min(tail.length, buf.length); n > 0; n--) {
      if (buf.startsWith(tail.slice(-n))) { confirmed = n; break; }
    }
    settled = true;
    const out = buf.slice(confirmed);
    buf = "";
    if (out) emit(out);
  };
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
