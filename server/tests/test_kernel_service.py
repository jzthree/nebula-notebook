"""
Tests for kernel_service - working directory support and session persistence
"""
import pytest
import asyncio
import os
import tempfile
import uuid
from pathlib import Path

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from kernel_service import KernelService
from session_store import SessionStore, PersistedSession


@pytest.fixture
def temp_session_store():
    """Create a temporary session store for testing"""
    temp_path = Path(tempfile.gettempdir()) / f"test_kernel_{uuid.uuid4().hex}.db"
    store = SessionStore(db_path=temp_path)
    yield store
    # Cleanup
    if hasattr(store._local, 'conn') and store._local.conn:
        store._local.conn.close()
        store._local.conn = None
    temp_path.unlink(missing_ok=True)


@pytest.fixture
def kernel_service_instance(temp_session_store):
    """Create a fresh KernelService instance with temp session store"""
    service = KernelService()
    service._session_store = temp_session_store
    # Mark as ready for tests that need to start kernels
    service._ready = True
    return service


@pytest.fixture
def temp_directory():
    """Create a temporary directory for testing cwd"""
    with tempfile.TemporaryDirectory() as tmpdir:
        yield tmpdir


class TestKernelServiceCwd:
    """Test working directory support in kernel service"""

    @pytest.mark.asyncio
    async def test_start_kernel_with_cwd(self, kernel_service_instance, temp_directory):
        """Test that kernel starts with specified working directory"""
        # Start kernel with cwd
        session_id = await kernel_service_instance.start_kernel(
            kernel_name="python3",
            cwd=temp_directory
        )

        assert session_id is not None
        assert session_id in kernel_service_instance.sessions

        # Execute code to check the working directory
        outputs = []
        async def collect_output(output):
            outputs.append(output)

        await kernel_service_instance.execute_code(
            session_id,
            "import os; print(os.getcwd())",
            collect_output
        )

        # Check that cwd matches
        output_text = ''.join(o.get('content', '') for o in outputs if o.get('type') == 'stdout')
        assert temp_directory in output_text

        # Cleanup
        await kernel_service_instance.stop_kernel(session_id)

    @pytest.mark.asyncio
    async def test_start_kernel_without_cwd(self, kernel_service_instance):
        """Test that kernel starts normally without cwd (backwards compatible)"""
        session_id = await kernel_service_instance.start_kernel(kernel_name="python3")

        assert session_id is not None
        assert session_id in kernel_service_instance.sessions

        # Cleanup
        await kernel_service_instance.stop_kernel(session_id)

    @pytest.mark.asyncio
    async def test_start_kernel_with_home_tilde(self, kernel_service_instance):
        """Test that ~ is expanded in cwd path"""
        session_id = await kernel_service_instance.start_kernel(
            kernel_name="python3",
            cwd="~"
        )

        assert session_id is not None

        # Execute code to check the working directory
        outputs = []
        async def collect_output(output):
            outputs.append(output)

        await kernel_service_instance.execute_code(
            session_id,
            "import os; print(os.getcwd())",
            collect_output
        )

        # Check that cwd is the home directory
        output_text = ''.join(o.get('content', '') for o in outputs if o.get('type') == 'stdout')
        assert os.path.expanduser("~") in output_text

        # Cleanup
        await kernel_service_instance.stop_kernel(session_id)


class TestMultipleSessions:
    """Test multiple kernel sessions with different working directories"""

    @pytest.mark.asyncio
    async def test_multiple_sessions_different_cwd(self, kernel_service_instance):
        """Test that multiple sessions can have different working directories"""
        with tempfile.TemporaryDirectory() as dir1, tempfile.TemporaryDirectory() as dir2:
            # Start two kernels with different cwds
            session1 = await kernel_service_instance.start_kernel(cwd=dir1)
            session2 = await kernel_service_instance.start_kernel(cwd=dir2)

            assert session1 != session2
            assert len(kernel_service_instance.sessions) == 2

            # Check each session has correct cwd
            async def get_cwd(session_id):
                outputs = []
                async def collect(output):
                    outputs.append(output)
                await kernel_service_instance.execute_code(
                    session_id,
                    "import os; print(os.getcwd())",
                    collect
                )
                return ''.join(o.get('content', '') for o in outputs if o.get('type') == 'stdout')

            cwd1 = await get_cwd(session1)
            cwd2 = await get_cwd(session2)

            assert dir1 in cwd1
            assert dir2 in cwd2

            # Cleanup
            await kernel_service_instance.stop_kernel(session1)
            await kernel_service_instance.stop_kernel(session2)


