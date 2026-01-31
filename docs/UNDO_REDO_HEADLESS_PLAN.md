# Undo/Redo System: Headless Backend Integration Plan

## Overview

Integrate the undo/redo system into the headless backend to achieve feature parity with the UI, enabling MCP agents to have full undo/redo capabilities.

## Implementation Status

| Phase | Description | Status |
|-------|-------------|--------|
| 1 | Patch-in-memory optimization | ✅ Complete |
| 2 | Extract core library | ✅ Complete |
| 3 | React hook wrapper | ✅ Complete |
| 4 | Headless backend integration | 🔲 Not started |
| 5 | MCP operation parity | 🔲 Not started |
| 6 | Testing & verification | 🔲 Not started |

## Current State

| Component | UI | Headless |
|-----------|:--:|:--------:|
| Operation execution | ✅ | ✅ |
| Undo/redo stacks | ✅ | ❌ |
| History persistence | ✅ | ❌ |
| State reconstruction | ✅ | ❌ |
| Agent session locking | N/A | ✅ |

## Design Decisions

### 1. Patches Everywhere (Memory Optimization)

**Decision**: Store patches in memory, not just on disk.

**Current flow:**
```
Edit → updateContent (full content) → save → convertToCompactFormat → updateContentPatch (patch)
```

**New flow:**
```
Edit → updateContentPatch (patch) → save → (no conversion needed)
```

**Benefits:**
- Memory scales with edit size, not content size
- Consistent format: memory = disk = loaded
- No conversion step on save
- Better scalability for long editing sessions

**Implementation:**
- Modify `flushCell()` to compute patch immediately
- Remove `convertToCompactFormat()` conversion for `updateContent`
- Keep `lastContentRef` for computing deltas (O(cells), not O(operations))

### 2. Shared Core Library

**Decision**: Extract framework-agnostic core from `useUndoRedo.ts`.

```
lib/undoRedoCore.ts          ← Pure functions, no React
  ↑                ↑
hooks/useUndoRedo.ts    node-server/notebook/undoRedoManager.ts
  (React wrapper)              (Headless wrapper)
```

### 3. Operation Format

Keep current operation types, no changes:
- `insertCell`, `deleteCell`, `moveCell`
- `updateContentPatch` (replacing `updateContent` in memory)
- `updateMetadata`, `batch`
- Log operations: `runCell`, `executionComplete`, etc.

---

## Implementation Phases

### Phase 1: Patch-in-Memory Optimization ✅ COMPLETE

**Files:** `hooks/useUndoRedo.ts`

**Status:** Implemented. `flushCell()` and `updateContent()` now compute patches immediately instead of storing full content. Memory scales with edit size, not content size.

**Changes:**

1. **Modify `flushCell()`** - Compute patch immediately
   ```typescript
   const flushCell = useCallback((cellId: string, currentContent: string) => {
     const oldContent = lastContentRef.current.get(cellId);
     if (oldContent === undefined || oldContent === currentContent) return;

     const diff = createDiff(oldContent, currentContent);
     const patch = diffToPatch(oldContent, diff);

     executeOperation({
       type: 'updateContentPatch',
       cellId,
       patch,
       oldHash: hashText(oldContent),
       newHash: hashText(currentContent),
     });

     lastContentRef.current.set(cellId, currentContent);
   }, [executeOperation]);
   ```

2. **Simplify `getFullHistory()`** - Remove `updateContent` → patch conversion
   ```typescript
   const getFullHistory = useCallback((): TimestampedOperation[] => {
     return fullHistoryRef.current.map(op => {
       // Only strip outputs, no content conversion needed
       if (op.type === 'snapshot') {
         return { ...op, cells: op.cells.map(stripCellOutputs) };
       }
       if (op.type === 'insertCell' || op.type === 'deleteCell') {
         return { ...op, cell: stripCellOutputs(op.cell) };
       }
       return op;
     });
   }, [stripCellOutputs]);
   ```

3. **Remove `updateContent` from runtime paths** - Keep type for backwards compatibility with old history files

4. **Update tests** - Verify patch-based operations work correctly

