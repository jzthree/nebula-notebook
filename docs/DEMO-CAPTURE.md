# Nebula Demo — Autonomous Capture Spec

The frame-level shooting plan and the harness that records it **with no human
in the loop**. Companion to [`DEMO.md`](./DEMO.md) (the creative storyboard).

---

## 1. How autonomous capture works

Claude drives the entire shoot through two tool surfaces, playing both on-screen
roles:

| Role | Tooling | What it does |
|------|---------|--------------|
| **The user** | `claude-in-chrome` (`computer`, `javascript_tool`, `navigate`) | Types in cells, clicks buttons, scrolls, opens menus, fires keyboard shortcuts. |
| **The agent** | `nebula-notebook` MCP (`start_agent_session`, `update_cell`, `execute_cell`, …) | Reads/edits/runs cells exactly as Claude Code would — the notebook reacts live in the captured viewport. |
| **The director** | `gif_creator` + `javascript_tool` (caption overlay) | Brackets each scene's recording and burns in captions as DOM overlays. |

**Why this is the unlock:** the collaborative beats (Act 3) normally need a live
`claude` CLI responding in real time — impossible to make deterministic. By
issuing the agent's edits *directly* through the MCP while simultaneously driving
the browser as the user, every take is identical and frame-accurate. No CLI
timing, no flakiness.

### Capture primitive
- **Output = one GIF per scene** (viewport capture, no OS screen-recording
  permission, no desktop clutter). GIFs autoplay inline on GitHub — ideal for the
  README.
- **`ffmpeg` is not installed.** Single continuous `.mp4` with crossfades is
  optional and requires `brew install ffmpeg`; the GIF set is the zero-dependency
  default and the recommended deliverable.
- **Captions** are injected DOM overlays (not ffmpeg burn-in) so they're
  ffmpeg-free and viewport-native. `gif_creator`'s own click-indicator + progress
  overlays are disabled for product polish (`showWatermark:false`,
  `showActionLabels:false`).

### The per-scene loop (the harness)
```
for each scene:
  1. resetScene()        # MCP sets cells to a known state; navigate; scroll target into view
  2. injectCaption(text) # JS overlay, fixed bottom, gradient
  3. gif_creator start_recording
  4. computer.screenshot                      # bracket: first frame
  5. run the beat sheet:
       USER beats  -> computer.type/left_click/key/scroll
       AGENT beats -> mcp__nebula__update_cell / execute_cell / start_agent_session
       sprinkle computer.screenshot at key moments to guarantee those frames
  6. computer.screenshot                      # bracket: last frame
  7. gif_creator stop_recording
  8. gif_creator export(download:true, filename:"scene-NN-<slug>.gif",
                        options:{showWatermark:false, showActionLabels:false, quality:8})
  9. removeCaption(); resetScene()            # leave clean state for next scene
```

### Reusable caption overlay (injected via `javascript_tool`)
```js
(t => { const e = document.getElementById('demo-cap') || document.body.appendChild(
  Object.assign(document.createElement('div'), { id:'demo-cap' }));
  e.textContent = t;
  Object.assign(e.style, { position:'fixed', left:0, right:0, bottom:0,
    padding:'16px 28px', font:'600 22px -apple-system,system-ui,sans-serif',
    color:'#fff', textAlign:'center', letterSpacing:'.2px', zIndex:2147483647,
    pointerEvents:'none', background:'linear-gradient(transparent,rgba(15,23,42,.85))' });
})(CAPTION_TEXT)
```
Remove with `document.getElementById('demo-cap')?.remove()`.

---

## 2. Pre-flight (one-time, the only human-adjacent steps)

1. **Fresh server on current code** — the running instance is stale. Build + run:
   `npm run stop && npm --prefix node-server run build && NO_AUTH=true NEBULA_PRESERVE_KERNELS=true NEBULA_REATTACH_KERNELS=true npm run start`. Confirm `:3000` and a real API path (e.g. `GET /api/notebook/cells?path=…`) both answer.
