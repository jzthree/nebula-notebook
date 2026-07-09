#!/usr/bin/env node
/**
 * Prompt regression eval: does a SIMPLE instruction-only prompt behave as well
 * as the current 3-example prompt? Real model calls, objective predicates,
 * multiple trials per case (model output varies run to run).
 *
 *   node eval/prompt-eval.mjs [trials-per-case]   # default 3
 *
 * Costs real API turns (~cases × trials × prompts). Not a vitest suite.
 */
import { ClaudeBackend } from "../dist/backends/claude.js";
import { buildPrompt } from "../dist/core/prompt.js";
import { extractCompletionTag, stripFences, trimPrefixOverlap } from "../dist/core/text.js";

const TRIALS = Number(process.argv[2] || 5); // n=3 proved too thin: a case flipped 3/3 -> 0/3 between runs

// ---- the challenger: simple & precise, no examples ----
function buildSimplePrompt(req, opts) {
  const hints = [];
  if (req.kernelName) hints.push(`kernel=${req.kernelName}`);
  if (req.filename) hints.push(`file=${req.filename}`);
  const hintLine = hints.length ? ` Hints: ${hints.join(", ")}.` : "";
  const parts = [
    `You are a code completion engine for a Jupyter-style notebook.${hintLine} ` +
      `Reply with <completion>TEXT</completion> where TEXT is inserted verbatim at <CURSOR>. ` +
      `TEXT must compose exactly with the surrounding characters: start with a newline ` +
      `(plus indentation) if and only if the current line is already complete; never ` +
      `break a word the cursor is inside; no fences, no explanation, no repetition of ` +
      `existing code; at most ${opts.maxLines} lines.`,
  ];
  const cells = (req.cells ?? []).filter((c, i) => i !== req.activeCellIndex && c.content.trim());
  if (cells.length) parts.push(`Earlier notebook cells for context:\n${cells.map((c) => c.content).join("\n\n")}`);
  parts.push(`<cell>\n${req.prefix}<CURSOR>${req.suffix ?? ""}\n</cell>`);
  return parts.join("\n\n");
}

// ---- cases with objective pass predicates on the PROCESSED completion ----
// after a leading newline, the first real char must start an identifier/comment —
// catches degenerate output like "\n <- function(n)" (newline but broken content)
const sane = (t) => /^\n+[\s]*[A-Za-z_#(\['"0-9]/.test(t);
const CASES = [
  { name: "complete-comment", kernel: "python3", prefix: "# load the csv and summarize",
    pass: (t) => t.startsWith("\n") && sane(t) },
  { name: "single-word-comment", kernel: "ir", prefix: "# fibonacci",
    pass: (t) => t.startsWith("\n") && sane(t) },
  { name: "mid-word-comment", kernel: "ir", prefix: "#fib",
    pass: (t) => !t.startsWith("\n") && /^[a-z]/i.test(t) },
  { name: "mid-expression", kernel: "python3", prefix: "df.gro",
    pass: (t) => !t.startsWith("\n") && t.startsWith("up") },
  { name: "block-open", kernel: "python3", prefix: "def add(a, b):",
    pass: (t) => t.startsWith("\n") && /^\n\s+/.test(t) },
  { name: "closed-statement", kernel: "python3", prefix: "x = 1",
    pass: (t) => t.startsWith("\n") },
  { name: "empty-cell-with-context", kernel: "python3", prefix: "",
    cells: [{ type: "code", content: "import pandas as pd\ndf = pd.read_csv('d.csv')" }, { type: "code", content: "" }],
    active: 1, pass: (t) => t.trim().length > 0 },
  { name: "no-prefix-echo", kernel: "python3", prefix: "for i in range(10):\n    print(i)\nfor j in",
    pass: (t) => !t.includes("for i in range(10)") && t.trim().length > 0 },
];

function processReply(raw, prefix) {
  const tagged = extractCompletionTag(raw);
  return trimPrefixOverlap(prefix, tagged !== null ? tagged : stripFences(raw));
}

const backend = new ClaudeBackend({ poolSize: 2 });
await new Promise((r) => setTimeout(r, 6000)); // warm

const results = {};
for (const promptName of ["current", "simple"]) {
  results[promptName] = {};
  for (const c of CASES) {
    let passes = 0;
    const samples = [];
    for (let t = 0; t < TRIALS; t++) {
      const req = {
        prefix: c.prefix, suffix: "", kernelName: c.kernel,
        cells: c.cells ?? [{ type: "code", content: "import numpy as np" }, { type: "code", content: c.prefix }],
        activeCellIndex: c.active ?? 1,
      };
      const opts = { contextBudget: 2500, maxLines: 5 };
      const prompt = promptName === "current" ? buildPrompt(req, opts) : buildSimplePrompt(req, opts);
      try {
        const raw = await backend.complete(prompt);
        const text = processReply(raw, c.prefix);
        const ok = c.pass(text);
        if (ok) passes++;
        samples.push(`${ok ? "✓" : "✗"} ${JSON.stringify(text.slice(0, 40))}`);
      } catch (e) {
        samples.push(`✗ ERROR ${e.message.slice(0, 50)}`);
      }
    }
    results[promptName][c.name] = { passes, samples };
    console.log(`${promptName.padEnd(8)} ${c.name.padEnd(26)} ${passes}/${TRIALS}  ${results[promptName][c.name].samples[0]}`);
  }
}

console.log("\n==== SUMMARY (passes across all cases) ====");
for (const p of ["current", "simple"]) {
  const tot = Object.values(results[p]).reduce((s, r) => s + r.passes, 0);
  console.log(`${p}: ${tot}/${CASES.length * TRIALS}`);
  for (const [name, r] of Object.entries(results[p])) {
    if (r.passes < TRIALS) console.log(`  weak: ${name} ${r.passes}/${TRIALS} → ${r.samples.filter((s) => s.startsWith("✗")).join(" | ")}`);
  }
}
backend.dispose();
