#!/usr/bin/env python3
"""
Build the deterministic demo fixtures for the Nebula product film.

Creates ~/demo/{exoplanets.csv, exoplanets.ipynb, bug.ipynb, exoplanets.py,
exoplanets.qmd} and a git repo with the .ipynb committed (for the Act-4 diff).

Cell ids are STABLE and readable so the capture harness can address cells by
id (see docs/DEMO-CAPTURE.md). The fixture map:
  title load(C2) scatter(C3) plotly(C4) widget(C5) tqdm(C6) occ(C7) ; bug(Cbug)

Re-run any time to reset the fixtures. Pure stdlib (no pandas needed here).
"""

import json, os, random, subprocess, sys

HOME = os.path.expanduser("~")
DEMO = os.path.join(HOME, "demo")
os.makedirs(DEMO, exist_ok=True)

# ----------------------------------------------------------------------------
# 1. Synthetic exoplanets.csv (seeded → identical every run)
# ----------------------------------------------------------------------------
def build_csv(path, n=800):
    random.seed(7)
    methods = ["transit"] * 60 + ["radial velocity"] * 30 + ["imaging"] * 10
    startypes = ["G", "K", "M", "F"]
    lines = ["name,period_days,radius_earth,method,in_habitable_zone,startype"]
    hz_count = 0
    for i in range(n):
        method = random.choice(methods)
        if method == "imaging":
            p = 10 ** random.uniform(2.5, 3.3)
            r = random.uniform(8, 16)
        elif method == "radial velocity":
            p = 10 ** random.uniform(0.3, 3.3)
            r = random.uniform(3, 14)
        else:  # transit
            p = 10 ** random.uniform(0, 3.0)
            r = 10 ** random.uniform(-0.1, 1.0)
        hz = (130 <= p <= 480) and (0.8 <= r <= 2.2) and random.random() < 0.6
        hz_count += hz
        lines.append(f"NB-{i:04d},{p:.2f},{r:.2f},{method},{hz},{random.choice(startypes)}")
    with open(path, "w") as f:
        f.write("\n".join(lines) + "\n")
    return len(lines) - 1, hz_count


# ----------------------------------------------------------------------------
# 2. Source-of-truth cell list (id, type, source) → drives every format
# ----------------------------------------------------------------------------
WIDGET_SRC = r'''from IPython.display import display

nebula_widget = {
    "height": 260,
    "html": """
    <div data-nebula-root class='card'>
      <div class='eyebrow'>Nebula JS Output</div>
      <h2>Habitable-zone explorer</h2>
      <p class='subtitle'>Running through <code>application/vnd.nebula.web+json</code>.</p>
      <div class='metric-row'><span>Candidates in band</span><strong data-value>0</strong></div>
      <button data-randomize>Resample</button>
      <div data-bars class='bars'></div>
    </div>
    """,
    "css": """
    .card { font-family: ui-sans-serif, system-ui, sans-serif; padding: 18px;
      border-radius: 16px; color: #0f172a;
      background: linear-gradient(135deg, #f8fafc, #e0f2fe);
      border: 1px solid #cbd5e1; box-shadow: 0 8px 20px rgba(15,23,42,.08); }
    .eyebrow { font-size: 11px; letter-spacing: .12em; text-transform: uppercase;
      color: #0369a1; margin-bottom: 10px; font-weight: 700; }
    h2 { margin: 0 0 8px; font-size: 24px; line-height: 1.2; }
    .subtitle { margin: 0 0 16px; color: #334155; font-size: 14px; }
    code { background: rgba(255,255,255,.7); padding: 2px 6px; border-radius: 999px; font-size: 12px; }
    .metric-row { display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 14px; font-size: 14px; }
    strong { font-size: 28px; color: #7c3aed; }
    button { border: 0; background: #0f172a; color: white; padding: 10px 14px;
      border-radius: 999px; cursor: pointer; font-weight: 600; margin-bottom: 14px; }
    .bars { display: grid; grid-template-columns: repeat(6, minmax(0,1fr)); gap: 10px;
      align-items: end; height: 96px; }
    .bar { border-radius: 10px 10px 4px 4px;
      background: linear-gradient(180deg, #7c3aed, #2563eb); min-height: 16px;
      transition: height 160ms ease; }
    """,
    "js": """
    const barsEl = container.querySelector('[data-bars]');
    const valueEl = container.querySelector('[data-value]');
    const button = container.querySelector('[data-randomize]');
    let state = [18, 34, 26, 42, 30, 22];
    const render = () => {
      valueEl.textContent = String(state.reduce((s, v) => s + v, 0));
      barsEl.replaceChildren(...state.map((v) => {
        const bar = document.createElement('div');
        bar.className = 'bar'; bar.style.height = `${v * 2}px`; return bar;
      }));
    };
    button.addEventListener('click', () => {
      state = state.map(() => 16 + Math.floor(Math.random() * 32)); render();
    });
    render();
    """,
}
display({"application/vnd.nebula.web+json": nebula_widget,
         "text/plain": "Habitable-zone explorer (Nebula web output)"}, raw=True)
'''

