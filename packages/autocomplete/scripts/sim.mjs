// Simulation harness: realistic notebook completion scenarios + stress tests
// against the LIVE claude backend (codex with --codex). Uses your subscription.
//
//   node scripts/sim.mjs [--codex]
//
// Hard failures: empty output, markdown fences, prefix echo, errors, timeouts.
// Soft warnings: completion doesn't match the semantic expectation (models
// vary run to run; soft misses are reported but don't fail the suite).
import { AutocompleteEngine, ClaudeBackend, CodexBackend } from "../dist/index.js";

const useCodex = process.argv.includes("--codex");
const backend = useCodex
  ? new CodexBackend({ codexHome: process.env.NEBULA_CODEX_HOME })
  : new ClaudeBackend();
const engine = new AutocompleteEngine({ backend });

const hard = [];
const soft = [];
const latencies = [];
let n = 0;

function checkHard(name, text) {
  if (!text || !text.trim()) hard.push(`${name}: empty completion`);
  if (text.includes("```")) hard.push(`${name}: contains markdown fence`);
}

async function scenario(name, req, expectAny = []) {
  n++;
  const t0 = performance.now();
  try {
    const res = await engine.complete({ language: "python", ...req });
    const dt = Math.round(performance.now() - t0);
    if (!res.fromCache) latencies.push(dt);
    checkHard(name, res.text);
    const tail = req.prefix.trimEnd().split("\n").pop().trim();
    if (tail && tail.length > 4 && res.text.trim().startsWith(tail)) {
      hard.push(`${name}: echoes the current line ("${tail.slice(0, 30)}…")`);
    }
    if (expectAny.length && !expectAny.some((s) => res.text.includes(s))) {
      soft.push(`${name}: expected one of ${JSON.stringify(expectAny)}, got ${JSON.stringify(res.text.slice(0, 60))}`);
    }
    console.log(`  ok  ${name} (${dt}ms${res.fromCache ? ", cache" : ""}): ${JSON.stringify(res.text.slice(0, 50))}`);
    return res;
  } catch (e) {
    hard.push(`${name}: threw ${e.message}`);
    console.log(`  ERR ${name}: ${e.message}`);
  }
}

console.log(`backend: ${backend.name}\n\n== realistic scenarios ==`);

await scenario(
  "fim-return",
  { prefix: "def parse_config(path: str) -> dict:\n    import tomllib\n    with open(path, 'rb') as f:\n        return ", sessionKey: "s1" },
  ["tomllib.load", "load(f)"],
);
await scenario(
  "fim-mid-suffix",
  { prefix: "def area(r):\n    return 3.14159 * ", suffix: "\n\nprint(area(2))", sessionKey: "s2" },
  ["r"],
);
await scenario(
  "cross-cell-pandas",
  {
    prefix: "mean_price = df[",
    cells: [
      { type: "markdown", content: "Analyze the sales data: compute the mean price." },
      { type: "code", content: "import pandas as pd\ndf = pd.read_csv('sales.csv')  # columns: price, qty, region" },
      { type: "code", content: "mean_price = df[" },
    ],
    activeCellIndex: 2,
    sessionKey: "s3",
  },
  ["price"],
);
await scenario(
  "comment-to-code",
  { prefix: "# return the n-th fibonacci number iteratively\ndef fib(n):\n", sessionKey: "s4" },
  ["for", "while", "a, b"],
);
await scenario(
  "class-body",
  { prefix: "class Stack:\n    def __init__(self):\n", sessionKey: "s5" },
  ["self."],
);
await scenario(
  "dict-value",
  { prefix: "config = {\n    'host': 'localhost',\n    'port': ", sessionKey: "s6" },
  ["8", "5", "3", "9"], // any plausible port digit
);
await scenario(
  "unicode-string",
  { prefix: "def greet(name):\n    return f'你好, ", suffix: "'", sessionKey: "s7" },
);
const cacheRes = await scenario(
  "cache-hit (repeat of fim-return)",
  { prefix: "def parse_config(path: str) -> dict:\n    import tomllib\n    with open(path, 'rb') as f:\n        return ", sessionKey: "s1" },
);
if (cacheRes && !cacheRes.fromCache) hard.push("cache-hit: expected fromCache=true");

