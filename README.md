# Nebula Notebook

Nebula is what notebooks should feel like in 2025 — built for what's coming next.

## Quick Start

```bash
git clone https://github.com/jzthree/nebula-notebook.git
cd nebula-notebook
npm install
cd node-server && npm install && cd ..

npm run start
```

On first start, a QR code will appear in the terminal. Scan it with an authenticator app (Google Authenticator, Authy, etc.) to set up 2FA.

Open http://localhost:3000 and enter your 6-digit code.

## Features

**Core**
- Real Jupyter kernel execution (Python, Julia, R, etc.)
- Real filesystem access - open notebooks from anywhere
- Autosave with crash recovery
- Undo/redo with full edit history

**Navigation**
- Table of Contents breadcrumb - auto-generated from markdown headers
- Search & replace across all cells (Cmd/Ctrl+F)
- Keyboard shortcuts (Shift+Enter to run, Cmd+S to save, etc.)

**AI Assistant**
- Multi-provider support: Gemini, OpenAI, Anthropic
- Code generation and error fixing
- Context-aware suggestions

**Editor**
- Syntax highlighting with CodeMirror
- Tab autocomplete for variables
- Auto-indent detection
- Execution queue with status indicators

**UI/UX**
- Virtualized cell list for large notebooks
- Collapsible/resizable outputs
- Sound & browser notifications for long-running cells
- Dark-mode friendly error display

## Prerequisites

- Node.js 18+
- Python 3.10+ with Jupyter kernels (`pip install ipykernel`)

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
└── types.ts
```

## Authentication

Nebula uses TOTP-based two-factor authentication:

1. **First Start**: QR code printed to terminal - scan with authenticator app
2. **Login**: Enter 6-digit code in browser
3. **Trust Browser**: Check option for 30-day sessions

Config stored in `~/.nebula/auth.json`. Multiple servers sharing the same home directory share the same 2FA.

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
npm run start
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

Servers without the correct secret will be rejected during registration.

### Requirements

- All servers must have network access to each other
- Client servers need access to the same filesystem paths as the main server (for notebook files)
- Each server runs its own Jupyter kernels locally

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, CodeMirror
- **Backend**: Node.js, Express, ZeroMQ (Jupyter kernel protocol)
- **Auth**: TOTP (otplib), JWT (jsonwebtoken)
- **AI**: OpenAI, Anthropic, Google GenAI SDKs

## License

MIT
