# Nebula Notebook

Nebula is an agent-native notebook — built for you and your AI to work in the same cells, and a fast, polished one even if you never touch the AI.

<p align="center">
  <!-- 2½-min product tour. Uploaded into the `demo-assets` release description, so GitHub
       transcodes it and streams it inline via the user-attachments URL below (video/mp4,
       range requests, no attachment disposition). The 12 MB original also stays attached to
       that release as a downloadable asset. Neither is committed to the repo, so clones stay
       lean. Renderers that strip <video> (npm, some mirrors) fall back to the link inside. -->
  <video src="https://github.com/user-attachments/assets/77d794be-cdcc-4285-ba2d-c3779b9141ed" controls muted width="940" poster="https://raw.githubusercontent.com/jzthree/nebula-notebook/main/docs/assets/nebula-hero.svg">
    <a href="https://github.com/jzthree/nebula-notebook/releases/download/demo-assets/nebula-demo-16x9.mp4">Watch the 2½-minute product tour</a>
  </video>
</p>
<p align="center"><sub>▶ <a href="https://github.com/user-attachments/assets/77d794be-cdcc-4285-ba2d-c3779b9141ed">Watch the 2½-minute tour</a> · or skim the autoplay clips below</sub></p>

## Highlights

- **Agent-native** — Claude Code, Codex, Cursor & friends operate notebooks through MCP (`npx nebula-notebook-mcp setup-mcp`); an agent terminal is built into every notebook, with one-click launch pre-briefed on your server and notebook
- **Edit while the agent edits** — per-cell optimistic concurrency: if an agent's write conflicts with yours, it's rejected and handed your current content to retry against — nothing is silently overwritten
- **"Fix with agent"** on any failing cell, plus per-cell prompts — both inject straight into the agent's terminal, context included
- **Jupyter kernels** over ZeroMQ (Python, Julia, R, …) that survive dev-server restarts and reattach
- **Rich outputs** — Plotly MIME rendering and Nebula-native interactive JS outputs, in a virtualized cell list that stays fast on large notebooks
- **Runs anywhere** — `npx nebula-notebook`, TOTP 2FA, and multi-server clusters behind a single UI

## See it in action

**An agent edits your notebook live** — reindenting a cell while you watch, with a presence ring on the cell it's touching:

<p align="center">
  <img src="https://raw.githubusercontent.com/jzthree/nebula-notebook/main/docs/assets/demo/scene-agent.gif" alt="An agent reindents a code cell from 4-space to 2-space live in the UI, with a purple presence ring around the cell" width="760">
</p>

**Interactive outputs, no widget plumbing** — `application/vnd.nebula.web+json` widgets respond to clicks:

<p align="center">
  <img src="https://raw.githubusercontent.com/jzthree/nebula-notebook/main/docs/assets/demo/scene-widget.gif" alt="A Nebula-native interactive web output: clicking Resample re-rolls the bar chart live" width="760">
</p>

**Time-travel through your edit history** — preview any past moment with diff highlighting, then restore:

<p align="center">
  <img src="https://raw.githubusercontent.com/jzthree/nebula-notebook/main/docs/assets/demo/scene-history.gif" alt="The History panel: clicking a past edit previews the notebook at that moment with an orange modified-cell highlight and a Restore option" width="760">
</p>

**Find across the whole notebook** — regex search with live match counts:

<p align="center">
  <img src="https://raw.githubusercontent.com/jzthree/nebula-notebook/main/docs/assets/demo/scene-search.gif" alt="Notebook-wide search: typing a query highlights every match across cells with a running match count" width="760">
</p>

<sub>All clips captured headlessly from the running app — regenerate with <code>python scripts/demo-shoot.py all</code>.</sub>

## Quick Start

```bash
npx nebula-notebook
```

Nebula itself is pure Node — but running notebooks needs a Python (3.10+) with `ipykernel` on the server machine. If none is found, the kernel menu detects your Python environments (venv, conda, uv, pixi, system) and shows the exact setup command for each; environments that already have `ipykernel` register with one click.

On first start, a QR code will appear in the terminal. Scan it with an authenticator app (Google Authenticator, Authy, etc.) to set up 2FA.

Open http://localhost:3000 and enter your 6-digit code.

To let agents (Claude Code, Codex, Cursor, Gemini CLI, …) operate your notebooks, register the Nebula MCP on the machine where your agent runs:

```bash
npx nebula-notebook-mcp setup-mcp
```

Then open a notebook, click **Agent**, and launch Claude Code or Codex right in the notebook's terminal.

### From source (latest)

npm releases are point-in-time snapshots — to get the latest changes, install from source:

```bash
git clone https://github.com/jzthree/nebula-notebook.git
cd nebula-notebook
npm install

npm run start
```

## Root Directory

Set the server root directory (default is your home directory):

```bash
npm run start --workdir /path/to/projects
```

This root is used for the file browser and terminals. You can also change it from the file browser UI and it will be remembered by the server.

## Features

**Core**
- Jupyter kernel execution (Python, Julia, R, etc.)
- Built-in file browser — open notebooks anywhere on disk
- Autosave with crash recovery
- Undo/redo with full edit history

**Navigation**
- Table of Contents breadcrumb - auto-generated from markdown headers
- Search & replace across all cells (Cmd/Ctrl+F)
- Keyboard shortcuts (Shift+Enter to run, Cmd+S to save, etc.)

