"""
Tests for cell-level CRUD API endpoints.
TDD: Write failing tests first, then implement.
"""
import pytest
import sys
import json
import tempfile
import os
from pathlib import Path
from unittest.mock import MagicMock, AsyncMock, patch

# Add parent directory to path for imports
sys.path.insert(0, str(Path(__file__).parent.parent))

# Create mock modules before importing main
mock_google = MagicMock()
mock_genai = MagicMock()
mock_google.genai = mock_genai
sys.modules['google'] = mock_google
sys.modules['google.genai'] = mock_genai

mock_openai = MagicMock()
sys.modules['openai'] = mock_openai

mock_anthropic = MagicMock()
sys.modules['anthropic'] = mock_anthropic


def create_test_notebook(cells=None):
    """Create a temporary test notebook file"""
    if cells is None:
        cells = [
            {
                "cell_type": "code",
                "source": "print('hello')",
                "metadata": {"nebula_id": "cell-1"},
                "outputs": [],
                "execution_count": 1
            },
            {
                "cell_type": "markdown",
                "source": "# Title",
                "metadata": {"nebula_id": "cell-2"},
                "outputs": []
            },
            {
                "cell_type": "code",
                "source": "x = 42",
                "metadata": {"nebula_id": "cell-3"},
                "outputs": [],
                "execution_count": 2
            }
        ]

    notebook = {
        "nbformat": 4,
        "nbformat_minor": 5,
        "metadata": {
            "kernelspec": {
                "name": "python3",
                "display_name": "Python 3"
            }
        },
        "cells": cells
    }

    # Create temp file
    fd, path = tempfile.mkstemp(suffix='.ipynb')
    with os.fdopen(fd, 'w') as f:
        json.dump(notebook, f)

    return path


@pytest.fixture
def temp_notebook():
    """Create a temporary notebook for testing"""
    path = create_test_notebook()
    yield path
    # Cleanup
    if os.path.exists(path):
        os.unlink(path)


@pytest.fixture
def mock_kernel_service():
    """Create a mock kernel service"""
    mock_ks = MagicMock()
    mock_ks.is_ready = True
    mock_ks.get_available_kernels.return_value = []
    mock_ks.get_all_sessions.return_value = []
    mock_ks.initialize_async = AsyncMock()
    mock_ks.cleanup = AsyncMock()
    return mock_ks


@pytest.fixture
def mock_session_store():
    """Create a mock session store"""
    mock_ss = MagicMock()
    mock_ss.mark_all_orphaned.return_value = 0
    mock_ss.cleanup_old_sessions.return_value = 0
    return mock_ss


@pytest.fixture
def mock_llm_service():
    """Create a mock LLM service"""
    mock_llm = MagicMock()
    mock_llm.get_available_providers.return_value = {}
    return mock_llm


@pytest.fixture
def mock_python_discovery():
    """Create a mock Python discovery"""
    mock_pd = MagicMock()
    mock_pd.discover.return_value = []
    mock_pd.get_cache_info.return_value = {"cached": True, "age": 100}
    return mock_pd


@pytest.fixture
def client(mock_kernel_service, mock_session_store, mock_llm_service, mock_python_discovery):
    """Create a test client with mocked services"""
    with patch.dict('sys.modules', {
        'kernel_service': MagicMock(kernel_service=mock_kernel_service),
        'session_store': MagicMock(session_store=mock_session_store),
        'llm_service': MagicMock(llm_service=mock_llm_service, LLMConfig=MagicMock()),
        'python_discovery': MagicMock(python_discovery=mock_python_discovery),
    }):
        with patch('main.kernel_service', mock_kernel_service), \
             patch('main.session_store', mock_session_store), \
             patch('main.llm_service', mock_llm_service), \
             patch('main.python_discovery', mock_python_discovery):

            from fastapi.testclient import TestClient
            from main import app

            with TestClient(app) as test_client:
                yield test_client


