# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Nebula Notebook is a web-based Jupyter notebook alternative with AI integration. It uses real Jupyter kernels via ZeroMQ, supports multiple LLM providers (Gemini, OpenAI, Anthropic), and provides real filesystem access. The backend is Node.js/TypeScript with Express, communicating with Jupyter kernels via the ZeroMQ protocol.

## Development Commands

```bash
# Install dependencies
npm install                    # Frontend + backend dependencies
cd node-server && npm install  # Backend dependencies

# Run the application
npm run dev                    # Development mode with hot reload (Vite on :3000, Node on :8000)
npm run start                  # Alias for npm run dev
npm run prod                   # Production mode (Node.js on :3000 only)

# Build
npm run build                  # Production build (frontend + backend)
npm run preview                # Preview production build

# Testing
npm test                       # Run all frontend tests (vitest)
npm test -- --watch            # Watch mode for TDD
cd node-server && npm test     # Run backend tests
```

## Architecture

### Frontend (React 19 + TypeScript + Vite)

**Core Notebook Components:**
- `components/Notebook.tsx` - Main notebook container: multi-tab management, file I/O, kernel sessions, undo/redo, search, inline rename
- `components/Cell.tsx` - Individual cell: execution controls, AI generation, queue position, output scrolling
- `components/CodeEditor.tsx` - CodeMirror 6 editor: syntax highlighting, kernel-based completion, indentation detection
- `components/CellOutput.tsx` - Output rendering: stdout/stderr/error/HTML/image, truncation, resizable collapsed state
- `components/VirtualCellList.tsx` - React Virtuoso for large notebook performance (1000px overscan)

**Dashboard & File Browser:**
- `components/Dashboard.tsx` - Landing page: recent notebooks, file browser, active kernels, terminals, tips
- `components/FileBrowser.tsx` - File/folder browser: sidebar and inline variants, create/delete/rename/upload/download
- `components/FileListItem.tsx` - File list item: icons, metadata, inline rename, context actions

**Terminal:**
- `components/TerminalPage.tsx` - Full-screen terminal with persistent named terminals
- `components/TerminalInstance.tsx` - xterm.js integration with WebSocket PTY connection
- `components/TerminalPanel.tsx` - Embedded terminal panel in notebook view

**AI & Chat:**
- `components/AIChatSidebar.tsx` - AI assistant: full notebook context, multi-message history, image support

**Utilities & Dialogs:**
- `components/SettingsModal.tsx` - Settings: General, AI, Appearance, Notifications tabs
- `components/KernelManager.tsx` - Kernel management: list sessions, memory usage, interrupt/restart
- `components/HistoryPanel.tsx` - Notebook history: timeline view, preview, restore to any point
- `components/NotebookSearch.tsx` - Find & replace: regex, case-sensitive, navigate matches
- `components/AuthGate.tsx` / `TOTPLogin.tsx` - 2FA authentication

**Services:**
- `services/kernelService.ts` - Multi-session kernel management, WebSocket streaming, code completion
- `services/fileService.ts` - Filesystem operations, notebook I/O, history/session persistence
- `services/llmService.ts` - Multi-provider LLM client (Google, OpenAI, Anthropic)
- `services/authService.ts` - JWT token management for 2FA
- `services/terminalService.ts` - Terminal session management
- `services/clusterService.ts` - Multi-server clustering support

**Hooks:**
- `hooks/useUndoRedo.ts` - Operation-based notebook history (insert/delete/move/update cells)
- `hooks/useAutosave.ts` - Debounced autosave (1s) with conflict detection
- `hooks/useConflictResolution.ts` - mtime-based conflict handling

**Utilities:**
- `utils/notebookAvatar.ts` - Deterministic notebook avatars
- `utils/indentationDetector.ts` - Auto-detect code indentation
- `lib/notebookOperations.ts` - Pure functions for notebook state
- `lib/diffUtils.ts` - Diff and patch utilities

### Backend (Node.js + TypeScript + Express)

**Entry & Config:**
- `node-server/src/index.ts` - Express server, WebSocket setup, auth initialization

**Routes:**
- `routes/auth.ts` - 2FA authentication endpoints
- `routes/kernel.ts` - Kernel session management and WebSocket
- `routes/notebook.ts` - Notebook cells, history, session, agent permissions
- `routes/fs.ts` - Filesystem operations (list, read, write, rename, delete, upload, download)
- `routes/llm.ts` - LLM generation endpoints
- `routes/python.ts` - Python environment discovery
- `routes/cluster.ts` - Multi-server clustering

