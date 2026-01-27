"""
Tests for MCP output truncation in read_output

Tests verify that:
1. Default truncation limits are applied (100 lines, 10000 chars)
2. Pagination with line_offset works correctly
3. Large outputs are auto-saved to temp files
4. Truncation metadata is correctly returned
5. Binary/image outputs are handled specially
"""

import pytest
import os
import sys
import tempfile

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from headless_handler import (
    HeadlessOperationHandler,
    OUTPUT_DEFAULT_MAX_LINES,
    OUTPUT_DEFAULT_MAX_CHARS,
)


class MockFsService:
    """Mock filesystem service for testing output truncation"""

    def __init__(self):
        self.notebooks = {}

    def _normalize_path(self, path: str) -> str:
        return path

    def get_notebook_cells(self, path: str):
        if path not in self.notebooks:
            raise FileNotFoundError(f"Notebook not found: {path}")
        nb = self.notebooks[path]
        return {
            "cells": nb.get("cells", []),
            "metadata": nb.get("metadata", {}),
            "mtime": 12345
        }

    def save_notebook_cells(self, path: str, cells: list, kernel_name: str = None, notebook_metadata: dict = None):
        if path not in self.notebooks:
            self.notebooks[path] = {"cells": [], "metadata": {}}
        self.notebooks[path]["cells"] = cells
        return {"success": True, "mtime": 12345}

    def get_notebook_metadata(self, path: str) -> dict:
        if path in self.notebooks:
            return self.notebooks[path].get("metadata", {})
        return {}

    def is_agent_permitted(self, path: str) -> bool:
        """Always return True for testing - permissions tested separately"""
        return True

    def has_history(self, path: str) -> bool:
        return True

    def add_notebook(self, path: str, cells: list, metadata: dict = None):
        self.notebooks[path] = {
            "cells": cells,
            "metadata": metadata or {"nebula": {"agent_created": True}}
        }


class TestTruncateOutput:
    """Tests for the _truncate_output helper method"""

    @pytest.fixture
    def handler(self):
        return HeadlessOperationHandler(MockFsService())

    def test_no_truncation_needed(self, handler):
        """Short output should not be truncated"""
        content = "line 1\nline 2\nline 3"
        result, metadata = handler._truncate_output(content, 100, 10000, 0)

        assert result == content
        assert metadata["truncated"] is False
        assert metadata["total_lines"] == 3
        assert metadata["returned_range"]["start_line"] == 0
        assert metadata["returned_range"]["end_line"] == 3

    def test_truncation_by_lines(self, handler):
        """Output exceeding line limit should be truncated"""
        lines = [f"line {i}" for i in range(200)]
        content = "\n".join(lines)

        result, metadata = handler._truncate_output(content, 50, 100000, 0)

        assert metadata["truncated"] is True
        assert metadata["truncation_reason"] == "lines"
        assert metadata["total_lines"] == 200
        assert metadata["returned_range"]["end_line"] == 50
        assert result.count("\n") == 49  # 50 lines = 49 newlines

    def test_truncation_by_chars(self, handler):
        """Output exceeding character limit should be truncated"""
        # Create content where char limit is hit before line limit
        lines = ["x" * 500 for _ in range(50)]  # 500 chars per line
        content = "\n".join(lines)

        result, metadata = handler._truncate_output(content, 1000, 1000, 0)

        assert metadata["truncated"] is True
        assert metadata["truncation_reason"] == "chars"
        # Should have truncated based on chars, not lines

    def test_pagination_with_offset(self, handler):
        """Line offset should skip initial lines"""
        lines = [f"line {i}" for i in range(100)]
        content = "\n".join(lines)

        result, metadata = handler._truncate_output(content, 20, 100000, 50)

        # Should return lines 50-69
        assert metadata["returned_range"]["start_line"] == 50
        assert metadata["returned_range"]["end_line"] == 70
        assert "line 50" in result
        assert "line 49" not in result

    def test_offset_beyond_content(self, handler):
        """Offset beyond content should return empty"""
        content = "line 1\nline 2\nline 3"

        result, metadata = handler._truncate_output(content, 100, 10000, 100)

        assert result == ""
        assert metadata["returned_range"]["start_line"] == 100
        assert metadata["returned_range"]["end_line"] == 100

    def test_always_returns_at_least_one_line(self, handler):
        """Even with very low char limit, should return at least one line"""
        content = "a" * 500 + "\nshort"

        result, metadata = handler._truncate_output(content, 100, 10, 0)

        # Should include at least the first line even though it exceeds char limit
        assert len(result) > 0
        assert result.startswith("a" * 500)


