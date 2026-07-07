import type { CompletionRequest, CompletionResult } from "../types.js";

export interface FetchCompletionOptions {
  signal?: AbortSignal;
  onChunk?: (text: string) => void;
}

export type CompletionFetcher = (
  req: CompletionRequest,
  opts?: FetchCompletionOptions,
) => Promise<CompletionResult>;

/**
 * Browser-side client for the SSE endpoint registered by
 * registerAutocompleteRoute. Streams chunks via onChunk and resolves with the
 * final CompletionResult.
 */
export interface CompletionFetcherOptions {
  /** Extra headers (e.g. auth) merged into every request. */
  headers?: Record<string, string> | (() => Record<string, string>);
}

export function createCompletionFetcher(
  endpoint: string,
  options: CompletionFetcherOptions = {},
): CompletionFetcher {
  return async (req, { signal, onChunk } = {}) => {
    const extra =
      typeof options.headers === "function" ? options.headers() : (options.headers ?? {});
    const resp = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...extra },
      body: JSON.stringify(req),
      signal,
    });
    if (!resp.ok || !resp.body) {
      throw new Error(`autocomplete request failed: HTTP ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let done: CompletionResult | null = null;
    for (;;) {
      const { done: eof, value } = await reader.read();
      if (eof) break;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const line = buf.slice(0, i).replace(/^data: /, "");
        buf = buf.slice(i + 2);
        if (!line.trim()) continue;
        const ev = JSON.parse(line);
        if (ev.type === "chunk") onChunk?.(ev.text);
        else if (ev.type === "done") done = ev as CompletionResult;
        else if (ev.type === "error") throw new Error(ev.message);
      }
    }
    if (!done) throw new Error("stream ended without a done event");
    return done;
  };
}
