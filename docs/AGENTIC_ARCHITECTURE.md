# Agentic Architecture

This document describes Nebula Notebook's agentic system - how AI agents interact with notebooks programmatically while maintaining consistency with the UI.

## Overview

The agentic system enables AI agents (MCP clients, CLI tools) to manipulate notebooks through a unified API. The key innovation is the **Operation Router** pattern, which transparently routes operations to either the UI (when connected) or a headless file handler (when not).

```
                                    ┌─────────────────────┐
                                    │   Nebula UI (React) │
                                    │                     │
                                    │  useOperationHandler│◄──── Ground truth
                                    │     (WebSocket)     │       when connected
                                    └──────────┬──────────┘
                                               │
┌──────────────────┐    ┌──────────────────┐   │
│  AI Agent (MCP)  │───►│   NebulaClient   │   │
│  Claude Desktop  │    │  (TypeScript)    │   │
│  Cursor, etc.    │    └────────┬─────────┘   │
└──────────────────┘             │             │
                                 ▼             │
                    ┌────────────────────────┐ │
                    │   POST /api/notebook/  │ │
                    │       operation        │ │
                    └────────────┬───────────┘ │
                                 │             │
                                 ▼             │
                    ┌────────────────────────┐ │
                    │    Operation Router    │◄┘
                    │       (Python)         │
                    └──────┬─────────┬───────┘
                           │         │
              UI connected │         │ No UI
                           ▼         ▼
                    ┌─────────┐ ┌─────────────────┐
                    │WebSocket│ │HeadlessOperation│
                    │ to UI   │ │    Handler      │◄──── Ground truth
                    └─────────┘ └─────────────────┘       when no UI
                                         │
                                         ▼
                                   ┌──────────┐
                                   │  .ipynb  │
                                   │   File   │
                                   └──────────┘
```

## Core Concepts

### 1. Operation-Based API

All notebook mutations go through typed operations. This provides:
- **Consistency**: Same operation format for UI, agents, and file operations
- **Auditability**: Operations can be logged, replayed, or undone
- **Validation**: Schema-driven validation before applying changes

```typescript
// Example operations
interface InsertCellOp {
  type: 'insertCell';
  notebookPath: string;
  index: number;
  cell: { id: string; type: 'code' | 'markdown'; content: string };
}

interface UpdateContentOp {
  type: 'updateContent';
  notebookPath: string;
  cellId: string;
  content: string;
}
```

### 2. Dual-Mode Operation

The system operates in two modes depending on UI presence:

| Aspect | UI Mode | Headless Mode |
|--------|---------|---------------|
| **Ground Truth** | React state | In-memory cache |
| **Persistence** | UI handles autosave | Async write-back |
| **Real-time** | Yes (WebSocket) | N/A |
| **Session Indicator** | Shown in UI | N/A |

**Key insight**: From the agent's perspective, both modes are identical. The agent calls `client.insertCellOp()` and doesn't need to know which mode is active.

### 3. Agent Sessions

Agent sessions provide UI feedback and prevent concurrent agent access:

```typescript
// Start session - shows "locked" indicator in UI
await client.startAgentSession(path, 'my-agent');

// ... perform operations ...

// End session - clears indicator
await client.endAgentSession(path);
```

In headless mode, session operations are no-ops (succeed but do nothing).

## Component Reference

### NebulaClient (`nebula-tools/src/notebook/client.ts`)

TypeScript client for programmatic notebook access. Used by:
- MCP server for Claude Desktop/Cursor integration
- CLI tools for scripting
- Test automation

**Key methods:**

| Method | Description |
|--------|-------------|
| `insertCellOp()` | Insert a cell at position |
| `deleteCellOp()` | Delete cell by ID or index |
| `updateContentOp()` | Update cell content |
| `executeCell()` | Execute cell with WebSocket streaming |
| `readNotebookViaRouter()` | Read notebook (UI state or file) |
| `startAgentSession()` | Lock notebook for agent use |
| `endAgentSession()` | Unlock notebook |

### Operation Router (`server/main.py`)

Python backend that routes operations to UI or headless handler:

```python
@app.post("/api/notebook/operation")
async def apply_operation(request: OperationRequest):
    path = request.operation.get('notebookPath')

    # Check if UI is connected for this notebook
    if path in notebook_connections:
        # Route to UI via WebSocket
        return await forward_to_ui(path, request.operation)
    else:
        # Handle headlessly
        return await headless_handler.apply_operation(request.operation)
```

