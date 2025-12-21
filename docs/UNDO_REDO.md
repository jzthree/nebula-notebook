# Undo/Redo System Architecture

This document explains the design and implementation of the notebook's undo/redo system, including the keyframe pattern, history persistence, and edge case handling.

## Overview

The notebook uses a **dual undo architecture** that separates fine-grained text editing from coarse-grained notebook operations:

| System | Trigger | Scope | Granularity |
|--------|---------|-------|-------------|
| CodeMirror | Keyboard `Ctrl/Cmd+Z` | Per-cell text | Character-level |
| useUndoRedo | Toolbar buttons | Notebook structure | Operation-level |

This separation is intentional—users get fine-grained text editing via keyboard shortcuts and structural notebook changes via toolbar, each at the appropriate granularity level.

## The Keyframe Pattern

### Problem: Tracking Every Keystroke is Expensive

If we tracked every character typed as an operation, we'd have:
- Thousands of operations per editing session
- Huge memory usage
- Slow undo (one character at a time)

### Solution: Keyframes

Instead of tracking every keystroke, we batch content changes between **keyframe events**. A keyframe is a boundary where we capture the current state before proceeding.

**Keyframe events (operations that trigger a flush):**

| Event | Why it's a keyframe |
|-------|---------------------|
| Cell blur (focus leaves editor) | User finished editing, natural boundary |
| Undo/Redo button click | Need current state before applying undo |
| Cell insert/delete/move | Structural change, capture content first |
| Cell type change | Markdown ↔ Code, capture content first |
| Cell execution | Running code, capture content first |
| Save (manual or auto) | Persisting to disk, capture content first |
| First edit after undo | Breaking the redo chain, commit redo history |

### How Flushing Works

```
User types: "hello" → "hello world" → "hello world!"

Timeline:
  t0: Cell created with "hello"
      lastContentRef["cell1"] = "hello"

  t1-t99: User types " world!"
      Content updates in real-time (setCells)
      lastContentRef still = "hello" (unchanged)

  t100: User clicks another cell (blur = keyframe)
      flushCell("cell1", "hello world!")
      Creates op: { oldContent: "hello", newContent: "hello world!" }
      lastContentRef["cell1"] = "hello world!"
```

The flush compares `lastContentRef` (last known state) with current content and creates a single `updateContent` operation capturing all changes since the last keyframe.

## Operation Types

### Undoable Operations

```typescript
type UndoableOperation =
  | { type: 'insertCell'; index: number; cell: Cell }
  | { type: 'deleteCell'; index: number; cell: Cell }
  | { type: 'moveCell'; fromIndex: number; toIndex: number }
  | { type: 'updateContent'; cellId: string; oldContent: string; newContent: string }
  | { type: 'updateContentPatch'; cellId: string; patch: Patch; ... }  // Compact storage
  | { type: 'changeType'; cellId: string; oldType: CellType; newType: CellType }
  | { type: 'batch'; operations: UndoableOperation[] }
```

### Log Operations (Non-undoable)

```typescript
type LogOperation =
  | { type: 'runCell'; cellId: string; cellIndex: number }
  | { type: 'runAllCells'; cellCount: number }
  | { type: 'executionComplete'; cellId: string; cellIndex: number; durationMs: number; success: boolean; output?: string }
  | { type: 'interruptKernel' }
  | { type: 'restartKernel' }
```

### Snapshots

```typescript
type SnapshotOperation = { type: 'snapshot'; cells: Cell[] }
```

A snapshot captures the complete notebook state at a point in time. Used at the start of a session for reconstruction.

### User Operations vs Atomic Operations

The undo/redo system only tracks **atomic operations** (insertCell, deleteCell, moveCell, updateContent, changeType). User-facing keyboard shortcuts are **composite operations** that decompose into these atoms:

| User Action | Keyboard | Atomic Operation(s) |
|-------------|----------|---------------------|
| Cut cell | `X` | Stores in clipboard, then `deleteCell` |
| Copy cell | `C` | Stores in clipboard only (no history entry) |
| Paste cell | `V` | `insertCell` |
| Enqueue cell | `E` | Stores in queue, then `deleteCell` |
| Dequeue cell | `D` | `insertCell` |
| Move cell up/down | `Cmd+Shift+↑/↓` | `moveCell` |

**Key insight:** Cut, copy, paste, enqueue, and dequeue are not visible as distinct operations in the history. The history only sees the underlying atomic operations. For example:

