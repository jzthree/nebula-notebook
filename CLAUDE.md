# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nebula Notebook is a web-based Jupyter notebook alternative with AI integration. It uses real Jupyter kernels, supports multiple LLM providers (Gemini, OpenAI, Anthropic), and provides real filesystem access.

## Development Commands

```bash
# Install dependencies
npm install                    # Frontend
cd server && pip install -r requirements.txt  # Backend

# Run the application
npm run start                  # Start both frontend and backend concurrently
npm run dev                    # Frontend only (Vite, port 3000)
npm run server                 # Backend only (FastAPI with hot reload, port 8000)

# Build
npm run build                  # Production build
npm run preview                # Preview production build
```

## Architecture

**Frontend (React 19 + TypeScript + Vite)**
- `components/Notebook.tsx` - Main orchestrator: cell state management, kernel lifecycle, autosave coordination
- `components/Cell.tsx` - Individual cell editor with execution controls
- `components/VirtualCellList.tsx` - React Virtuoso for large notebook performance
- `components/AIChatSidebar.tsx` - AI chat interface for code generation and analysis
- `services/kernelService.ts` - Kernel management, WebSocket handling, Python environment discovery
- `services/llmService.ts` - Multi-provider LLM client (Gemini, OpenAI, Anthropic)
- `services/fileService.ts` - Filesystem operations
- `hooks/useAutosave.ts` - Debounced autosave (1s) with localStorage crash recovery
- `hooks/useUndoRedo.ts` - Cell state history management
- `types.ts` - Core types: `Cell`, `CellOutput`, `NotebookMetadata`

**Backend (Python + FastAPI)**
- `server/main.py` - API endpoints and WebSocket handlers
- `server/kernel_service.py` - Jupyter kernel session management
- `server/llm_service.py` - LLM provider abstraction layer
- `server/fs_service.py` - Filesystem operations (read/write/list)
- `server/python_discovery.py` - VS Code-style Python environment detection (system, conda, pyenv, venv, homebrew)

**Communication Pattern**
- REST API for CRUD operations
- WebSocket (`/api/kernels/{session_id}/ws`) for streaming kernel output during execution

## Key API Endpoints

- `GET /api/kernels` - List available kernelspecs
- `POST /api/kernels/start` - Start a kernel session
- `WS /api/kernels/{session_id}/ws` - Stream execution output
- `POST /api/python/environments` - Discover Python environments
- `POST /api/generate` - LLM code generation
- `POST /api/chat` - LLM chat/analysis
- `/api/fs/*` - Filesystem operations

## Configuration

- Frontend dev server proxies `/api/*` to backend (configured in `vite.config.ts`)
- Environment variables in `server/.env` (copy from `server/.env.example`)
- Required: At least one LLM API key (GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY)
- TypeScript paths: `@/*` maps to project root

## Feature Development Workflow

### Git Branching
- Create feature branch: `git checkout -b feature/<feature-name>`
- Commit after each logical unit of work
- Use conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`

### TDD (Test-Driven Development)
1. Write failing tests first
2. Implement minimum code to pass
3. Refactor while keeping tests green
4. Commit when tests pass

### Test Locations
- Backend: `server/tests/` (pytest)
- Frontend: `__tests__/` directories alongside components (vitest)
