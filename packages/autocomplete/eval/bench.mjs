#!/usr/bin/env node
/**
 * Realistic notebook-autocomplete benchmark: fill-in-the-middle over
 * notebook-shaped scenarios with hidden ground truth, scored on
 *  - contextual accuracy: does the completion use identifiers DEFINED in
 *    other cells (the anti-hallucination axis), via per-case mustInclude
 *  - first-line similarity to ground truth (SequenceMatcher-style ratio)
 *  - TTFB (first streamed text char) and total turn time
 * across configs (model × thinking budget). Configs are interleaved per case
 * so API drift cancels (lesson: sequential blocks produced phantom effects).
 *
 *   node eval/bench.mjs [trials-per-case]     # default 2
 *
 * Real API calls: cases × configs × trials turns. Run locally (no tunnel).
 */
import { ClaudeBackend } from "../dist/backends/claude.js";
import { buildPrompt } from "../dist/core/prompt.js";
import { extractCompletionTag, stripFences, trimPrefixOverlap } from "../dist/core/text.js";

const TRIALS = Number(process.argv[2] || 2);

const CONFIGS = [
  { name: "haiku",        model: "haiku",  thinking: 0 },
  { name: "haiku+think",  model: "haiku",  thinking: 1024 },
  { name: "sonnet",       model: "sonnet", thinking: 0 },
  { name: "sonnet+think", model: "sonnet", thinking: 1024 },
];

// ---------------------------------------------------------------------------
// Corpus: notebook scenarios. Each case: context cells, prefix (cursor cell up
// to cursor), truth (canonical continuation), mustInclude (context-defined
// identifiers a NON-hallucinating completion must use).
// ---------------------------------------------------------------------------
const PANDAS_CTX = [
  { type: "markdown", content: "Housing price analysis" },
  { type: "code", content: "import pandas as pd\nimport numpy as np\nimport matplotlib.pyplot as plt" },
  { type: "code", content: "listings = pd.read_csv('housing.csv')\nlistings['price_per_sqft'] = listings['sale_price'] / listings['sqft']\nlistings['is_condo'] = listings['property_type'] == 'condo'" },
];
const SKLEARN_CTX = [
  { type: "code", content: "from sklearn.model_selection import train_test_split\nfrom sklearn.ensemble import GradientBoostingRegressor\nfrom sklearn.metrics import mean_absolute_error" },
  { type: "code", content: "feature_cols = ['sqft', 'bedrooms', 'year_built', 'lot_size']\nX = listings[feature_cols]\ny = listings['sale_price']\nX_train, X_test, y_train, y_test = train_test_split(X, y, test_size=0.2, random_state=42)" },
];
const R_CTX = [
  { type: "code", content: "library(dplyr)\nlibrary(ggplot2)" },
  { type: "code", content: "measurements <- read.csv('sensor_readings.csv')\nmeasurements$temp_c <- (measurements$temp_f - 32) * 5/9\ndaily_avg <- measurements %>% group_by(sensor_id, day) %>% summarise(mean_temp = mean(temp_c))" },
];
const TORCH_CTX = [
  { type: "code", content: "import torch\nimport torch.nn as nn\nfrom torch.utils.data import DataLoader" },
  { type: "code", content: "class SeqEncoder(nn.Module):\n    def __init__(self, vocab_size, hidden_dim):\n        super().__init__()\n        self.embedding = nn.Embedding(vocab_size, hidden_dim)\n        self.gru = nn.GRU(hidden_dim, hidden_dim, batch_first=True)\n    def forward(self, x):\n        emb = self.embedding(x)\n        out, h = self.gru(emb)\n        return h.squeeze(0)" },
  { type: "code", content: "encoder = SeqEncoder(vocab_size=8000, hidden_dim=256)\noptimizer = torch.optim.AdamW(encoder.parameters(), lr=3e-4)\nloss_fn = nn.CrossEntropyLoss()" },
];
const STR_CTX = [
  { type: "code", content: "import re\nfrom collections import Counter\nlog_lines = open('server.log').read().splitlines()" },
  { type: "code", content: "ip_pattern = re.compile(r'^(\\d+\\.\\d+\\.\\d+\\.\\d+)')\ndef extract_ip(line):\n    m = ip_pattern.match(line)\n    return m.group(1) if m else None" },
];