CELLS = [
    ("title", "markdown",
     "# 🪐 Exoplanets — where do worlds like ours hide?\n\n"
     "A quick tour of 800 confirmed planets: how we found them, how big they are, "
     "and which sit in the habitable zone."),
    ("load", "code",
     'import pandas as pd\n\n'
     'df = pd.read_csv("exoplanets.csv")\n'
     'print(f"{len(df):,} planets · {df.method.nunique()} discovery methods")\n'
     'df.head()'),
    ("scatter", "code",
     'import matplotlib.pyplot as plt\n\n'
     'fig, ax = plt.subplots(figsize=(9, 4.5))\n'
     'colors = {"transit": "#38bdf8", "radial velocity": "#f59e0b", "imaging": "#f472b6"}\n'
     'for method, g in df.groupby("method"):\n'
     '    ax.scatter(g.period_days, g.radius_earth, s=12, alpha=.6,\n'
     '               c=colors.get(method, "#94a3b8"), label=method)\n'
     'hz = df[df.in_habitable_zone]\n'
     'ax.scatter(hz.period_days, hz.radius_earth, s=90, facecolors="none",\n'
     '           edgecolors="#7c3aed", linewidths=1.6, label="habitable zone")\n'
     'ax.set(xscale="log", xlabel="orbital period (days)", ylabel="radius (R⊕)")\n'
     'ax.legend(frameon=False, fontsize=8)\n'
     'plt.show()'),
    ("plotly", "code",
     'import plotly.express as px\n'
     'import plotly.io as pio\n'
     'pio.renderers.default = "plotly_mimetype"\n\n'
     'fig = px.scatter(df, x="period_days", y="radius_earth", color="method",\n'
     '                 log_x=True, height=360, opacity=.7,\n'
     '                 color_discrete_map={"transit": "#38bdf8",\n'
     '                                     "radial velocity": "#f59e0b",\n'
     '                                     "imaging": "#f472b6"})\n'
     'fig.update_layout(margin=dict(l=40, r=20, t=20, b=40))\n'
     'fig.show()'),
    ("widget", "code", WIDGET_SRC),
    ("tqdm", "code",
     'from tqdm import tqdm\n'
     'import time\n\n'
     'total = 0\n'
     'for i in tqdm(range(50), desc="scanning catalog"):\n'
     '    total += i\n'
     '    time.sleep(0.03)\n'
     'print("scanned:", total)'),
    ("occ", "code",
     '# Mandelbrot escape time — the agent will reindent this 4-space block to 2.\n'
     'def escape_time(c):\n'
     '    z = 0j\n'
     '    for n in range(100):\n'
     '        z = z * z + c\n'
     '        if abs(z) > 2.0:\n'
     '            return n\n'
     '    return 100'),
]

# padding markdown so the notebook is long enough to *show* instant load
NOTES = [
    "Transit dips, radial-velocity wobbles, and direct imaging each probe a "
    "different slice of parameter space.",
    "Hot Jupiters cluster at short periods and large radii — easy to find, "
    "nothing like home.",
    "The small-planet valley around 1.5–2 R⊕ is a real feature, not a "
    "selection effect.",
    "Kepler's long-baseline photometry is what made the temperate band visible.",
    "Radial velocity favors massive planets close to bright stars.",
    "Directly imaged planets are young, hot, and far out — the pink corner.",
    "Habitability is more than the zone: atmosphere, star activity, and "
    "composition all matter.",
    "G and K dwarfs are the friendliest hosts for long-lived biospheres.",
]
for i in range(28):
    CELLS.append((f"pad-{i:02d}", "markdown", f"### Note {i+1}\n\n{NOTES[i % len(NOTES)]}"))


