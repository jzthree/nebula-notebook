"""
Notebook Operation Router

Routes notebook operations to either:
1. Connected UI via WebSocket (real-time collaboration)
2. Headless notebook manager (file-based when no UI)

From the agent's (MCP) perspective, operations look identical regardless of mode.
"""
from __future__ import annotations

import asyncio
import uuid
from typing import Dict, Optional, Any
from dataclasses import dataclass, field
from pathlib import Path

from fastapi import WebSocket

from headless_handler import HeadlessOperationHandler
from cell_metadata import CELL_METADATA_SCHEMA, validate_metadata_value


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
        self._headless_manager: Optional[HeadlessOperationHandler] = None

        # Operation timeout in seconds
        self._operation_timeout = 30.0

        # Track active agent sessions - notebooks locked by agents
        # These should NOT fall back to headless if UI disconnects
        self._agent_sessions: set[str] = set()

    def set_headless_handler(self, handler: HeadlessOperationHandler):
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

    def start_agent_session(self, notebook_path: str):
        """Mark a notebook as being in an agent session"""
        normalized_path = str(Path(notebook_path).resolve())
        self._agent_sessions.add(normalized_path)
        print(f"[OperationRouter] Agent session started for: {normalized_path}")

    def end_agent_session(self, notebook_path: str):
        """Mark a notebook as no longer in an agent session"""
        normalized_path = str(Path(notebook_path).resolve())
        self._agent_sessions.discard(normalized_path)
        print(f"[OperationRouter] Agent session ended for: {normalized_path}")

    def is_agent_session(self, notebook_path: str) -> bool:
        """Check if a notebook is in an agent session"""
        normalized_path = str(Path(notebook_path).resolve())
        return normalized_path in self._agent_sessions

    async def apply_operation(self, operation: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply a notebook operation.

        Routes to UI if connected, otherwise uses headless manager.
        Returns operation result in unified format.
        """
        notebook_path = operation.get('notebookPath', '')
        normalized_path = str(Path(notebook_path).resolve())
        op_type = operation.get('type', 'unknown')

        # Debug logging
        print(f"[OperationRouter] apply_operation:")
        print(f"  op_type: {op_type}")
        print(f"  notebook_path: {notebook_path}")
        print(f"  normalized_path: {normalized_path}")
        print(f"  registered_uis: {list(self._ui_connections.keys())}")
        print(f"  has_ui: {normalized_path in self._ui_connections}")
        print(f"  is_agent_session: {normalized_path in self._agent_sessions}")

        if normalized_path in self._ui_connections:
            print(f"  -> Routing to UI")
            return await self._forward_to_ui(normalized_path, operation)
        else:
            # Check if this is an agent session - if so, fail instead of falling back
            if normalized_path in self._agent_sessions:
                print(f"  -> FAILING: Agent session but UI disconnected")
                return {
                    'success': False,
                    'error': 'Agent session active but UI disconnected. Cannot fall back to headless mode during agent session.'
                }
            print(f"  -> Routing to HEADLESS")
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

    async def read_notebook(
        self,
        notebook_path: str,
        include_outputs: bool = True,
        max_lines: int = None,
        max_chars: int = None,
        max_lines_error: int = None,
        max_chars_error: int = None
    ) -> Dict[str, Any]:
        """
        Read notebook state.

        If UI is connected, requests current state from UI.
        Otherwise reads from file.

        Args:
            notebook_path: Path to the notebook file
            include_outputs: Whether to include cell outputs (default: True)
            max_lines: Max lines per regular output (default: 100)
            max_chars: Max chars per regular output (default: 10000)
            max_lines_error: Max lines per error output (default: 200)
            max_chars_error: Max chars per error output (default: 20000)
        """
        normalized_path = str(Path(notebook_path).resolve())

        if normalized_path in self._ui_connections:
            # UI always returns full outputs - we apply truncation after
            result = await self._read_from_ui(normalized_path)
            if result.get('success'):
                # Always apply truncation (with defaults) when outputs included
                result = self._apply_output_truncation(
                    result, include_outputs, max_lines, max_chars,
                    max_lines_error, max_chars_error
                )
            return result
        else:
            return await self._read_from_file(
                notebook_path, include_outputs, max_lines, max_chars,
                max_lines_error, max_chars_error
            )

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

    async def _read_from_file(
        self,
        notebook_path: str,
        include_outputs: bool = True,
        max_lines: int = None,
        max_chars: int = None,
        max_lines_error: int = None,
        max_chars_error: int = None
    ) -> Dict[str, Any]:
        """Read notebook from file"""
        if self._headless_manager is None:
            return {
                'success': False,
                'error': 'Headless manager not configured'
            }

        return await self._headless_manager.read_notebook(
            notebook_path,
            include_outputs=include_outputs,
            max_lines=max_lines,
            max_chars=max_chars,
            max_lines_error=max_lines_error,
            max_chars_error=max_chars_error
        )

    def _apply_output_truncation(
        self,
        result: Dict[str, Any],
        include_outputs: bool,
        max_lines: int,
        max_chars: int,
        max_lines_error: int = None,
        max_chars_error: int = None
    ) -> Dict[str, Any]:
        """Apply output truncation to a read result (for UI-sourced data)

        When include_outputs=True, truncation is always applied with defaults.
        Error outputs get higher limits (200 lines, 20000 chars) by default.
        """
        if not result.get('success') or 'data' not in result:
            return result

        cells = result['data'].get('cells', [])
        if not include_outputs:
            # Strip outputs entirely
            result['data']['cells'] = [{**cell, 'outputs': []} for cell in cells]
            return result

        # Always apply truncation when outputs are included (use defaults if not specified)
        if self._headless_manager is not None:
            effective_max_lines = max_lines if max_lines is not None else 100
            effective_max_chars = max_chars if max_chars is not None else 10000
            effective_max_lines_error = max_lines_error if max_lines_error is not None else 200
            effective_max_chars_error = max_chars_error if max_chars_error is not None else 20000
            result['data']['cells'] = self._headless_manager._truncate_cell_outputs(
                cells, effective_max_lines, effective_max_chars,
                effective_max_lines_error, effective_max_chars_error
            )

        return result


# Global router instance
operation_router = OperationRouter()
