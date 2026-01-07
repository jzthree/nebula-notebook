"""
Tests for the Operation Router and Headless Notebook Manager

Tests verify:
1. Headless mode operations (file-based)
2. UI connection registration/unregistration
3. Operation routing logic
4. Cell ID conflict resolution
"""

import pytest
import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

# Add parent directory to path for imports
import sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from operation_router import OperationRouter, HeadlessNotebookManager


class MockFsService:
    """Mock filesystem service for testing"""

    def __init__(self):
        self.notebooks = {}

    def get_notebook_cells(self, path: str):
        """Return notebook cells for a path, converting from Jupyter to internal format"""
        if path not in self.notebooks:
            raise FileNotFoundError(f"Notebook not found: {path}")

        nb = self.notebooks[path]
        # Convert from Jupyter format to internal format (like real fs_service does)
        internal_cells = []
        for i, cell in enumerate(nb["cells"]):
            cell_type = cell.get("cell_type", "code")
            if cell_type == "raw":
                cell_type = "code"

            # Convert source to string
            source = cell.get("source", [])
            if isinstance(source, list):
                content = "".join(source)
            else:
                content = source

            # Get ID from metadata or generate one
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
            "kernelspec": nb.get("kernelspec", {}),
            "mtime": nb.get("mtime", 12345)
        }

    def save_notebook_cells(self, path: str, cells: list, kernel_name: str = None):
        """Save notebook cells - converts from internal format back to Jupyter format"""
        if path not in self.notebooks:
            self.notebooks[path] = {"cells": [], "kernelspec": {"name": "python3"}, "mtime": 12345}

        # Convert from internal format back to Jupyter format for storage
        jupyter_cells = []
        for cell in cells:
            jupyter_cell = {
                "cell_type": cell.get("type", "code"),
                "source": cell.get("content", ""),
                "metadata": {
                    "nebula_id": cell.get("id")
                },
                "outputs": cell.get("outputs", []),
                "execution_count": cell.get("executionCount")
            }
            jupyter_cells.append(jupyter_cell)

        self.notebooks[path]["cells"] = jupyter_cells
        return {"mtime": 12345}

    def add_notebook(self, path: str, cells: list):
        """Helper to add a notebook for testing (cells in Jupyter format)"""
        self.notebooks[path] = {
            "cells": cells,
            "kernelspec": {"name": "python3"},
            "mtime": 12345
        }


@pytest.fixture
def mock_fs():
    """Create a mock filesystem service"""
    return MockFsService()


@pytest.fixture
def headless_manager(mock_fs):
    """Create a headless notebook manager with mock fs"""
    return HeadlessNotebookManager(mock_fs)


@pytest.fixture
def router(headless_manager):
    """Create an operation router with headless manager"""
    r = OperationRouter()
    r.set_headless_manager(headless_manager)
    return r