- Cutting a cell records a `deleteCell` operation
- Pasting records an `insertCell` operation
- The clipboard/queue state is ephemeral and not persisted

This means undoing a "paste" will undo the `insertCell`, but the clipboard remains unchanged. Similarly, undoing an "enqueue" restores the deleted cell but doesn't remove it from the queue.

## History Structure

The system maintains three related structures:

```
┌─────────────────────────────────────────────────────────────────┐
│                        fullHistoryRef                           │
│  (Append-only log of ALL operations with timestamps)            │
│  ┌─────────┬─────────┬─────────┬─────────┬─────────┬─────────┐  │
│  │snapshot │ insert  │ update  │  undo   │ update  │  ...    │  │
│  │  t=0    │  t=100  │  t=200  │  t=300  │  t=400  │         │  │
│  └─────────┴─────────┴─────────┴─────────┴─────────┴─────────┘  │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────┐     ┌─────────────────────┐
│     undoStack       │     │     redoStack       │
│  (Operations that   │     │  (Undone operations │
│   can be undone)    │     │   that can be       │
│                     │     │   redone)           │
│  ┌─────────┐        │     │                     │
│  │ insert  │        │     │        (empty)      │
│  ├─────────┤        │     │                     │
│  │ update  │        │     │                     │
│  └─────────┘        │     │                     │
└─────────────────────┘     └─────────────────────┘
```

### Operation Linking for Undo Tracking

Each operation gets a unique `operationId`. When an operation is undone, we record this in history:

```typescript
interface BaseOperation {
  timestamp: number;
  operationId?: string;        // Unique ID for this operation
  isUndo?: boolean;            // True if this is an undo-generated op
  undoesOperationId?: string;  // ID of the operation being undone
}
```

**Example: User inserts cell, then undoes**

```
fullHistoryRef after undo:
[
  { type: 'snapshot', ... },
  { type: 'insertCell', operationId: 'abc123', ... },
  { type: 'deleteCell', operationId: 'def456', isUndo: true, undoesOperationId: 'abc123', ... }
]
```

The undo is recorded as the reverse operation (`deleteCell`) with `isUndo: true` and a link to the original operation.

### Loading History: Filtering Undone Operations

When loading history from persistence, we rebuild the undoStack by filtering out:
1. Operations marked with `isUndo: true`
2. Operations whose `operationId` appears in any `undoesOperationId`

```typescript
const loadHistory = (history: TimestampedOperation[]) => {
  // Build set of undone operation IDs
  const undoneIds = new Set<string>();
  for (const op of history) {
    if (op.isUndo && op.undoesOperationId) {
      undoneIds.add(op.undoesOperationId);
    }
  }

  // Rebuild undoStack excluding undo ops and their targets
  const undoableOps = history.filter(op =>
    !op.isUndo &&
    !(op.operationId && undoneIds.has(op.operationId))
  );

  setUndoStack(undoableOps);
  setRedoStack([]);  // Redo is never restored
};
```

## First Edit After Undo (Breaking the Redo Chain)

When a user undoes an operation, the undone operation moves to the redo stack. If they then make a new edit, we need to:

1. **Commit the redo stack to history** - Record that those operations were "abandoned"
2. **Clear the redo stack** - The new edit creates a new timeline

```
Timeline:
  User types "A"          undoStack: [A]     redoStack: []
  User types "B"          undoStack: [A,B]   redoStack: []
  User clicks Undo        undoStack: [A]     redoStack: [B]
  User types "C"
    → First edit after undo is a KEYFRAME
    → Convert B to history as an undo op
    → Clear redo stack
    → Add C to undo stack
                          undoStack: [A,C]   redoStack: []
```

### Detection: `hasRedoToFlush()`

We use a ref-based check for immediate reads (React state updates are batched):

```typescript
const hasRedoToFlush = useCallback(() => {
  return redoStackRef.current.length > 0;
}, []);
```

In `handleUpdateCell`:
```typescript
const handleUpdateCell = (id: string, content: string) => {
  if (hasRedoToFlush()) {
    flushCell(id, content);  // This clears redo stack
  }
  setCells(prev => prev.map(c => c.id === id ? { ...c, content } : c));
};
```

## Session State Persistence

### Problem: Unflushed Edits Across Reload