class TestUpdateCell:
    """Tests for PATCH /api/notebook/cell"""

    def test_update_cell_content_by_id(self, client, temp_notebook):
        """Update cell content using cell_id"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "cell-1",
            "content": "print('updated')"
        })

        assert response.status_code == 200
        data = response.json()
        assert data["cell_id"] == "cell-1"
        assert data["cell_index"] == 0
        assert "mtime" in data

        # Verify the file was updated
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        source = notebook["cells"][0]["source"]
        if isinstance(source, list):
            source = "".join(source)
        assert source == "print('updated')"

    def test_update_cell_content_by_index(self, client, temp_notebook):
        """Update cell content using cell_index"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_index": 2,
            "content": "y = 100"
        })

        assert response.status_code == 200
        data = response.json()
        assert data["cell_id"] == "cell-3"
        assert data["cell_index"] == 2

        # Verify the file was updated
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        source = notebook["cells"][2]["source"]
        if isinstance(source, list):
            source = "".join(source)
        assert source == "y = 100"

    def test_update_cell_type(self, client, temp_notebook):
        """Change cell type from code to markdown"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "cell-1",
            "cell_type": "markdown"
        })

        assert response.status_code == 200

        # Verify the file was updated
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        assert notebook["cells"][0]["cell_type"] == "markdown"

    def test_update_cell_metadata(self, client, temp_notebook):
        """Update cell metadata (merge with existing)"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "cell-1",
            "metadata": {"custom_key": "custom_value"}
        })

        assert response.status_code == 200

        # Verify the file was updated - metadata should be merged
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        metadata = notebook["cells"][0]["metadata"]
        assert metadata.get("nebula_id") == "cell-1"  # Original preserved
        assert metadata.get("custom_key") == "custom_value"  # New added

    def test_update_cell_not_found_by_id(self, client, temp_notebook):
        """Returns 404 for non-existent cell ID"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "nonexistent-cell",
            "content": "new content"
        })

        assert response.status_code == 404

    def test_update_cell_not_found_by_index(self, client, temp_notebook):
        """Returns 404 for out-of-range cell index"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_index": 999,
            "content": "new content"
        })

        assert response.status_code == 404

    def test_update_cell_invalid_type(self, client, temp_notebook):
        """Returns 422 for invalid cell_type"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "cell-1",
            "cell_type": "invalid_type"
        })

        assert response.status_code == 422

    def test_update_cell_notebook_not_found(self, client):
        """Returns 404 for non-existent notebook"""
        response = client.patch("/api/notebook/cell", json={
            "path": "/nonexistent/notebook.ipynb",
            "cell_id": "cell-1",
            "content": "new content"
        })

        assert response.status_code == 404

    def test_update_cell_no_identifier(self, client, temp_notebook):
        """Returns 400 when neither cell_id nor cell_index provided"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "content": "new content"
        })

        assert response.status_code == 400

    def test_update_cell_returns_mtime(self, client, temp_notebook):
        """Response includes mtime for optimistic concurrency"""
        response = client.patch("/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "cell-1",
            "content": "updated"
        })

        assert response.status_code == 200
        data = response.json()
        assert "mtime" in data
        assert isinstance(data["mtime"], float)
        assert data["mtime"] > 0