class TestHeadlessNotebookManager:
    """Tests for HeadlessNotebookManager"""

    @pytest.mark.asyncio
    async def test_insert_cell_append(self, headless_manager, mock_fs):
        """Test appending a cell to notebook"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "print('hello')", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        operation = {
            "type": "insertCell",
            "notebookPath": "/test/notebook.ipynb",
            "index": -1,  # Append
            "cell": {
                "id": "new-cell",
                "type": "code",
                "content": "print('world')"
            }
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert result["cellId"] == "new-cell"
        assert result["cellIndex"] == 1
        assert len(mock_fs.notebooks["/test/notebook.ipynb"]["cells"]) == 2

    @pytest.mark.asyncio
    async def test_insert_cell_at_index(self, headless_manager, mock_fs):
        """Test inserting a cell at specific index"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "cell 1", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
            {"cell_type": "code", "source": "cell 2", "metadata": {"nebula_id": "cell-2"}, "outputs": []}
        ])

        operation = {
            "type": "insertCell",
            "notebookPath": "/test/notebook.ipynb",
            "index": 1,  # Insert at index 1
            "cell": {
                "id": "middle-cell",
                "type": "code",
                "content": "inserted"
            }
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert result["cellId"] == "middle-cell"
        assert result["cellIndex"] == 1

        cells = mock_fs.notebooks["/test/notebook.ipynb"]["cells"]
        assert len(cells) == 3
        assert cells[1]["metadata"]["nebula_id"] == "middle-cell"

    @pytest.mark.asyncio
    async def test_insert_cell_duplicate_id_auto_fix(self, headless_manager, mock_fs):
        """Test that duplicate cell IDs are auto-fixed"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "existing", "metadata": {"nebula_id": "my-cell"}, "outputs": []}
        ])

        operation = {
            "type": "insertCell",
            "notebookPath": "/test/notebook.ipynb",
            "index": -1,
            "cell": {
                "id": "my-cell",  # Duplicate!
                "type": "code",
                "content": "new content"
            }
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert result["cellId"] == "my-cell-2"  # Auto-fixed
        assert result["idModified"] is True

    @pytest.mark.asyncio
    async def test_delete_cell_by_index(self, headless_manager, mock_fs):
        """Test deleting a cell by index"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "cell 1", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
            {"cell_type": "code", "source": "cell 2", "metadata": {"nebula_id": "cell-2"}, "outputs": []},
            {"cell_type": "code", "source": "cell 3", "metadata": {"nebula_id": "cell-3"}, "outputs": []}
        ])

        operation = {
            "type": "deleteCell",
            "notebookPath": "/test/notebook.ipynb",
            "cellIndex": 1
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        cells = mock_fs.notebooks["/test/notebook.ipynb"]["cells"]
        assert len(cells) == 2
        assert cells[0]["metadata"]["nebula_id"] == "cell-1"
        assert cells[1]["metadata"]["nebula_id"] == "cell-3"

    @pytest.mark.asyncio
    async def test_delete_cell_by_id(self, headless_manager, mock_fs):
        """Test deleting a cell by ID"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "cell 1", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
            {"cell_type": "code", "source": "cell 2", "metadata": {"nebula_id": "cell-2"}, "outputs": []}
        ])

        operation = {
            "type": "deleteCell",
            "notebookPath": "/test/notebook.ipynb",
            "cellId": "cell-1"
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        cells = mock_fs.notebooks["/test/notebook.ipynb"]["cells"]
        assert len(cells) == 1
        assert cells[0]["metadata"]["nebula_id"] == "cell-2"

    @pytest.mark.asyncio
    async def test_update_content(self, headless_manager, mock_fs):
        """Test updating cell content"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "original", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        operation = {
            "type": "updateContent",
            "notebookPath": "/test/notebook.ipynb",
            "cellId": "cell-1",
            "content": "updated content"
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert mock_fs.notebooks["/test/notebook.ipynb"]["cells"][0]["source"] == "updated content"

    @pytest.mark.asyncio
    async def test_update_content_cell_not_found(self, headless_manager, mock_fs):
        """Test updating content for non-existent cell"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "existing", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        operation = {
            "type": "updateContent",
            "notebookPath": "/test/notebook.ipynb",
            "cellId": "non-existent",
            "content": "new content"
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is False
        assert "not found" in result["error"]

    @pytest.mark.asyncio
    async def test_move_cell(self, headless_manager, mock_fs):
        """Test moving a cell"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "cell 1", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
            {"cell_type": "code", "source": "cell 2", "metadata": {"nebula_id": "cell-2"}, "outputs": []},
            {"cell_type": "code", "source": "cell 3", "metadata": {"nebula_id": "cell-3"}, "outputs": []}
        ])

        operation = {
            "type": "moveCell",
            "notebookPath": "/test/notebook.ipynb",
            "fromIndex": 0,
            "toIndex": 2
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        cells = mock_fs.notebooks["/test/notebook.ipynb"]["cells"]
        assert cells[0]["metadata"]["nebula_id"] == "cell-2"
        assert cells[1]["metadata"]["nebula_id"] == "cell-3"
        assert cells[2]["metadata"]["nebula_id"] == "cell-1"

    @pytest.mark.asyncio
    async def test_duplicate_cell(self, headless_manager, mock_fs):
        """Test duplicating a cell"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "original", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        operation = {
            "type": "duplicateCell",
            "notebookPath": "/test/notebook.ipynb",
            "cellIndex": 0,
            "newCellId": "cell-1-copy"
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert result["cellId"] == "cell-1-copy"
        assert result["cellIndex"] == 1

        cells = mock_fs.notebooks["/test/notebook.ipynb"]["cells"]
        assert len(cells) == 2
        assert cells[1]["source"] == "original"
        assert cells[1]["metadata"]["nebula_id"] == "cell-1-copy"

    @pytest.mark.asyncio
    async def test_update_metadata_type_change(self, headless_manager, mock_fs):
        """Test changing cell type via metadata"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "# heading", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        operation = {
            "type": "updateMetadata",
            "notebookPath": "/test/notebook.ipynb",
            "cellId": "cell-1",
            "changes": {"type": "markdown"}
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert mock_fs.notebooks["/test/notebook.ipynb"]["cells"][0]["cell_type"] == "markdown"

    @pytest.mark.asyncio
    async def test_update_outputs(self, headless_manager, mock_fs):
        """Test updating cell outputs"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "print('hi')", "metadata": {"nebula_id": "cell-1"}, "outputs": [], "execution_count": None}
        ])

        operation = {
            "type": "updateOutputs",
            "notebookPath": "/test/notebook.ipynb",
            "cellId": "cell-1",
            "outputs": [
                {"type": "stdout", "content": "hi\n"}
            ],
            "executionCount": 1
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        cell = mock_fs.notebooks["/test/notebook.ipynb"]["cells"][0]
        assert len(cell["outputs"]) == 1
        assert cell["execution_count"] == 1

    @pytest.mark.asyncio
    async def test_read_notebook(self, headless_manager, mock_fs):
        """Test reading notebook"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "print('hello')", "metadata": {"nebula_id": "cell-1"}, "outputs": [], "execution_count": 1}
        ])

        result = await headless_manager.read_notebook("/test/notebook.ipynb")

        assert result["success"] is True
        assert len(result["data"]["cells"]) == 1
        assert result["data"]["cells"][0]["id"] == "cell-1"
        assert result["data"]["cells"][0]["content"] == "print('hello')"


