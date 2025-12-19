"""
Jupyter Kernel Service - Manages real Jupyter kernels
"""
import asyncio
import uuid
import base64
from datetime import datetime
from typing import Dict, List, Optional, Any, Callable
from dataclasses import dataclass, field
from jupyter_client import KernelManager, kernelspec
from jupyter_client.asynchronous import AsyncKernelClient

from session_store import session_store, PersistedSession


@dataclass
class KernelSession:
    """Represents an active kernel session"""
    id: str
    kernel_name: str
    manager: KernelManager
    client: AsyncKernelClient
    file_path: Optional[str] = None  # The notebook file this kernel is for
    status: str = "idle"
    execution_count: int = 0


class KernelService:
    """Service for managing Jupyter kernels"""

    def __init__(self):
        self.sessions: Dict[str, KernelSession] = {}
        # Map from file_path to session_id for "one notebook = one kernel"
        self.file_to_session: Dict[str, str] = {}
        self._lock = asyncio.Lock()
        # Cached kernel specs (lazy loaded)
        self._kernels_cache: Optional[list[dict]] = None
        self._kernels_loading: bool = False
        self._ready: bool = False
        # Heartbeat monitoring callbacks
        self._status_callbacks: List[Callable[[str, str], None]] = []
        # Session persistence store
        self._session_store = session_store

    def _normalize_path(self, path: str) -> str:
        """Normalize a file path for consistent lookup"""
        from pathlib import Path
        return str(Path(path).expanduser().resolve())

    @property
    def is_ready(self) -> bool:
        """Check if kernel service has completed initial discovery"""
        return self._ready

    def _discover_kernels_sync(self) -> list[dict]:
        """Synchronously discover available kernels (can be slow)"""
        specs = kernelspec.find_kernel_specs()
        result = []

        for name, path in specs.items():
            try:
                spec = kernelspec.get_kernel_spec(name)
                result.append({
                    "name": name,
                    "display_name": spec.display_name,
                    "language": spec.language,
                    "path": path
                })
            except Exception as e:
                print(f"Error loading kernelspec {name}: {e}")

        return result

    async def initialize_async(self):
        """Background initialization - call after server starts"""
        if self._kernels_loading or self._ready:
            return

        self._kernels_loading = True
        print("Discovering Jupyter kernels in background...")

        # Run kernel discovery in thread pool to not block
        loop = asyncio.get_event_loop()
        self._kernels_cache = await loop.run_in_executor(
            None, self._discover_kernels_sync
        )

        self._kernels_loading = False
        self._ready = True
        print(f"Found {len(self._kernels_cache)} kernels")

    def get_available_kernels(self) -> list[dict]:
        """List all available kernelspecs on the system"""
        # Return cache if available
        if self._kernels_cache is not None:
            return self._kernels_cache

        # Fallback to sync discovery if not initialized yet
        # (shouldn't happen after initialize_async is called)
        if not self._kernels_loading:
            self._kernels_cache = self._discover_kernels_sync()
            self._ready = True

        return self._kernels_cache or []

    async def start_kernel(self, kernel_name: str = "python3", cwd: str = None, file_path: str = None) -> str:
        """Start a new kernel session with optional working directory

        Args:
            kernel_name: The kernel to start (e.g., 'python3')
            cwd: Working directory for the kernel process
            file_path: The notebook file path (for "one notebook = one kernel")
        """
        # Normalize file path for consistent lookup
        normalized_file_path = self._normalize_path(file_path) if file_path else None

        async with self._lock:
            return await self._start_kernel_internal(kernel_name, cwd, normalized_file_path)

    async def _start_kernel_internal(self, kernel_name: str = "python3", cwd: str = None, file_path: str = None) -> str:
        """Internal kernel start - caller must hold self._lock"""
        session_id = str(uuid.uuid4())

        # Create kernel manager
        km = KernelManager(kernel_name=kernel_name)

        # Prepare start_kernel kwargs
        start_kwargs = {}
        if cwd:
            start_kwargs['cwd'] = self._normalize_path(cwd)

        km.start_kernel(**start_kwargs)

        # Get async client
        client = km.client()
        client.start_channels()

        # Wait for kernel to be ready
        await self._wait_for_ready(client)

        session = KernelSession(
            id=session_id,
            kernel_name=kernel_name,
            manager=km,
            client=client,
            file_path=file_path,
            status="idle"
        )

        self.sessions[session_id] = session
        if file_path:
            self.file_to_session[file_path] = session_id

        # Persist session to database
        now = datetime.now().timestamp()
        # Get kernel PID - newer jupyter_client uses provisioner
        kernel_pid = None
        try:
            if hasattr(km, 'provisioner') and km.provisioner:
                kernel_pid = km.provisioner.process.pid
            elif hasattr(km, 'kernel') and km.kernel:
                kernel_pid = km.kernel.pid
        except (AttributeError, TypeError):
            pass

        persisted = PersistedSession(
            session_id=session_id,
            kernel_name=kernel_name,
            file_path=file_path,
            kernel_pid=kernel_pid,
            status='active',
            created_at=now,
            last_heartbeat=now,
            connection_file=km.connection_file
        )
        self._session_store.save_session(persisted)

        return session_id

    async def get_or_create_kernel(self, file_path: str, kernel_name: str = "python3") -> str:
        """Get existing kernel for a notebook file, or create a new one.

        This implements "one notebook = one kernel" - multiple browser tabs
        opening the same notebook will share the same kernel.

        If the requested kernel_name differs from the existing kernel, the old
        kernel is stopped and a new one is started with the requested kernel.

        Args:
            file_path: The notebook file path
            kernel_name: The kernel to start if creating new (or switch to)

        Returns:
            session_id of existing or new kernel
        """
        from pathlib import Path

        # Normalize path for consistent lookup
        normalized_path = self._normalize_path(file_path)

        # Hold lock for the entire operation to prevent race conditions
        # where two concurrent requests both create kernels for the same file
        async with self._lock:
            existing_session_id = self.file_to_session.get(normalized_path)
            if existing_session_id and existing_session_id in self.sessions:
                session = self.sessions[existing_session_id]
                # Verify kernel is still alive
                if session.manager.is_alive():
                    # Check if kernel type matches what was requested
                    if session.kernel_name == kernel_name:
                        return existing_session_id
                    else:
                        # Kernel type changed - need to stop old and start new
                        print(f"Switching kernel for {file_path}: {session.kernel_name} -> {kernel_name}")
                        # Mark for stopping outside the lock
                        session_to_stop = existing_session_id
                else:
                    # Kernel died, clean up and create new
                    del self.file_to_session[normalized_path]
                    del self.sessions[existing_session_id]

            # Create new kernel with notebook's directory as cwd (inside lock)
            cwd = str(Path(normalized_path).parent)
            return await self._start_kernel_internal(kernel_name=kernel_name, cwd=cwd, file_path=normalized_path)

    def get_kernel_for_file(self, file_path: str) -> Optional[str]:
        """Get the session_id for a notebook file if one exists"""
        normalized_path = self._normalize_path(file_path)
        session_id = self.file_to_session.get(normalized_path)
        if session_id and session_id in self.sessions:
            if self.sessions[session_id].manager.is_alive():
                return session_id
        return None

    async def _wait_for_ready(self, client: AsyncKernelClient, timeout: float = 30.0):
        """Wait for kernel to be ready"""
        start_time = asyncio.get_event_loop().time()
        while True:
            if asyncio.get_event_loop().time() - start_time > timeout:
                raise TimeoutError("Kernel did not start in time")

            try:
                msg = client.get_shell_msg(timeout=0.5)
                if msg.get('msg_type') == 'kernel_info_reply':
                    break
            except:
                # Send kernel_info_request
                client.kernel_info()
                await asyncio.sleep(0.1)

    async def stop_kernel(self, session_id: str, timeout: float = 5.0) -> bool:
        """Stop a kernel session with graceful shutdown

        Args:
            session_id: The kernel session ID
            timeout: Seconds to wait for graceful shutdown before forcing (default 5.0)

        Returns:
            True if kernel was stopped successfully
        """
        import signal

        async with self._lock:
            session = self.sessions.pop(session_id, None)
            # Also remove from file_to_session mapping
            if session and session.file_path:
                self.file_to_session.pop(session.file_path, None)

        if session:
            try:
                session.client.stop_channels()

                # Graceful shutdown: try SIGTERM first, then force if needed
                if session.manager.is_alive():
                    try:
                        # Try graceful shutdown (SIGTERM)
                        session.manager.shutdown_kernel(now=False)

                        # Wait for kernel to terminate gracefully
                        loop = asyncio.get_event_loop()
                        start_time = loop.time()
                        while session.manager.is_alive() and (loop.time() - start_time) < timeout:
                            await asyncio.sleep(0.1)

                        # If still alive after timeout, force kill (SIGKILL)
                        if session.manager.is_alive():
                            print(f"Kernel {session_id} did not stop gracefully, forcing shutdown")
                            session.manager.shutdown_kernel(now=True)
                    except Exception as e:
                        # If graceful fails, force it
                        print(f"Graceful shutdown failed for {session_id}: {e}")
                        session.manager.shutdown_kernel(now=True)

                # Delete from persistence store
                self._session_store.delete_session(session_id)
                return True
            except Exception as e:
                print(f"Error stopping kernel: {e}")
                return False
        return False

    async def interrupt_kernel(self, session_id: str) -> bool:
        """Interrupt kernel execution"""
        session = self.sessions.get(session_id)
        if session:
            try:
                session.manager.interrupt_kernel()
                return True
            except Exception as e:
                print(f"Error interrupting kernel: {e}")
                return False
        return False

    async def restart_kernel(self, session_id: str) -> bool:
        """Restart a kernel"""
        session = self.sessions.get(session_id)
        if session:
            try:
                session.manager.restart_kernel()
                await self._wait_for_ready(session.client)
                session.execution_count = 0
                return True
            except Exception as e:
                print(f"Error restarting kernel: {e}")
                return False
        return False

    async def execute_code(
        self,
        session_id: str,
        code: str,
        on_output: Callable[[dict], Any]
    ) -> dict:
        """
        Execute code in a kernel session with streaming output

        Args:
            session_id: The kernel session ID
            code: Code to execute
            on_output: Callback for each output message

        Returns:
            Final execution result with kernel's execution_count
        """
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        session.status = "busy"
        exec_count = None  # Will be set from kernel's execute_reply

        try:
            # Execute the code
            msg_id = session.client.execute(code, store_history=True)

            # Process iopub messages for output (no timeout - cells can run indefinitely)
            while True:
                try:
                    msg = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: session.client.get_iopub_msg(timeout=None)
                    )
                except Exception as e:
                    # Only break on actual errors, not timeouts
                    print(f"Error getting iopub message: {e}")
                    break

                msg_type = msg.get('msg_type', '')
                content = msg.get('content', {})
                parent_msg_id = msg.get('parent_header', {}).get('msg_id', '')

                # Only process messages for our execution
                if parent_msg_id != msg_id:
                    continue

                # Capture execution count from execute_input
                if msg_type == 'execute_input':
                    exec_count = content.get('execution_count')

                output = self._process_message(msg_type, content)
                if output:
                    await on_output(output)

                # Check for execution completion
                if msg_type == 'status' and content.get('execution_state') == 'idle':
                    break

            # Update session's execution count from kernel
            if exec_count is not None:
                session.execution_count = exec_count

            session.status = "idle"
            return {"status": "ok", "execution_count": exec_count}

        except Exception as e:
            session.status = "idle"
            error_output = {
                "type": "error",
                "content": str(e)
            }
            await on_output(error_output)
            return {"status": "error", "error": str(e)}

    def _process_message(self, msg_type: str, content: dict) -> Optional[dict]:
        """Process a kernel message and return formatted output"""

        if msg_type == 'stream':
            stream_name = content.get('name', 'stdout')
            text = content.get('text', '')
            return {
                "type": "stderr" if stream_name == 'stderr' else "stdout",
                "content": text
            }

        elif msg_type == 'execute_result':
            data = content.get('data', {})
            return self._format_display_data(data)

        elif msg_type == 'display_data':
            data = content.get('data', {})
            return self._format_display_data(data)

        elif msg_type == 'error':
            traceback = content.get('traceback', [])
            # Clean ANSI codes from traceback
            clean_tb = '\n'.join(self._strip_ansi(line) for line in traceback)
            return {
                "type": "error",
                "content": clean_tb
            }

        return None

    def _format_display_data(self, data: dict) -> dict:
        """Format display data for the frontend"""
        # Priority: image > html > text

        if 'image/png' in data:
            # Already base64 encoded
            return {
                "type": "image",
                "content": data['image/png']
            }

        if 'text/html' in data:
            return {
                "type": "html",
                "content": data['text/html']
            }

        if 'text/plain' in data:
            return {
                "type": "stdout",
                "content": data['text/plain']
            }

        return None

    def _strip_ansi(self, text: str) -> str:
        """Remove ANSI escape codes from text"""
        import re
        ansi_escape = re.compile(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])')
        return ansi_escape.sub('', text)

    def get_session_status(self, session_id: str) -> Optional[dict]:
        """Get status of a kernel session"""
        session = self.sessions.get(session_id)
        if session:
            return {
                "id": session.id,
                "kernel_name": session.kernel_name,
                "status": session.status,
                "execution_count": session.execution_count
            }
        return None

    def get_all_sessions(self) -> list[dict]:
        """Get all active kernel sessions with memory usage"""
        try:
            import psutil
            has_psutil = True
        except ImportError:
            has_psutil = False

        sessions_info = []
        for session_id, session in self.sessions.items():
            info = {
                "id": session.id,
                "kernel_name": session.kernel_name,
                "file_path": session.file_path,
                "status": session.status,
                "execution_count": session.execution_count,
                "memory_mb": None,
                "pid": None
            }

            # Get memory usage if psutil available
            if has_psutil and session.manager.is_alive():
                try:
                    # Get kernel process PID
                    pid = session.manager.kernel.pid
                    info["pid"] = pid
                    proc = psutil.Process(pid)
                    mem_info = proc.memory_info()
                    info["memory_mb"] = round(mem_info.rss / (1024 * 1024), 1)
                except (psutil.NoSuchProcess, psutil.AccessDenied, AttributeError):
                    pass

            sessions_info.append(info)

        return sessions_info

    async def cleanup(self):
        """Cleanup all kernel sessions"""
        # Get all session IDs first, then stop each one
        # (stop_kernel acquires lock internally, so we can't hold lock here)
        session_ids = list(self.sessions.keys())
        for session_id in session_ids:
            await self.stop_kernel(session_id)


# Global instance
kernel_service = KernelService()
