// Live smoke test against the real CLIs (uses your subscriptions).
//   node scripts/smoke.mjs [claude|codex]
import { AutocompleteEngine, ClaudeBackend, CodexBackend } from "../dist/index.js";

const which = process.argv[2] ?? "claude";
const backend =
  which === "codex"
    ? new CodexBackend({ codexHome: process.env.NEBULA_CODEX_HOME })
    : new ClaudeBackend();

const engine = new AutocompleteEngine({ backend });
const req = {
  prefix: "def parse_config(path: str) -> dict:\n    import tomllib\n    with open(path, 'rb') as f:\n        return ",
  suffix: "",
  language: "python",
  cells: [
    { type: "markdown", content: "Config loading utilities" },
    { type: "code", content: "import tomllib" },
  ],
  activeCellIndex: 1,
  sessionKey: "smoke",
};

for (let i = 1; i <= 2; i++) {
  const res = await engine.complete(req, {
    onChunk: (t) => process.stdout.write(t),
  });
  console.log(
    `\n[run ${i}] backend=${res.backend} cache=${res.fromCache} ttfb=${res.ttfbMs}ms total=${res.totalMs}ms`,
  );
}
engine.dispose();
