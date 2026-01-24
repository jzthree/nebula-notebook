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
import tempfile
import time
import uuid
from typing import Dict, Any, Optional, Tuple, List

from cell_metadata import validate_metadata_value
from kernel_service import kernel_service

# Output truncation defaults for MCP read_output
OUTPUT_DEFAULT_MAX_LINES = 100
OUTPUT_DEFAULT_MAX_CHARS = 10000
# Separate limits for error outputs (tracebacks need more context)
OUTPUT_DEFAULT_MAX_LINES_ERROR = 200
OUTPUT_DEFAULT_MAX_CHARS_ERROR = 20000


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

    def _check_agent_permission(self, notebook_path: str, operation_type: str) -> Optional[Dict[str, Any]]:
        """
        Check if agent has permission to modify this notebook.

        Agent can modify a notebook if:
        1. Notebook was created by agent (nebula.agent_created = true), OR
        2. User explicitly permitted it (nebula.agent_permitted = true), AND history exists

        For user-permitted notebooks, history must exist as a safety measure.

        Returns None if permitted, or an error dict if not permitted.
        """
        # Check if notebook is agent-created (always permitted)
        if self._fs_service.is_agent_permitted(notebook_path):
            # For agent-created notebooks, no additional checks needed
            metadata = self._fs_service.get_notebook_metadata(notebook_path)
            nebula = metadata.get("nebula", {})
            if nebula.get("agent_created", False):
                return None  # Agent-created notebooks are always modifiable

            # For user-permitted notebooks, require history as safety measure
            if not self._fs_service.has_history(notebook_path):
                return {
                    'success': False,
                    'error': f'Agent cannot modify "{notebook_path}": notebook is user-permitted but history is not enabled. '
                             f'Open the notebook in the UI first to enable history tracking, or the agent can create a new notebook.'
                }
            return None  # User-permitted with history

        # Not permitted - provide helpful error message
        return {
            'success': False,
            'error': f'Agent cannot modify "{notebook_path}": notebook is not agent-permitted. '
                     f'Either open the notebook in Nebula UI and grant agent permission, '
                     f'or the agent can create a new notebook which will be automatically permitted.'
        }

    async def apply_operation(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply operation to notebook (in-memory) and auto-flush to disk.

        Write operations update cache then persist. Read operations use cache only.
        """
        op_type = operation.get('type')
        notebook_path = operation.get('notebookPath', '')

        # Read-only operations (no flush needed, no permission check needed)
        read_only_ops = {'readCell', 'readCellOutput', 'searchCells', 'startAgentSession', 'endAgentSession'}

        # Operations that don't require permission (create new or read-only)
        permission_exempt_ops = {'createNotebook', 'readCell', 'readCellOutput', 'searchCells', 'startAgentSession', 'endAgentSession'}

        # Check agent permission for write operations on existing notebooks
        if op_type not in permission_exempt_ops and notebook_path:
            permission_error = self._check_agent_permission(notebook_path, op_type)
            if permission_error:
                return permission_error

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
            # Batch operations (Phase 1 enhancements)
            elif op_type == 'deleteCells':
                result = await self._delete_cells(operation)
            elif op_type == 'insertCells':
                result = await self._insert_cells(operation)
            elif op_type == 'searchCells':
                result = await self._search_cells(operation)
            elif op_type == 'clearOutputs':
                result = await self._clear_outputs(operation)
            elif op_type == 'executeCell':
                result = await self._execute_cell(operation)
            elif op_type == 'startAgentSession':
                # Track agent session in router to prevent headless fallback
                agent_id = operation.get('agentId', 'unknown')
                client_name = operation.get('clientName')
                client_version = operation.get('clientVersion')
                if self._operation_router:
                    result = self._operation_router.start_agent_session(
                        notebook_path, agent_id, client_name, client_version
                    )
                else:
                    import time
                    now = time.time()
                    result = {
                        'success': True,
                        'lock': {
                            'agent_id': agent_id,
                            'client_name': client_name,
                            'client_version': client_version,
                            'expires_at': now + 5 * 60,
                            'locked_at': now
                        }
                    }
            elif op_type == 'endAgentSession':
                # End agent session tracking in router
                agent_id = operation.get('agentId', 'unknown')
                if self._operation_router:
                    result = self._operation_router.end_agent_session(notebook_path, agent_id)
                else:
                    result = {'success': True}
            elif op_type == 'undo':
                # Undo requires UI to be connected (undo state is maintained in browser)
                return {
                    'success': False,
                    'error': 'Undo requires the notebook to be open in the browser. Undo state is maintained in the UI.'
                }
            elif op_type == 'redo':
                # Redo requires UI to be connected (redo state is maintained in browser)
                return {
                    'success': False,
                    'error': 'Redo requires the notebook to be open in the browser. Redo state is maintained in the UI.'
                }
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

    async def read_notebook(
        self,
        notebook_path: str,
        include_outputs: bool = True,
        max_lines: int = None,
        max_chars: int = None,
        max_lines_error: int = None,
        max_chars_error: int = None
    ) -> Dict[str, Any]:
        """Read notebook from cache (loads from disk on first access)

        Args:
            notebook_path: Path to the notebook file
            include_outputs: Whether to include cell outputs (default: True)
            max_lines: Max lines per regular output (default: 100)
            max_chars: Max chars per regular output (default: 10000)
            max_lines_error: Max lines per error output (default: 200)
            max_chars_error: Max chars per error output (default: 20000)

        When include_outputs=True, truncation is always applied with defaults.
        Error outputs get higher limits since tracebacks need more context.
        """
        try:
            notebook = self._get_cached_notebook(notebook_path)
            cells = notebook['cells']

            if include_outputs:
                # Always apply truncation when outputs are included
                effective_max_lines = max_lines if max_lines is not None else OUTPUT_DEFAULT_MAX_LINES
                effective_max_chars = max_chars if max_chars is not None else OUTPUT_DEFAULT_MAX_CHARS
                effective_max_lines_error = max_lines_error if max_lines_error is not None else OUTPUT_DEFAULT_MAX_LINES_ERROR
                effective_max_chars_error = max_chars_error if max_chars_error is not None else OUTPUT_DEFAULT_MAX_CHARS_ERROR
                cells = self._truncate_cell_outputs(
                    cells, effective_max_lines, effective_max_chars,
                    effective_max_lines_error, effective_max_chars_error
                )
            else:
                # Strip outputs entirely
                cells = [{**cell, 'outputs': []} for cell in cells]

            return {
                'success': True,
                'data': {
                    'path': notebook_path,
                    'cells': cells,
                    'metadata': notebook.get('metadata', {})
                }
            }
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    def _truncate_cell_outputs(
        self,
        cells: list,
        max_lines: int,
        max_chars: int,
        max_lines_error: int = None,
        max_chars_error: int = None
    ) -> list:
        """Apply truncation to outputs of all cells

        Args:
            cells: List of cells to process
            max_lines: Max lines for regular outputs (stdout, stderr)
            max_chars: Max chars for regular outputs
            max_lines_error: Max lines for error outputs (default: same as max_lines)
            max_chars_error: Max chars for error outputs (default: same as max_chars)
        """
        # Default error limits to regular limits if not specified
        effective_max_lines_error = max_lines_error if max_lines_error is not None else max_lines
        effective_max_chars_error = max_chars_error if max_chars_error is not None else max_chars

        truncated_cells = []
        for cell in cells:
            outputs = cell.get('outputs', [])
            truncated_outputs = []

            for output in outputs:
                content = output.get('content', '')
                output_type = output.get('type', 'stdout')

                # Skip truncation for binary/image outputs
                if output_type in ('image', 'html'):
                    truncated_outputs.append({
                        **output,
                        'is_binary': output_type == 'image'
                    })
                    continue

                # Use separate limits for error outputs (tracebacks need more context)
                if output_type == 'error':
                    lines_limit = effective_max_lines_error
                    chars_limit = effective_max_chars_error
                else:
                    lines_limit = max_lines
                    chars_limit = max_chars

                # Apply truncation
                truncated_content, metadata = self._truncate_output(
                    content, lines_limit, chars_limit, 0
                )

                truncated_outputs.append({
                    'type': output_type,
                    'content': truncated_content,
                    **metadata
                })

            truncated_cells.append({
                **cell,
                'outputs': truncated_outputs
            })

        return truncated_cells

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
        """
        Move a cell to a new position.

        Supports two modes:
        1. By index: fromIndex, toIndex (legacy)
        2. By ID: cellId, afterCellId (or toIndex=-1 for start)

        Parameters:
            notebookPath: Path to notebook
            fromIndex: Source index (legacy mode)
            toIndex: Target index (legacy mode)
            cellId: ID of cell to move (ID mode)
            afterCellId: Move after this cell (ID mode, optional)
            toIndex: -1 to move to start, or target index (with cellId)
        """
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        from_index = operation.get('fromIndex')
        to_index = operation.get('toIndex')
        after_cell_id = operation.get('afterCellId')

        cells = self._get_cells(notebook_path)

        # Determine source cell
        if cell_id:
            # Find by ID
            from_index = None
            for i, cell in enumerate(cells):
                if cell.get('id') == cell_id:
                    from_index = i
                    break
            if from_index is None:
                return {'success': False, 'error': f'Cell with ID "{cell_id}" not found'}
        elif from_index is None:
            return {'success': False, 'error': 'Must provide cellId or fromIndex'}

        if from_index < 0 or from_index >= len(cells):
            return {'success': False, 'error': 'Invalid from_index'}

        # Determine target position
        if after_cell_id:
            # Move after specified cell
            target_index = None
            for i, cell in enumerate(cells):
                if cell.get('id') == after_cell_id:
                    target_index = i + 1  # Insert after this cell
                    break
            if target_index is None:
                return {'success': False, 'error': f'Cell with ID "{after_cell_id}" not found'}
            # Adjust if moving from before target
            if from_index < target_index:
                target_index -= 1
            to_index = target_index
        elif to_index == -1:
            # Move to start (before all cells)
            to_index = 0
        elif to_index is None:
            return {'success': False, 'error': 'Must provide afterCellId or toIndex'}

        if to_index < 0 or to_index >= len(cells):
            return {'success': False, 'error': 'Invalid to_index'}

        # Perform move
        cell = cells.pop(from_index)
        cells.insert(to_index, cell)
        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell.get('id'),
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

        # Create empty notebook structure with agent permission marker
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
                },
                'nebula': {
                    'agent_created': True,
                    'agent_permitted': True
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

    def _truncate_output(
        self,
        content: str,
        max_lines: int,
        max_chars: int,
        line_offset: int = 0
    ) -> Tuple[str, Dict[str, Any]]:
        """
        Truncate output content with pagination support.

        Returns: (truncated_content, metadata)
        """
        lines = content.split('\n')
        total_lines = len(lines)
        total_chars = len(content)

        # Apply line offset
        if line_offset > 0:
            lines = lines[line_offset:]

        # Track what we're returning
        start_line = line_offset
        end_line = start_line
        char_count = 0
        truncated = False
        truncation_reason = None
        result_lines = []

        for i, line in enumerate(lines):
            # Check if adding this line would exceed limits
            new_char_count = char_count + len(line) + (1 if i > 0 else 0)  # +1 for newline

            if i >= max_lines:
                truncated = True
                truncation_reason = 'lines'
                break

            if new_char_count > max_chars and i > 0:  # Always include at least 1 line
                truncated = True
                truncation_reason = 'chars'
                break

            result_lines.append(line)
            char_count = new_char_count
            end_line = start_line + i + 1

        truncated_content = '\n'.join(result_lines)

        metadata = {
            'truncated': truncated,
            'truncation_reason': truncation_reason,
            'total_lines': total_lines,
            'total_chars': total_chars,
            'returned_range': {
                'start_line': start_line,
                'end_line': end_line,
                'char_count': len(truncated_content),
            }
        }

        return truncated_content, metadata

    def _save_output_to_temp_file(self, content: str, cell_id: str) -> str:
        """Save output to a temp file and return the path."""
        # Create nebula temp directory
        temp_dir = os.path.join(tempfile.gettempdir(), 'nebula', 'outputs')
        os.makedirs(temp_dir, exist_ok=True)

        # Generate unique filename
        filename = f"cell_output_{cell_id}_{uuid.uuid4().hex[:8]}.txt"
        filepath = os.path.join(temp_dir, filename)

        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)

        return filepath

    async def _read_cell_output(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Read outputs of a single cell by ID or index with smart truncation.

        Parameters:
            notebookPath: Path to notebook
            cellId/cellIndex: Cell identifier
            max_lines: Max lines for regular output (default: 100)
            max_chars: Max characters for regular output (default: 10000)
            max_lines_error: Max lines for error output (default: 200)
            max_chars_error: Max characters for error output (default: 20000)
            line_offset: Start from line N for pagination (default: 0)
            save_to_file: Save full output to temp file (default: false)
            maxWait: Wait up to N seconds for new outputs (default: 0)

        Returns truncated output with metadata about full output size.
        Use save_to_file=true to save the complete output for analysis.
        Use maxWait > 0 to poll for new outputs from long-running cells.
        """
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        cell_index = operation.get('cellIndex')
        max_wait = operation.get('maxWait', 0)  # Polling timeout in seconds

        # Truncation parameters (separate limits for errors)
        max_lines = operation.get('max_lines', OUTPUT_DEFAULT_MAX_LINES)
        max_chars = operation.get('max_chars', OUTPUT_DEFAULT_MAX_CHARS)
        max_lines_error = operation.get('max_lines_error', OUTPUT_DEFAULT_MAX_LINES_ERROR)
        max_chars_error = operation.get('max_chars_error', OUTPUT_DEFAULT_MAX_CHARS_ERROR)
        line_offset = operation.get('line_offset', 0)
        save_to_file = operation.get('save_to_file', False)

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

        # If max_wait > 0, poll for new outputs
        if max_wait > 0:
            initial_output_count = len(cell.get('outputs', []))
            initial_output_chars = sum(len(o.get('content', '')) for o in cell.get('outputs', []))
            start_time = time.time()
            poll_interval = 0.5  # Poll every 500ms

            while time.time() - start_time < max_wait:
                await asyncio.sleep(poll_interval)
                # Re-read cells to get updated outputs
                cells = self._get_cells(notebook_path)
                # Re-find cell (use target_index since we already validated it)
                cell = cells[target_index]
                current_output_count = len(cell.get('outputs', []))
                current_output_chars = sum(len(o.get('content', '')) for o in cell.get('outputs', []))

                # Check if outputs changed (more outputs or more content)
                if current_output_count > initial_output_count or current_output_chars > initial_output_chars:
                    break  # New output arrived

        # Process each output with truncation
        processed_outputs = []
        temp_files = []

        for output in cell.get('outputs', []):
            output_type = output.get('type', '')
            content = output.get('content', '')

            # Images are returned as-is (not affected by truncation limits)
            if output_type == 'image':
                processed_outputs.append({
                    'type': output_type,
                    'content': content,  # Return actual base64 image data
                    'truncated': False,
                    'is_binary': True,
                })
                continue

            # Calculate total size
            total_lines = content.count('\n') + 1 if content else 0
            total_chars = len(content)

            # Only save to temp file if explicitly requested
            temp_file_path = None
            if save_to_file and content:
                temp_file_path = self._save_output_to_temp_file(
                    content,
                    cell.get('id', f'cell_{target_index}')
                )
                temp_files.append(temp_file_path)

            # Use separate limits for error outputs (tracebacks need more context)
            if output_type == 'error':
                lines_limit = max_lines_error
                chars_limit = max_chars_error
            else:
                lines_limit = max_lines
                chars_limit = max_chars

            # Apply truncation
            truncated_content, truncation_meta = self._truncate_output(
                content, lines_limit, chars_limit, line_offset
            )

            processed_output = {
                'type': output_type,
                'content': truncated_content,
                **truncation_meta,
            }

            if temp_file_path:
                processed_output['temp_file'] = temp_file_path
                processed_output['temp_file_size'] = total_chars

            processed_outputs.append(processed_output)

        return {
            'success': True,
            'cellId': cell.get('id'),
            'cellIndex': target_index,
            'outputs': processed_outputs,
            'executionCount': cell.get('executionCount'),
            'output_count': len(processed_outputs),
            'temp_files': temp_files if temp_files else None,
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

    # =========================================================================
    # Batch Operations (Phase 1 enhancements)
    # =========================================================================

    async def _delete_cells(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Delete multiple cells by ID in a single operation.
        More efficient than multiple single deletes.
        """
        notebook_path = operation['notebookPath']
        cell_ids = operation.get('cellIds', [])

        if not cell_ids:
            return {'success': False, 'error': 'No cell IDs provided'}

        cells = self._get_cells(notebook_path)
        original_count = len(cells)

        # Find indices to delete (in reverse order to avoid index shifting)
        indices_to_delete = []
        deleted_ids = []
        not_found = []

        for cell_id in cell_ids:
            found = False
            for i, cell in enumerate(cells):
                if cell.get('id') == cell_id:
                    indices_to_delete.append(i)
                    deleted_ids.append(cell_id)
                    found = True
                    break
            if not found:
                not_found.append(cell_id)

        # Delete in reverse order to maintain correct indices
        for idx in sorted(indices_to_delete, reverse=True):
            cells.pop(idx)

        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'deletedCount': len(deleted_ids),
            'deletedIds': deleted_ids,
            'notFound': not_found if not_found else None,
            'totalCells': len(cells)
        }

    async def _insert_cells(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Insert multiple cells at a position in a single operation.
        More efficient than multiple single inserts.
        """
        notebook_path = operation['notebookPath']
        position = operation.get('position', -1)  # -1 means append at end
        new_cells = operation.get('cells', [])

        if not new_cells:
            return {'success': False, 'error': 'No cells provided'}

        cells = self._get_cells(notebook_path)

        # Validate and prepare cells
        inserted_cells = []
        for i, cell_data in enumerate(new_cells):
            cell_id = cell_data.get('id') or f'cell-{len(cells) + i}-{id(cell_data)}'
            cell = {
                'id': cell_id,
                'type': cell_data.get('type', 'code'),
                'content': cell_data.get('content', ''),
                'outputs': cell_data.get('outputs', []),
                'executionCount': cell_data.get('executionCount'),
            }
            inserted_cells.append(cell)

        # Insert at position
        if position < 0 or position >= len(cells):
            # Append at end
            insert_index = len(cells)
            cells.extend(inserted_cells)
        else:
            insert_index = position
            for i, cell in enumerate(inserted_cells):
                cells.insert(position + i, cell)

        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'insertedCount': len(inserted_cells),
            'insertedIds': [c['id'] for c in inserted_cells],
            'startIndex': insert_index,
            'totalCells': len(cells)
        }

    async def _search_cells(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Search cells by keyword in source and/or outputs.
        """
        notebook_path = operation['notebookPath']
        query = operation.get('query', '')
        include_outputs = operation.get('includeOutputs', False)
        limit = operation.get('limit', 10)

        if not query:
            return {'success': False, 'error': 'No search query provided'}

        cells = self._get_cells(notebook_path)
        query_lower = query.lower()
        matches = []

        for i, cell in enumerate(cells):
            cell_id = cell.get('id', f'cell-{i}')
            content = cell.get('content', '')

            # Search in source
            if query_lower in content.lower():
                # Find line number of first match
                lines = content.split('\n')
                match_line = None
                for line_num, line in enumerate(lines):
                    if query_lower in line.lower():
                        match_line = line_num
                        break

                matches.append({
                    'cellId': cell_id,
                    'cellIndex': i,
                    'matchLocation': 'source',
                    'matchLine': match_line,
                    'preview': content[:200] + ('...' if len(content) > 200 else '')
                })

            # Search in outputs if requested
            if include_outputs:
                for out_idx, output in enumerate(cell.get('outputs', [])):
                    out_content = output.get('content', '')
                    if query_lower in out_content.lower():
                        matches.append({
                            'cellId': cell_id,
                            'cellIndex': i,
                            'matchLocation': 'output',
                            'outputIndex': out_idx,
                            'outputType': output.get('type', 'unknown'),
                            'preview': out_content[:200] + ('...' if len(out_content) > 200 else '')
                        })

            if len(matches) >= limit:
                break

        return {
            'success': True,
            'query': query,
            'matchCount': len(matches),
            'matches': matches[:limit],
            'hasMore': len(matches) > limit
        }

    async def _clear_outputs(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Clear outputs from one or more cells without re-executing.
        Useful for cleanup before sharing notebooks.
        """
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        cell_ids = operation.get('cellIds', [])

        # Support both single ID and list of IDs
        if cell_id and not cell_ids:
            cell_ids = [cell_id]

        cells = self._get_cells(notebook_path)
        cleared_ids = []
        not_found = []

        if not cell_ids:
            # Clear all cells if no IDs specified
            for cell in cells:
                if cell.get('outputs'):
                    cell['outputs'] = []
                    cell['executionCount'] = None
                    cleared_ids.append(cell.get('id'))
        else:
            # Clear specific cells
            for cid in cell_ids:
                found = False
                for cell in cells:
                    if cell.get('id') == cid:
                        cell['outputs'] = []
                        cell['executionCount'] = None
                        cleared_ids.append(cid)
                        found = True
                        break
                if not found:
                    not_found.append(cid)

        self._save_cells(notebook_path, cells)

        return {
            'success': True,
            'clearedCount': len(cleared_ids),
            'clearedIds': cleared_ids,
            'notFound': not_found if not_found else None
        }

    async def _execute_cell(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute a cell in headless mode.

        Routes to kernel service for execution. For long-running cells,
        returns with status='busy' after max_wait seconds.
        """
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        cell_index = operation.get('cellIndex')
        session_id = operation.get('sessionId')
        max_wait = operation.get('maxWait', 10)  # Default 10 seconds
        save_outputs = operation.get('saveOutputs', True)

        cells = self._get_cells(notebook_path)

        # Find the cell
        if cell_id:
            found_index = None
            for i, cell in enumerate(cells):
                if cell.get('id') == cell_id:
                    found_index = i
                    break
            if found_index is None:
                return {'success': False, 'error': f'Cell with ID "{cell_id}" not found'}
            cell_index = found_index
        elif cell_index is not None:
            if cell_index < 0 or cell_index >= len(cells):
                return {'success': False, 'error': f'Cell index {cell_index} out of range'}
        else:
            return {'success': False, 'error': 'Must provide cellId or cellIndex'}

        cell = cells[cell_index]
        cell_id = cell.get('id')

        if cell.get('type') != 'code':
            return {'success': False, 'error': f'Cell {cell_index} is not a code cell'}

        code = cell.get('content', '')
        if not code.strip():
            # Empty cell - just clear outputs
            cell['outputs'] = []
            cell['executionCount'] = None
            if save_outputs:
                self._save_cells(notebook_path, cells)
            return {
                'success': True,
                'cellId': cell_id,
                'cellIndex': cell_index,
                'executionStatus': 'idle',
                'outputs': [],
                'executionCount': None
            }

        # Get or create kernel session
        if not session_id:
            # Try to get existing session for this file
            for sid, session in kernel_service.sessions.items():
                if session.file_path == notebook_path:
                    session_id = sid
                    break

            # Create new session if needed
            if not session_id:
                try:
                    session = await kernel_service.start_kernel(file_path=notebook_path)
                    session_id = session.id
                except Exception as e:
                    return {'success': False, 'error': f'Failed to start kernel: {e}'}

        # Verify session exists
        if session_id not in kernel_service.sessions:
            return {'success': False, 'error': f'Session {session_id} not found'}

        # Execute with timeout
        outputs: List[Dict[str, Any]] = []
        execution_count = None
        start_time = time.time()
        execution_complete = asyncio.Event()
        execution_error = None

        async def output_callback(output: Dict[str, Any]):
            nonlocal execution_count
            outputs.append(output)
            # Save outputs periodically if requested
            if save_outputs and len(outputs) % 5 == 0:
                cell['outputs'] = outputs.copy()
                self._save_cells(notebook_path, cells)

        async def execute_task():
            nonlocal execution_count, execution_error
            try:
                result = await kernel_service.execute_code(session_id, code, output_callback)
                execution_count = result.get('execution_count')
                if result.get('status') == 'error':
                    execution_error = result.get('error')
            except Exception as e:
                execution_error = str(e)
            finally:
                execution_complete.set()

        # Start execution in background
        task = asyncio.create_task(execute_task())

        # Wait for completion or timeout
        try:
            await asyncio.wait_for(execution_complete.wait(), timeout=max_wait)
            status = 'error' if execution_error else 'idle'
        except asyncio.TimeoutError:
            status = 'busy'  # Still running

        elapsed = time.time() - start_time

        # Update cell outputs
        cell['outputs'] = outputs.copy()
        if execution_count is not None:
            cell['executionCount'] = execution_count

        if save_outputs:
            self._save_cells(notebook_path, cells)

        result = {
            'success': True,
            'cellId': cell_id,
            'cellIndex': cell_index,
            'executionStatus': status,
            'executionCount': execution_count,
            'outputs': outputs,
            'executionTime': int(elapsed * 1000),  # ms
            'sessionId': session_id,
            'error': execution_error
        }
        # Add helpful message when cell is still running
        if status == 'busy':
            result['message'] = f'Cell still executing after {max_wait}s. Use read_output with max_wait to poll for results.'
        return result
