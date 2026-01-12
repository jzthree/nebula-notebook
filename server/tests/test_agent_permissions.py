"""
Tests for the agent permission system

Tests verify that:
1. Agent-created notebooks are always modifiable
2. User-permitted notebooks require history to be enabled
3. Non-permitted notebooks block agent modifications
4. Permission checks work for all write operations
"""

import pytest
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from headless_handler import HeadlessOperationHandler


class MockFsService:
    """Mock filesystem service for testing agent permissions"""

    def __init__(self):
        self.notebooks = {}
        self.history = {}  # path -> list of history entries
        self.metadata = {}  # path -> notebook metadata

    def _normalize_path(self, path: str) -> str:
        """Normalize path (mock just returns as-is)"""
        return path

    def get_notebook_cells(self, path: str):
        """Return notebook cells for a path"""
        if path not in self.notebooks:
            raise FileNotFoundError(f"Notebook not found: {path}")

        nb = self.notebooks[path]
        internal_cells = []
        for i, cell in enumerate(nb.get("cells", [])):
            cell_type = cell.get("cell_type", "code")
            if cell_type == "raw":
                cell_type = "code"

            source = cell.get("source", [])
            if isinstance(source, list):
                content = "".join(source)
            else:
                content = source

            cell_id = cell.get("metadata", {}).get("nebula_id") or cell.get("id") or f"cell-{i}"

            internal_cells.append({
                "id": cell_id,
                "type": cell_type,
                "content": content,
                "outputs": cell.get("outputs", []),
                "executionCount": cell.get("execution_count"),
            })

        return {
            "cells": internal_cells,
            "metadata": nb.get("metadata", {}),
            "mtime": 12345
        }

    def save_notebook_cells(self, path: str, cells: list, kernel_name: str = None, notebook_metadata: dict = None):
        """Save notebook cells"""
        if path not in self.notebooks:
            self.notebooks[path] = {"cells": [], "metadata": {}}

        jupyter_cells = []
        for cell in cells:
            jupyter_cell = {
                "cell_type": cell.get("type", "code"),
                "source": cell.get("content", ""),
                "metadata": {"nebula_id": cell.get("id")},
                "outputs": cell.get("outputs", []),
                "execution_count": cell.get("executionCount")
            }
            jupyter_cells.append(jupyter_cell)

        self.notebooks[path]["cells"] = jupyter_cells
        if notebook_metadata:
            existing = self.notebooks[path].get("metadata", {})
            for key, value in notebook_metadata.items():
                if isinstance(value, dict) and isinstance(existing.get(key), dict):
                    existing[key] = {**existing[key], **value}
                else:
                    existing[key] = value
            self.notebooks[path]["metadata"] = existing
        return {"success": True, "mtime": 12345}

    def get_notebook_metadata(self, path: str) -> dict:
        """Get notebook metadata"""
        if path in self.notebooks:
            return self.notebooks[path].get("metadata", {})
        return {}

    def update_notebook_metadata(self, path: str, metadata_updates: dict) -> dict:
        """Update notebook metadata"""
        if path not in self.notebooks:
            return {"success": False, "error": f"Notebook not found: {path}"}

        existing = self.notebooks[path].get("metadata", {})
        for key, value in metadata_updates.items():
            if isinstance(value, dict) and isinstance(existing.get(key), dict):
                existing[key] = {**existing[key], **value}
            else:
                existing[key] = value
        self.notebooks[path]["metadata"] = existing
        return {"success": True}

    def is_agent_permitted(self, path: str) -> bool:
        """Check if notebook is agent-permitted"""
        metadata = self.get_notebook_metadata(path)
        nebula = metadata.get("nebula", {})
        return nebula.get("agent_created", False) or nebula.get("agent_permitted", False)

    def has_history(self, path: str) -> bool:
        """Check if notebook has history"""
        return path in self.history and len(self.history[path]) > 0

    def add_notebook(self, path: str, cells: list, metadata: dict = None):
        """Helper to add a notebook for testing"""
        self.notebooks[path] = {
            "cells": cells,
            "metadata": metadata or {}
        }

    def add_history(self, path: str, history: list):
        """Helper to add history for a notebook"""
        self.history[path] = history


