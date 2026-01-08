"""
Tests for main.py API endpoints
Uses mocked services to avoid dependency issues
"""
import pytest
import sys
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


@pytest.fixture
def mock_kernel_service():
    """Create a mock kernel service"""
    mock_ks = MagicMock()
    mock_ks.is_ready = True
    mock_ks.get_available_kernels.return_value = [
        {"name": "python3", "display_name": "Python 3", "language": "python", "path": "/usr/share/jupyter/kernels/python3"}
    ]
    mock_ks.get_all_sessions.return_value = []
    mock_ks.start_kernel = AsyncMock(return_value="test-session-123")
    mock_ks.stop_kernel = AsyncMock(return_value=True)
    mock_ks.interrupt_kernel = AsyncMock(return_value=True)
    mock_ks.restart_kernel = AsyncMock(return_value=True)
    mock_ks.get_or_create_kernel = AsyncMock(return_value="test-session-456")
    mock_ks.get_kernel_for_file.return_value = None
    mock_ks.get_session_status.return_value = {
        "id": "test-session-123",
        "kernel_name": "python3",
        "status": "idle",
        "execution_count": 0
    }
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
    mock_llm.get_available_providers.return_value = {
        "google": {"name": "Google Gemini", "models": ["gemini-2.5-flash"]},
    }
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
                yield test_client, mock_kernel_service, mock_session_store


class TestHealthEndpoints:
    """Test health check endpoints"""

    def test_health_check(self, client):
        """Test /api/health endpoint"""
        test_client, mock_ks, _ = client
        response = test_client.get("/api/health")
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "version" in data
        assert "ready" in data

    def test_ready_check_when_ready(self, client):
        """Test /api/ready when service is ready"""
        test_client, mock_ks, _ = client
        mock_ks.is_ready = True

        response = test_client.get("/api/ready")
        assert response.status_code == 200
        assert response.json()["status"] == "ready"

    def test_ready_check_when_not_ready(self, client):
        """Test /api/ready when service is still initializing"""
        test_client, mock_ks, _ = client
        mock_ks.is_ready = False

        response = test_client.get("/api/ready")
        assert response.status_code == 503
        assert "initializing" in response.json()["detail"]