**Estimated scope:** ~50 lines changed in `useUndoRedo.ts`

---

### Phase 2: Extract Core Library ✅ COMPLETE

**New file:** `lib/undoRedoCore.ts`

**Status:** Implemented. Created `lib/undoRedoCore.ts` with:
- All type definitions (exported and re-exported from hook)
- Pure functions: `applyOperation`, `reverseOperation`, `getAffectedCellIds`, `convertToCompactFormat`, `rebuildUndoStack`
- `UndoRedoManager` class for stateful management

Extract from `useUndoRedo.ts`:
- Type definitions (operations, history entries)
- `applyOperation()` - Pure function
- `reverseOperation()` - Pure function
- `getAffectedCellIds()` - Pure function
- History management logic (add, rebuild stacks, filter undone ops)

**Structure:**
```typescript
// lib/undoRedoCore.ts

// Types
export type UndoableOperation = ...
export type LogOperation = ...
export type TimestampedOperation = ...

// Pure functions
export function applyOperation(cells: Cell[], op: Operation): Cell[]
export function reverseOperation(op: Operation): Operation
export function getAffectedCellIds(op: Operation, cells?: Cell[]): string[]

// History management (stateless)
export function rebuildUndoStack(history: TimestampedOperation[]): Operation[]
export function filterUndoneOperations(history: TimestampedOperation[]): TimestampedOperation[]

// Class for stateful management (used by both React and headless)
export class UndoRedoManager {
  private cells: Cell[];
  private undoStack: Operation[];
  private redoStack: Operation[];
  private fullHistory: TimestampedOperation[];
  private lastContent: Map<string, string>;

  constructor(initialCells: Cell[]);

  // Operations
  insertCell(index: number, cell: Cell): void;
  deleteCell(index: number): Cell | null;
  moveCell(fromIndex: number, toIndex: number): void;
  flushCell(cellId: string, currentContent: string): void;
  updateMetadata(cellId: string, changes: MetadataChanges): void;
  batch(operations: Operation[]): void;

  // Undo/Redo
  undo(): UndoRedoResult | null;
  redo(): UndoRedoResult | null;
  canUndo(): boolean;
  canRedo(): boolean;

  // History
  getFullHistory(): TimestampedOperation[];
  loadHistory(history: TimestampedOperation[]): void;
  logOperation(op: LogOperation): void;

  // State
  getCells(): Cell[];
  setCells(cells: Cell[]): void;
}
```

**Estimated scope:** ~400 lines new file, ~300 lines removed from hook

---

### Phase 3: React Hook Wrapper ✅ COMPLETE

**File:** `hooks/useUndoRedo.ts`

**Status:** Implemented. The React hook now imports types and pure functions from `lib/undoRedoCore.ts`, eliminating code duplication while maintaining the same API for React consumers.

Thin wrapper around `UndoRedoManager`:

```typescript
export function useUndoRedo(initialCells: Cell[]) {
  const managerRef = useRef<UndoRedoManager>(new UndoRedoManager(initialCells));
  const [cells, setCellsState] = useState<Cell[]>(initialCells);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  // Wrap manager methods to trigger React state updates
  const insertCell = useCallback((index: number, cell: Cell) => {
    managerRef.current.insertCell(index, cell);
    setCellsState(managerRef.current.getCells());
    setCanUndo(managerRef.current.canUndo());
    setCanRedo(managerRef.current.canRedo());
  }, []);

  // ... similar wrappers for other methods

  return {
    cells,
    insertCell,
    deleteCell,
    // ...
  };
}
```

**Estimated scope:** ~200 lines (down from ~1000)

---

### Phase 4: Headless Backend Integration

**New file:** `node-server/src/notebook/undoRedoManager.ts`

Wraps `UndoRedoManager` for headless use:

```typescript
import { UndoRedoManager } from '../../../lib/undoRedoCore';

class HeadlessUndoRedoManager {
  private managers: Map<string, UndoRedoManager> = new Map();

  getManager(notebookPath: string): UndoRedoManager {
    if (!this.managers.has(notebookPath)) {
      const cells = this.loadCells(notebookPath);
      const history = this.loadHistory(notebookPath);
      const manager = new UndoRedoManager(cells);
      manager.loadHistory(history);
      this.managers.set(notebookPath, manager);
    }
    return this.managers.get(notebookPath)!;
  }

  // Persist after operations
  async persist(notebookPath: string): Promise<void> {
    const manager = this.managers.get(notebookPath);
    if (manager) {
      await this.saveCells(notebookPath, manager.getCells());
      await this.saveHistory(notebookPath, manager.getFullHistory());
    }
  }
}
```

**Modify:** `node-server/src/notebook/headless-handler.ts`

Replace direct cell manipulation with `UndoRedoManager`:

```typescript
// Before
async insertCell(operation): Promise<OperationResult> {
  const notebook = await this.getNotebook(notebookPath);
  notebook.cells.splice(index, 0, newCell);
  await this.persist(notebookPath);
}

// After
async insertCell(operation): Promise<OperationResult> {
  const manager = this.undoRedoManager.getManager(notebookPath);
  manager.insertCell(index, newCell);
  await this.undoRedoManager.persist(notebookPath);
}
```

**Add new operations to headless:**
```typescript
async undo(operation): Promise<OperationResult> {
  const manager = this.undoRedoManager.getManager(notebookPath);
  const result = manager.undo();
  if (result) {
    await this.undoRedoManager.persist(notebookPath);
    return { success: true, affectedCellIds: result.affectedCellIds };
  }
  return { success: false, error: 'Nothing to undo' };
}

async redo(operation): Promise<OperationResult> {
  // Similar
}
```

**Estimated scope:** ~150 lines new, ~200 lines modified in headless-handler

---

### Phase 5: MCP Operation Parity

**Add to operation router:** `node-server/src/notebook/operation-router.ts`

New operations exposed to MCP:
- `undo` - Undo last operation
- `redo` - Redo last undone operation
- `getHistory` - Get operation history (for agent awareness)
- `getHistorySince` - Get operations since timestamp

**Update MCP server** (when finalized):
- Expose undo/redo as tools
- Include history in notebook context

---

### Phase 6: Testing & Verification

1. **Unit tests for `undoRedoCore.ts`**
   - Operation application and reversal
   - History management
   - Edge cases (empty history, corrupted patches)

2. **Integration tests**
   - Same operation sequence produces identical history in UI vs headless
   - Undo/redo across UI ↔ headless transitions
   - History persistence and reload

3. **MCP parity tests**
   - Agent performs operations, UI can undo
   - UI performs operations, agent can undo
   - Mixed sequences

---

## Migration & Compatibility

### Backwards Compatibility

- Old history files with `updateContent` will still load (type kept for parsing)
- `applyOperation` handles both `updateContent` and `updateContentPatch`
- New history files will only contain `updateContentPatch`

### Rollout Strategy

1. Deploy Phase 1 (patch-in-memory) - Non-breaking, just optimization
2. Deploy Phase 2-3 (core extraction) - Refactor, same behavior
3. Deploy Phase 4-5 (headless integration) - New capability
4. Deploy Phase 6 (tests) - Confidence building

---

## Open Questions

1. **History pruning**: Should we add compaction for very long histories?
   - Option A: Keep all (current)
   - Option B: Compact old patches into periodic snapshots
   - Option C: Configurable retention policy

2. **Conflict resolution**: When UI and headless both have changes?
   - Current: Agent session locking prevents this
   - Future: Could support merge strategies

3. **Output undo**: Should `clearOutputs` be undoable?
   - Current: No
   - Proposed: Yes, as `updateMetadata` on outputs field

---

## File Summary

| File | Action | Lines |
|------|--------|-------|
| `lib/undoRedoCore.ts` | New | ~400 |
| `hooks/useUndoRedo.ts` | Refactor | ~200 (from ~1000) |
| `node-server/src/notebook/undoRedoManager.ts` | New | ~150 |
| `node-server/src/notebook/headless-handler.ts` | Modify | ~200 |
| `node-server/src/notebook/operation-router.ts` | Modify | ~50 |
| Tests | New | ~300 |

**Total estimated effort:** ~1300 lines of code changes