### useOperationHandler (`hooks/useOperationHandler.ts`)

React hook that receives and applies operations from agents:

1. Connects WebSocket to `/api/notebook/{path}/ws`
2. Receives operations from backend
3. Applies to React state (insertCell, deleteCell, etc.)
4. Sends result back to backend
5. Updates UI indicators (agent session badge, toasts)

### HeadlessOperationHandler (`server/headless_handler.py`)

File-based operation handler for when no UI is connected:

1. Loads notebook from disk on first access (cached)
2. Applies operations to in-memory cache
3. Persists to disk asynchronously (write-back pattern)
4. Supports all operation types

**Write-back caching**:
```python
# Cache structure: path -> {cells, metadata, dirty}
self._cache[path] = {
    'cells': [...],
    'metadata': {...},
    'dirty': True  # Needs persistence
}

# After operation, schedule async write
self._schedule_persist(notebook_path)
```

## Operation Types

### Cell Operations

| Operation | Description | Fields |
|-----------|-------------|--------|
| `insertCell` | Insert new cell | `index`, `cell` |
| `deleteCell` | Remove cell | `cellId` or `cellIndex` |
| `updateContent` | Change cell content | `cellId`, `content` |
| `updateMetadata` | Change cell metadata | `cellId`, `changes` |
| `moveCell` | Reorder cell | `fromIndex`, `toIndex` |
| `duplicateCell` | Copy cell | `cellIndex`, `newCellId` |
| `updateOutputs` | Set execution outputs | `cellId`, `outputs`, `executionCount` |

### Notebook Operations

| Operation | Description | Fields |
|-----------|-------------|--------|
| `createNotebook` | Create new notebook | `notebookPath`, `overwrite`, `kernelName` |
| `clearNotebook` | Delete all cells | (none) |

### Read Operations

| Operation | Description | Fields |
|-----------|-------------|--------|
| `readCell` | Get single cell | `cellId` or `cellIndex` |
| `readCellOutput` | Get cell outputs | `cellId` or `cellIndex` |

### Session Operations

| Operation | Description | Fields |
|-----------|-------------|--------|
| `startAgentSession` | Lock for agent | `agentId` (optional) |
| `endAgentSession` | Unlock | (none) |

## Data Flow Examples

### Example 1: Agent Inserts Cell (UI Connected)

```
1. Agent: client.insertCellOp(path, 0, cell)
2. Client: POST /api/notebook/operation
3. Router: Notebook has UI connection? Yes
4. Router: Forward via WebSocket to UI
5. UI (useOperationHandler): Receive operation
6. UI: insertCell(0, cell) - updates React state
7. UI: Send result back via WebSocket
8. Router: Return result to client
9. Agent: Receives { success: true, cellId: '...', cellIndex: 0 }
10. UI: Autosave triggers (debounced)
```

### Example 2: Agent Inserts Cell (Headless)

```
1. Agent: client.insertCellOp(path, 0, cell)
2. Client: POST /api/notebook/operation
3. Router: Notebook has UI connection? No
4. Router: headless_handler.apply_operation(op)
5. Handler: Load notebook from disk (if not cached)
6. Handler: Insert cell into cache
7. Handler: Mark dirty, schedule async persist
8. Handler: Return result immediately
9. Agent: Receives { success: true, cellId: '...', cellIndex: 0 }
10. Handler: (background) Write to disk
```

### Example 3: Execute Cell with Output Streaming

```
1. Agent: client.executeCell(path, sessionId, { cellIndex: 0 })
2. Client: Read cell via router (gets content)
3. Client: Connect WebSocket to /api/kernels/{sessionId}/ws
4. Client: Send { type: 'execute', code: cellContent }
5. Kernel: Execute, stream outputs
6. Client: Receive outputs, periodically call updateOutputsOp()
7. (Operations routed to UI or headless as above)
8. Kernel: Complete, send status: idle
9. Client: Final updateOutputsOp() with executionCount
10. Agent: Receives ExecutionResult with all outputs
```

## UI Integration

### Agent Session Indicator

When an agent session is active, the UI shows:

