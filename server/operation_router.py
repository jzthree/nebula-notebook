"""
Notebook Operation Router

Routes notebook operations to either:
1. Connected UI via WebSocket (real-time collaboration)
2. Headless notebook manager (file-based when no UI)

From the agent's (MCP) perspective, operations look identical regardless of mode.
"""

import asyncio
import uuid
import json
from typing import Dict, Optional, Any, Callable, Awaitable
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import WebSocket


@dataclass
class UIConnection:
    """Represents an active UI connection for a notebook"""
    websocket: WebSocket
    notebook_path: str
    # Track pending operation requests
    pending_requests: Dict[str, asyncio.Future] = field(default_factory=dict)


class OperationRouter:
    """
    Routes notebook operations to UI or handles them in headless mode.

    Usage:
        router = OperationRouter()

        # When UI connects
        await router.register_ui(websocket, notebook_path)

        # When applying an operation (from MCP tool)
        result = await router.apply_operation(operation)

        # When UI disconnects
        router.unregister_ui(notebook_path)
    """

    def __init__(self):
        # Map of notebook_path -> UIConnection
        self._ui_connections: Dict[str, UIConnection] = {}

        # Headless operation handler (file-based fallback)
        self._headless_manager: Optional['HeadlessOperationHandler'] = None

        # Operation timeout in seconds
        self._operation_timeout = 30.0

    def set_headless_handler(self, handler: 'HeadlessOperationHandler'):
        """Set the headless operation handler for file-based operations"""
        self._headless_manager = handler

    async def register_ui(self, websocket: WebSocket, notebook_path: str):
        """Register a UI connection for a notebook path"""
        normalized_path = str(Path(notebook_path).resolve())

        # If there's an existing connection, close it
        if normalized_path in self._ui_connections:
            old_conn = self._ui_connections[normalized_path]
            # Cancel any pending requests
            for future in old_conn.pending_requests.values():
                if not future.done():
                    future.cancel()

        self._ui_connections[normalized_path] = UIConnection(
            websocket=websocket,
            notebook_path=normalized_path
        )
        print(f"[OperationRouter] UI registered for: {normalized_path}")

    def unregister_ui(self, notebook_path: str):
        """Unregister a UI connection"""
        normalized_path = str(Path(notebook_path).resolve())

        if normalized_path in self._ui_connections:
            conn = self._ui_connections.pop(normalized_path)
            # Cancel any pending requests
            for future in conn.pending_requests.values():
                if not future.done():
                    future.cancel()
            print(f"[OperationRouter] UI unregistered for: {normalized_path}")

    def has_ui(self, notebook_path: str) -> bool:
        """Check if a UI is connected for the notebook"""
        normalized_path = str(Path(notebook_path).resolve())
        return normalized_path in self._ui_connections

    async def apply_operation(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply a notebook operation.

        Routes to UI if connected, otherwise uses headless manager.
        Returns operation result in unified format.
        """
        notebook_path = operation.get('notebookPath', '')
        normalized_path = str(Path(notebook_path).resolve())

        if normalized_path in self._ui_connections:
            return await self._forward_to_ui(normalized_path, operation)
        else:
            return await self._apply_headless(operation)

    async def _forward_to_ui(self, notebook_path: str, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Forward operation to connected UI and wait for response"""
        conn = self._ui_connections[notebook_path]
        request_id = str(uuid.uuid4())

        # Create a future to wait for the response
        loop = asyncio.get_event_loop()
        response_future: asyncio.Future = loop.create_future()
        conn.pending_requests[request_id] = response_future

        try:
            # Send operation to UI
            message = {
                'type': 'operation',
                'operation': operation,
                'requestId': request_id
            }
            await conn.websocket.send_json(message)

            # Wait for response with timeout
            result = await asyncio.wait_for(
                response_future,
                timeout=self._operation_timeout
            )
            return result

        except asyncio.TimeoutError:
            return {
                'success': False,
                'error': f'Operation timed out after {self._operation_timeout}s'
            }
        except Exception as e:
            return {
                'success': False,
                'error': f'Failed to forward operation to UI: {str(e)}'
            }
        finally:
            # Clean up pending request
            conn.pending_requests.pop(request_id, None)

    def handle_ui_response(self, notebook_path: str, response: Dict[str, Any]):
        """Handle operation response from UI"""
        normalized_path = str(Path(notebook_path).resolve())

        if normalized_path not in self._ui_connections:
            print(f"[OperationRouter] Received response for unknown notebook: {notebook_path}")
            return

        conn = self._ui_connections[normalized_path]
        request_id = response.get('requestId')

        if request_id and request_id in conn.pending_requests:
            future = conn.pending_requests[request_id]
            if not future.done():
                result = response.get('result', {'success': False, 'error': 'No result in response'})
                future.set_result(result)

    async def _apply_headless(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Apply operation in headless mode (file-based)"""
        if self._headless_manager is None:
            return {
                'success': False,
                'error': 'Headless manager not configured'
            }

        return await self._headless_manager.apply_operation(operation)

    async def read_notebook(self, notebook_path: str) -> Dict[str, Any]:
        """
        Read notebook state.

        If UI is connected, requests current state from UI.
        Otherwise reads from file.
        """
        normalized_path = str(Path(notebook_path).resolve())

        if normalized_path in self._ui_connections:
            return await self._read_from_ui(normalized_path)
        else:
            return await self._read_from_file(notebook_path)

    async def _read_from_ui(self, notebook_path: str) -> Dict[str, Any]:
        """Request current notebook state from UI"""
        conn = self._ui_connections[notebook_path]
        request_id = str(uuid.uuid4())

        loop = asyncio.get_event_loop()
        response_future: asyncio.Future = loop.create_future()
        conn.pending_requests[request_id] = response_future

        try:
            message = {
                'type': 'readNotebook',
                'requestId': request_id
            }
            await conn.websocket.send_json(message)

            result = await asyncio.wait_for(
                response_future,
                timeout=self._operation_timeout
            )
            return result

        except asyncio.TimeoutError:
            # Fallback to file if UI doesn't respond
            print(f"[OperationRouter] UI read timeout, falling back to file")
            return await self._read_from_file(notebook_path)
        except Exception as e:
            return {
                'success': False,
                'error': f'Failed to read from UI: {str(e)}'
            }
        finally:
            conn.pending_requests.pop(request_id, None)

    async def _read_from_file(self, notebook_path: str) -> Dict[str, Any]:
        """Read notebook from file"""
        if self._headless_manager is None:
            return {
                'success': False,
                'error': 'Headless manager not configured'
            }

        return await self._headless_manager.read_notebook(notebook_path)


class HeadlessOperationHandler:
    """
    Handles notebook operations when no UI is connected.

    Reads from and writes to notebook files directly.
    This provides file-based fallback for MCP operations.

    Mirrors useOperationHandler (React) but operates on files instead of UI state.
    """

    def __init__(self, fs_service):
        """Initialize with filesystem service for notebook I/O"""
        self._fs_service = fs_service

    async def apply_operation(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Apply operation directly to notebook file"""
        op_type = operation.get('type')
        notebook_path = operation.get('notebookPath', '')

        try:
            if op_type == 'insertCell':
                return await self._insert_cell(operation)
            elif op_type == 'deleteCell':
                return await self._delete_cell(operation)
            elif op_type == 'updateContent':
                return await self._update_content(operation)
            elif op_type == 'updateMetadata':
                return await self._update_metadata(operation)
            elif op_type == 'moveCell':
                return await self._move_cell(operation)
            elif op_type == 'duplicateCell':
                return await self._duplicate_cell(operation)
            elif op_type == 'updateOutputs':
                return await self._update_outputs(operation)
            elif op_type == 'createNotebook':
                return await self._create_notebook(operation)
            else:
                return {
                    'success': False,
                    'error': f'Unknown operation type: {op_type}'
                }
        except Exception as e:
            return {
                'success': False,
                'error': str(e)
            }

    async def read_notebook(self, notebook_path: str) -> Dict[str, Any]:
        """Read notebook from file"""
        try:
            # get_notebook_cells already returns internal format
            result = self._fs_service.get_notebook_cells(notebook_path)
            cells = result.get('cells', [])
            return {
                'success': True,
                'data': {
                    'path': notebook_path,
                    'cells': cells,
                    'metadata': result.get('metadata', {})
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

        # Read current notebook (returns internal format with 'id', 'type', 'content')
        result = self._fs_service.get_notebook_cells(notebook_path)
        cells = result.get('cells', [])

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

        # Create cell in internal format (matching get_notebook_cells output)
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

        # Save notebook
        self._fs_service.save_notebook_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell_id,
            'cellIndex': actual_index,
            'idModified': id_modified,
            'requestedId': original_id if id_modified else None
        }

    async def _delete_cell(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Delete a cell"""
        notebook_path = operation['notebookPath']
        cell_id = operation.get('cellId')
        cell_index = operation.get('cellIndex')

        result = self._fs_service.get_notebook_cells(notebook_path)
        cells = result.get('cells', [])

        # Find cell to delete (internal format uses 'id' at top level)
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

        # Delete cell
        deleted_cell = cells.pop(target_index)

        # Save notebook
        self._fs_service.save_notebook_cells(notebook_path, cells)

        return {
            'success': True,
            'cellIndex': target_index
        }

    async def _update_content(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Update cell content"""
        notebook_path = operation['notebookPath']
        cell_id = operation['cellId']
        content = operation['content']

        result = self._fs_service.get_notebook_cells(notebook_path)
        cells = result.get('cells', [])

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

        # Update content (internal format uses 'content', not 'source')
        cells[target_index]['content'] = content

        # Save notebook
        self._fs_service.save_notebook_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell_id,
            'cellIndex': target_index
        }

    async def _update_metadata(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Update cell metadata"""
        notebook_path = operation['notebookPath']
        cell_id = operation['cellId']
        changes = operation['changes']

        result = self._fs_service.get_notebook_cells(notebook_path)
        cells = result.get('cells', [])

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

        cell = cells[target_index]
        old_values = {}

        # Apply changes (internal format uses 'type', not 'cell_type')
        if 'type' in changes:
            old_values['type'] = cell.get('type')
            cell['type'] = changes['type']

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

        if 'scrolled' in changes:
            cell['scrolled'] = changes['scrolled']

        if 'scrolledHeight' in changes:
            cell['scrolledHeight'] = changes['scrolledHeight']

        # Save notebook
        self._fs_service.save_notebook_cells(notebook_path, cells)

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

        result = self._fs_service.get_notebook_cells(notebook_path)
        cells = result.get('cells', [])

        if from_index < 0 or from_index >= len(cells):
            return {'success': False, 'error': 'Invalid from_index'}
        if to_index < 0 or to_index >= len(cells):
            return {'success': False, 'error': 'Invalid to_index'}

        # Move cell
        cell = cells.pop(from_index)
        cells.insert(to_index, cell)

        # Save notebook
        self._fs_service.save_notebook_cells(notebook_path, cells)

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

        result = self._fs_service.get_notebook_cells(notebook_path)
        cells = result.get('cells', [])

        if cell_index < 0 or cell_index >= len(cells):
            return {'success': False, 'error': 'Invalid cell_index'}

        # Deep copy the cell (internal format uses 'id', not 'metadata.nebula_id')
        import copy
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

        # Update the ID in internal format
        new_cell['id'] = actual_id
        # Clear outputs for duplicated cell
        new_cell['outputs'] = []
        new_cell['executionCount'] = None

        # Insert after original
        cells.insert(cell_index + 1, new_cell)

        # Save notebook
        self._fs_service.save_notebook_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': actual_id,
            'cellIndex': cell_index + 1,
            'idModified': id_modified,
            'totalCells': len(cells)
        }

    async def _update_outputs(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Update cell outputs"""
        notebook_path = operation['notebookPath']
        cell_id = operation['cellId']
        outputs = operation['outputs']
        execution_count = operation.get('executionCount')

        result = self._fs_service.get_notebook_cells(notebook_path)
        cells = result.get('cells', [])

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

        # Save notebook
        self._fs_service.save_notebook_cells(notebook_path, cells)

        return {
            'success': True,
            'cellId': cell_id,
            'cellIndex': target_index
        }

    async def _create_notebook(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """Create a new notebook file"""
        import os

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

        # Get mtime for sync
        mtime = os.path.getmtime(normalized_path)

        return {
            'success': True,
            'path': notebook_path,
            'mtime': mtime
        }


# Global router instance
operation_router = OperationRouter()
