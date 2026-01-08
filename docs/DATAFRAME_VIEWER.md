# Plan: Interactive Virtualized DataFrame Viewer

## Overview

Add itable-style interactive DataFrame viewing with virtualization for arbitrarily large DataFrames. Features: virtual scrolling (rows AND columns), sorting, filtering - all handled on the backend for performance.

**Design Goals:**
1. Works with arbitrarily large DataFrames (rows AND columns)
2. AI can still understand DataFrame structure (text summary included)
3. **Plugin architecture** - cleanly removable without touching core types

---

## AI Integration Strategy

**Current state**: AI chat only sees cell code + images, NOT stdout/html outputs.

**Solution**: Include a hidden text summary in the output that AI can read:

```html
<!-- AI-readable summary (hidden from display) -->
<div class="sr-only" data-ai-context="true">
DataFrame: 1,000,000 rows x 50 columns
Columns: id (int64), name (object), value (float64), ...
Sample: id=1, name="foo", value=3.14 | id=2, name="bar", value=2.71 | ...
</div>
<!-- Interactive viewer -->
<div data-nebula-dataframe='{"df_id": "abc123", ...}'></div>
```

When `getNotebookContext()` builds AI context, we can optionally extract `data-ai-context` content.

---

## Plugin Architecture (Clean Removal)

**Principle**: Keep core types untouched. DataFrame detection happens at render time.

```
┌─────────────────────────────────────────────────────────────┐
│ CORE (unchanged)                                             │
│ - CellOutput type stays: 'stdout' | 'html' | 'image' | ...  │
│ - kernel_service.py unchanged                                │
│ - Output flows as type: 'html'                              │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ PLUGIN: DataFrame Viewer (all in isolated files)            │
│ - dataframe_service.py: Registry + API endpoints            │
│ - DataFrameViewer.tsx: Virtualized table component          │
│ - CellOutput.tsx: Detects marker in HTML, renders viewer    │
│ - Settings toggle: "Enable interactive DataFrame viewer"    │
└─────────────────────────────────────────────────────────────┘
```

**To remove the plugin**: Delete the files, remove detection in CellOutput.tsx. DataFrames fall back to standard HTML tables.

---

## Architecture

```
Kernel executes df → DataFrame hook intercepts _repr_html_()
                   → Registers df in registry with UUID
                   → Returns HTML with embedded marker + AI summary
                            ↓
Backend passes through → Sends type: "html" (unchanged!)
                            ↓
Frontend CellOutput → Detects data-nebula-dataframe marker
                    → If found AND enabled: <DataFrameViewer />
                    → If not found OR disabled: dangerouslySetInnerHTML
```

**Key Design**:
- Output type stays `html` - no core type changes
- DataFrames stay in kernel memory for windowed fetching
- Plugin can be disabled via settings

---

## Critical Files

### Backend (Python) - Plugin files
- `server/dataframe_service.py` - **NEW** - DataFrame registry, windowing, sort/filter
- `server/dataframe_routes.py` - **NEW** - API endpoints (imported into main.py)
- `server/kernel_service.py` - **MINOR** - Inject DataFrame hook on kernel start

### Frontend (TypeScript) - Plugin files
- `services/dataframeService.ts` - **NEW** - API client with caching
- `components/DataFrameViewer.tsx` - **NEW** - Virtualized table component
- `components/CellOutput.tsx` - **MINOR** - Detect marker in HTML, conditionally render

### Core files (minimal changes)
- `types.ts` - **NO CHANGE** - CellOutput type unchanged
- `server/main.py` - **MINOR** - Import dataframe_routes
- `services/llmService.ts` - **OPTIONAL** - Extract AI context from outputs

---

## Implementation Steps

### Phase 1: Backend - DataFrame Registry

**File: `server/dataframe_service.py`** (new)

```python
class DataFrameRegistry:
    """Per-session DataFrame registry with lifecycle management"""

    def register(self, session_id: str, df, cell_id: str = None) -> str:
        """Register DataFrame, return UUID"""
        df_id = str(uuid.uuid4())[:8]
        self._registries[session_id][df_id] = weakref.ref(df)
        return df_id

    def get_data_window(self, session_id, df_id, row_start, row_end, col_start, col_end):
        """Return sliced data as JSON-serializable dict"""
        df = self._registries[session_id][df_id]()
        return df.iloc[row_start:row_end, col_start:col_end].to_dict('records')

    def create_sorted_view(self, session_id, df_id, column, ascending) -> str:
        """Sort and register as new view, return new df_id"""

    def create_filtered_view(self, session_id, df_id, column, op, value) -> str:
        """Filter and register as new view, return new df_id"""
```

### Phase 2: Backend - DataFrame Hook Injection

**File: `server/kernel_service.py`**

Inject on kernel start:
```python
DATAFRAME_HOOK = '''
import pandas as pd
_NEBULA_DF_REGISTRY = {}

def _nebula_df_repr(df):
    if len(df) <= 100 and len(df.columns) <= 20:
        return df._repr_html_()  # Small df: use standard HTML

    df_id = str(uuid.uuid4())[:8]
    _NEBULA_DF_REGISTRY[df_id] = df

    return f'<div data-nebula-dataframe=\\'{json.dumps({
        "df_id": df_id,
        "total_rows": len(df),
        "total_cols": len(df.columns),
        "columns": [{"name": c, "dtype": str(df[c].dtype)} for c in df.columns],
        "preview_data": df.head(50).to_dict("records")
    })}\\'></div>'

pd.DataFrame._repr_html_ = lambda self: _nebula_df_repr(self)
'''
```

