export interface NotebookCellContext {
  type: "code" | "markdown";
  content: string;
}

export interface CompletionRequest {
  /** Text before the cursor in the active cell. Required. */
  prefix: string;
  /** Text after the cursor in the active cell. */
  suffix?: string;
  /** Explicit language, if known. Usually omitted — prefer the hints below and
   *  let the model infer the language from the code + kernel/filename. */
  language?: string;
  /** Active kernel name/spec (e.g. "python3", "ir", "julia-1.9"). A hint. */
  kernelName?: string;
  /** Notebook filename (e.g. "analysis.ipynb"). A hint. */
  filename?: string;
  /** All notebook cells, in order, for cross-cell context. */
  cells?: NotebookCellContext[];
  /** Index of the active cell within `cells`. */
  activeCellIndex?: number;
  /**
   * Requests sharing a sessionKey supersede each other: issuing a new one
   * aborts the previous in-flight request. Use the cell id.
   */
  sessionKey?: string;
  /** Model override (e.g. "haiku" | "sonnet"). Engines are pooled per model. */
  model?: string;
  /** Per-request cross-cell context budget in chars (clamped server-side).
   *  More context grounds suggestions in the notebook (fewer hallucinated
   *  names) at the cost of a bigger prompt. */
  contextBudget?: number;
  /** Per-request cap on suggested lines (clamped server-side). */
  maxLines?: number;
  /** Backend selector, for servers hosting more than one engine. */
  backend?: string;
}

export interface CompletionResult {
  text: string;
  backend: string;
  fromCache: boolean;
  ttfbMs: number;
  totalMs: number;
  /** Per-request engine/worker diagnostics (see CompletionDiag). */
  diag?: CompletionDiag;
}

/**
 * Where a completion's latency went — filled by the backend, forwarded in the
 * SSE done event so the browser console can show the breakdown.
 */
export interface CompletionDiag {
  /** Transport the worker ran on. */
  transport?: string;
  /** ms spent queued behind an earlier in-flight turn for the same session
   *  (single-flight per cell — typing bursts wait for the previous turn
   *  instead of fanning out across workers; see engine.complete). */
  queueWaitMs?: number;
  /** ms from request start until the turn was dispatched to a warm worker
   *  (pool scan + possible spawn + warmup wait). The silent part of TTFB. */
  workerWaitMs?: number;
  /** A fresh worker process had to be spawned for this request. */
  coldSpawn?: boolean;
  /** The turn was retried on a fresh worker after the first one died. */
  retried?: boolean;
  /** How many turns this worker had already served (conversation history
   *  grows with each turn, inflating time-to-first-byte). */
  workerTurn?: number;
  /** Accumulated prompt chars in this worker's history before this turn —
   *  the actual TTFB-drag driver (recycled past maxHistoryCharsPerWorker). */
  workerHistoryChars?: number;
  /** Busy workers / pool size at request time (busy=size → cold spawn). */
  poolBusy?: number;
  poolSize?: number;
  /** Characters in the assembled prompt. */
  promptChars?: number;
  /** Characters in the RAW model reply, before tag/fence/overlap trimming —
   *  rawChars>0 with empty final text means post-processing removed it. */
  rawChars?: number;
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
    opts: { signal?: AbortSignal; onChunk?: (text: string) => void; diag?: CompletionDiag },
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
