# Performance Guidelines

This document covers performance patterns and common pitfalls for the notebook editor, with a focus on typing responsiveness.

## Typing Performance Architecture

The notebook achieves near-zero perceived typing latency through careful architecture:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                         KEYSTROKE TIMELINE                                   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  User presses key                                                            │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────────────────────────┐                                │
│  │ CodeMirror renders character (sync)     │ ◄── CHARACTER VISIBLE HERE    │
│  │ Updates internal state                  │     (0ms latency)              │
│  └─────────────────────────────────────────┘                                │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────────────────────────┐                                │
│  │ onChange callback fires                 │                                │
│  │ handleUpdateCell called                 │                                │
│  └─────────────────────────────────────────┘                                │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────────────────────────┐                                │
│  │ hasRedoToFlush() - O(1) ref read        │                                │
│  └─────────────────────────────────────────┘                                │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────────────────────────┐                                │
│  │ startTransition(() => setCells(...))    │ ◄── Marked as LOW PRIORITY    │
│  │ React state update (non-urgent)         │     Can be interrupted        │
│  └─────────────────────────────────────────┘                                │
│       │                                                                      │
│       ▼ (deferred to next frame)                                            │
│  ┌─────────────────────────────────────────┐                                │
│  │ React reconciliation                    │                                │
│  │ Only edited Cell re-renders (memo)      │                                │
│  │ Virtualization: only visible cells      │                                │
│  └─────────────────────────────────────────┘                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Why This Works

1. **CodeMirror renders first**: The `@uiw/react-codemirror` wrapper ensures the keystroke appears in the DOM synchronously, before any React work happens. This is the critical insight—the character is visible at 0ms.

2. **startTransition for state updates**: We wrap `setCells` in `startTransition` to explicitly tell React this update is non-urgent:
   ```tsx
   const handleUpdateCell = useCallback((id: string, content: string) => {
     if (hasRedoToFlush()) {
       flushCell(id, content);
     }
     // Non-urgent: CodeMirror already rendered the keystroke
     startTransition(() => {
       setCells(prev => prev.map(c => c.id === id ? { ...c, content } : c));
     });
   }, [setCells, hasRedoToFlush, flushCell]);
   ```

3. **Memoization prevents cascade**: Only the edited cell re-renders because:
   - `cells.map()` returns the same object reference for unchanged cells
   - Cell memo comparison checks `prevProps.cell === nextProps.cell`

4. **Virtualization limits DOM work**: Only ~10-15 visible cells exist in the DOM at any time.

### Performance Guarantees

| Layer | Latency | Notes |
|-------|---------|-------|
| Character visible | 0ms | CodeMirror synchronous render |
| onChange fires | ~0.1ms | After CodeMirror render |
| hasRedoToFlush | O(1) | Ref read, no computation |
| setCells queued | ~0.1ms | startTransition, non-blocking |
| React reconcile | Deferred | Next frame, interruptible |

## Critical Rule: No O(N) Work Per Keystroke

Every keystroke triggers a render cycle. Any O(N) operation (where N = number of cells) in the render path causes cumulative lag that becomes noticeable with larger notebooks.

**Acceptable per-keystroke operations:**
- O(1) ref reads/writes
- O(1) state updates
- Single cell re-render (the edited cell)

**Unacceptable per-keystroke operations:**
- `cells.map()`, `cells.filter()`, `cells.find()` in render
- `cells.findIndex()` in JSX
- `JSON.stringify(cells)` or similar serialization
- Any loop over all cells

## Common Performance Regressions

### 1. Inline Array Computations in JSX

**Bad - runs on every render:**
```tsx
<CodeEditor
  allCellsContent={allCells.filter(c => c.type === 'code').map(c => c.content)}
/>
```

**Good - use ref and compute lazily:**
```tsx
// In parent component
const allCellsRef = useRef(allCells);
allCellsRef.current = allCells;

// Pass ref instead
<CodeEditor allCellsRef={allCellsRef} />

// In CodeEditor - compute only when needed (e.g., autocomplete triggers)
const content = allCellsRef.current.filter(c => c.type === 'code').map(c => c.content);
```

### 2. IIFE with O(N) Operations in JSX

**Bad - findIndex runs on every render:**
```tsx
{executionQueue.length > 0 && (() => {
  const cellIndex = cells.findIndex(c => c.id === executionQueue[0]);
  return <span>[{cellIndex + 1}]</span>;
})()}
```

