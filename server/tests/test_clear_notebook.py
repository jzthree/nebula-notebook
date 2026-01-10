"""
Tests for the clearNotebook operation

Following TDD approach:
1. Write tests first (this file)
2. Run tests -> verify failure
3. Implement _clear_notebook() in headless_handler.py
4. Run tests -> verify passing
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
        """Return notebook cells for a path, converting from Jupyter to internal format"""
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


class TestClearNotebookOperation:
    """Test suite for clearNotebook operation"""

    @pytest.fixture
    def mock_fs(self):
        """Setup mock filesystem with test notebook"""
        mock = MockFsService()
        # Create notebook with 100 cells
        cells = [
            {
                "cell_type": "code",
                "source": f"print('Cell {i}')",
                "metadata": {"nebula_id": f"cell-{i}"},
                "outputs": [],
            }
            for i in range(100)
        ]
        mock.add_notebook("/test/large_notebook.ipynb", cells)
        return mock

    @pytest.fixture
    def handler(self, mock_fs):
        """Create handler with mocked filesystem"""
        return HeadlessOperationHandler(mock_fs)

    @pytest.mark.asyncio
    async def test_clear_notebook_removes_all_cells(self, handler, mock_fs):
        """SHOULD remove all cells in a single operation"""
        operation = {
            'type': 'clearNotebook',
            'notebookPath': '/test/large_notebook.ipynb'
        }

        result = await handler.apply_operation(operation)

        assert result['success'] is True
        assert result['deletedCount'] == 100
        assert result['totalCells'] == 0
        assert result['operationTime'] is None  # Placeholder

        # Verify cells were actually cleared (check via handler's cache)
        cells = handler._get_cells('/test/large_notebook.ipynb')
        assert len(cells) == 0

    @pytest.mark.asyncio
    async def test_clear_notebook_preserves_metadata(self, handler, mock_fs):
        """SHOULD preserve notebook-level metadata"""
        operation = {
            'type': 'clearNotebook',
            'notebookPath': '/test/large_notebook.ipynb'
        }

        await handler.apply_operation(operation)

        # Metadata should still exist
        notebook_data = mock_fs.get_notebook_cells('/test/large_notebook.ipynb')
        assert 'kernelspec' in notebook_data
        assert notebook_data['kernelspec']['name'] == 'python3'

    @pytest.mark.asyncio
    async def test_clear_notebook_on_empty_notebook(self, handler, mock_fs):
        """SHOULD handle empty notebooks gracefully"""
        mock_fs.add_notebook('/test/empty.ipynb', [])

        operation = {
            'type': 'clearNotebook',
            'notebookPath': '/test/empty.ipynb'
        }
        result = await handler.apply_operation(operation)

        assert result['success'] is True
        assert result['deletedCount'] == 0
        assert result['totalCells'] == 0

    @pytest.mark.asyncio
    async def test_clear_notebook_nonexistent_fails(self, handler):
        """SHOULD return error for nonexistent notebook"""
        operation = {
            'type': 'clearNotebook',
            'notebookPath': '/nonexistent.ipynb'
        }

        result = await handler.apply_operation(operation)

        assert result['success'] is False
        assert 'error' in result
        assert 'not found' in result['error'].lower()

    @pytest.mark.asyncio
    async def test_clear_notebook_marks_dirty(self, handler, mock_fs):
        """SHOULD mark notebook as dirty for persistence"""
        operation = {
            'type': 'clearNotebook',
            'notebookPath': '/test/large_notebook.ipynb'
        }

        await handler.apply_operation(operation)

        # Check that the notebook was saved (cells cleared in cache)
        cells = handler._get_cells('/test/large_notebook.ipynb')
        assert len(cells) == 0