class TestSessionPersistence:
    """Test session persistence in kernel service"""

    @pytest.mark.asyncio
    async def test_start_kernel_persists_session(self, kernel_service_instance, temp_session_store):
        """Test that starting a kernel saves session to store"""
        session_id = await kernel_service_instance.start_kernel(kernel_name="python3")

        # Verify session is persisted
        persisted = temp_session_store.get_session(session_id)
        assert persisted is not None
        assert persisted.session_id == session_id
        assert persisted.kernel_name == "python3"
        assert persisted.status == "active"
        assert persisted.kernel_pid is not None

        # Cleanup
        await kernel_service_instance.stop_kernel(session_id)

    @pytest.mark.asyncio
    async def test_start_kernel_persists_file_path(self, kernel_service_instance, temp_session_store):
        """Test that file_path is persisted when provided"""
        file_path = "/path/to/test/notebook.ipynb"
        session_id = await kernel_service_instance.start_kernel(
            kernel_name="python3",
            file_path=file_path
        )

        # Verify file_path is persisted
        persisted = temp_session_store.get_session(session_id)
        assert persisted is not None
        assert persisted.file_path == file_path

        # Cleanup
        await kernel_service_instance.stop_kernel(session_id)

    @pytest.mark.asyncio
    async def test_stop_kernel_deletes_session(self, kernel_service_instance, temp_session_store):
        """Test that stopping a kernel deletes session from store"""
        session_id = await kernel_service_instance.start_kernel(kernel_name="python3")

        # Verify session exists
        assert temp_session_store.get_session(session_id) is not None

        # Stop kernel
        result = await kernel_service_instance.stop_kernel(session_id)
        assert result is True

        # Verify session is deleted
        assert temp_session_store.get_session(session_id) is None

    @pytest.mark.asyncio
    async def test_session_has_connection_file(self, kernel_service_instance, temp_session_store):
        """Test that connection_file is persisted for reconnection"""
        session_id = await kernel_service_instance.start_kernel(kernel_name="python3")

        persisted = temp_session_store.get_session(session_id)
        assert persisted.connection_file is not None
        assert len(persisted.connection_file) > 0

        # Cleanup
        await kernel_service_instance.stop_kernel(session_id)


class TestGracefulShutdown:
    """Test graceful kernel shutdown"""

    @pytest.mark.asyncio
    async def test_stop_kernel_graceful(self, kernel_service_instance):
        """Test that stop_kernel shuts down gracefully"""
        session_id = await kernel_service_instance.start_kernel(kernel_name="python3")

        # Verify kernel is running
        session = kernel_service_instance.sessions.get(session_id)
        assert session is not None
        assert session.manager.is_alive()

        # Stop kernel - should complete successfully
        result = await kernel_service_instance.stop_kernel(session_id)
        assert result is True

        # Verify kernel is no longer in sessions
        assert session_id not in kernel_service_instance.sessions

    @pytest.mark.asyncio
    async def test_stop_kernel_with_timeout(self, kernel_service_instance):
        """Test that stop_kernel respects timeout parameter"""
        session_id = await kernel_service_instance.start_kernel(kernel_name="python3")

        # Stop kernel with explicit timeout
        result = await kernel_service_instance.stop_kernel(session_id, timeout=2.0)
        assert result is True

    @pytest.mark.asyncio
    async def test_stop_kernel_not_found(self, kernel_service_instance):
        """Test that stop_kernel returns False for non-existent session"""
        result = await kernel_service_instance.stop_kernel("nonexistent-session-id")
        assert result is False


class TestKernelReadinessGuards:
    """Test kernel service readiness guards"""

    @pytest.mark.asyncio
    async def test_start_kernel_raises_when_not_ready(self):
        """Test that start_kernel raises KernelNotReadyError when not initialized"""
        from errors import KernelNotReadyError

        service = KernelService()
        service._ready = False

        with pytest.raises(KernelNotReadyError):
            await service.start_kernel(kernel_name="python3")

    @pytest.mark.asyncio
    async def test_get_or_create_kernel_raises_when_not_ready(self):
        """Test that get_or_create_kernel raises KernelNotReadyError when not initialized"""
        from errors import KernelNotReadyError

        service = KernelService()
        service._ready = False

        with pytest.raises(KernelNotReadyError):
            await service.get_or_create_kernel(
                file_path="/path/to/notebook.ipynb",
                kernel_name="python3"
            )

    @pytest.mark.asyncio
    async def test_execute_code_raises_when_not_ready(self):
        """Test that execute_code raises KernelNotReadyError when not initialized"""
        from errors import KernelNotReadyError

        service = KernelService()
        service._ready = False

        async def dummy_callback(output):
            pass

        with pytest.raises(KernelNotReadyError):
            await service.execute_code("session-id", "print('hi')", dummy_callback)


class TestKernelTypedErrors:
    """Test typed error handling in kernel service"""

    @pytest.mark.asyncio
    async def test_execute_code_session_not_found_raises_typed_error(self, kernel_service_instance):
        """Test that missing session raises KernelNotFoundError"""
        from errors import KernelNotFoundError

        # Ensure service is ready
        kernel_service_instance._ready = True

        async def dummy_callback(output):
            pass

        with pytest.raises(KernelNotFoundError):
            await kernel_service_instance.execute_code(
                "nonexistent-session-id",
                "print('hello')",
                dummy_callback
            )

    @pytest.mark.asyncio
    async def test_execute_code_with_timeout_parameter(self, kernel_service_instance):
        """Test that execute_code accepts timeout parameter"""
        # Start a kernel
        session_id = await kernel_service_instance.start_kernel(kernel_name="python3")

        outputs = []
        async def collect_output(output):
            outputs.append(output)

        # Execute code with timeout (should complete before timeout)
        result = await kernel_service_instance.execute_code(
            session_id,
            "print('hello')",
            collect_output,
            timeout=30.0  # 30 second timeout
        )

        assert result["status"] == "ok"

        # Cleanup
        await kernel_service_instance.stop_kernel(session_id)