class TestInsertCell:
    """Tests for POST /api/notebook/cell"""

    def test_insert_cell_at_index(self, client, temp_notebook):
        """Insert cell at specific position"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": 1,
            "cell_type": "code",
            "content": "new_cell_content"
        })

        assert response.status_code == 201
        data = response.json()
        assert data["cell_index"] == 1
        assert data["total_cells"] == 4  # Was 3, now 4
        assert "cell_id" in data
        assert "mtime" in data

        # Verify the file was updated
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        assert len(notebook["cells"]) == 4
        source = notebook["cells"][1]["source"]
        if isinstance(source, list):
            source = "".join(source)
        assert source == "new_cell_content"

    def test_insert_cell_append(self, client, temp_notebook):
        """Insert cell with index=-1 appends to end"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": -1,
            "cell_type": "markdown",
            "content": "## Appended"
        })

        assert response.status_code == 201
        data = response.json()
        assert data["cell_index"] == 3  # Appended to end (was 3 cells, now at index 3)
        assert data["total_cells"] == 4

        # Verify the file was updated
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        assert len(notebook["cells"]) == 4
        assert notebook["cells"][3]["cell_type"] == "markdown"

    def test_insert_cell_with_client_id(self, client, temp_notebook):
        """Client-provided cell_id is preserved"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": 0,
            "cell_type": "code",
            "content": "first",
            "cell_id": "my-custom-id"
        })

        assert response.status_code == 201
        data = response.json()
        assert data["cell_id"] == "my-custom-id"

        # Verify the ID in the file
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        assert notebook["cells"][0]["metadata"]["nebula_id"] == "my-custom-id"

    def test_insert_cell_generates_unique_id(self, client, temp_notebook):
        """Auto-generates cell_id when not provided"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": 0,
            "cell_type": "code",
            "content": "auto id"
        })

        assert response.status_code == 201
        data = response.json()
        assert "cell_id" in data
        assert len(data["cell_id"]) > 0

    def test_insert_cell_at_end(self, client, temp_notebook):
        """Insert at index equal to length (append)"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": 3,  # Current length is 3
            "cell_type": "code",
            "content": "at end"
        })

        assert response.status_code == 201
        data = response.json()
        assert data["cell_index"] == 3
        assert data["total_cells"] == 4

    def test_insert_notebook_not_found(self, client):
        """Returns 404 for non-existent notebook"""
        response = client.post("/api/notebook/cell", json={
            "path": "/nonexistent/notebook.ipynb",
            "index": 0,
            "cell_type": "code",
            "content": "test"
        })

        assert response.status_code == 404

    def test_insert_cell_invalid_index(self, client, temp_notebook):
        """Returns 422 for out-of-range index"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": 100,  # Way out of range
            "cell_type": "code",
            "content": "test"
        })

        assert response.status_code == 422

    def test_insert_cell_invalid_type(self, client, temp_notebook):
        """Returns 422 for invalid cell_type"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": 0,
            "cell_type": "invalid",
            "content": "test"
        })

        assert response.status_code == 422

    def test_insert_cell_default_type_is_code(self, client, temp_notebook):
        """Default cell_type is 'code'"""
        response = client.post("/api/notebook/cell", json={
            "path": temp_notebook,
            "index": 0,
            "content": "default type"
        })

        assert response.status_code == 201

        # Verify the cell type
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        assert notebook["cells"][0]["cell_type"] == "code"


class TestDeleteCell:
    """Tests for DELETE /api/notebook/cell"""

    def test_delete_cell_by_id(self, client, temp_notebook):
        """Delete cell using cell_id"""
        response = client.request("DELETE", "/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "cell-2"
        })

        assert response.status_code == 200
        data = response.json()
        assert data["deleted_cell_id"] == "cell-2"
        assert data["total_cells"] == 2  # Was 3, now 2
        assert "mtime" in data

        # Verify the file was updated
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        assert len(notebook["cells"]) == 2
        # cell-2 was the markdown cell at index 1, should be gone
        for cell in notebook["cells"]:
            assert cell["metadata"].get("nebula_id") != "cell-2"

    def test_delete_cell_by_index(self, client, temp_notebook):
        """Delete cell using cell_index"""
        response = client.request("DELETE", "/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_index": 0
        })

        assert response.status_code == 200
        data = response.json()
        assert data["deleted_cell_id"] == "cell-1"
        assert data["total_cells"] == 2

        # Verify the file was updated - first cell should now be the old second cell
        with open(temp_notebook, 'r') as f:
            notebook = json.load(f)
        assert len(notebook["cells"]) == 2
        assert notebook["cells"][0]["metadata"]["nebula_id"] == "cell-2"

    def test_delete_cell_not_found_by_id(self, client, temp_notebook):
        """Returns 404 for non-existent cell ID"""
        response = client.request("DELETE", "/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "nonexistent-cell"
        })

        assert response.status_code == 404

    def test_delete_cell_not_found_by_index(self, client, temp_notebook):
        """Returns 404 for out-of-range cell index"""
        response = client.request("DELETE", "/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_index": 999
        })

        assert response.status_code == 404

    def test_delete_cell_no_identifier(self, client, temp_notebook):
        """Returns 400 when neither cell_id nor cell_index provided"""
        response = client.request("DELETE", "/api/notebook/cell", json={
            "path": temp_notebook
        })

        assert response.status_code == 400

    def test_delete_notebook_not_found(self, client):
        """Returns 404 for non-existent notebook"""
        response = client.request("DELETE", "/api/notebook/cell", json={
            "path": "/nonexistent/notebook.ipynb",
            "cell_id": "cell-1"
        })

        assert response.status_code == 404

    def test_delete_cell_returns_mtime(self, client, temp_notebook):
        """Response includes mtime for optimistic concurrency"""
        response = client.request("DELETE", "/api/notebook/cell", json={
            "path": temp_notebook,
            "cell_id": "cell-1"
        })

        assert response.status_code == 200
        data = response.json()
        assert "mtime" in data
        assert isinstance(data["mtime"], float)
        assert data["mtime"] > 0