```tsx
{agentSession && (
  <span className="text-purple-800 bg-purple-200 border border-purple-300">
    <Bot className="animate-pulse" />
    <span>Agent</span>
  </span>
)}
```

### Toast Notifications

Operations trigger toast notifications:

```typescript
onAgentOperation: (operation, result) => {
  if (operation.type === 'startAgentSession') {
    toast('Agent session started', 'info');
  }
  if (operation.type === 'insertCell') {
    toast(`Agent inserted cell at position ${result.cellIndex}`, 'info');
  }
  // ...
}
```

## Error Handling

### ID Conflict Resolution

When inserting a cell with duplicate ID:

```typescript
// Agent requests ID "cell-1" but it exists
const result = await client.insertCellOp(path, 0, {
  id: 'cell-1',
  type: 'code',
  content: '# Hello'
});

// Result: ID auto-fixed
{
  success: true,
  cellId: 'cell-1-2',      // Modified ID
  idModified: true,
  requestedId: 'cell-1'    // Original request
}
```

### Metadata Validation

Metadata changes are validated against schema:

```typescript
// Invalid metadata rejected
await client.updateMetadataOp(path, cellId, {
  scrolled: 'not-a-boolean'  // Error: must be boolean
});
// Returns { success: false, error: 'scrolled must be boolean' }
```

### Operation Failures

Failed operations return descriptive errors:

```typescript
{
  success: false,
  error: 'Cell with ID "xyz" not found'
}
```

## Best Practices

### 1. Always Use Sessions

```typescript
// Good: Session provides UI feedback
await client.startAgentSession(path, 'my-agent');
try {
  // ... operations ...
} finally {
  await client.endAgentSession(path);
}
```

### 2. Prefer Cell IDs Over Indices

```typescript
// Good: IDs are stable across edits
await client.updateContentOp(path, 'my-cell-id', content);

// Risky: Index may change if cells added/removed
await client.deleteCellOp(path, { cellIndex: 3 });
```

### 3. Handle ID Conflicts

```typescript
const result = await client.insertCellOp(path, 0, cell);
if (result.data?.idModified) {
  // Update your reference to use the actual ID
  actualId = result.data.cellId;
}
```

### 4. Use Streaming for Long Executions

```typescript
// Good: Streaming provides real-time output
await client.executeCell(path, sessionId, {
  cellIndex: 0,
  timeout: 120000,  // 2 minutes
  save: true        // Auto-save outputs
});
```

## Testing

### Manual Testing with Demo Script

```bash
cd nebula-tools
npm run build
node demo-physics-tools.js
```

This creates a physics notebook demonstrating all operation types.

### Headless vs UI Testing

1. **With UI**: Open notebook in browser, run demo - watch UI update live
2. **Without UI**: Close browser, run demo - check file changes

### WebSocket Testing

Monitor WebSocket traffic in browser DevTools:
- Network tab > WS filter
- Look for `/api/notebook/{path}/ws`
- Messages show operation routing

## Troubleshooting

### Operations Not Reflected in UI

1. Check WebSocket connection (browser DevTools > Network > WS)
2. Verify correct notebook path
3. Check backend logs for routing decisions

### Headless Writes Not Persisted

1. Check `headless_handler.is_dirty(path)` status
2. Call `await headless_handler.flush(path)` explicitly
3. Check file permissions

### Session Not Clearing

1. Ensure `endAgentSession()` is called (use try/finally)
2. Check for ref/state sync issues (see `agentSessionRef` pattern)

## Future Considerations

### History Parity (Not Yet Implemented)

UI mode maintains full operation history for undo/redo and session replay. Headless mode currently only persists final state. Adding history to headless mode would enable:

- Session replay from headless runs
- Training data collection
- Debugging agent behavior

### Multi-Agent Coordination

Current design assumes single agent per notebook. Multi-agent would require:
- Operation sequencing/locking
- Conflict resolution beyond ID deduplication
- Session hierarchy or namespacing

## Related Documentation

- [API.md](./API.md) - REST API reference
- [WEBSOCKET_PROTOCOL.md](./WEBSOCKET_PROTOCOL.md) - WebSocket message formats
- [UNDO_REDO.md](./UNDO_REDO.md) - History and undo system
- [nebula-tools README](../../nebula-tools/README.md) - MCP server setup