When a user is editing a cell and reloads the page:
- The current content is in the DOM/React state
- But `lastContentRef` has the old content (last keyframe)
- After reload, both are reset—the "diff" is lost

### Solution: Persist Unflushed State

We persist the unflushed edit boundary to `.nebula/notebook.session.json`:

```typescript
interface SessionState {
  unflushedEdit?: {
    cellId: string;           // Which cell has unflushed edits
    lastFlushedContent: string; // The content at last keyframe
  };
}
```

**Save (during autosave):**
```typescript
const unflushedState = getUnflushedState(activeCellId, cells);
await saveNotebookSession(fileId, { unflushedEdit: unflushedState });
```

**Load (when opening notebook):**
```typescript
const session = await loadNotebookSession(path);
if (session.unflushedEdit) {
  setUnflushedState(session.unflushedEdit);  // Restore lastContentRef
  setPendingFocus({ cellId, mode: 'editor' }); // Enter edit mode
  scrollToIndex(cellIndex);
}
```

### Why Enter Edit Mode on Restore?

The blur event triggers `flushActiveCell()`. If we don't enter edit mode:
1. The cell isn't focused
2. Clicking another cell doesn't trigger blur on the restored cell
3. The unflushed edits never get flushed

By entering edit mode, we ensure the blur fires when the user moves away.

## React State vs Refs

React batches state updates, which can cause stale reads. We use refs for immediate reads:

```typescript
// State (for React rendering, may be stale in callbacks)
const [undoStack, setUndoStackState] = useState<Operation[]>([]);
const [redoStack, setRedoStackState] = useState<Operation[]>([]);

// Refs (for immediate reads)
const undoStackRef = useRef<Operation[]>([]);
const redoStackRef = useRef<Operation[]>([]);

// Helper that updates both
const setUndoStack = (update) => {
  if (typeof update === 'function') {
    setUndoStackState(prev => {
      const newStack = update(prev);
      undoStackRef.current = newStack;  // Sync ref immediately
      return newStack;
    });
  } else {
    undoStackRef.current = update;
    setUndoStackState(update);
  }
};
```

**Use cases:**
- `peekUndo()` reads from `undoStackRef` to see operations added by `flushCell()` in the same event loop
- `hasRedoToFlush()` reads from `redoStackRef` to detect first edit after undo
- `flushActiveCell()` uses `activeCellIdRef` to get the current active cell

## Autosave Integration

### Blocking Autosave During Undo State

When the redo stack is non-empty (user has undone), autosave is blocked:

```typescript
const { status: autosaveStatus } = useAutosave({
  fileId: currentFileId,
  cells,
  onSave: performSaveToFile,
  hasRedoHistory: canRedo,  // Blocks autosave when true
});
```

**Why?** Autosave would:
1. Trigger a flush (keyframe)
2. Clear the redo stack
3. User loses ability to redo

### Manual Save Confirmation

When manually saving with redo history:
```typescript
const handleManualSave = async () => {
  if (canRedo) {
    const confirmed = await confirm({
      title: 'Save will clear redo history',
      message: 'Saving now will permanently remove your ability to redo...',
    });
    if (!confirmed) return;
  }
  commitHistoryBeforeKeyframe();  // Convert redo to history
  await saveNow();
};
```

## Compact Storage Format

For persistence, `updateContent` operations are converted to patch format:

```typescript
// Before (verbose)
{ type: 'updateContent', oldContent: 'hello', newContent: 'hello world' }

// After (compact)
{ type: 'updateContentPatch', patch: [...], oldHash: 'abc', newHash: 'def' }
```

The patch uses a diff algorithm to store only the changes, reducing storage significantly for large cells.

## Summary of Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Dual undo architecture | Fine-grained text undo (keyboard) + coarse notebook undo (toolbar) |
| Keyframe pattern | Batch content changes, avoid per-keystroke tracking |
| Append-only history | Never modify past entries, link undos via operationId |
| Session state persistence | Preserve unflushed edits across reload without creating keyframes |
| Ref-based immediate reads | Avoid React batching issues in same-event-loop operations |
| Autosave blocking during undo | Prevent accidental loss of redo history |

## File Locations

- `hooks/useUndoRedo.ts` - Core undo/redo logic
- `hooks/useAutosave.ts` - Autosave state machine
- `components/Notebook.tsx` - Integration and keyframe triggers
- `services/fileService.ts` - Session/history persistence API
- `server/fs_service.py` - Backend storage for `.nebula/` files