**Good - memoize the computation:**
```tsx
const executionIndicator = useMemo(() => {
  if (executionQueue.length === 0) return null;
  const cellIndex = cells.findIndex(c => c.id === executionQueue[0]);
  return { cellIndex };
}, [executionQueue, cells]);

// In JSX
{executionIndicator && <span>[{executionIndicator.cellIndex + 1}]</span>}
```

### 3. Effects That Run on Every Cells Change

**Bad - runs on every keystroke:**
```tsx
useEffect(() => {
  const serialized = JSON.stringify(cells); // O(N)
  checkForChanges(serialized);
}, [cells]);
```

**Good - debounce expensive operations:**
```tsx
useEffect(() => {
  // Quick reference check first
  if (cells === cellsRef.current) return;
  cellsRef.current = cells;

  // Debounce the expensive check
  const timeout = setTimeout(() => {
    const serialized = JSON.stringify(cells);
    checkForChanges(serialized);
  }, 300);

  return () => clearTimeout(timeout);
}, [cells]);
```

### 4. Autocomplete Keyword Scanning

The autocomplete system extracts identifiers from all cells. This must NOT run on every keystroke.

**Architecture:**
```
User types → Cell re-renders → CodeEditor re-renders
                                    ↓
                              allCellsRef updated (O(1))
                                    ↓
                              No autocomplete work yet!
                                    ↓
User triggers autocomplete (typing a word, waiting for popup)
                                    ↓
                              Completion source reads from ref
                              Computes identifiers (O(N)) - only now!
```

**Key insight:** Pass refs instead of computed arrays. The O(N) work happens when autocomplete triggers, not on every keystroke.

## Cell Memoization

The `Cell` component is memoized with a custom comparison:

```tsx
export const Cell = memo(CellComponent, (prevProps, nextProps) => {
  return (
    prevProps.cell === nextProps.cell &&
    prevProps.index === nextProps.index &&
    prevProps.isActive === nextProps.isActive &&
    // ... other visual props
  );
});
```

**Important:** We deliberately exclude:
- `allCells` - changes on every keystroke, but Cell uses ref
- Callback functions - change frequently due to closure dependencies
- Any prop that changes on every keystroke but doesn't affect rendering

## Ref Pattern for Immediate Reads

React batches state updates. When you need to read state immediately after writing:

```tsx
// State for React rendering
const [undoStack, setUndoStackState] = useState([]);

// Ref for immediate reads
const undoStackRef = useRef([]);

// Helper that updates both
const setUndoStack = useCallback((update) => {
  if (typeof update === 'function') {
    setUndoStackState(prev => {
      const newStack = update(prev);
      undoStackRef.current = newStack; // Sync ref immediately
      return newStack;
    });
  } else {
    undoStackRef.current = update;
    setUndoStackState(update);
  }
}, []);

// Read from ref for immediate values
const hasItems = undoStackRef.current.length > 0;
```

This pattern is used for:
- `undoStackRef` / `redoStackRef` - immediate reads after flush
- `cellsRef` - avoid stale closures in callbacks
- `activeCellIdRef` - immediate reads in event handlers

## Profiling Typing Performance

When investigating typing lag:

1. **React DevTools Profiler**
   - Record while typing
   - Look for components re-rendering unexpectedly
   - Check render duration for each component

2. **Chrome Performance Tab**
   - Record while typing rapidly
   - Look for long tasks (>50ms blocks the main thread)
   - Check for repeated expensive function calls

3. **Console Timing**
   ```tsx
   const handleUpdateCell = useCallback((id, content) => {
     console.time('handleUpdateCell');
     // ... work
     console.timeEnd('handleUpdateCell');
   }, []);
   ```

## Performance Checklist for PRs

Before merging code that touches the typing path:

- [ ] No new `cells.map/filter/find/findIndex` in render or JSX
- [ ] No new `useEffect` with `cells` in dependency array (without debounce)
- [ ] New props to Cell are either stable or excluded from memo comparison
- [ ] Autocomplete-related code uses refs, not computed arrays
- [ ] No new O(N) operations in `handleUpdateCell` or `onChange` handlers

## File Reference

| File | Performance Concern |
|------|---------------------|
| `components/Notebook.tsx` | Main render, effects, callbacks |
| `components/Cell.tsx` | Memo comparison, ref usage |
| `components/CodeEditor.tsx` | Extensions, autocomplete |
| `hooks/useAutosave.ts` | Debounced change detection |
| `hooks/useUndoRedo.ts` | Stack operations, refs |
