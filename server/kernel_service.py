"""
Jupyter Kernel Service - Manages real Jupyter kernels
"""
import asyncio
import uuid
import base64
from typing import Dict, Optional, Any, Callable
from dataclasses import dataclass, field
from jupyter_client import KernelManager, kernelspec
from jupyter_client.asynchronous import AsyncKernelClient


@dataclass
class KernelSession:
    """Represents an active kernel session"""
    id: str
    kernel_name: str
    manager: KernelManager
    client: AsyncKernelClient
    status: str = "idle"
    execution_count: int = 0


class KernelService:
    """Service for managing Jupyter kernels"""

    def __init__(self):
        self.sessions: Dict[str, KernelSession] = {}
        self._lock = asyncio.Lock()

    def get_available_kernels(self) -> list[dict]:
        """List all available kernelspecs on the system"""
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

    async def start_kernel(self, kernel_name: str = "python3", cwd: str = None) -> str:
        """Start a new kernel session with optional working directory

        Args:
            kernel_name: The kernel to start (e.g., 'python3')
            cwd: Working directory for the kernel process
        """
        from pathlib import Path

        session_id = str(uuid.uuid4())

        # Create kernel manager
        km = KernelManager(kernel_name=kernel_name)

        # Prepare start_kernel kwargs
        start_kwargs = {}
        if cwd:
            expanded_cwd = str(Path(cwd).expanduser().resolve())
            start_kwargs['cwd'] = expanded_cwd

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
            status="idle"
        )

        async with self._lock:
            self.sessions[session_id] = session

        return session_id

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

    async def stop_kernel(self, session_id: str) -> bool:
        """Stop a kernel session"""
        async with self._lock:
            session = self.sessions.pop(session_id, None)

        if session:
            try:
                session.client.stop_channels()
                session.manager.shutdown_kernel(now=True)
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
            Final execution result
        """
        session = self.sessions.get(session_id)
        if not session:
            raise ValueError(f"Session {session_id} not found")

        session.status = "busy"
        session.execution_count += 1
        exec_count = session.execution_count

        try:
            # Execute the code
            msg_id = session.client.execute(code, store_history=True)

            # Process messages until execution is complete
            while True:
                try:
                    msg = await asyncio.get_event_loop().run_in_executor(
                        None,
                        lambda: session.client.get_iopub_msg(timeout=30)
                    )
                except:
                    break

                msg_type = msg.get('msg_type', '')
                content = msg.get('content', {})
                parent_msg_id = msg.get('parent_header', {}).get('msg_id', '')

                # Only process messages for our execution
                if parent_msg_id != msg_id:
                    continue

                output = self._process_message(msg_type, content)
                if output:
                    await on_output(output)

                # Check for execution completion
                if msg_type == 'status' and content.get('execution_state') == 'idle':
                    break

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

    async def cleanup(self):
        """Cleanup all kernel sessions"""
        async with self._lock:
            for session_id in list(self.sessions.keys()):
                await self.stop_kernel(session_id)


# Global instance
kernel_service = KernelService()
