"""
Headless Operation Handler

Handles notebook operations when no UI is connected to Nebula.

## Architecture Context

This module is part of Nebula's dual-mode operation system:

    Agent → NebulaClient → Operation Router → [ UI Handler | Headless Handler ]

When a notebook is NOT open in the browser (no WebSocket connection), the
Operation Router delegates to this HeadlessOperationHandler instead of
forwarding to the UI.

## Write-Back Caching Strategy

To optimize for agent workflows (many rapid operations), this handler uses
write-back caching:

    1. First access: Load notebook from disk into memory cache
    2. Operations: Apply to cache only (no disk I/O)
    3. After operation: Schedule async persist (non-blocking)
    4. Persist: Write to disk in background, re-check dirty flag

This provides:
- Fast operation response times (no blocking I/O)
- Automatic batching of rapid sequential operations
- Crash safety via periodic background writes

## Usage

    handler = HeadlessOperationHandler(fs_service)

    # Apply operation (returns immediately, persists in background)
    result = await handler.apply_operation({
        'type': 'insertCell',
        'notebookPath': '/path/to/notebook.ipynb',
        'index': 0,
        'cell': {'id': 'cell-1', 'type': 'code', 'content': '# Hello'}
    })

    # Force immediate persistence (for graceful shutdown)
    await handler.flush()

## Supported Operations

Cell Operations:
- insertCell, deleteCell, updateContent, updateMetadata
- moveCell, duplicateCell, updateOutputs, clearNotebook

Notebook Operations:
- createNotebook, readCell, readCellOutput

Session Operations (no-ops in headless mode):
- startAgentSession, endAgentSession

## Thread Safety

- Uses asyncio.Lock per notebook path to prevent overlapping writes
- Cache mutations are synchronous (no race conditions)
- Persist operations run in thread pool to avoid blocking event loop

See also: hooks/useOperationHandler.ts (UI-side equivalent)
"""

import asyncio
import copy
import json
import os
from typing import Dict, Any, Optional

from cell_metadata import validate_metadata_value