2. **Install fixture libs into the kernel.** The `nebula` kernel is a uv venv
   (no `pip`); use uv:
   `uv pip install --python ~/.venvs/nebula/bin/python pandas plotly tqdm nbformat`
   (numpy + matplotlib already present; `nbformat` is required for Plotly's MIME
   output). *Done.*
3. **Build the fixtures** (§3) — `~/.venvs/nebula/bin/python scripts/demo-fixtures.py`.
   Creates `~/demo/{exoplanets.csv,.ipynb,.py,.qmd, bug.ipynb}` + a git commit.
   *Done; all cells verified through the real kernel.*
4. **Kernel idle** — `nebula` kernel attached, green pill.
5. **Decide deliverable** — GIF set (default) or `brew install ffmpeg` for a
   stitched `.mp4`.
6. **Viewport** — 1440×900 tab, light theme, full-screen, chrome hidden.

Everything after this is Claude-driven; no human keystrokes.

---

## 3. Fixtures (deterministic, built via MCP before the shoot)

A small setup pass (`scripts/demo-fixtures.*`, MCP-driven) creates:

- **`~/demo/exoplanets.ipynb`** — the hero. Cells, in order:
  1. md: title "Where do worlds like ours hide?"
  2. code: imports + `pd.read_csv` (runs clean)
  3. code: the discovery-method scatter (matplotlib) — the README hero plot
  4. code: a **Plotly** interactive figure (period vs radius, colored by method)
  5. code: a **`application/vnd.nebula.web+json`** widget — **lift the ready
     slider example verbatim from cell 2 of `interactive-output-demo.ipynb`**
     (already in the repo, production-grade) rather than writing one.
  6. code: a `tqdm` loop (`for _ in tqdm(range(50)): time.sleep(0.02)`)
  7. code: the cell used for the **OCC money shot** — a function indented with
     4 spaces (agent will reindent to 2 while user types)
  8–40: padding markdown/code so the notebook is long enough to *show* instant
     load (mostly collapsed markdown notes).
- **`~/demo/bug.ipynb`** — one cell that raises (e.g. `df.groupby('startype')` —
  misspelled column → `KeyError`) for "Fix with agent".
- **`~/demo/exoplanets.qmd`** + **`~/demo/exoplanets.py`** — same notebook saved
  in both text formats, for the Act-4 git-diff beat (and a `git init` in `~/demo`
  with the `.ipynb` committed once so the diff is real on camera).

`resetScene()` rewrites the specific cells a scene touches back to these known
states between takes.

**Cell addressing — the ids are stable and readable.** The MCP tools address
cells by `cell_id` (string) or `cell_index` (**0-based**), *not* by the 1-based
scene numbers. Collaborative ops **must** use `cell_id` (indices shift under user
edits). The fixtures bake in these ids, so the beats reference them directly:

| scene cell | `cell_id` | what it is |
|---|---|---|
| title | `title` | markdown intro |
| C2 | `load` | pandas read_csv |
| C3 | `scatter` | matplotlib hero plot |
| C4 | `plotly` | interactive Plotly |
| C5 | `widget` | nebula-web widget |
| C6 | `tqdm` | progress-bar loop |
| C7 | `occ` | the money-shot cell (4-space → 2-space) |
| (bug.ipynb) | `bug` | the `KeyError` cell |

---

## 4. Frame-level beat sheets

Granularity is the **beat** (~0.3–0.6 s = a few GIF frames). Actor codes:
**U** = user (browser), **A** = agent (MCP), **D** = director (caption/record),
**📸** = capture a screenshot frame here. Agent calls use **`cell_id`** (the
`C2…C7`/`Cbug` from the fixture map), never the 1-based scene number.

### Scene 00 — HOOK (the cold open) · target 5 s
Caption: *"Your notebook. Your agent. At the same time."*
| t | actor | beat |
|---|---|---|
| 0.0 | D | reset cell 7 to 4-space version; scroll so cells 6–7 fill viewport; start_recording 📸 |
| 0.4 | A | `start_agent_session(exclusive:false)` → purple "Agent" badge appears 📸 |
| 0.8 | U | click into cell 6, begin typing a comment `# exploring the habitable zone…` |
| 1.6 | A | `update_cell(cell_id="occ", <2-space reindent>)` → cell 7 text rewrites, **purple ring** blooms 📸 |
| 2.4 | U | keep typing in cell 6 (both cursors visibly active) 📸 |
| 3.2 | A | `execute_cell(cell_id="occ")` → output refreshes green 📸 |
| 4.2 | D | hold final frame 📸; stop_recording; export `scene-00-hook.gif` |

