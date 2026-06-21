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
2. **Build fixtures** (§3) — deterministic demo notebooks.
3. **Kernel idle** — `nebula` kernel attached, green pill.
4. **Decide deliverable** — GIF set (default) or `brew install ffmpeg` for a
   stitched `.mp4`.
5. **Viewport** — 1440×900 tab, light theme, full-screen, chrome hidden.

Everything after this is Claude-driven; no human keystrokes.

---

## 3. Fixtures (deterministic, built via MCP before the shoot)

A small setup pass (`scripts/demo-fixtures.*`, MCP-driven) creates:

- **`~/demo/exoplanets.ipynb`** — the hero. Cells, in order:
  1. md: title "Where do worlds like ours hide?"
  2. code: imports + `pd.read_csv` (runs clean)
  3. code: the discovery-method scatter (matplotlib) — the README hero plot
  4. code: a **Plotly** interactive figure (period vs radius, colored by method)
  5. code: a **`application/vnd.nebula.web+json`** widget (a small interactive
     control — e.g. a slider that filters the habitable-zone band)
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

---

## 4. Frame-level beat sheets

Granularity is the **beat** (~0.3–0.6 s = a few GIF frames). Actor codes:
**U** = user (browser), **A** = agent (MCP), **D** = director (caption/record),
**📸** = capture a screenshot frame here.

### Scene 00 — HOOK (the cold open) · target 5 s
Caption: *"Your notebook. Your agent. At the same time."*
| t | actor | beat |
|---|---|---|
| 0.0 | D | reset cell 7 to 4-space version; scroll so cells 6–7 fill viewport; start_recording 📸 |
| 0.4 | A | `start_agent_session(exclusive:false)` → purple "Agent" badge appears 📸 |
| 0.8 | U | click into cell 6, begin typing a comment `# exploring the habitable zone…` |
| 1.6 | A | `update_cell(7, <2-space reindent>)` → cell 7 text rewrites, **purple ring** blooms 📸 |
| 2.4 | U | keep typing in cell 6 (both cursors visibly active) 📸 |
| 3.2 | A | `execute_cell(7)` → output refreshes green 📸 |
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
| 0.8 | — | `Q1 Q2 Q3` queue badges pulse on pending cells 📸 |
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
| 0.4 | A | `execute_cell(6)` (tqdm loop) |
| 0.6–3.0 | — | a single clean bar advances 0→100% (no `\r` wall) 📸📸📸 |
| 3.4 | D | stop; export `scene-04-tqdm.gif` |

### Scene 05 — KEYBOARD FLOW · 6 s
Caption: *"Fly through it without the mouse."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | `key cmd+shift+p` → quick cell navigator opens; start_recording 📸 |
| 0.6 | U | `type "plotly"` → list filters, match count 📸 |
| 1.4 | U | `key Return` → jumps to the Plotly cell 📸 |
| 2.2 | U | `key Escape` then `b` (new cell), `m` (→markdown), `y` (→code) 📸📸 |
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
| 1.0 | U | `key cmd+z cmd+z` → affected cells **flash yellow-green** 📸📸 |
| 2.5 | U | open **History** panel (status bar) 📸 |
| 3.5 | U | click an operation 3 steps back → notebook **previews** with diff highlight (orange/red) 📸📸 |
| 6.0 | U | click **Restore here** 📸 |
| 7.4 | D | stop; export `scene-07-history.gif` |

### Scene 08 — FIX WITH AGENT · 8 s
Caption: *"One click. It reads, fixes, and re-runs."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | navigate to `bug.ipynb`; the failing cell shows red error; start_recording 📸 |
| 0.6 | U | click **Fix with agent** on the error 📸 |
| 1.2 | — | Agent terminal panel slides up; "Agent" badge 📸 |
| 1.8 | A | `start_agent_session` → `read_cell` → `update_cell(<fixed code>)` → cell rewrites 📸📸 |
| 4.5 | A | `execute_cell` → red turns green, output correct 📸 |
| 6.0 | — | purple ring on the fixed cell 📸 |
| 7.4 | D | stop; export `scene-08-fix.gif` |

### Scene 09 — THE MONEY SHOT (OCC self-heal) · 10 s · **the most important GIF**
Caption: *"Edit the same cell. Nothing gets clobbered."*
| t | actor | beat |
|---|---|---|
| 0.0 | D | reset cell 7 → 4-space; scroll cells 6–7 into view; start_recording 📸 |
| 0.5 | A | `start_agent_session(exclusive:false)`; `read_cell(7)` (arms OCC at 4-space hash) 📸 |
| 1.5 | U | click into cell 7 and **type** a new comment line + tweak indentation (changes the cell *the agent is about to write*) 📸📸 |
| 3.0 | A | `update_cell(7, <2-space version built on the OLD read>)` → **conflict**: returns user's current content 📸 |
| 4.0 | — | soft **blue toast**: "agent will retry with your version" (not a red error) 📸 |
| 4.8 | A | re-`read_cell(7)` → re-apply 2-space reindent **on top of** the user's new line → `update_cell` succeeds 📸📸 |
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
| 0.0 | U | open the kernel menu / kernel manager; start_recording 📸 |
| 0.8 | — | detected envs listed (conda/venv/uv/system) with Register / copy-command 📸📸 |
| 3.0 | U | hover the PEP 668 "externally managed" hint → exact install command 📸 |
| 5.4 | D | stop; export `scene-11-kernels.gif` |

### Scene 12 — GIT-FRIENDLY FORMATS · 7 s
Caption: *"Notebooks your git history will thank you for."*
| t | actor | beat |
|---|---|---|
| 0.0 | U | `+` menu → show Notebook/.qmd/.py options; start_recording 📸 |
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