class HeadlessOperationHandler:
    """
    Handles notebook operations when no UI is connected.

    Maintains notebook content in memory as ground truth:
    - Reads from disk only on first access (cached thereafter)
    - Mutations update cache only (no disk I/O)
    - Persists to disk on explicit flush() call

    Call flush() when appropriate:
    - After completing a batch of operations
    - When session ends or client disconnects
    - Periodically for crash safety (caller's responsibility)

    Mirrors useOperationHandler (React) but operates on files instead of UI state.
    """

    def __init__(self, fs_service, operation_router=None):
        """
        Initialize with filesystem service for notebook I/O.

        Args:
            fs_service: Filesystem service for reading/writing notebooks
            operation_router: Optional OperationRouter for agent session tracking
        """
        self._fs_service = fs_service
        self._operation_router = operation_router
        # Cache: path -> {cells, metadata, dirty}
        self._cache: Dict[str, Dict[str, Any]] = {}
        # Write coordination: prevents overlapping writes, allows non-blocking ops
        self._write_locks: Dict[str, asyncio.Lock] = {}
        self._write_tasks: Dict[str, asyncio.Task] = {}

    def _get_cached_notebook(self, path: str) -> Dict[str, Any]:
        """Get notebook from cache, loading from disk if needed (only once per notebook)."""
        if path not in self._cache:
            result = self._fs_service.get_notebook_cells(path)
            self._cache[path] = {
                'cells': result.get('cells', []),
                'metadata': result.get('metadata', {}),
                'dirty': False,
            }
        return self._cache[path]

    def _get_cells(self, path: str) -> list:
        """Get cells for a notebook (from cache)."""
        return self._get_cached_notebook(path)['cells']

    def _save_cells(self, path: str, cells: list):
        """Update cells in cache (no disk I/O). Call flush() to persist."""
        notebook = self._get_cached_notebook(path)
        notebook['cells'] = cells
        notebook['dirty'] = True

    def _get_write_lock(self, path: str) -> asyncio.Lock:
        """Get or create a write lock for a notebook path."""
        if path not in self._write_locks:
            self._write_locks[path] = asyncio.Lock()
        return self._write_locks[path]

    async def _async_persist(self, path: str):
        """
        Persist notebook to disk asynchronously.

        - Acquires lock to prevent overlapping writes
        - Runs I/O in thread to not block event loop
        - Re-checks dirty flag after write (catches changes made during write)
        """
        lock = self._get_write_lock(path)

        async with lock:
            # Keep writing while dirty (new changes may arrive during write)
            while path in self._cache and self._cache[path]['dirty']:
                # Snapshot cells and clear dirty before write
                cells = copy.deepcopy(self._cache[path]['cells'])
                self._cache[path]['dirty'] = False

                # Run blocking I/O in thread pool
                await asyncio.to_thread(
                    self._fs_service.save_notebook_cells, path, cells
                )
                # Loop re-checks dirty in case new changes came in during write

    def _schedule_persist(self, path: str):
        """
        Schedule a non-blocking persist. Returns immediately.

        If a write is already in progress/scheduled, this is a no-op
        (the running write will pick up our changes via dirty flag).
        """
        # Skip if write already running - it will catch our dirty flag
        if path in self._write_tasks:
            task = self._write_tasks[path]
            if not task.done():
                return

        # Start background write task
        self._write_tasks[path] = asyncio.create_task(self._async_persist(path))

    async def flush(self, path: Optional[str] = None):
        """
        Persist dirty notebooks to disk and wait for completion.

        Args:
            path: Specific notebook path to flush, or None to flush all.
        """
        paths = [path] if path else list(self._cache.keys())
        tasks = []
        for p in paths:
            if p in self._cache and self._cache[p]['dirty']:
                tasks.append(self._async_persist(p))
        if tasks:
            await asyncio.gather(*tasks)

    def invalidate(self, path: Optional[str] = None):
        """
        Invalidate cache, forcing reload from disk on next access.

        Args:
            path: Specific notebook path to invalidate, or None to invalidate all.
        """
        if path:
            self._cache.pop(path, None)
        else:
            self._cache.clear()

    def is_dirty(self, path: str) -> bool:
        """Check if a notebook has unsaved changes."""
        return path in self._cache and self._cache[path]['dirty']

    async def apply_operation(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply operation to notebook (in-memory) and auto-flush to disk.

        Write operations update cache then persist. Read operations use cache only.
        """
        op_type = operation.get('type')
        notebook_path = operation.get('notebookPath', '')

        # Read-only operations (no flush needed)
        read_only_ops = {'readCell', 'readCellOutput', 'startAgentSession', 'endAgentSession'}

        try:
            if op_type == 'insertCell':
                result = await self._insert_cell(operation)
            elif op_type == 'deleteCell':
                result = await self._delete_cell(operation)
            elif op_type == 'updateContent':
                result = await self._update_content(operation)
            elif op_type == 'updateMetadata':
                result = await self._update_metadata(operation)
            elif op_type == 'moveCell':
                result = await self._move_cell(operation)
            elif op_type == 'duplicateCell':
                result = await self._duplicate_cell(operation)
            elif op_type == 'updateOutputs':
                result = await self._update_outputs(operation)
            elif op_type == 'createNotebook':
                result = await self._create_notebook(operation)
            elif op_type == 'readCell':
                result = await self._read_cell(operation)
            elif op_type == 'readCellOutput':
                result = await self._read_cell_output(operation)
            elif op_type == 'clearNotebook':
                result = await self._clear_notebook(operation)
            elif op_type == 'startAgentSession':
                # Track agent session in router to prevent headless fallback
                if self._operation_router:
                    self._operation_router.start_agent_session(notebook_path)
                result = {'success': True}
            elif op_type == 'endAgentSession':
                # End agent session tracking in router
                if self._operation_router:
                    self._operation_router.end_agent_session(notebook_path)
                result = {'success': True}
            else:
                return {
                    'success': False,
                    'error': f'Unknown operation type: {op_type}'
                }

            # Schedule non-blocking persist after successful write operations
            if result.get('success') and op_type not in read_only_ops and notebook_path:
                self._schedule_persist(notebook_path)

            return result
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    async def read_notebook(self, notebook_path: str) -> Dict[str, Any]:
        """Read notebook from cache (loads from disk on first access)"""
        try:
            notebook = self._get_cached_notebook(notebook_path)
            return {
                'success': True,
                'data': {
                    'path': notebook_path,
                    'cells': notebook['cells'],
                    'metadata': notebook.get('metadata', {})
                }
            }
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    def _convert_cells_to_internal(self, jupyter_cells: list) -> list:
        """Convert Jupyter cells to internal format"""
        cells = []
        for i, cell in enumerate(jupyter_cells):
            metadata = cell.get('metadata', {})
            cell_id = metadata.get('nebula_id', f'cell-{i}')

            cells.append({
                'id': cell_id,
                'type': 'code' if cell.get('cell_type') == 'code' else 'markdown',
                'content': ''.join(cell.get('source', [])) if isinstance(cell.get('source'), list) else cell.get('source', ''),
                'outputs': self._convert_outputs(cell.get('outputs', [])),
                'executionCount': cell.get('execution_count'),
                'metadata': {k: v for k, v in metadata.items() if k != 'nebula_id'}
            })
        return cells

    def _convert_outputs(self, jupyter_outputs: list) -> list:
        """Convert Jupyter outputs to internal format"""
        outputs = []
        for output in jupyter_outputs:
            output_type = output.get('output_type', '')

            if output_type == 'stream':
                text = output.get('text', '')
                if isinstance(text, list):
                    text = ''.join(text)
                stream_type = 'stderr' if output.get('name') == 'stderr' else 'stdout'
                outputs.append({'type': stream_type, 'content': text})

            elif output_type in ('execute_result', 'display_data'):
                data = output.get('data', {})
                if 'image/png' in data:
                    outputs.append({'type': 'image', 'content': data['image/png']})
                elif 'text/html' in data:
                    html = data['text/html']
                    if isinstance(html, list):
                        html = ''.join(html)
                    outputs.append({'type': 'html', 'content': html})
                elif 'text/plain' in data:
                    text = data['text/plain']
                    if isinstance(text, list):
                        text = ''.join(text)
                    outputs.append({'type': 'stdout', 'content': text})

            elif output_type == 'error':
                error_text = '\n'.join(output.get('traceback', []))
                outputs.append({'type': 'error', 'content': error_text})

        return outputs

    def _convert_cells_to_jupyter(self, cells: list) -> list:
        """Convert internal cells to Jupyter format"""
        jupyter_cells = []
        for cell in cells:
            jupyter_cell = {
                'cell_type': cell.get('type', 'code'),
                'source': cell.get('content', ''),
                'metadata': {
                    'nebula_id': cell.get('id'),
                    **cell.get('metadata', {})
                }
            }

            if cell.get('type') == 'code':
                jupyter_cell['outputs'] = self._convert_outputs_to_jupyter(cell.get('outputs', []))
                jupyter_cell['execution_count'] = cell.get('executionCount')

            jupyter_cells.append(jupyter_cell)

        return jupyter_cells

    def _convert_outputs_to_jupyter(self, outputs: list) -> list:
        """Convert internal outputs to Jupyter format"""
        jupyter_outputs = []
        for output in outputs:
            out_type = output.get('type', '')
            content = output.get('content', '')

            if out_type in ('stdout', 'stderr'):
                jupyter_outputs.append({
                    'output_type': 'stream',
                    'name': 'stderr' if out_type == 'stderr' else 'stdout',
                    'text': content
                })
            elif out_type == 'image':
                jupyter_outputs.append({
                    'output_type': 'display_data',
                    'data': {'image/png': content},
                    'metadata': {}
                })
            elif out_type == 'html':
                jupyter_outputs.append({
                    'output_type': 'display_data',
                    'data': {'text/html': content},
                    'metadata': {}
                })
            elif out_type == 'error':
                jupyter_outputs.append({
                    'output_type': 'error',
                    'ename': 'Error',
                    'evalue': '',
                    'traceback': content.split('\n')
                })

        return jupyter_outputs

    async def _insert_cell(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Insert a new cell"""
        notebook_path = operation['notebookPath']
        index = operation['index']
        cell_data = operation['cell']

        cells = self._get_cells(notebook_path)

        # Check for duplicate ID
        cell_id = cell_data['id']
        existing_ids = {c.get('id') for c in cells}
        original_id = cell_id
        id_modified = False

        if cell_id in existing_ids:
            # Auto-fix duplicate ID
            counter = 2
            while f"{original_id}-{counter}" in existing_ids:
                counter += 1
            cell_id = f"{original_id}-{counter}"
            id_modified = True

        # Create cell in internal format
        new_cell = {
            'id': cell_id,
            'type': cell_data.get('type', 'code'),
            'content': cell_data.get('content', ''),
            'outputs': [],
            'executionCount': None,
        }

        # Insert at position
        if index == -1 or index >= len(cells):
            cells.append(new_cell)
            actual_index = len(cells) - 1
        else:
            cells.insert(index, new_cell)
            actual_index = index

        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell_id,
            'cellIndex': actual_index,
            'idModified': id_modified,
            'requestedId': original_id if id_modified else None,
            'totalCells': len(cells),
            'operationTime': None  # Placeholder for future timing integration
        }

    async def _delete_cell(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Delete a cell"""
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        cell_index = operation.get('cellIndex')

        cells = self._get_cells(notebook_path)

        # Find cell to delete
        target_index = None
        if cell_id:
            for i, cell in enumerate(cells):
                if cell.get('id') == cell_id:
                    target_index = i
                    break
        elif cell_index is not None:
            target_index = cell_index

        if target_index is None or target_index >= len(cells):
            return {
                'success': False,
                'error': 'Cell not found'
            }

        cells.pop(target_index)
        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'cellIndex': target_index,
            'totalCells': len(cells),
            'operationTime': None  # Placeholder for future timing integration
        }

    async def _update_content(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Update cell content"""
        notebook_path = operation['notebookPath']
        cell_id = operation['cellId']
        content = operation['content']

        cells = self._get_cells(notebook_path)

        # Find cell
        target_index = None
        for i, cell in enumerate(cells):
            if cell.get('id') == cell_id:
                target_index = i
                break

        if target_index is None:
            return {
                'success': False,
                'error': f'Cell with ID "{cell_id}" not found'
            }

        cells[target_index]['content'] = content
        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell_id,
            'cellIndex': target_index
        }

    async def _update_metadata(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Update cell metadata - schema-driven validation"""
        notebook_path = operation['notebookPath']
        cell_id = operation['cellId']
        changes = operation['changes']

        # Validate all changes against schema before applying any
        errors = []
        for key, value in changes.items():
            validation = validate_metadata_value(key, value)
            if not validation.get('valid'):
                errors.append(validation.get('error', f'Invalid field: {key}'))
        if errors:
            return {'success': False, 'error': '; '.join(errors)}

        cells = self._get_cells(notebook_path)

        # Find cell
        target_index = None
        for i, cell in enumerate(cells):
            if cell.get('id') == cell_id:
                target_index = i
                break

        if target_index is None:
            return {
                'success': False,
                'error': f'Cell with ID "{cell_id}" not found'
            }

        cell = cells[target_index]
        old_values = {}

        # Handle ID change specially (requires conflict resolution)
        if 'id' in changes:
            new_id = changes['id']
            existing_ids = {c.get('id') for c in cells}
            existing_ids.discard(cell_id)  # Remove current ID

            id_modified = False
            original_new_id = new_id

            if new_id in existing_ids:
                counter = 2
                while f"{original_new_id}-{counter}" in existing_ids:
                    counter += 1
                new_id = f"{original_new_id}-{counter}"
                id_modified = True

            old_values['id'] = cell_id
            cell['id'] = new_id
            cell_id = new_id

        # Apply all other validated changes generically (schema-driven)
        for key, value in changes.items():
            if key == 'id':
                continue  # Already handled above
            old_values[key] = cell.get(key)
            cell[key] = value

        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell_id,
            'cellIndex': target_index,
            'changes': {k: {'old': old_values.get(k), 'new': changes[k]} for k in changes}
        }

    async def _move_cell(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Move a cell"""
        notebook_path = operation['notebookPath']
        from_index = operation['fromIndex']
        to_index = operation['toIndex']

        cells = self._get_cells(notebook_path)

        if from_index < 0 or from_index >= len(cells):
            return {'success': False, 'error': 'Invalid from_index'}
        if to_index < 0 or to_index >= len(cells):
            return {'success': False, 'error': 'Invalid to_index'}

        cell = cells.pop(from_index)
        cells.insert(to_index, cell)
        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'fromIndex': from_index,
            'toIndex': to_index
        }

    async def _duplicate_cell(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Duplicate a cell"""
        notebook_path = operation['notebookPath']
        cell_index = operation['cellIndex']
        new_cell_id = operation['newCellId']

        cells = self._get_cells(notebook_path)

        if cell_index < 0 or cell_index >= len(cells):
            return {'success': False, 'error': 'Invalid cell_index'}

        new_cell = copy.deepcopy(cells[cell_index])

        # Check for duplicate ID
        existing_ids = {c.get('id') for c in cells}
        actual_id = new_cell_id
        id_modified = False

        if actual_id in existing_ids:
            counter = 2
            while f"{new_cell_id}-{counter}" in existing_ids:
                counter += 1
            actual_id = f"{new_cell_id}-{counter}"
            id_modified = True

        new_cell['id'] = actual_id
        new_cell['outputs'] = []
        new_cell['executionCount'] = None

        cells.insert(cell_index + 1, new_cell)
        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': actual_id,
            'cellIndex': cell_index + 1,
            'idModified': id_modified,
            'totalCells': len(cells),
            'operationTime': None  # Placeholder for future timing integration
        }

    async def _update_outputs(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Update cell outputs"""
        notebook_path = operation['notebookPath']
        cell_id = operation['cellId']
        outputs = operation['outputs']
        execution_count = operation.get('executionCount')

        cells = self._get_cells(notebook_path)

        # Find cell (internal format uses 'id' at top level)
        target_index = None
        for i, cell in enumerate(cells):
            if cell.get('id') == cell_id:
                target_index = i
                break

        if target_index is None:
            return {
                'success': False,
                'error': f'Cell with ID "{cell_id}" not found'
            }

        # Update outputs (store in internal format - save_notebook_cells handles conversion)
        # Convert from operation format to internal format
        internal_outputs = []
        for output in outputs:
            internal_outputs.append({
                'type': output.get('type', 'stdout'),
                'content': output.get('content', ''),
            })
        cells[target_index]['outputs'] = internal_outputs
        if execution_count is not None:
            cells[target_index]['executionCount'] = execution_count

        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell_id,
            'cellIndex': target_index
        }

    async def _create_notebook(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new notebook file"""
        notebook_path = operation['notebookPath']
        overwrite = operation.get('overwrite', False)
        kernel_name = operation.get('kernelName', 'python3')
        kernel_display_name = operation.get('kernelDisplayName', 'Python 3')

        # Normalize path
        normalized_path = self._fs_service._normalize_path(notebook_path)

        # Check if file exists
        if os.path.exists(normalized_path) and not overwrite:
            return {
                'success': False,
                'error': f'Notebook already exists: {notebook_path}. Use overwrite=true to replace.'
            }

        # Create empty notebook structure
        notebook = {
            'nbformat': 4,
            'nbformat_minor': 5,
            'metadata': {
                'kernelspec': {
                    'name': kernel_name,
                    'display_name': kernel_display_name
                },
                'language_info': {
                    'name': 'python'
                }
            },
            'cells': []
        }

        # Write notebook file
        os.makedirs(os.path.dirname(normalized_path), exist_ok=True)
        with open(normalized_path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=2)

        # Invalidate cache so next access reads from fresh file
        self.invalidate(notebook_path)

        # Get mtime for sync
        mtime = os.path.getmtime(normalized_path)

        return {
            'success': True,
            'path': notebook_path,
            'mtime': mtime
        }

    async def _read_cell(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Read a single cell by ID or index"""
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        cell_index = operation.get('cellIndex')

        cells = self._get_cells(notebook_path)

        # Find cell
        target_index = None
        cell = None

        if cell_id:
            for i, c in enumerate(cells):
                if c.get('id') == cell_id:
                    target_index = i
                    cell = c
                    break
            if cell is None:
                return {'success': False, 'error': f'Cell with ID "{cell_id}" not found'}
        elif cell_index is not None:
            if cell_index < 0 or cell_index >= len(cells):
                return {'success': False, 'error': f'Cell index {cell_index} out of range'}
            target_index = cell_index
            cell = cells[cell_index]
        else:
            return {'success': False, 'error': 'Must provide cellId or cellIndex'}

        return {
            'success': True,
            'cellId': cell.get('id'),
            'cellIndex': target_index,
            'cell': {
                'id': cell.get('id'),
                'type': cell.get('type'),
                'content': cell.get('content', ''),
                'outputs': [{'type': o.get('type'), 'content': o.get('content', '')} for o in cell.get('outputs', [])],
                'executionCount': cell.get('executionCount'),
                'metadata': {
                    'scrolled': cell.get('scrolled'),
                    'scrolledHeight': cell.get('scrolledHeight'),
                },
            },
        }

    async def _read_cell_output(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Read outputs of a single cell by ID or index"""
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        cell_index = operation.get('cellIndex')

        cells = self._get_cells(notebook_path)

        # Find cell
        target_index = None
        cell = None

        if cell_id:
            for i, c in enumerate(cells):
                if c.get('id') == cell_id:
                    target_index = i
                    cell = c
                    break
            if cell is None:
                return {'success': False, 'error': f'Cell with ID "{cell_id}" not found'}
        elif cell_index is not None:
            if cell_index < 0 or cell_index >= len(cells):
                return {'success': False, 'error': f'Cell index {cell_index} out of range'}
            target_index = cell_index
            cell = cells[cell_index]
        else:
            return {'success': False, 'error': 'Must provide cellId or cellIndex'}

        return {
            'success': True,
            'cellId': cell.get('id'),
            'cellIndex': target_index,
            'outputs': [{'type': o.get('type'), 'content': o.get('content', '')} for o in cell.get('outputs', [])],
            'executionCount': cell.get('executionCount'),
        }

    async def _clear_notebook(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Clear all cells from a notebook.
        Returns deleted count and metadata for Phase 2 compatibility.
        """
        notebook_path = operation['notebookPath']

        cells = self._get_cells(notebook_path)
        deleted_count = len(cells)

        # Clear all cells
        self._save_cells(notebook_path, [])

        return {
            'success': True,
            'deletedCount': deleted_count,
            'totalCells': 0,
            'operationTime': None  # Placeholder for future timing integration
        }