### Scene 01 — INSTANT OPEN · 4 s
Caption: *"Big notebooks open instantly."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | `navigate` to `/?file=~/demo/exoplanets.ipynb`; start_recording immediately 📸 |
| 0.3 | — | cells paint progressively (content-visibility batching visible) 📸 |
| 1.0 | U | `scroll` down fast through 40 cells — buttery, no jank 📸 |
| 2.5 | U | `scroll` back to top 📸 |
| 3.5 | D | stop; export `scene-01-open.gif` |

### Scene 02 — RUN ALL, WITH A PULSE · 6 s
Caption: *"See what's running — and how long it took."*
| t | actor | beat |
|---|---|---|
| 0.0 | D | reset cells 2–6 to un-run (clear outputs via MCP); start_recording 📸 |
| 0.4 | U | click **Run All** 📸 |
| 0.8 | — | pending cells show a pulsing amber **`[*]`** marker (hover title: "Queued at position N") 📸 |
| 2.0 | — | cell 2 finishes → inline `34ms`; cell 3 scatter renders 📸 |
| 3.5 | — | Plotly (cell 4) renders 📸 |
| 5.0 | — | all idle; execution times visible down the gutter 📸 |
| 5.6 | D | stop; export `scene-02-runall.gif` |

### Scene 03 — LIVE OUTPUTS · 6 s
Caption: *"Interactive outputs. No widget plumbing."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | scroll Plotly (cell 4) into view; start_recording 📸 |
| 0.5 | U | `left_click_drag` to pan, then `scroll` to zoom the plot 📸📸 |
| 2.0 | U | `hover` a point → tooltip 📸 |
| 3.0 | U | scroll to the nebula-web widget (cell 5) |
| 3.5 | U | drag its slider → the habitable band updates live 📸📸 |
| 5.5 | D | stop; export `scene-03-outputs.gif` |

### Scene 04 — PROGRESS BARS DONE RIGHT · 4 s
Caption: *"Progress bars, done right."*
| t | actor | beat |
|---|---|---|
| 0.0 | D | reset cell 6; scroll into view; start_recording 📸 |
| 0.4 | A | `execute_cell(cell_id="tqdm")` (tqdm loop) |
| 0.6–3.0 | — | a single clean bar advances 0→100% (no `\r` wall) 📸📸📸 |
| 3.4 | D | stop; export `scene-04-tqdm.gif` |

### Scene 05 — KEYBOARD FLOW · 6 s
Caption: *"Fly through it without the mouse."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | `key cmd+shift+p` → quick cell navigator opens; start_recording 📸 |
| 0.6 | U | `type "plotly"` → list filters, match count 📸 |
| 1.4 | U | `key Return` → jumps to the Plotly cell 📸 |
| 2.2 | U | `key Escape` then `b` (cell **below**; `a`=above), `m` (→markdown), `y` (→code) 📸📸 |
| 5.2 | D | stop; export `scene-05-keyboard.gif` |

### Scene 06 — SEARCH & REPLACE · 6 s
Caption: *"Real find-and-replace. Regex included."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | `key cmd+f` → search bar, seeded from selection; start_recording 📸 |
| 0.5 | U | `type "radius"` → live match count, in-editor highlights across cells 📸 |
| 1.5 | U | toggle regex on; `type "_earth"` appended 📸 |
| 2.5 | U | open Replace, `type "_re"`, click **Replace all** 📸📸 |
| 5.4 | D | stop; export `scene-06-search.gif` |

### Scene 07 — TIME TRAVEL · 8 s
Caption: *"Scrub through your entire edit history."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | make 2 quick edits (so history has entries); start_recording 📸 |
| 1.0 | U | `key cmd+z cmd+z` → affected cells **pulse blue** (glow) 📸📸 |
| 2.5 | U | open **History** panel (status bar) 📸 |
| 3.5 | U | click an operation 3 steps back → notebook **previews** with diff highlight (orange/red) 📸📸 |
| 6.0 | U | click **Restore…** in the preview banner → **Restore Here** in the dialog 📸 |
| 7.4 | D | stop; export `scene-07-history.gif` |