### Phase 3: Backend - API Endpoints

**File: `server/main.py`**

```python
@app.get("/api/dataframe/{session_id}/{df_id}/data")
async def get_dataframe_data(
    session_id: str, df_id: str,
    row_start: int = 0, row_end: int = 100,
    col_start: int = 0, col_end: int = None
):
    return dataframe_registry.get_data_window(...)

@app.post("/api/dataframe/{session_id}/{df_id}/sort")
async def sort_dataframe(session_id: str, df_id: str, column: str, ascending: bool):
    new_id = dataframe_registry.create_sorted_view(...)
    return {"df_id": new_id, "metadata": ...}

@app.post("/api/dataframe/{session_id}/{df_id}/filter")
async def filter_dataframe(session_id: str, df_id: str, column: str, op: str, value: Any):
    new_id = dataframe_registry.create_filtered_view(...)
    return {"df_id": new_id, "total_rows": ..., "metadata": ...}
```

### Phase 4: Frontend - Types & Service

**File: `types.ts`**
```typescript
export interface CellOutput {
  type: 'stdout' | 'stderr' | 'image' | 'html' | 'error' | 'dataframe';
  content: string | DataFrameMetadata;
}

export interface DataFrameMetadata {
  df_id: string;
  total_rows: number;
  total_cols: number;
  columns: Array<{ name: string; dtype: string }>;
  preview_data: Record<string, any>[];
}
```

**File: `services/dataframeService.ts`** (new)
```typescript
class DataFrameService {
  private cache = new Map<string, DataWindow>();

  async getData(sessionId, dfId, rowStart, rowEnd, colStart, colEnd): Promise<DataWindow>
  async sort(sessionId, dfId, column, ascending): Promise<{df_id, metadata}>
  async filter(sessionId, dfId, column, op, value): Promise<{df_id, metadata}>
}
```

### Phase 5: Frontend - DataFrameViewer Component

**File: `components/DataFrameViewer.tsx`** (new)

```tsx
export const DataFrameViewer: React.FC<Props> = ({ sessionId, metadata }) => {
  // State
  const [currentDfId, setCurrentDfId] = useState(metadata.df_id);
  const [dataCache, setDataCache] = useState<Map<number, Row>>(/* preview */);
  const [colStart, setColStart] = useState(0);  // Column virtualization
  const [sortSpec, setSortSpec] = useState<SortSpec | null>(null);
  const [filters, setFilters] = useState<FilterSpec[]>([]);

  // Fetch rows on scroll
  const handleRangeChange = useCallback((range) => {
    fetchRange(range.startIndex, range.endIndex + OVERSCAN);
  }, []);

  return (
    <div className="border rounded-lg">
      {/* Header: row count, column nav, reset button */}
      {/* Column headers with sort/filter controls */}
      <Virtuoso
        totalCount={totalRows}
        itemContent={renderRow}
        rangeChanged={handleRangeChange}
      />
    </div>
  );
};
```

### Phase 6: Frontend - CellOutput Integration

**File: `components/CellOutput.tsx`**

```tsx
case 'dataframe':
  return <DataFrameViewer sessionId={sessionId} metadata={output.content} />;
```

---

## Threshold Logic

- **Small DataFrame** (≤100 rows AND ≤20 cols): Use standard pandas HTML
- **Large DataFrame** (>100 rows OR >20 cols): Use virtualized viewer

This handles the user's concern about very wide DataFrames too.

---

## Lifecycle Management

1. **Kernel restart**: Clear all DataFrames for session via `cleanup_session()`
2. **Cell re-execution**: Clear DataFrames from previous execution of that cell
3. **WeakRef**: Use `weakref.ref(df)` so Python GC can collect when kernel drops reference

---

## API Contract

| Method | Endpoint | Purpose |
|--------|----------|---------|
| GET | `/api/dataframe/{session}/{df}/data?row_start=&row_end=&col_start=&col_end=` | Fetch data window |
| POST | `/api/dataframe/{session}/{df}/sort` | Create sorted view |
| POST | `/api/dataframe/{session}/{df}/filter` | Create filtered view |

---

## Testing Checklist

### Core Functionality
- [ ] Small DataFrame (≤100 rows, ≤20 cols) renders as standard HTML
- [ ] Large DataFrame (100k rows) renders with virtualization
- [ ] Wide DataFrame (100 cols) has horizontal column navigation
- [ ] Sort by clicking column header works
- [ ] Filter by column value works
- [ ] Reset clears sort/filters

### Lifecycle
- [ ] Kernel restart invalidates DataFrame refs gracefully
- [ ] Cell re-execution cleans up old DataFrames
- [ ] WeakRef allows GC when kernel drops reference

### Performance
- [ ] 1M row DataFrame scrolls smoothly
- [ ] Data window fetching is debounced
- [ ] Frontend caches fetched windows

### AI Integration
- [ ] AI chat can describe DataFrame structure from hidden summary
- [ ] data-ai-context is extracted in getNotebookContext()

### Plugin Architecture
- [ ] Setting toggle enables/disables interactive viewer
- [ ] When disabled, DataFrames render as standard HTML
- [ ] Deleting plugin files doesn't break notebook (graceful fallback)