**Services:**
- `kernel/kernel-service.ts` - Jupyter kernel management via ZeroMQ
- `kernel/kernelspec.ts` - Kernel discovery
- `fs/fs-service.ts` - Filesystem operations, notebook I/O, metadata preservation
- `llm/llm-service.ts` - Multi-provider LLM abstraction
- `auth/auth-service.ts` - TOTP 2FA and JWT management
- `auth/auth-middleware.ts` - Route and WebSocket authentication
- `terminal/pty-manager.ts` - PTY session management
- `discovery/discovery-service.ts` - Python environment discovery

## Key API Endpoints

**Authentication** (unprotected)
- `GET /api/auth/status` - Check 2FA config and auth status
- `POST /api/auth/verify` - Verify TOTP code, get JWT token

**Kernels** (protected)
- `GET /api/kernels` - List available kernelspecs
- `POST /api/kernels/start` - Start kernel session
- `POST /api/kernels/for-file` - Get or create kernel for notebook (one notebook = one kernel)
- `WS /api/kernels/{id}/ws` - WebSocket for kernel I/O and completion
- `POST /api/kernels/{id}/interrupt` - Interrupt execution
- `POST /api/kernels/{id}/restart` - Restart kernel
- `GET /api/kernels/sessions` - List active sessions with memory usage

**Notebook** (protected)
- `GET /api/notebook/cells` - Get cells + kernelspec + mtime
- `POST /api/notebook/save` - Save notebook cells
- `GET/POST /api/notebook/history` - Load/save operation history
- `GET/POST /api/notebook/session` - Load/save editing state
- `GET /api/notebook/agent-status` - Check agent permissions
- `POST /api/notebook/permit-agent` - Grant/revoke agent access
- `WS /api/notebook/{path}/ws` - Real-time notebook sync

**Filesystem** (protected)
- `GET /api/fs/list` - List directory contents
- `GET /api/fs/read` - Read file contents
- `GET /api/fs/download` - Download file (raw stream)
- `POST /api/fs/write` - Write file
- `POST /api/fs/create` - Create file or folder
- `DELETE /api/fs/delete` - Delete file or folder
- `POST /api/fs/rename` - Rename/move (handles notebook metadata files)
- `POST /api/fs/duplicate` - Duplicate file or folder
- `POST /api/fs/upload` - Upload file (multipart)

**Terminals** (protected)
- `GET /api/terminals` - List terminals
- `POST /api/terminals` - Create terminal
- `POST /api/terminals/named/{name}` - Get or create named terminal
- `WS /api/terminals/{id}/ws` - WebSocket for terminal I/O

**LLM** (protected)
- `POST /api/llm/generate` - Generate text
- `POST /api/llm/generate-structured` - Generate JSON (code + explanation + action)
- `POST /api/llm/chat` - Chat with notebook context

**Python Discovery** (protected)
- `GET /api/python/environments` - List Python envs and kernelspecs
- `POST /api/python/install-kernel` - Register Python env as kernel

## URL Parameters

- `?file=<path>` - Open notebook file directly
- `?terminal=<name>` - Open persistent named terminal

## Configuration

- Frontend dev server proxies `/api/*` to backend (configured in `vite.config.ts`)
- 2FA config stored in `~/.nebula/auth.json` (mode 0600)
- Notebook history/session stored in `.nebula/` directory alongside notebooks
- TypeScript paths: `@/*` maps to project root

### Settings (localStorage)
```typescript
interface NebulaSettings {
  rootDirectory: string;
  llmProvider: 'google' | 'openai' | 'anthropic';
  llmModel: string;
  lastKernel: string;
  notifyOnLongRun?: boolean;
  notifyThresholdSeconds?: number;
  notifySoundEnabled?: boolean;
  indentation?: 'auto' | '2' | '4' | '8' | 'tab';
  showLineNumbers?: boolean;
  showCellIds?: boolean;
  apiKeys?: { google?, openai?, anthropic? };
}
```

## Authentication (2FA)

Nebula uses TOTP-based two-factor authentication:

1. **First Start**: Server prints QR code to terminal. Scan with authenticator app.
2. **Login**: Enter 6-digit code in the UI
3. **Trust Browser**: Check "Trust this browser" for 30-day sessions (vs 24 hours)
4. **Rate Limiting**: 5 attempts per 30 seconds