class TestReadCellOutput:
    """Tests for _read_cell_output with truncation"""

    @pytest.fixture
    def mock_fs(self):
        return MockFsService()

    @pytest.fixture
    def handler(self, mock_fs):
        return HeadlessOperationHandler(mock_fs)

    @pytest.mark.asyncio
    async def test_basic_output_reading(self, mock_fs, handler):
        """Should read cell outputs correctly"""
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "print('hello')",
                "outputs": [{"type": "stdout", "content": "hello\n"}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is True
        assert len(result["outputs"]) == 1
        assert result["outputs"][0]["content"] == "hello\n"
        assert result["outputs"][0]["truncated"] is False

    @pytest.mark.asyncio
    async def test_default_truncation_applied(self, mock_fs, handler):
        """Default limits should be applied to large outputs"""
        # Create output with many lines
        large_output = "\n".join([f"line {i}" for i in range(500)])
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "for i in range(500): print(f'line {i}')",
                "outputs": [{"type": "stdout", "content": large_output}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is True
        output = result["outputs"][0]
        assert output["truncated"] is True
        assert output["total_lines"] == 500
        assert output["returned_range"]["end_line"] <= OUTPUT_DEFAULT_MAX_LINES

    @pytest.mark.asyncio
    async def test_custom_limits(self, mock_fs, handler):
        """Custom truncation limits should be respected"""
        large_output = "\n".join([f"line {i}" for i in range(100)])
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "",
                "outputs": [{"type": "stdout", "content": large_output}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1",
            "max_lines": 10,
            "max_chars": 50000
        })

        assert result["success"] is True
        output = result["outputs"][0]
        assert output["truncated"] is True
        assert output["returned_range"]["end_line"] == 10

    @pytest.mark.asyncio
    async def test_pagination_offset(self, mock_fs, handler):
        """Pagination with line_offset should work"""
        large_output = "\n".join([f"line {i}" for i in range(200)])
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "",
                "outputs": [{"type": "stdout", "content": large_output}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1",
            "max_lines": 50,
            "line_offset": 100
        })

        assert result["success"] is True
        output = result["outputs"][0]
        assert output["returned_range"]["start_line"] == 100
        assert "line 100" in output["content"]
        assert "line 99" not in output["content"]

    @pytest.mark.asyncio
    async def test_large_output_not_auto_saved(self, mock_fs, handler):
        """Large outputs should NOT be auto-saved without explicit save_to_file"""
        # Create a large output
        large_output = "\n".join([f"line {i}" for i in range(2000)])
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "",
                "outputs": [{"type": "stdout", "content": large_output}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is True
        output = result["outputs"][0]
        # Should NOT have temp_file unless explicitly requested
        assert "temp_file" not in output or output.get("temp_file") is None
        # Should still be truncated
        assert output["truncated"] is True

    @pytest.mark.asyncio
    async def test_force_save_to_file(self, mock_fs, handler):
        """save_to_file=True should save even small outputs"""
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "",
                "outputs": [{"type": "stdout", "content": "small output"}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1",
            "save_to_file": True
        })

        assert result["success"] is True
        output = result["outputs"][0]
        assert "temp_file" in output
        assert os.path.exists(output["temp_file"])

        # Cleanup
        os.remove(output["temp_file"])

    @pytest.mark.asyncio
    async def test_image_output_returned_in_full(self, mock_fs, handler):
        """Image outputs should be returned in full, not truncated"""
        image_content = "base64data..." * 1000
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "",
                "outputs": [{"type": "image", "content": image_content}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is True
        output = result["outputs"][0]
        assert output["is_binary"] is True
        assert output["content"] == image_content  # Full image data returned
        assert output["truncated"] is False

    @pytest.mark.asyncio
    async def test_multiple_outputs(self, mock_fs, handler):
        """Multiple outputs should all be processed"""
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-1",
                "type": "code",
                "content": "",
                "outputs": [
                    {"type": "stdout", "content": "stdout output"},
                    {"type": "stderr", "content": "stderr output"},
                    {"type": "html", "content": "<div>html</div>"},
                ],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "cell-1"
        })

        assert result["success"] is True
        assert result["output_count"] == 3
        assert len(result["outputs"]) == 3

    @pytest.mark.asyncio
    async def test_cell_not_found(self, mock_fs, handler):
        """Should return error for non-existent cell"""
        mock_fs.add_notebook("/test.ipynb", [])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellId": "nonexistent"
        })

        assert result["success"] is False
        assert "not found" in result["error"]

    @pytest.mark.asyncio
    async def test_cell_by_index(self, mock_fs, handler):
        """Should be able to read by cell index"""
        mock_fs.add_notebook("/test.ipynb", [
            {
                "id": "cell-0",
                "type": "code",
                "content": "",
                "outputs": [{"type": "stdout", "content": "first cell"}],
            },
            {
                "id": "cell-1",
                "type": "code",
                "content": "",
                "outputs": [{"type": "stdout", "content": "second cell"}],
            }
        ])

        result = await handler.apply_operation({
            "type": "readCellOutput",
            "notebookPath": "/test.ipynb",
            "cellIndex": 1
        })

        assert result["success"] is True
        assert "second cell" in result["outputs"][0]["content"]