class TestKernelEndpoints:
    """Test kernel-related API endpoints"""

    def test_list_kernels(self, client):
        """Test GET /api/kernels"""
        test_client, mock_ks, _ = client
        response = test_client.get("/api/kernels")
        assert response.status_code == 200
        data = response.json()
        assert "kernels" in data
        assert len(data["kernels"]) > 0
        assert data["kernels"][0]["name"] == "python3"

    def test_list_kernel_sessions(self, client):
        """Test GET /api/kernels/sessions"""
        test_client, mock_ks, _ = client
        mock_ks.get_all_sessions.return_value = [
            {"id": "session-1", "kernel_name": "python3", "status": "idle"}
        ]

        response = test_client.get("/api/kernels/sessions")
        assert response.status_code == 200
        data = response.json()
        assert "sessions" in data
        assert len(data["sessions"]) == 1

    def test_start_kernel(self, client):
        """Test POST /api/kernels/start"""
        test_client, mock_ks, _ = client

        response = test_client.post("/api/kernels/start", json={
            "kernel_name": "python3",
            "cwd": "/tmp"
        })

        assert response.status_code == 200
        data = response.json()
        assert data["session_id"] == "test-session-123"
        assert data["kernel_name"] == "python3"
        mock_ks.start_kernel.assert_called_once()

    def test_start_kernel_with_file_path(self, client):
        """Test POST /api/kernels/start with file_path"""
        test_client, mock_ks, _ = client

        response = test_client.post("/api/kernels/start", json={
            "kernel_name": "python3",
            "file_path": "/path/to/notebook.ipynb"
        })

        assert response.status_code == 200
        mock_ks.start_kernel.assert_called_once_with(
            kernel_name="python3",
            cwd=None,
            file_path="/path/to/notebook.ipynb"
        )

    def test_start_kernel_error(self, client):
        """Test POST /api/kernels/start with error"""
        test_client, mock_ks, _ = client
        mock_ks.start_kernel = AsyncMock(side_effect=Exception("Kernel failed to start"))

        response = test_client.post("/api/kernels/start", json={"kernel_name": "python3"})

        assert response.status_code == 500
        assert "Kernel failed to start" in response.json()["detail"]

    def test_get_or_create_kernel_for_file(self, client):
        """Test POST /api/kernels/for-file"""
        test_client, mock_ks, _ = client

        response = test_client.post("/api/kernels/for-file", json={
            "file_path": "/path/to/notebook.ipynb",
            "kernel_name": "python3"
        })

        assert response.status_code == 200
        data = response.json()
        assert data["session_id"] == "test-session-456"
        assert data["file_path"] == "/path/to/notebook.ipynb"

    def test_get_kernel_for_file_exists(self, client):
        """Test GET /api/kernels/for-file when kernel exists"""
        test_client, mock_ks, _ = client
        mock_ks.get_kernel_for_file.return_value = "existing-session-id"

        response = test_client.get("/api/kernels/for-file", params={"file_path": "/path/to/notebook.ipynb"})

        assert response.status_code == 200
        data = response.json()
        assert data["exists"] is True
        assert data["session_id"] == "existing-session-id"

    def test_get_kernel_for_file_not_exists(self, client):
        """Test GET /api/kernels/for-file when kernel doesn't exist"""
        test_client, mock_ks, _ = client
        mock_ks.get_kernel_for_file.return_value = None

        response = test_client.get("/api/kernels/for-file", params={"file_path": "/path/to/notebook.ipynb"})

        assert response.status_code == 200
        data = response.json()
        assert data["exists"] is False
        assert data["session_id"] is None

    def test_stop_kernel(self, client):
        """Test DELETE /api/kernels/{session_id}"""
        test_client, mock_ks, _ = client

        response = test_client.delete("/api/kernels/test-session-123")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        mock_ks.stop_kernel.assert_called_once_with("test-session-123")

    def test_stop_kernel_not_found(self, client):
        """Test DELETE /api/kernels/{session_id} when not found"""
        test_client, mock_ks, _ = client
        mock_ks.stop_kernel = AsyncMock(return_value=False)

        response = test_client.delete("/api/kernels/nonexistent-session")

        assert response.status_code == 404
        assert "not found" in response.json()["detail"]

    def test_interrupt_kernel(self, client):
        """Test POST /api/kernels/{session_id}/interrupt"""
        test_client, mock_ks, _ = client

        response = test_client.post("/api/kernels/test-session-123/interrupt")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        mock_ks.interrupt_kernel.assert_called_once_with("test-session-123")

    def test_interrupt_kernel_not_found(self, client):
        """Test POST /api/kernels/{session_id}/interrupt when not found"""
        test_client, mock_ks, _ = client
        mock_ks.interrupt_kernel = AsyncMock(return_value=False)

        response = test_client.post("/api/kernels/nonexistent-session/interrupt")

        assert response.status_code == 404

    def test_restart_kernel(self, client):
        """Test POST /api/kernels/{session_id}/restart"""
        test_client, mock_ks, _ = client

        response = test_client.post("/api/kernels/test-session-123/restart")

        assert response.status_code == 200
        assert response.json()["status"] == "ok"
        mock_ks.restart_kernel.assert_called_once_with("test-session-123")

    def test_restart_kernel_not_found(self, client):
        """Test POST /api/kernels/{session_id}/restart when not found"""
        test_client, mock_ks, _ = client
        mock_ks.restart_kernel = AsyncMock(return_value=False)

        response = test_client.post("/api/kernels/nonexistent-session/restart")

        assert response.status_code == 404

    def test_get_kernel_status(self, client):
        """Test GET /api/kernels/{session_id}/status"""
        test_client, mock_ks, _ = client

        response = test_client.get("/api/kernels/test-session-123/status")

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "test-session-123"
        assert data["kernel_name"] == "python3"
        assert data["status"] == "idle"

    def test_get_kernel_status_not_found(self, client):
        """Test GET /api/kernels/{session_id}/status when not found"""
        test_client, mock_ks, _ = client
        mock_ks.get_session_status.return_value = None

        response = test_client.get("/api/kernels/nonexistent-session/status")

        assert response.status_code == 404