### Scene 08 — FIX WITH AGENT · 8 s
Caption: *"One click. It reads, fixes, and re-runs."*

> **Wiring note (verified):** the **Fix with agent** button does *not* call MCP —
> it injects a prompt into the agent **terminal**, expecting a live `claude`/`codex`
> CLI to read it and drive the MCP. Two ways to shoot this:
> **(a) Authentic** — launch a real `claude` in the Agent tab first (the chip does
> this); the button then genuinely drives the fix end-to-end (most truthful, less
> deterministic). **(b) Deterministic (default)** — the harness plays the agent via
> MCP directly on the button's cue, so the click reads as causal on screen. The
> beats below are (b); for (a), drop the `A`-role MCP rows and let the CLI act.
| t | actor | beat |
|---|---|---|
| 0.0 | U | navigate to `bug.ipynb`; the failing cell shows red error; start_recording 📸 |
| 0.6 | U | click **Fix with agent** on the error → Agent terminal panel slides up, prompt injected, "Agent" badge 📸 |
| 1.8 | A | (harness MCP) `start_agent_session` → `read_cell(cell_id="bug")` → `update_cell(cell_id="bug", <fixed code>)` → cell rewrites 📸📸 |
| 4.5 | A | `execute_cell(cell_id="bug")` → red turns green, output correct 📸 |
| 6.0 | — | purple ring on the fixed cell 📸 |
| 7.4 | D | stop; export `scene-08-fix.gif` |

### Scene 09 — THE MONEY SHOT (OCC self-heal) · 10 s · **the most important GIF**
Caption: *"Edit the same cell. Nothing gets clobbered."*
| t | actor | beat |
|---|---|---|
| 0.0 | D | reset cell 7 → 4-space; scroll cells 6–7 into view; start_recording 📸 |
| 0.5 | A | `start_agent_session(exclusive:false)`; `read_cell(cell_id="occ")` (arms OCC at 4-space hash) 📸 |
| 1.5 | U | click into cell 7 and **type** a new comment line + tweak indentation (changes the cell *the agent is about to write*) 📸📸 |
| 3.0 | A | `update_cell(cell_id="occ", <2-space version built on the OLD read>)` → **conflict**: returns user's current content 📸 |
| 4.0 | — | soft **blue (info) toast**, exact text: *"Agent edit held off — you changed that cell; it will retry with your version"* 📸 |
| 4.8 | A | re-`read_cell(cell_id="occ")` → re-apply 2-space reindent **on top of** the user's new line → `update_cell` succeeds 📸📸 |
| 7.0 | — | cell 7 shows: user's comment preserved **and** 2-space indentation; purple ring 📸 |
| 8.5 | U | scroll to show nothing was lost 📸 |
| 9.6 | D | stop; export `scene-09-money-shot.gif` |

### Scene 10 — SURVIVES A REFRESH · 5 s
Caption: *"Your agent survives a refresh."*
| t | actor | beat |
|---|---|---|
| 0.0 | D | ensure an agent session/terminal is visibly active; start_recording 📸 |
| 0.5 | U | `key cmd+r` (reload) 📸 |
| 1.5 | — | page reloads; terminal panel reattaches, scrollback intact, badge returns 📸📸 |
| 4.4 | D | stop; export `scene-10-refresh.gif` |

### Scene 11 — WORKS WITH YOUR PYTHON · 6 s
Caption: *"It meets your environment where it is."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | click the **kernel selector** (the kernel pill in the header) to open its dropdown; start_recording 📸 |
| 0.8 | — | detected envs listed (conda/venv/uv/system) with Register / copy-command 📸📸 |
| 3.0 | U | hover the PEP 668 "externally managed" hint → exact install command 📸 |
| 5.4 | D | stop; export `scene-11-kernels.gif` |

