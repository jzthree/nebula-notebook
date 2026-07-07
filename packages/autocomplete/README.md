# nebula-autocomplete

LLM code autocomplete for notebook editors, backed by **Claude Code CLI** or
**Codex CLI** subscription auth (no API key). Three entry points:

| Import | What it is |
|---|---|
| `nebula-autocomplete` | `AutocompleteEngine` + `ClaudeBackend` / `CodexBackend` (Node) |
| `nebula-autocomplete/server` | `registerAutocompleteRoute(fastify, engine)` — SSE endpoint |
| `nebula-autocomplete/client` | `createCompletionFetcher(url)` — browser SSE client |
| `nebula-autocomplete/codemirror` | `ghostText(fetcher)` — CodeMirror 6 inline ghost text |

> **Licensing:** subscription auth is for personal use. Anthropic/OpenAI
> consumer terms prohibit routing other users through your subscription or
> offering subscription login in a distributed app. To ship this to others,
> implement a `CompletionBackend` that calls the provider API with a key —
> the rest of the stack is unchanged.

## Measured latency (2026-07, M-series Mac)

| Backend | Model | Warm TTFB | Notes |
|---|---|---|---|
| `ClaudeBackend` | haiku 4.5 | ~1.4–2.1s | token-streamed; warm process pool |
| `CodexBackend` | gpt-5.4-mini, low effort | ~2.5–3.2s | buffered; one-shot exec |

Cache hits return in 0ms. Claude's harness costs ~24k input tokens per
completion, codex ~12.6k — that overhead is inherent to CLI backends and is
why a raw-API backend (~0.6–1s) is the upgrade path for keystroke-grade UX.

## Quick start (server side)

```ts
import { AutocompleteEngine, ClaudeBackend } from "nebula-autocomplete";
import { registerAutocompleteRoute } from "nebula-autocomplete/server";

const engine = new AutocompleteEngine({
  backend: new ClaudeBackend(),          // or new CodexBackend({ codexHome })
  cacheSize: 128,
  contextBudget: 6000,                   // chars of cross-cell context
});

// inside your Fastify route registration (prefix "/api"):
registerAutocompleteRoute(fastify, engine); // POST /api/autocomplete (SSE)

process.on("exit", () => engine.dispose());
```

`CodexBackend` tip: create a clean `CODEX_HOME` containing only `auth.json`
(`mkdir -p .codex-home && cp ~/.codex/auth.json .codex-home/`) and pass it as
`codexHome` — it skips global MCP servers/plugins/hooks (~2s/request faster).
`gpt-5.4-mini` is the fast model that works with ChatGPT-subscription auth;
`*-codex-mini` variants are API-key-only.

## Quick start (client side, CodeMirror 6)

```ts
import { createCompletionFetcher } from "nebula-autocomplete/client";
import { ghostText } from "nebula-autocomplete/codemirror";

const fetchCompletion = createCompletionFetcher("/api/autocomplete");

const extension = ghostText(
  ({ prefix, suffix }, { signal, onChunk }) =>
    fetchCompletion(
      {
        prefix,
        suffix,
        language: "python",
        cells: allCellsRef.current ?? [],       // cross-cell context
        activeCellIndex,
        sessionKey: cellId,                      // supersedes stale requests
      },
      { signal, onChunk },
    ).then((r) => r.text),
  { debounceMs: 400 },
);
// add `extension` to the editor's extensions array
```

Tab accepts the suggestion, Escape dismisses, any edit or cursor move
invalidates it. Ghost text renders via a `.cm-ghost-text` span (style it in
your theme if the default 0.45 opacity doesn't fit).

## Integrating into nebula-notebook

This package now lives inside the nebula-notebook repo at
`packages/autocomplete` and is wired up already:

1. **Dependency** (in-repo `file:` link; bundled into the published tarball via
   `bundledDependencies`):
   - root `package.json`: `"nebula-autocomplete": "file:packages/autocomplete"`
   - `node-server/package.json`: `"nebula-autocomplete": "file:../packages/autocomplete"`
   `dist/` is built automatically by this package's `prepare` script on
   `npm install` (see `scripts/postinstall.cjs`).
2. **Server**: in `node-server/src/index.ts` where routes are registered under
   `/api` (~line 302), create one engine at startup and call
   `registerAutocompleteRoute(app, engine)`. Dispose it on shutdown.
3. **Client**: in `components/CodeEditor.tsx`, add the `ghostText(...)`
   extension to the extensions `useMemo` (~line 725). The existing
   kernel/static dropdown completion (`createCombinedCompletionSource`, line
   533) stays as-is — ghost text is complementary, not a replacement. Cells
   context is already available via the `allCellsRef` prop (line 51).
4. **Dev proxy**: nothing to add — Vite already proxies `/api` to the node
   server (`vite.config.ts:19`).

## API sketch

- `engine.complete(req, { signal, onChunk }) → Promise<CompletionResult>` —
  builds the prompt (instruction + nearest-cells context within budget +
  `<CURSOR>` marker), checks the LRU cache, and calls the backend. Requests
  sharing a `sessionKey` supersede each other. Output is fence-stripped and
  prefix-echo-trimmed.
- `CompletionBackend` — implement `{ name, complete(prompt, {signal, onChunk}), dispose() }`
  to add a backend (e.g. Anthropic API for production).

## Trajectory hygiene

Completions must not spam CLI history/trajectory stores. Verified behavior:

- **claude**: print mode + stream-json + `--tools ""` was observed to persist
  nothing on macOS (claude 2.1.201), but Claude Code **can** write
  `~/.claude/projects/<munged-cwd>/*.jsonl` session transcripts on other
  versions/platforms — so we don't rely on that. Each worker runs in its own
  UUID cwd; the backend deletes the matching `~/.claude/projects/*` transcript
  dir on worker recycle (per-worker, so it never touches an active worker) and
  the whole set on `dispose()`. Matching is by UUID token via
  `transcriptDirMatchesToken`, which is munge-algorithm-independent and cannot
  collide with a real project. Respects `CLAUDE_CONFIG_DIR`. The throwaway
  `workspaceDir` (also removed on dispose) is a second guard.
- **codex**: `--ephemeral` (no session/rollout files),
  `history.persistence="none"` (no prompt history), and
  `features.plugins=false` (skips the curated-plugins sync, which otherwise
  clones tens of MB into `CODEX_HOME/.tmp` on **every** exec). Verified: zero
  files and stable directory size across repeated completions. Codex still
  maintains a few small bounded sqlite files in `CODEX_HOME`.

## Development

```sh
npm install
npm run build     # tsc → dist/
npm test          # vitest unit tests (no CLI calls)
npm run smoke     # live end-to-end vs claude   (uses your subscription)
NEBULA_CODEX_HOME=path/to/.codex-home npm run smoke codex
```