class TestSaveOutputToTempFile:
    """Tests for _save_output_to_temp_file helper"""

    @pytest.fixture
    def handler(self):
        return HeadlessOperationHandler(MockFsService())

    def test_creates_temp_file(self, handler):
        """Should create a readable temp file"""
        content = "test content\nwith multiple\nlines"
        filepath = handler._save_output_to_temp_file(content, "test-cell")

        assert os.path.exists(filepath)
        with open(filepath, "r") as f:
            assert f.read() == content

        # Cleanup
        os.remove(filepath)

    def test_temp_file_in_nebula_directory(self, handler):
        """Temp files should be in nebula subdirectory"""
        filepath = handler._save_output_to_temp_file("test", "cell-id")

        assert "nebula" in filepath
        assert "outputs" in filepath

        # Cleanup
        os.remove(filepath)

    def test_unique_filenames(self, handler):
        """Each call should create a unique filename"""
        path1 = handler._save_output_to_temp_file("content1", "cell-1")
        path2 = handler._save_output_to_temp_file("content2", "cell-1")

        assert path1 != path2

        # Cleanup
        os.remove(path1)
        os.remove(path2)


class TestTruncationMetadata:
    """Tests for truncation metadata accuracy"""

    @pytest.fixture
    def handler(self):
        return HeadlessOperationHandler(MockFsService())

    def test_metadata_total_counts(self, handler):
        """Metadata should accurately report total lines and chars"""
        content = "line1\nline2\nline3"

        _, metadata = handler._truncate_output(content, 100, 10000, 0)

        assert metadata["total_lines"] == 3
        assert metadata["total_chars"] == len(content)

    def test_metadata_returned_range(self, handler):
        """Metadata should accurately report returned range"""
        lines = [f"line {i}" for i in range(100)]
        content = "\n".join(lines)

        _, metadata = handler._truncate_output(content, 30, 100000, 10)

        assert metadata["returned_range"]["start_line"] == 10
        assert metadata["returned_range"]["end_line"] == 40

    def test_metadata_char_count(self, handler):
        """Metadata should report actual returned char count"""
        content = "short line\n" + "long line " * 100

        result, metadata = handler._truncate_output(content, 100, 50, 0)

        assert metadata["returned_range"]["char_count"] == len(result)
