# Nebula Notebook

A modern, web-based computational notebook with real Jupyter kernels, AI assistance, and a clean interface.

## Quick Start

```bash
git clone https://github.com/jzthree/nebula-notebook.git
cd nebula-notebook
npm install
cd server && pip install -r requirements.txt && cd ..

# Configure API keys (optional, for AI features)
cp server/.env.example server/.env
# Edit server/.env with your API keys

npm run start
```

Open http://localhost:3000

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
- Python 3.10+
- Jupyter kernels (`pip install ipykernel`)

## Project Structure

```
nebula-notebook/
├── components/       # React components
├── hooks/            # Custom React hooks
├── lib/              # Core utilities (diff, operations)
├── services/         # Frontend API clients
├── server/           # Python FastAPI backend
│   ├── main.py
│   ├── kernel_service.py
│   ├── llm_service.py
│   └── fs_service.py
└── types.ts
```

## Tech Stack

- **Frontend**: React 19, TypeScript, Vite, Tailwind CSS, CodeMirror
- **Backend**: FastAPI, jupyter_client
- **AI**: OpenAI, Anthropic, Google GenAI SDKs

## License

MIT
