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
- `components/Notebook.tsx` - Main notebook component: file management, kernel sessions, cell state, execution queue, autosave
- `components/Cell.tsx` - Individual cell editor with execution controls and keyboard shortcuts
- `components/CodeEditor.tsx` - CodeMirror 6 editor with syntax highlighting
- `components/VirtualCellList.tsx` - React Virtuoso for large notebook performance
- `components/AIChatSidebar.tsx` - AI chat interface (per-notebook instance)
- `components/ErrorBoundary.tsx` - React error boundary for graceful error handling
- `services/kernelService.ts` - Multi-session kernel management, WebSocket handling
- `services/llmService.ts` - Multi-provider LLM client (Gemini, OpenAI, Anthropic)
- `services/fileService.ts` - Filesystem operations
- `hooks/useAutosave.ts` - Debounced autosave (1s) with localStorage crash recovery
- `hooks/useUndoRedo.ts` - Cell state history management
- `types.ts` - Core types: `Cell`, `Tab`, `NotebookState`, `KernelStatus`

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

### TDD (Test-Driven Development) - REQUIRED

**IMPORTANT:** Always follow TDD when making changes that alter or add functionality. This is non-negotiable for maintaining code quality.

**TDD Workflow:**
1. **Write failing tests first** - Before writing any implementation code, write tests that define the expected behavior
2. **Run tests to confirm they fail** - Verify the tests fail for the right reason (not due to syntax errors)
3. **Implement minimum code to pass** - Write only enough code to make the tests pass
4. **Run tests to confirm they pass** - All tests (new and existing) must be green
5. **Refactor while keeping tests green** - Clean up the code while ensuring tests continue to pass
6. **Commit when tests pass** - Make atomic commits with passing tests

**When to Write Tests:**
- Adding new features or components
- Fixing bugs (write a test that reproduces the bug first)
- Modifying existing behavior
- Integrating components together
- Adding new props, handlers, or callbacks

**Test Commands:**
```bash
npm test              # Run all frontend tests (vitest)
npm test -- --watch   # Watch mode for TDD
cd server && pytest   # Run backend tests
```

### Test Locations
- Backend: `server/tests/` (pytest)
- Frontend: `__tests__/` directories alongside components (vitest)

### Git Commits
- Make commits periodically after completing logical units of work
- Each commit should have passing tests
- Use conventional commit messages: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`

## Keyboard Shortcuts

The notebook supports Jupyter-style keyboard shortcuts with two modes:
- **Edit Mode**: When editing a cell (cursor in editor)
- **Command Mode**: When not editing (click outside cell or press Escape)

### Cell Execution (Edit Mode)
| Shortcut | Action |
|----------|--------|
| `Shift+Enter` | Run cell and advance to next (creates new cell if at end) |
| `Ctrl/Cmd+Enter` | Run current cell only |
| `Escape` | Exit edit mode (enter command mode) |

### Cell Mode (green border, when not editing)
| Shortcut | Action |
|----------|--------|
| `Enter` | Enter edit mode (focus cell editor) |
| `A` / `B` | Insert new cell above / below current |
| `M` / `Y` | Convert cell to Markdown / Code |
| `X` / `C` / `V` | Cut / Copy / Paste cell |
| `Shift+V` | Paste cell above |
| `E` / `D` | Enqueue / Dequeue cell (FIFO queue) |
| `Delete/Backspace` | Delete active cell |
| `Arrow Up/Down` | Navigate between cells |
| `Ctrl/Cmd+Shift+↑/↓` | Move cell up / down |

### Edit Mode (blue border, when editing)
| Shortcut | Action |
|----------|--------|
| `Escape` | Exit to cell mode |
| `Ctrl/Cmd+Z` / `Y` | Undo / Redo (text only, per-cell) |

### Global (works everywhere)
| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+S` | Save notebook |
| `Ctrl/Cmd+F` | Open search |
| `Ctrl/Cmd+C` | Interrupt kernel (when busy, otherwise copy) |
| `Shift+Enter` | Run cell and advance |
| `Ctrl/Cmd+Enter` | Run cell |