# ----------------------------------------------------------------------------
# 3. Writers
# ----------------------------------------------------------------------------
def ipynb_cell(cid, ctype, src):
    lines = src.split("\n")
    source = [l + "\n" for l in lines[:-1]] + [lines[-1]]
    cell = {"cell_type": ctype, "id": cid, "metadata": {"nebula_id": cid}, "source": source}
    if ctype == "code":
        cell["execution_count"] = None
        cell["outputs"] = []
    return cell

def write_ipynb(path, cells):
    nb = {
        "cells": [ipynb_cell(*c) for c in cells],
        "metadata": {
            "kernelspec": {"name": "nebula", "display_name": "Python 3.12 (Nebula)", "language": "python"},
            "language_info": {"name": "python"},
        },
        "nbformat": 4, "nbformat_minor": 5,
    }
    with open(path, "w") as f:
        json.dump(nb, f, indent=1)
        f.write("\n")

def write_percent(path, cells):
    out = ["# ---", "# jupyter:", "#   kernelspec:",
           "#     display_name: Python 3.12 (Nebula)", "#     language: python",
           "#     name: nebula", "# ---", ""]
    for cid, ctype, src in cells:
        if out and out[-1] != "":
            out.append("")
        if ctype == "markdown":
            out.append(f'# %% [markdown] id="{cid}"')
            out += ["# " + l if l else "#" for l in src.split("\n")]
        else:
            out.append(f'# %% id="{cid}"')
            out += src.split("\n")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")

def write_qmd(path, cells):
    out = ["---", "title: Exoplanets", "jupyter:", "  kernelspec:",
           "    display_name: Python 3.12 (Nebula)", "    language: python",
           "    name: nebula", "---", ""]
    for cid, ctype, src in cells:
        if out and out[-1] != "":
            out.append("")
        if ctype == "markdown":
            out.append(f"<!-- #| id: {cid} -->")
            out += src.split("\n")
        else:
            out.append("```{python}")
            out.append(f"#| id: {cid}")
            out += src.split("\n")
            out.append("```")
    with open(path, "w") as f:
        f.write("\n".join(out) + "\n")


# ----------------------------------------------------------------------------
# 4. Build everything
# ----------------------------------------------------------------------------
rows, hz = build_csv(os.path.join(DEMO, "exoplanets.csv"))
write_ipynb(os.path.join(DEMO, "exoplanets.ipynb"), CELLS)
write_percent(os.path.join(DEMO, "exoplanets.py"), CELLS)
write_qmd(os.path.join(DEMO, "exoplanets.qmd"), CELLS)

BUG = [
    ("setup", "code",
     'import pandas as pd\n'
     'df = pd.read_csv("exoplanets.csv")'),
    ("bug", "code",
     '# average planet radius by star type\n'
     'df.groupby("star_type").radius_earth.mean()  # column is actually "startype"'),
]
write_ipynb(os.path.join(DEMO, "bug.ipynb"), BUG)

# git repo with the .ipynb committed once, so Scene 12 shows a real diff
def git(*args):
    return subprocess.run(["git", "-C", DEMO, *args],
                          capture_output=True, text=True)
if not os.path.isdir(os.path.join(DEMO, ".git")):
    git("init", "-q")
git("config", "user.email", "demo@nebula.dev")
git("config", "user.name", "Nebula Demo")
git("add", "exoplanets.ipynb")
git("commit", "-q", "-m", "exoplanets analysis")

print(f"Fixtures built in {DEMO}")
print(f"  exoplanets.csv     {rows} rows ({hz} in habitable zone)")
print(f"  exoplanets.ipynb   {len(CELLS)} cells "
      f"(ids: {', '.join(c[0] for c in CELLS[:7])} …)")
print(f"  bug.ipynb          {len(BUG)} cells (Cbug = 'bug')")
print(f"  exoplanets.py/.qmd percent + quarto")
print(f"  git                committed exoplanets.ipynb")