class TestOperationRouter:
    """Tests for OperationRouter"""

    def test_has_ui_no_connection(self, router):
        """Test has_ui returns False when no UI connected"""
        assert router.has_ui("/test/notebook.ipynb") is False

    @pytest.mark.asyncio
    async def test_register_ui(self, router):
        """Test registering a UI connection"""
        mock_ws = AsyncMock()
        await router.register_ui(mock_ws, "/test/notebook.ipynb")

        # Path should be normalized
        assert router.has_ui("/test/notebook.ipynb") is True

    def test_unregister_ui(self, router):
        """Test unregistering a UI connection"""
        # First register
        mock_ws = AsyncMock()
        asyncio.get_event_loop().run_until_complete(
            router.register_ui(mock_ws, "/test/notebook.ipynb")
        )
        assert router.has_ui("/test/notebook.ipynb") is True

        # Then unregister
        router.unregister_ui("/test/notebook.ipynb")
        assert router.has_ui("/test/notebook.ipynb") is False

    @pytest.mark.asyncio
    async def test_apply_operation_headless(self, router, mock_fs):
        """Test operation routing to headless mode"""
        mock_fs.add_notebook("/test/notebook.ipynb", [])

        operation = {
            "type": "insertCell",
            "notebookPath": "/test/notebook.ipynb",
            "index": -1,
            "cell": {
                "id": "new-cell",
                "type": "code",
                "content": "print('test')"
            }
        }

        result = await router.apply_operation(operation)

        assert result["success"] is True
        assert result["cellId"] == "new-cell"

    @pytest.mark.asyncio
    async def test_read_notebook_headless(self, router, mock_fs):
        """Test reading notebook in headless mode"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "test", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        result = await router.read_notebook("/test/notebook.ipynb")

        assert result["success"] is True
        assert len(result["data"]["cells"]) == 1


class TestIDConflictResolution:
    """Tests for cell ID conflict resolution"""

    @pytest.mark.asyncio
    async def test_multiple_duplicate_ids(self, headless_manager, mock_fs):
        """Test that multiple duplicate IDs are resolved incrementally"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "1", "metadata": {"nebula_id": "cell"}, "outputs": []},
            {"cell_type": "code", "source": "2", "metadata": {"nebula_id": "cell-2"}, "outputs": []}
        ])

        # Try to add another "cell" - should become "cell-3"
        operation = {
            "type": "insertCell",
            "notebookPath": "/test/notebook.ipynb",
            "index": -1,
            "cell": {"id": "cell", "type": "code", "content": "3"}
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert result["cellId"] == "cell-3"
        assert result["idModified"] is True

    @pytest.mark.asyncio
    async def test_duplicate_on_duplicate(self, headless_manager, mock_fs):
        """Test duplicating a cell with auto-fixed ID"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "original", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
            {"cell_type": "code", "source": "copy", "metadata": {"nebula_id": "cell-1-copy"}, "outputs": []}
        ])

        # Try to duplicate with ID that already exists
        operation = {
            "type": "duplicateCell",
            "notebookPath": "/test/notebook.ipynb",
            "cellIndex": 0,
            "newCellId": "cell-1-copy"  # Already exists
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert result["cellId"] == "cell-1-copy-2"
        assert result["idModified"] is True


class TestEdgeCases:
    """Tests for edge cases and error handling"""

    @pytest.mark.asyncio
    async def test_delete_out_of_range(self, headless_manager, mock_fs):
        """Test deleting with out-of-range index"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "only cell", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        operation = {
            "type": "deleteCell",
            "notebookPath": "/test/notebook.ipynb",
            "cellIndex": 5  # Out of range
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is False
        assert "not found" in result["error"].lower() or "out of range" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_move_invalid_indices(self, headless_manager, mock_fs):
        """Test moving with invalid indices"""
        mock_fs.add_notebook("/test/notebook.ipynb", [
            {"cell_type": "code", "source": "cell", "metadata": {"nebula_id": "cell-1"}, "outputs": []}
        ])

        operation = {
            "type": "moveCell",
            "notebookPath": "/test/notebook.ipynb",
            "fromIndex": 0,
            "toIndex": 10  # Out of range
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_unknown_operation_type(self, headless_manager, mock_fs):
        """Test handling unknown operation type"""
        mock_fs.add_notebook("/test/notebook.ipynb", [])

        operation = {
            "type": "unknownOperation",
            "notebookPath": "/test/notebook.ipynb"
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is False
        assert "unknown" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_notebook_not_found(self, headless_manager, mock_fs):
        """Test operation on non-existent notebook"""
        operation = {
            "type": "insertCell",
            "notebookPath": "/non/existent.ipynb",
            "index": -1,
            "cell": {"id": "cell", "type": "code", "content": "test"}
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is False

    @pytest.mark.asyncio
    async def test_empty_notebook(self, headless_manager, mock_fs):
        """Test operations on empty notebook"""
        mock_fs.add_notebook("/test/notebook.ipynb", [])

        # Insert into empty notebook
        operation = {
            "type": "insertCell",
            "notebookPath": "/test/notebook.ipynb",
            "index": 0,
            "cell": {"id": "first-cell", "type": "code", "content": "first"}
        }

        result = await headless_manager.apply_operation(operation)

        assert result["success"] is True
        assert result["cellIndex"] == 0


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