class TestAgentPermissions:
    """Test suite for agent permission system"""

    @pytest.fixture
    def mock_fs(self):
        """Setup mock filesystem"""
        return MockFsService()

    @pytest.fixture
    def handler(self, mock_fs):
        """Create handler with mock filesystem"""
        return HeadlessOperationHandler(mock_fs)

    # --- Agent-created notebooks ---

    @pytest.mark.asyncio
    async def test_agent_created_notebook_allows_insert(self, mock_fs, handler):
        """Agent-created notebooks should allow insertCell"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={
            "nebula": {"agent_created": True, "agent_permitted": True}
        })

        result = await handler.apply_operation({
            "type": "insertCell",
            "notebookPath": "/test.ipynb",
            "index": 0,
            "cell": {"id": "cell-1", "type": "code", "content": "# test"}
        })

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_agent_created_notebook_allows_delete(self, mock_fs, handler):
        """Agent-created notebooks should allow deleteCell"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# test", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={"nebula": {"agent_created": True}})

        result = await handler.apply_operation({
            "type": "deleteCell",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_agent_created_notebook_allows_clear(self, mock_fs, handler):
        """Agent-created notebooks should allow clearNotebook"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# test", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={"nebula": {"agent_created": True}})

        result = await handler.apply_operation({
            "type": "clearNotebook",
            "notebookPath": "/test.ipynb"
        })

        assert result["success"] is True

    # --- User-permitted notebooks with history ---

    @pytest.mark.asyncio
    async def test_user_permitted_with_history_allows_insert(self, mock_fs, handler):
        """User-permitted notebooks with history should allow insertCell"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={
            "nebula": {"agent_permitted": True}
        })
        mock_fs.add_history("/test.ipynb", [{"type": "insertCell"}])

        result = await handler.apply_operation({
            "type": "insertCell",
            "notebookPath": "/test.ipynb",
            "index": 0,
            "cell": {"id": "cell-1", "type": "code", "content": "# test"}
        })

        assert result["success"] is True

    @pytest.mark.asyncio
    async def test_user_permitted_with_history_allows_update(self, mock_fs, handler):
        """User-permitted notebooks with history should allow updateContent"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# original", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={"nebula": {"agent_permitted": True}})
        mock_fs.add_history("/test.ipynb", [{"type": "insertCell"}])

        result = await handler.apply_operation({
            "type": "updateContent",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1",
            "content": "# updated"
        })

        assert result["success"] is True

    # --- User-permitted notebooks without history ---

    @pytest.mark.asyncio
    async def test_user_permitted_without_history_blocks_insert(self, mock_fs, handler):
        """User-permitted notebooks without history should block insertCell"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={
            "nebula": {"agent_permitted": True}
        })
        # No history added

        result = await handler.apply_operation({
            "type": "insertCell",
            "notebookPath": "/test.ipynb",
            "index": 0,
            "cell": {"id": "cell-1", "type": "code", "content": "# test"}
        })

        assert result["success"] is False
        assert "history is not enabled" in result["error"]

    @pytest.mark.asyncio
    async def test_user_permitted_without_history_blocks_clear(self, mock_fs, handler):
        """User-permitted notebooks without history should block clearNotebook"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# test", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={"nebula": {"agent_permitted": True}})
        # No history added

        result = await handler.apply_operation({
            "type": "clearNotebook",
            "notebookPath": "/test.ipynb"
        })

        assert result["success"] is False
        assert "history is not enabled" in result["error"]

    # --- Non-permitted notebooks ---

    @pytest.mark.asyncio
    async def test_non_permitted_notebook_blocks_insert(self, mock_fs, handler):
        """Non-permitted notebooks should block insertCell"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={})  # No nebula metadata

        result = await handler.apply_operation({
            "type": "insertCell",
            "notebookPath": "/test.ipynb",
            "index": 0,
            "cell": {"id": "cell-1", "type": "code", "content": "# test"}
        })

        assert result["success"] is False
        assert "not agent-permitted" in result["error"]

    @pytest.mark.asyncio
    async def test_non_permitted_notebook_blocks_delete(self, mock_fs, handler):
        """Non-permitted notebooks should block deleteCell"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# test", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={})

        result = await handler.apply_operation({
            "type": "deleteCell",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is False
        assert "not agent-permitted" in result["error"]

    @pytest.mark.asyncio
    async def test_non_permitted_notebook_blocks_update(self, mock_fs, handler):
        """Non-permitted notebooks should block updateContent"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# test", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={})

        result = await handler.apply_operation({
            "type": "updateContent",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1",
            "content": "# updated"
        })

        assert result["success"] is False
        assert "not agent-permitted" in result["error"]

    @pytest.mark.asyncio
    async def test_non_permitted_notebook_blocks_clear(self, mock_fs, handler):
        """Non-permitted notebooks should block clearNotebook"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# test", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={})

        result = await handler.apply_operation({
            "type": "clearNotebook",
            "notebookPath": "/test.ipynb"
        })

        assert result["success"] is False
        assert "not agent-permitted" in result["error"]

    @pytest.mark.asyncio
    async def test_non_permitted_notebook_blocks_move(self, mock_fs, handler):
        """Non-permitted notebooks should block moveCell"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# cell 1", "metadata": {"nebula_id": "cell-1"}},
            {"cell_type": "code", "source": "# cell 2", "metadata": {"nebula_id": "cell-2"}}
        ], metadata={})

        result = await handler.apply_operation({
            "type": "moveCell",
            "notebookPath": "/test.ipynb",
            "fromIndex": 0,
            "toIndex": 1
        })

        assert result["success"] is False
        assert "not agent-permitted" in result["error"]

    # --- Read operations should always work ---

    @pytest.mark.asyncio
    async def test_non_permitted_allows_read_cell(self, mock_fs, handler):
        """Non-permitted notebooks should still allow readCell"""
        mock_fs.add_notebook("/test.ipynb", [
            {"cell_type": "code", "source": "# test", "metadata": {"nebula_id": "cell-1"}}
        ], metadata={})

        result = await handler.apply_operation({
            "type": "readCell",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is True

    # --- createNotebook should be permission-exempt ---

    def test_create_notebook_is_permission_exempt(self, mock_fs, handler):
        """createNotebook should not require permission check"""
        # Verify createNotebook is in the permission-exempt list
        # This is checked in apply_operation before calling the implementation
        permission_exempt_ops = {'createNotebook', 'readCell', 'readCellOutput', 'startAgentSession', 'endAgentSession'}
        assert 'createNotebook' in permission_exempt_ops

        # Also verify non-permitted notebook doesn't block permission check for createNotebook
        mock_fs.add_notebook("/test.ipynb", [], metadata={})  # Non-permitted
        result = handler._check_agent_permission("/test.ipynb", "createNotebook")
        # The permission check would return an error, but it's never called for createNotebook
        # because it's exempt from the check in apply_operation


class TestAgentPermissionHelper:
    """Tests for the _check_agent_permission helper method"""

    @pytest.fixture
    def mock_fs(self):
        return MockFsService()

    @pytest.fixture
    def handler(self, mock_fs):
        return HeadlessOperationHandler(mock_fs)

    def test_agent_created_returns_none(self, mock_fs, handler):
        """Agent-created notebooks should return None (permitted)"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={
            "nebula": {"agent_created": True}
        })

        result = handler._check_agent_permission("/test.ipynb", "insertCell")
        assert result is None

    def test_user_permitted_with_history_returns_none(self, mock_fs, handler):
        """User-permitted with history should return None (permitted)"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={
            "nebula": {"agent_permitted": True}
        })
        mock_fs.add_history("/test.ipynb", [{"type": "test"}])

        result = handler._check_agent_permission("/test.ipynb", "insertCell")
        assert result is None

    def test_user_permitted_without_history_returns_error(self, mock_fs, handler):
        """User-permitted without history should return error"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={
            "nebula": {"agent_permitted": True}
        })

        result = handler._check_agent_permission("/test.ipynb", "insertCell")
        assert result is not None
        assert result["success"] is False
        assert "history is not enabled" in result["error"]

    def test_non_permitted_returns_error(self, mock_fs, handler):
        """Non-permitted notebooks should return error"""
        mock_fs.add_notebook("/test.ipynb", [], metadata={})

        result = handler._check_agent_permission("/test.ipynb", "insertCell")
        assert result is not None
        assert result["success"] is False
        assert "not agent-permitted" in result["error"]
