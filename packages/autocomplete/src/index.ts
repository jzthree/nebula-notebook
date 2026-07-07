export { AutocompleteEngine } from "./core/engine.js";
export { ClaudeBackend, type ClaudeBackendOptions } from "./backends/claude.js";
export { CodexBackend, type CodexBackendOptions } from "./backends/codex.js";
export { buildPrompt, cacheKey } from "./core/prompt.js";
export type { Transport, SshTransport } from "./transport.js";
export {
  stripFences,
  trimPrefixOverlap,
  trimSuffixOverlap,
  transcriptDirMatchesToken,
} from "./core/text.js";
export type {
  CompletionBackend,
  CompletionRequest,
  CompletionResult,
  CompleteOptions,
  EngineOptions,
  NotebookCellContext,
} from "./types.js";