console.log("\n== stress ==");

// Supersession storm: 5 rapid same-session requests; only the last should win.
{
  const results = await Promise.allSettled(
    ["a", "ab", "abc", "abcd", "abcde"].map(
      (p, i) =>
        new Promise((resolve, reject) =>
          setTimeout(
            () => engine.complete({ prefix: `x_${p} = `, sessionKey: "storm" }).then(resolve, reject),
            i * 60,
          ),
        ),
    ),
  );
  const fulfilled = results.filter((r) => r.status === "fulfilled").length;
  const superseded = results.filter(
    (r) => r.status === "rejected" && String(r.reason?.message).includes("superseded"),
  ).length;
  console.log(`  storm: ${fulfilled} fulfilled, ${superseded} superseded`);
  if (results[4].status !== "fulfilled") hard.push("storm: final request did not resolve");
  if (fulfilled + superseded !== 5) hard.push("storm: unexpected rejection reasons");
}

// Concurrency: 4 distinct sessions in parallel.
{
  const t0 = performance.now();
  const results = await Promise.allSettled(
    [1, 2, 3, 4].map((i) =>
      engine.complete({ prefix: `def f${i}(x):\n    return x + `, sessionKey: `con-${i}` }),
    ),
  );
  const okCount = results.filter((r) => r.status === "fulfilled").length;
  console.log(`  concurrency-4: ${okCount}/4 ok in ${Math.round(performance.now() - t0)}ms`);
  if (okCount !== 4) {
    for (const r of results) if (r.status === "rejected") hard.push(`concurrency-4: ${r.reason?.message}`);
  }
}

// Recycling: enough sequential turns to force worker replacement (maxTurns=8/worker).
{
  let okCount = 0;
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) {
    try {
      const r = await engine.complete({ prefix: `value_${i} = 1 + `, sessionKey: "recycle" });
      checkHard(`recycle-${i}`, r.text);
      okCount++;
    } catch (e) {
      hard.push(`recycle-${i}: ${e.message}`);
    }
  }
  console.log(`  recycling: ${okCount}/10 ok in ${Math.round(performance.now() - t0)}ms`);
}

// Abort mid-flight, then verify the engine still works.
{
  const ctrl = new AbortController();
  const p = engine.complete({ prefix: "def slow():\n    ", sessionKey: "ab" }, { signal: ctrl.signal });
  setTimeout(() => ctrl.abort(new Error("user typed")), 150);
  const settled = await p.then(
    () => "fulfilled",
    (e) => (String(e.message).includes("user typed") ? "aborted-correctly" : `wrong: ${e.message}`),
  );
  console.log(`  abort: ${settled}`);
  if (settled !== "aborted-correctly") hard.push(`abort: ${settled}`);
  try {
    await engine.complete({ prefix: "after_abort = 1 + ", sessionKey: "ab" });
    console.log("  post-abort request: ok");
  } catch (e) {
    hard.push(`post-abort: ${e.message}`);
  }
}

engine.dispose();

latencies.sort((a, b) => a - b);
const med = latencies[Math.floor(latencies.length / 2)] ?? 0;
console.log(`\n== summary ==`);
console.log(`live completions: ${latencies.length}, median ${med}ms, p90 ${latencies[Math.floor(latencies.length * 0.9)] ?? 0}ms, max ${latencies[latencies.length - 1] ?? 0}ms`);
if (soft.length) console.log(`\nsoft warnings (${soft.length}):\n  - ${soft.join("\n  - ")}`);
if (hard.length) {
  console.log(`\nHARD FAILURES (${hard.length}):\n  - ${hard.join("\n  - ")}`);
  process.exit(1);
}
console.log("\nall hard checks passed");