### Scene 12 — GIT-FRIENDLY FORMATS · 7 s
Caption: *"Notebooks your git history will thank you for."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | file browser **+** menu → entries: **Notebook** / **Quarto notebook** / **Python notebook** / **Python script** / plain file; start_recording 📸 |
| 1.0 | U | open `exoplanets.py` (percent) as text → clean readable cells 📸 |
| 2.5 | D | (split/overlay) show `git diff` of a one-line code change: `.py` = 1-line diff vs `.ipynb` = JSON blob 📸📸 |
| 6.4 | D | stop; export `scene-12-formats.gif` |

### Scene 13 — GET STARTED · 5 s
Caption: *"Two commands. Your notebook, and your agent."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | a clean terminal view; start_recording 📸 |
| 0.5 | U | `type "npx nebula-notebook"` (don't run) 📸 |
| 2.0 | U | new line, `type "npx nebula-notebook-mcp setup-mcp"` 📸 |
| 3.5 | D | cut to hero image (navigate to the SVG or an end-card HTML) 📸 |
| 4.6 | D | stop; export `scene-13-start.gif` |

**B-roll** (resource bar, favicon avatars, output drag-resize, FIFO queue,
headless agent, keyboard-help modal) follow the same loop template; capture
on demand if a scene needs padding.

---

## 5. Assembly

- **Default:** deliver the 14 named GIFs. Drop `scene-09-money-shot.gif` at the
  top of the README; sprinkle scenes 02/03/07 next to the Highlights bullets.
- **Optional single film:** with `ffmpeg` installed, convert each GIF to a clip
  and concat with 6-frame crossfades + the caption already burned in (it's in the
  pixels). One command per pair; final `nebula-demo.mp4` ~3 min.

---

## 6. Validation gate (do this first, before the full shoot)

Capture **Scene 05 (keyboard flow)** end-to-end as a proof: it exercises the
whole harness (navigate → caption inject → record → browser-driven beats →
export) with no agent role, so it isolates the capture pipeline. If that GIF
looks clean, run the agent scenes. If captions/quality/timing need tuning, fix
the harness once and it applies to every scene.

---

## 7. Review corrections (applied)

Three subagent reviews (agent-role, UI-role, harness/env) pressure-tested the
spec against the real code and environment. Applied above:

- **Cell addressing** — MCP uses `cell_id`/0-based `cell_index`, not 1-based
  numbers; collaborative ops require `cell_id`. Added the fixture id-map.
- **"Fix with agent" wiring** — the button injects a terminal prompt for a live
  CLI; it does *not* call MCP. Scene 08 now documents the authentic-vs-
  deterministic shoot options.
- **Queue marker** is `[*]` (pulsing amber, hover position), not `Q1/Q2`.
- **Undo flash** is a **blue** pulse/glow, not yellow-green.
- **OCC toast** exact text: *"Agent edit held off — you changed that cell; it
  will retry with your version"* (info/blue).
- **Restore** label is **Restore Here** (banner button: **Restore…**).
- **Scene 11** targets the **kernel selector dropdown** in the header (where
  detected envs + Register + install hints render), not the Kernel Manager panel.
- **+ menu** labels corrected to the real entries.
- **Pre-flight blockers — now resolved**: installed `pandas plotly tqdm nbformat`
  into the kernel (uv venv, no pip); authored + ran `scripts/demo-fixtures.py`
  (reuses the nebula-web widget from `interactive-output-demo.ipynb`); all 7 code
  cells verified through the real `nebula` kernel (load→html, scatter→png,
  plotly→`vnd.plotly.v1+json`, widget→`vnd.nebula.web+json`, tqdm→CR text bar,
  occ→fn, bug→`KeyError`). Server restarted fresh; `~/demo` git-committed.

Confirmed correct as written: `exclusive:false` collaborative mode; session
required for writes; OCC arm-on-read + conflict-returns-currentContent +
self-heal; presence ring on agent ops; `~/` URL expansion; `git` present;
Cmd+Shift+P navigator; Cmd+F seeded search + regex + "In all cells"; History
preview + diff; Run All + inline execution times; full-width toggle; caption
overlay safe; GIF durations within budget; ffmpeg absent (GIF-set deliverable).