Config file: `~/.nebula/auth.json` contains the TOTP secret.

## Keyboard Shortcuts

The notebook supports Jupyter-style keyboard shortcuts with two modes:
- **Edit Mode** (blue border): Cursor in editor
- **Cell Mode** (green border): Press Escape to enter

### Edit Mode (blue border)
| Shortcut | Action |
|----------|--------|
| `Shift+Enter` | Run cell and advance to next |
| `Ctrl/Cmd+Enter` | Run current cell only |
| `Escape` | Exit to cell mode |
| `Ctrl/Cmd+Z` / `Y` | Undo / Redo (text only) |

### Cell Mode (green border, press Escape to enter)
| Shortcut | Action |
|----------|--------|
| `Enter` | Enter edit mode |
| `A` / `B` | Insert cell above / below |
| `M` / `Y` | Convert to Markdown / Code |
| `X` / `C` / `V` | Cut / Copy / Paste cell |
| `Shift+V` | Paste cell above |
| `E` / `D` | Enqueue / Dequeue cell for batch execution |
| `Delete/Backspace` | Delete cell |
| `Arrow Up/Down` | Navigate between cells |
| `Ctrl/Cmd+Shift+↑/↓` | Move cell up / down |

### Global
| Shortcut | Action |
|----------|--------|
| `Ctrl/Cmd+S` | Save notebook |
| `Ctrl/Cmd+F` | Open search |
| `Ctrl/Cmd+C` | Interrupt kernel (when busy) |
| `Ctrl+\`` | Toggle integrated terminal |

## Key Features

### Cell Execution Queue
- Press `E` in cell mode to enqueue cells for batch execution
- Press `D` to dequeue
- FIFO execution order with queue position display

### History & Session
- Full operation history persisted to `.nebula/` directory
- Restore notebook to any point in history via History panel
- Session state preserved: active cell, unflushed edits

### File Browser
- Sidebar variant (notebook view) and inline variant (dashboard)
- Create/rename/duplicate/delete files and folders
- Drag-and-drop upload
- Filter to notebooks only (preference persisted)
- Inline rename by clicking filename

### Terminals
- Integrated terminal panel (`Ctrl+\``)
- Persistent named terminals via `?terminal=name` URL
- Multiple tabs can share same terminal session

### AI Integration
- Chat sidebar with full notebook context
- Cell generation from prompts
- Error fixing suggestions
- Multi-provider support (Gemini, OpenAI, Anthropic)

### MCP Server
Nebula includes an MCP server for AI agent integration, enabling agents to:
- Run code in notebooks
- Analyze data
- Execute notebook operations headlessly

## Undo/Redo System

Nebula uses a **dual undo/redo architecture**:

### 1. Text-Level Undo (CodeMirror)
- `Ctrl/Cmd+Z` / `Shift+Z` in edit mode
- Character-level undo per cell

### 2. Notebook-Level Undo (useUndoRedo hook)
- Toolbar Undo/Redo buttons
- Operations: insert/delete/move cells, type changes, metadata changes
- Full operation log with timestamps for session replay

### Operation Types
```typescript
type UndoableOperation =
  | { type: 'insertCell'; index: number; cell: Cell }
  | { type: 'deleteCell'; index: number; cell: Cell }
  | { type: 'moveCell'; fromIndex: number; toIndex: number }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string }
  | { type: 'updateMetadata'; cellId: string; changes: MetadataChanges }
  | { type: 'batch'; operations: UndoableOperation[] };
```

## Performance

- **Virtualization**: React Virtuoso renders only visible cells
- **Autosave**: 1-second debounce with conflict detection
- **Output Truncation**: Large outputs truncated for display (data preserved)

## Metadata Preservation

Cell metadata is preserved across load/save:
- `nebula_id`: Internal cell ID for history tracking
- `scrolled`: Jupyter-standard collapsed output state
- `_metadata`: Unknown metadata from external tools preserved

## Test Locations

- Frontend: `components/__tests__/`, `hooks/__tests__/`, `services/__tests__/`, `lib/__tests__/`
- Backend: `node-server/src/__tests__/`
- Framework: Vitest

## TDD Workflow (Required)

1. Write failing tests first
2. Run tests to confirm they fail
3. Implement minimum code to pass
4. Run tests to confirm they pass
5. Refactor while keeping tests green
6. Commit when tests pass