**Agents**
- Agent terminal built into every notebook — one click launches Claude Code or Codex, pre-briefed with the server URL and notebook path
- "Fix with agent" on any failing cell, and per-cell prompts, injected straight into the agent's terminal
- Full MCP toolset ([`nebula-notebook-mcp`](https://www.npmjs.com/package/nebula-notebook-mcp)): read/edit/execute cells, manage kernels and files — from any agent on any machine
- Agent sessions lock the notebook during edits and sync live into the UI

**Editor**
- Syntax highlighting with CodeMirror
- Tab autocomplete for variables
- Auto-indent detection
- Execution queue with status indicators

**UI/UX**
- Virtualized cell list for large notebooks
- Collapsible/resizable outputs
- Rich interactive outputs, including Plotly MIME rendering and Nebula-native JS outputs
- Sound & browser notifications for long-running cells
- Dark-mode friendly error display

## Rich Outputs

Nebula supports structured rich notebook outputs instead of flattening everything to plain text.

- Jupyter-compatible Plotly rendering via `application/vnd.plotly.v1+json`
- Nebula-native interactive outputs via `application/vnd.nebula.web+json`

See [docs/RICH_OUTPUTS.md](docs/RICH_OUTPUTS.md) for examples, payload format, shared library loading, and current compatibility limits.

## Prerequisites

- Node.js 20+
- Python 3.10+ with `ipykernel`, on the machine running the server (other Jupyter kernels — Julia, R, … — work too)

No ipykernel yet? Open the kernel menu in the UI: it detects your Python environments (venv, conda, uv, pixi, Homebrew, system), registers ready ones with one click, and shows the exact install command for the rest — including the PEP 668 "externally managed" cases (uv/Homebrew/system Python) where `pip install` is blocked and an isolated env is the right move.

## Project Structure

```
nebula-notebook/
├── components/       # React components
├── hooks/            # Custom React hooks
├── lib/              # Core utilities (diff, operations)
├── services/         # Frontend API clients
├── node-server/      # Node.js Express backend
│   └── src/
│       ├── index.ts          # Server entry point
│       ├── kernel/           # Jupyter kernel management (ZeroMQ)
│       ├── cluster/          # Multi-server cluster support
│       ├── auth/             # 2FA authentication
│       └── routes/           # API routes
├── packages/
│   └── mcp/          # Separately installable MCP adapter package
└── types.ts
```

## MCP Adapter

The MCP adapter is published as [`nebula-notebook-mcp`](https://www.npmjs.com/package/nebula-notebook-mcp)
and lives in this repository under `packages/mcp`. It is a separate package so it
can be installed on a local agent/client machine even when the Nebula Notebook
server is running elsewhere.

```bash
# Register the MCP with your installed agent CLIs (Claude Code, Codex, …)
npx nebula-notebook-mcp setup-mcp

# Agents must call connect_server(base_url) once per session —
# the base_url is the URL you open Nebula at, e.g. http://localhost:3000

# From a repo checkout instead: build or run the MCP server
npm run mcp:build
npm run mcp
```

## Authentication

Nebula uses TOTP-based two-factor authentication:

1. **First Start**: QR code printed to terminal - scan with authenticator app
2. **Login**: Enter 6-digit code in browser
3. **Trust Browser**: Check option for 30-day sessions

Config stored in `~/.nebula/auth.json`. Multiple servers sharing the same home directory share the same 2FA.

To print the QR code again later (for re-enroll/recovery), run:

```bash
npm run auth:qr
```

### Disable 2FA (local/dev)

Run the server with auth disabled:

```bash
npm run start --noauth
```

You can also use an env var if preferred:

```bash
NO_AUTH=true npm run start
```

### Preserve + Reattach Kernels (dev)

To keep kernels running across dev server restarts and reattach on startup:

```bash
NEBULA_PRESERVE_KERNELS=true NEBULA_REATTACH_KERNELS=true npm run start
```

CLI flags are also supported when running the node server directly:

```bash
cd node-server
npm run dev -- --preserve-kernels --reattach-kernels
```

## Multi-Server Cluster

Run kernels on multiple machines while accessing them from a single UI. Useful for:
- Offloading compute to more powerful servers
- Using different Python environments on different machines
- Distributed team setups with shared filesystem

### Setup

**Main Server** (the one you access in the browser):
```bash
npm run start
```

**Client Server** (additional compute nodes):
```bash
export NEBULA_MAIN_SERVER=http://main-server-hostname:3000
export NEBULA_SERVER_NAME="GPU Server"  # optional display name
npm run start -- --client
```

The client will automatically register with the main server and appear in the kernel menu.

### Usage

1. Click the kernel indicator in the toolbar
2. If multiple servers are registered, a **Server** section appears at the top
3. Select a server to run your kernels on that machine
4. Kernels, interrupt, and restart all work transparently across servers

### Security

For production deployments, set a shared secret on all servers:

```bash
export NEBULA_CLUSTER_SECRET="your-secret-key"
```

If your clients share the same filesystem as the main server, you can also copy `~/.nebula/cluster.json` from the main server instead of setting the env var.

Servers without the correct secret will be rejected during registration.

### Requirements

- All servers must have network access to each other
- Client servers need access to the same filesystem paths as the main server (for notebook files)
- Each server runs its own Jupyter kernels locally

## Tips

**Persistent Terminals**: Access standalone terminals via URL:
```
http://localhost:3000/?terminal=dev
http://localhost:3000/?terminal=logs
```
Terminals persist as long as the server runs. Bookmark different terminals for quick access.

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, CodeMirror
- **Backend**: Node.js, Fastify, ZeroMQ (Jupyter kernel protocol)
- **Auth**: TOTP (otplib), JWT (jsonwebtoken)
- **Agents**: MCP (`nebula-notebook-mcp`), used by Claude Code, Codex, and other agent CLIs

## License

MIT
