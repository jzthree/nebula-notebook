export interface NotebookCellContext {
  type: "code" | "markdown";
  content: string;
}

export interface CompletionRequest {
  /** Text before the cursor in the active cell. Required. */
  prefix: string;
  /** Text after the cursor in the active cell. */
  suffix?: string;
  /** Language of the active cell (e.g. "python"). */
  language?: string;
  /** All notebook cells, in order, for cross-cell context. */
  cells?: NotebookCellContext[];
  /** Index of the active cell within `cells`. */
  activeCellIndex?: number;
  /**
   * Requests sharing a sessionKey supersede each other: issuing a new one
   * aborts the previous in-flight request. Use the cell id.
   */
  sessionKey?: string;
  /** Backend selector, for servers hosting more than one engine. */
  backend?: string;
}

export interface CompletionResult {
  text: string;
  backend: string;
  fromCache: boolean;
  ttfbMs: number;
  totalMs: number;
}

export interface CompleteOptions {
  signal?: AbortSignal;
  /** Called with each streamed text chunk (claude backend streams; codex emits once). */
  onChunk?: (text: string) => void;
}

/** A completion backend: turns a prompt into text. */
export interface CompletionBackend {
  readonly name: string;
  complete(
    prompt: string,
    opts: { signal?: AbortSignal; onChunk?: (text: string) => void },
  ): Promise<string>;
  /** Release child processes. */
  dispose(): void;
}

export interface EngineOptions {
  backend: CompletionBackend;
  /** Max completions cached (keyed on context). Default 128. 0 disables. */
  cacheSize?: number;
  /** Character budget for cross-cell context in the prompt. Default 6000. */
  contextBudget?: number;
  /** Max lines the model is asked to produce. Default 5. */
  maxLines?: number;
}