class TestKernelExecuteEndpoint:
    """Test POST /api/kernels/{session_id}/execute REST endpoint"""

    def test_execute_code_success(self, client):
        """Test successful code execution via REST"""
        test_client, mock_ks, _ = client

        async def mock_execute(session_id, code, on_output, timeout=None):
            # Simulate some output
            await on_output({"type": "stdout", "content": "hello\n"})
            return {"status": "ok", "execution_count": 1}

        mock_ks.execute_code = AsyncMock(side_effect=mock_execute)

        response = test_client.post(
            "/api/kernels/test-session-123/execute",
            json={"code": "print('hello')"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "ok"
        assert "outputs" in data
        assert len(data["outputs"]) == 1
        assert data["outputs"][0]["type"] == "stdout"
        assert data["execution_count"] == 1

    def test_execute_code_with_timeout(self, client):
        """Test execute respects timeout parameter"""
        test_client, mock_ks, _ = client

        async def mock_execute(session_id, code, on_output, timeout=None):
            return {"status": "ok", "execution_count": 1}

        mock_ks.execute_code = AsyncMock(side_effect=mock_execute)

        response = test_client.post(
            "/api/kernels/test-session-123/execute",
            json={"code": "print('hello')", "timeout": 5.0}
        )

        assert response.status_code == 200
        # Verify timeout was passed to execute_code
        call_kwargs = mock_ks.execute_code.call_args.kwargs
        assert call_kwargs.get("timeout") == 5.0

    def test_execute_code_session_not_found(self, client):
        """Test execute returns 404 when session not found"""
        test_client, mock_ks, _ = client

        # Import error inside test to avoid import issues
        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from errors import KernelNotFoundError

        mock_ks.execute_code = AsyncMock(
            side_effect=KernelNotFoundError(detail="Session not found")
        )

        response = test_client.post(
            "/api/kernels/nonexistent/execute",
            json={"code": "print('hello')"}
        )

        assert response.status_code == 404
        assert response.json()["error_code"] == "KERNEL_NOT_FOUND"

    def test_execute_code_when_not_ready(self, client):
        """Test execute returns 503 when service not ready"""
        test_client, mock_ks, _ = client

        import sys
        sys.path.insert(0, str(Path(__file__).parent.parent))
        from errors import KernelNotReadyError

        mock_ks.execute_code = AsyncMock(
            side_effect=KernelNotReadyError(detail="Service not ready")
        )

        response = test_client.post(
            "/api/kernels/test-session-123/execute",
            json={"code": "print('hello')"}
        )

        assert response.status_code == 503
        assert response.json()["error_code"] == "KERNEL_NOT_READY"

    def test_execute_code_multiple_outputs(self, client):
        """Test execute collects multiple outputs"""
        test_client, mock_ks, _ = client

        async def mock_execute(session_id, code, on_output, timeout=None):
            await on_output({"type": "stdout", "content": "line1\n"})
            await on_output({"type": "stdout", "content": "line2\n"})
            await on_output({"type": "stderr", "content": "warning\n"})
            return {"status": "ok", "execution_count": 2}

        mock_ks.execute_code = AsyncMock(side_effect=mock_execute)

        response = test_client.post(
            "/api/kernels/test-session-123/execute",
            json={"code": "print('line1'); print('line2')"}
        )

        assert response.status_code == 200
        data = response.json()
        assert len(data["outputs"]) == 3
        assert data["outputs"][0]["content"] == "line1\n"
        assert data["outputs"][1]["content"] == "line2\n"
        assert data["outputs"][2]["type"] == "stderr"

    def test_execute_code_error_result(self, client):
        """Test execute returns error status from kernel"""
        test_client, mock_ks, _ = client

        async def mock_execute(session_id, code, on_output, timeout=None):
            await on_output({"type": "error", "content": "NameError: name 'foo' is not defined"})
            return {"status": "error", "error": "NameError"}

        mock_ks.execute_code = AsyncMock(side_effect=mock_execute)

        response = test_client.post(
            "/api/kernels/test-session-123/execute",
            json={"code": "foo"}
        )

        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "error"
        assert data["error"] == "NameError"
