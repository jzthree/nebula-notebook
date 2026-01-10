"""
Tests for operation metadata responses (Phase 1.2)

Following TDD approach:
1. Write tests first (this file)
2. Run tests -> verify failure
3. Update operation handlers to include metadata
4. Run tests -> verify passing

All mutation operations should return metadata with:
- totalCells: Number of cells after operation
- operationTime: Optional timing info (Phase 3)
"""

import pytest
import os
import sys

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from headless_handler import HeadlessOperationHandler


class MockFsService:
    """Mock filesystem service for testing"""

    def __init__(self):
        self.notebooks = {}

    def get_notebook_cells(self, path: str):
        """Return notebook cells for a path"""
        if path not in self.notebooks:
            raise FileNotFoundError(f"Notebook not found: {path}")

        nb = self.notebooks[path]
        # Convert from Jupyter format to internal format
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
        """Save notebook cells"""
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


class TestInsertCellMetadata:
    """Test insertCell operation returns metadata"""

    @pytest.fixture
    def mock_fs(self):
        """Setup mock filesystem with test notebook"""
        mock = MockFsService()
        mock.add_notebook('/test/notebook.ipynb', [
            {"cell_type": "code", "source": "x=1", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
        ])
        return mock

    @pytest.fixture
    def handler(self, mock_fs):
        return HeadlessOperationHandler(mock_fs)

    @pytest.mark.asyncio
    async def test_insert_cell_returns_total_cells_metadata(self, handler, mock_fs):
        """insertCell SHOULD return totalCells in metadata envelope"""
        operation = {
            'type': 'insertCell',
            'notebookPath': '/test/notebook.ipynb',
            'index': -1,
            'cell': {'id': 'cell-2', 'type': 'code', 'content': 'x=2'}
        }

        result = await handler.apply_operation(operation)

        assert result['success'] is True
        assert 'totalCells' in result, "Response should include totalCells"
        assert result['totalCells'] == 2, "Should have 2 cells after insert"
        assert result['operationTime'] is None, "Should include operationTime placeholder"

    @pytest.mark.asyncio
    async def test_insert_cell_metadata_correct_after_multiple_inserts(self, handler, mock_fs):
        """totalCells SHOULD increment with each insert"""
        # Insert 3 cells
        for i in range(3):
            operation = {
                'type': 'insertCell',
                'notebookPath': '/test/notebook.ipynb',
                'index': -1,
                'cell': {'id': f'new-cell-{i}', 'type': 'code', 'content': f'x={i}'}
            }
            result = await handler.apply_operation(operation)

            assert result['success'] is True
            expected_count = 2 + i  # Started with 1, added i cells
            assert result['totalCells'] == expected_count

    @pytest.mark.asyncio
    async def test_insert_cell_into_empty_notebook(self, handler, mock_fs):
        """insertCell into empty notebook SHOULD return totalCells=1"""
        mock_fs.add_notebook('/test/empty.ipynb', [])

        operation = {
            'type': 'insertCell',
            'notebookPath': '/test/empty.ipynb',
            'index': -1,
            'cell': {'id': 'first-cell', 'type': 'code', 'content': 'print("hello")'}
        }

        result = await handler.apply_operation(operation)

        assert result['success'] is True
        assert result['totalCells'] == 1


class TestDeleteCellMetadata:
    """Test deleteCell operation returns metadata"""

    @pytest.fixture
    def mock_fs(self):
        """Setup mock filesystem with test notebook"""
        mock = MockFsService()
        mock.add_notebook('/test/notebook.ipynb', [
            {"cell_type": "code", "source": "x=1", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
            {"cell_type": "code", "source": "x=2", "metadata": {"nebula_id": "cell-2"}, "outputs": []},
            {"cell_type": "code", "source": "x=3", "metadata": {"nebula_id": "cell-3"}, "outputs": []},
        ])
        return mock

    @pytest.fixture
    def handler(self, mock_fs):
        return HeadlessOperationHandler(mock_fs)

    @pytest.mark.asyncio
    async def test_delete_cell_returns_total_cells_metadata(self, handler, mock_fs):
        """deleteCell SHOULD return totalCells in metadata envelope"""
        operation = {
            'type': 'deleteCell',
            'notebookPath': '/test/notebook.ipynb',
            'cellIndex': 0
        }

        result = await handler.apply_operation(operation)

        assert result['success'] is True
        assert 'totalCells' in result, "Response should include totalCells"
        assert result['totalCells'] == 2, "Should have 2 cells after deleting 1"
        assert result['operationTime'] is None, "Should include operationTime placeholder"

    @pytest.mark.asyncio
    async def test_delete_cell_metadata_decrements_correctly(self, handler, mock_fs):
        """totalCells SHOULD decrement with each delete"""
        # Delete all 3 cells one by one
        for expected_count in [2, 1, 0]:
            operation = {
                'type': 'deleteCell',
                'notebookPath': '/test/notebook.ipynb',
                'cellIndex': 0  # Always delete first cell
            }
            result = await handler.apply_operation(operation)

            assert result['success'] is True
            assert result['totalCells'] == expected_count

    @pytest.mark.asyncio
    async def test_delete_last_cell_returns_zero_cells(self, handler, mock_fs):
        """Deleting last cell SHOULD return totalCells=0"""
        mock_fs.add_notebook('/test/single.ipynb', [
            {"cell_type": "code", "source": "x=1", "metadata": {"nebula_id": "only-cell"}, "outputs": []},
        ])

        operation = {
            'type': 'deleteCell',
            'notebookPath': '/test/single.ipynb',
            'cellIndex': 0
        }

        result = await handler.apply_operation(operation)

        assert result['success'] is True
        assert result['totalCells'] == 0


class TestDuplicateCellMetadata:
    """Test duplicateCell operation uses metadata envelope (refactor existing)"""

    @pytest.fixture
    def mock_fs(self):
        """Setup mock filesystem with test notebook"""
        mock = MockFsService()
        mock.add_notebook('/test/notebook.ipynb', [
            {"cell_type": "code", "source": "x=1", "metadata": {"nebula_id": "cell-1"}, "outputs": []},
            {"cell_type": "code", "source": "x=2", "metadata": {"nebula_id": "cell-2"}, "outputs": []},
        ])
        return mock

    @pytest.fixture
    def handler(self, mock_fs):
        return HeadlessOperationHandler(mock_fs)

    @pytest.mark.asyncio
    async def test_duplicate_cell_uses_metadata_envelope(self, handler, mock_fs):
        """duplicateCell SHOULD use metadata envelope (not top-level totalCells)"""
        operation = {
            'type': 'duplicateCell',
            'notebookPath': '/test/notebook.ipynb',
            'cellIndex': 0,
            'newCellId': 'cell-1-copy'
        }

        result = await handler.apply_operation(operation)

        assert result['success'] is True
        # totalCells should be at top level (flat structure)
        assert 'totalCells' in result, "Response should include totalCells"
        assert result['totalCells'] == 3, "Should have 3 cells after duplication"
        assert result['operationTime'] is None, "Should include operationTime placeholder"
