"""
Tests for kernel_service - working directory support
"""
import pytest
import asyncio
import os
import tempfile
from pathlib import Path

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from kernel_service import KernelService


@pytest.fixture
def kernel_service_instance():
    """Create a fresh KernelService instance for each test"""
    return KernelService()


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