const CASES = [
  // -------- pandas: context-identifier fidelity --------
  { id: "pd-mid-attr", cells: PANDAS_CTX, kernel: "python3",
    prefix: "expensive = listings[listings['price_per_sq",
    truth: "ft'] > 500]", mustInclude: ["ft'"] },
  { id: "pd-groupby", cells: PANDAS_CTX, kernel: "python3",
    prefix: "avg_by_type = listings.groupby('property_type')['",
    truth: "sale_price'].mean()", anyInclude: ["sale_price", "price_per_sqft"] },
  { id: "pd-new-stmt", cells: PANDAS_CTX, kernel: "python3",
    prefix: "condos = listings[listings['is_condo']]",
    truth: "\nprint(condos.shape)", mustInclude: ["condos"] },
  { id: "pd-comment-driven", cells: PANDAS_CTX, kernel: "python3",
    prefix: "# plot the distribution of price per square foot",
    truth: "\nplt.hist(listings['price_per_sqft'], bins=50)\nplt.show()", mustInclude: ["price_per_sqft"] },
  { id: "pd-chain", cells: PANDAS_CTX, kernel: "python3",
    prefix: "top10 = listings.sort_values('sale_price', ascending=False).",
    truth: "head(10)", mustInclude: ["head"] },
  // -------- sklearn: multi-cell flow --------
  { id: "sk-fit", cells: [...PANDAS_CTX, ...SKLEARN_CTX], kernel: "python3",
    prefix: "model = GradientBoostingRegressor(random_state=42)\nmodel.fit(",
    truth: "X_train, y_train)", mustInclude: ["X_train", "y_train"] },
  { id: "sk-predict-score", cells: [...PANDAS_CTX, ...SKLEARN_CTX], kernel: "python3",
    prefix: "preds = model.predict(X_test)\nmae = ",
    truth: "mean_absolute_error(y_test, preds)", mustInclude: ["mean_absolute_error", "y_test"] },
  { id: "sk-feature-loop", cells: [...PANDAS_CTX, ...SKLEARN_CTX], kernel: "python3",
    prefix: "for col in feature_",
    truth: "cols:", mustInclude: ["cols"] },
  // -------- R: language fidelity + context --------
  { id: "r-pipe", cells: R_CTX, kernel: "ir",
    prefix: "hot_days <- daily_avg %>% filter(mean_",
    truth: "temp > 30)", mustInclude: ["temp"] },
  { id: "r-ggplot", cells: R_CTX, kernel: "ir",
    prefix: "# plot mean temperature per sensor over days",
    truth: "\nggplot(daily_avg, aes(x = day, y = mean_temp, color = sensor_id)) + geom_line()",
    mustInclude: ["daily_avg", "mean_temp"] },
  { id: "r-mid-word", cells: R_CTX, kernel: "ir",
    prefix: "#conver",
    truth: "t fahrenheit to celsius", mustInclude: [], mustNotStartNL: true },
  // -------- torch: API + defined names --------
  { id: "torch-loop", cells: TORCH_CTX, kernel: "python3",
    prefix: "for epoch in range(10):\n    for batch_x, batch_y in loader:\n        optimizer.zero_grad()\n        h = ",
    truth: "encoder(batch_x)", mustInclude: ["encoder"] },
  { id: "torch-backward", cells: TORCH_CTX, kernel: "python3",
    prefix: "        loss = loss_fn(logits, batch_y)\n        loss.",
    truth: "backward()", mustInclude: ["backward"] },
  // -------- string/regex --------
  { id: "str-counter", cells: STR_CTX, kernel: "python3",
    prefix: "ip_counts = Counter(",
    truth: "extract_ip(line) for line in log_lines)", mustInclude: ["extract_ip", "log_lines"] },
  { id: "str-filter-none", cells: STR_CTX, kernel: "python3",
    prefix: "valid_ips = [ip for ip in ",
    truth: "map(extract_ip, log_lines) if ip]", mustInclude: ["log_lines"] },
  // -------- structural newline discipline --------
  { id: "block-open", cells: PANDAS_CTX, kernel: "python3",
    prefix: "def summarize(df):",
    truth: "\n    return df.describe()", mustInclude: [], mustStartNL: true },
  { id: "after-stmt", cells: TORCH_CTX, kernel: "python3",
    prefix: "encoder.train()",
    truth: "\nfor epoch in range(10):", mustInclude: [], mustStartNL: true },
  { id: "empty-cell", cells: [...PANDAS_CTX, { type: "code", content: "" }], active: 3, kernel: "python3",
    prefix: "",
    truth: "listings.head()", mustInclude: ["listings"] },
];

// ---------------------------------------------------------------------------
function similarity(a, b) {
  // char bigram dice coefficient on the first 60 chars — cheap, order-tolerant
  const grams = (s) => { const g = new Map(); const t = s.slice(0, 60);
    for (let i = 0; i < t.length - 1; i++) { const k = t.slice(i, i + 2); g.set(k, (g.get(k) ?? 0) + 1); } return g; };
  const ga = grams(a), gb = grams(b);
  let overlap = 0, total = 0;
  for (const [k, v] of ga) { overlap += Math.min(v, gb.get(k) ?? 0); total += v; }
  for (const v of gb.values()) total += v;
  return total === 0 ? 0 : (2 * overlap) / total;
}

function score(c, text) {
  const firstLines = text.split("\n").filter((l) => l.trim()).slice(0, 2).join("\n");
  const ctxOk =
    (c.mustInclude ?? []).every((m) => text.includes(m)) &&
    (!c.anyInclude || c.anyInclude.some((m) => text.includes(m)));
  const nlOk = c.mustStartNL ? text.startsWith("\n") : c.mustNotStartNL ? !text.startsWith("\n") : true;
  const sim = similarity(c.truth.trim(), firstLines);
  return { ctxOk: ctxOk && nlOk, sim };
}

const backends = new Map();
for (const cfg of CONFIGS) {
  backends.set(cfg.name, new ClaudeBackend({ poolSize: 2, model: cfg.model, maxThinkingTokens: cfg.thinking }));
}
console.log("warming 4 pools…");
await new Promise((r) => setTimeout(r, 15000));

const rows = [];
for (const c of CASES) {
  for (let t = 0; t < TRIALS; t++) {
    for (const cfg of CONFIGS) {          // interleave configs within a case
      const req = { prefix: c.prefix, suffix: "", kernelName: c.kernel,
        cells: c.cells.concat(c.active === undefined ? [{ type: "code", content: c.prefix }] : []),
        activeCellIndex: c.active ?? c.cells.length };
      const prompt = buildPrompt(req, { contextBudget: 20000, maxLines: 10 });
      const t0 = performance.now();
      let ttfb = null;
      try {
        const raw = await backends.get(cfg.name).complete(prompt, {
          onChunk: () => { if (ttfb === null) ttfb = performance.now() - t0; },
        });
        const total = performance.now() - t0;
        const tagged = extractCompletionTag(raw);
        const text = trimPrefixOverlap(c.prefix, tagged !== null ? tagged : stripFences(raw));
        const { ctxOk, sim } = score(c, text);
        rows.push({ cfg: cfg.name, id: c.id, ctxOk, sim, ttfb, total, text: text.slice(0, 60) });
        console.log(`${cfg.name.padEnd(13)} ${c.id.padEnd(18)} ctx=${ctxOk ? "✓" : "✗"} sim=${sim.toFixed(2)} ttfb=${Math.round(ttfb ?? total)}ms  ${JSON.stringify(text.slice(0, 42))}`);
      } catch (e) {
        rows.push({ cfg: cfg.name, id: c.id, ctxOk: false, sim: 0, ttfb: null, total: null, err: String(e.message).slice(0, 60) });
        console.log(`${cfg.name.padEnd(13)} ${c.id.padEnd(18)} ERROR ${e.message.slice(0, 50)}`);
      }
    }
  }
}

// ---------------- summary ----------------
const pct = (x) => (100 * x).toFixed(0) + "%";
const q = (arr, p) => { const s = arr.filter((x) => x != null).sort((a, b) => a - b); return s.length ? Math.round(s[Math.floor(p * (s.length - 1))]) : null; };
console.log("\n==== SUMMARY (quality vs latency) ====");
console.log("config        ctx-acc  sim    ttfb p50/p90      total p50");
for (const cfg of CONFIGS) {
  const r = rows.filter((x) => x.cfg === cfg.name);
  const ctx = r.filter((x) => x.ctxOk).length / r.length;
  const sim = r.reduce((s, x) => s + x.sim, 0) / r.length;
  const ttfbs = r.map((x) => x.ttfb);
  console.log(`${cfg.name.padEnd(13)} ${pct(ctx).padEnd(8)} ${sim.toFixed(2).padEnd(6)} ${q(ttfbs, 0.5)}/${q(ttfbs, 0.9)}ms`.padEnd(58) + `${q(r.map((x) => x.total), 0.5)}ms`);
}
console.log("\nper-case weak spots (ctx failures by config):");
for (const cfg of CONFIGS) {
  const fails = [...new Set(rows.filter((x) => x.cfg === cfg.name && !x.ctxOk).map((x) => x.id))];
  if (fails.length) console.log(`  ${cfg.name}: ${fails.join(", ")}`);
}
for (const b of backends.values()) b.dispose();
