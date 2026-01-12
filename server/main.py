"""
Nebula Notebook Backend Server
FastAPI server for Jupyter kernel management, LLM, and filesystem operations
"""
import os
import asyncio
import json
from contextlib import asynccontextmanager
from typing import Optional, List, Dict, Any
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query, UploadFile, File, Form, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

from kernel_service import kernel_service
from llm_service import llm_service, LLMConfig
from fs_service import fs_service
from python_discovery import python_discovery
from session_store import session_store
from config import SESSION_MAX_AGE_HOURS, BACKEND_SHUTDOWN_TIMEOUT_SECONDS
from errors import NebulaError, convert_sdk_error
from operation_router import operation_router
from headless_handler import HeadlessOperationHandler
from timing_middleware import TimingMiddleware


# --- Pydantic Models ---

class StartKernelRequest(BaseModel):
    kernel_name: str = "python3"
    cwd: Optional[str] = None  # Working directory for the kernel
    file_path: Optional[str] = None  # Notebook file path for "one notebook = one kernel"


class GetOrCreateKernelRequest(BaseModel):
    file_path: str  # The notebook file path
    kernel_name: str = "python3"


class ExecuteCodeRequest(BaseModel):
    session_id: str
    code: str


class GenerateRequest(BaseModel):
    prompt: str
    system_prompt: str
    provider: str = "google"
    model: str = "gemini-2.5-flash"
    temperature: float = 0.2
    images: Optional[List[Dict[str, str]]] = None


class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, str]]
    system_prompt: str
    provider: str = "google"
    model: str = "gemini-2.5-flash"
    temperature: float = 0.2
    images: Optional[List[Dict[str, str]]] = None


class WriteFileRequest(BaseModel):
    path: str
    content: Any
    file_type: str = "text"


class CreateFileRequest(BaseModel):
    path: str
    is_directory: bool = False


class RenameFileRequest(BaseModel):
    old_path: str
    new_path: str


class SaveNotebookRequest(BaseModel):
    path: str
    cells: List[Dict[str, Any]]
    kernel_name: Optional[str] = None  # Kernel name to persist in notebook metadata
    history: Optional[List[Dict[str, Any]]] = None  # Operation history to save alongside notebook


class SaveHistoryRequest(BaseModel):
    notebook_path: str
    history: List[Dict[str, Any]]


class SaveSessionRequest(BaseModel):
    notebook_path: str
    session: Dict[str, Any]


class PermitAgentAccessRequest(BaseModel):
    notebook_path: str
    permitted: bool = True  # Set to False to revoke permission


class InstallKernelRequest(BaseModel):
    python_path: str
    kernel_name: Optional[str] = None


class GenerateStructuredRequest(BaseModel):
    prompt: str
    system_prompt: str
    provider: str = "google"
    model: str = "gemini-2.5-flash"
    temperature: float = 0.2


class NotebookOperationRequest(BaseModel):
    """Unified notebook operation request from MCP tools"""
    operation: Dict[str, Any]


# --- Lifespan ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup - respond to requests immediately, initialize in background
    print("Starting Nebula Notebook Backend...")

    # Initialize operation router with headless handler
    headless_handler = HeadlessOperationHandler(fs_service, operation_router)
    operation_router.set_headless_handler(headless_handler)
    print("Operation router initialized with agent session tracking")

    # Mark any previously active sessions as orphaned (from crashed server)
    orphaned_count = session_store.mark_all_orphaned()
    if orphaned_count > 0:
        print(f"Marked {orphaned_count} sessions as orphaned from previous run")

    # Clean up old orphaned/terminated sessions
    cleaned_count = session_store.cleanup_old_sessions(max_age_hours=SESSION_MAX_AGE_HOURS)
    if cleaned_count > 0:
        print(f"Cleaned up {cleaned_count} old sessions")

    # Start background initialization (don't await - let it run in background)
    asyncio.create_task(kernel_service.initialize_async())

    yield
    # Shutdown with timeout
    print("Shutting down... Cleaning up kernels...")
    try:
        await asyncio.wait_for(kernel_service.cleanup(), timeout=BACKEND_SHUTDOWN_TIMEOUT_SECONDS)
        print("Cleanup complete.")
    except asyncio.TimeoutError:
        print("Cleanup timed out, forcing shutdown.")


# --- App ---

app = FastAPI(
    title="Nebula Notebook API",
    description="Backend API for Nebula Notebook",
    version="1.0.0",
    lifespan=lifespan
)

# Timing middleware - register FIRST to measure total request time
app.add_middleware(TimingMiddleware, slow_request_threshold_ms=1000.0)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify exact origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Exception Handlers ---

@app.exception_handler(NebulaError)
async def nebula_error_handler(request: Request, exc: NebulaError):
    """Handle NebulaError exceptions with structured error responses."""
    return JSONResponse(
        status_code=exc.status_code,
        content=exc.to_dict()
    )


# --- Cell Metadata Schema ---

@app.get("/api/cell/metadata-schema")
async def get_cell_metadata_schema():
    """
    Get the cell metadata schema.

    Returns all metadata fields supported by Nebula cells,
    including type information and whether agents can modify them.
    Used by MCP servers to validate agent operations.
    """
    return {
        "id": {
            "type": "string",
            "description": "Unique cell identifier. Agent-created cells should use human-readable IDs.",
            "agentMutable": True,
        },
        "type": {
            "type": "enum",
            "values": ["code", "markdown"],
            "description": "Cell type: code for executable cells, markdown for documentation.",
            "agentMutable": True,
        },
        "scrolled": {
            "type": "boolean",
            "description": "Whether cell output is collapsed (Jupyter standard).",
            "agentMutable": True,
            "default": False,
        },
        "scrolledHeight": {
            "type": "number",
            "description": "Height in pixels when output is collapsed.",
            "agentMutable": True,
        },
    }


# --- Kernel Endpoints ---

@app.get("/api/kernels")
async def list_kernels():
    """List available kernelspecs"""
    return {"kernels": kernel_service.get_available_kernels()}


@app.get("/api/kernels/debug")
async def debug_kernels():
    """Debug endpoint to show kernel discovery paths and environment"""
    import os
    from pathlib import Path
    from jupyter_client import kernelspec

    # Get paths jupyter_client is searching
    jupyter_paths = []
    try:
        from jupyter_core.paths import jupyter_data_dir, jupyter_path
        jupyter_paths = jupyter_path()
    except Exception as e:
        jupyter_paths = [f"Error getting paths: {e}"]

    # Check common kernel locations
    common_paths = [
        Path.home() / ".local" / "share" / "jupyter" / "kernels",
        Path("/usr/local/share/jupyter/kernels"),
        Path("/usr/share/jupyter/kernels"),
    ]

    conda_prefix = os.environ.get("CONDA_PREFIX")
    if conda_prefix:
        common_paths.append(Path(conda_prefix) / "share" / "jupyter" / "kernels")

    path_status = {}
    for p in common_paths:
        if p.exists():
            try:
                kernels = [d.name for d in p.iterdir() if d.is_dir() and (d / "kernel.json").exists()]
                path_status[str(p)] = {"exists": True, "kernels": kernels}
            except Exception as e:
                path_status[str(p)] = {"exists": True, "error": str(e)}
        else:
            path_status[str(p)] = {"exists": False}

    return {
        "python_executable": os.sys.executable,
        "jupyter_data_paths": jupyter_paths,
        "common_paths": path_status,
        "env": {
            "JUPYTER_PATH": os.environ.get("JUPYTER_PATH", "(not set)"),
            "CONDA_PREFIX": os.environ.get("CONDA_PREFIX", "(not set)"),
            "HOME": os.environ.get("HOME", "(not set)"),
        },
        "discovered_kernels": kernel_service.get_available_kernels(),
    }


@app.get("/api/kernels/sessions")
async def list_kernel_sessions():
    """List all active kernel sessions with memory usage"""
    return {"sessions": kernel_service.get_all_sessions()}


@app.post("/api/kernels/start")
async def start_kernel(request: StartKernelRequest):
    """Start a new kernel session"""
    try:
        session_id = await kernel_service.start_kernel(
            kernel_name=request.kernel_name,
            cwd=request.cwd,
            file_path=request.file_path
        )
        return {"session_id": session_id, "kernel_name": request.kernel_name}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/kernels/for-file")
async def get_or_create_kernel_for_file(request: GetOrCreateKernelRequest):
    """Get existing kernel for a notebook file, or create a new one.

    This implements "one notebook = one kernel" - multiple browser tabs
    opening the same notebook will share the same kernel.
    """
    try:
        session_id = await kernel_service.get_or_create_kernel(
            file_path=request.file_path,
            kernel_name=request.kernel_name
        )
        return {
            "session_id": session_id,
            "kernel_name": request.kernel_name,
            "file_path": request.file_path
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/kernels/for-file")
async def get_kernel_for_file(file_path: str):
    """Check if a kernel exists for a notebook file"""
    session_id = kernel_service.get_kernel_for_file(file_path)
    if session_id:
        return {"session_id": session_id, "exists": True}
    return {"session_id": None, "exists": False}


@app.delete("/api/kernels/{session_id}")
async def stop_kernel(session_id: str):
    """Stop a kernel session"""
    success = await kernel_service.stop_kernel(session_id)
    if success:
        return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/kernels/{session_id}/interrupt")
async def interrupt_kernel(session_id: str):
    """Interrupt kernel execution"""
    success = await kernel_service.interrupt_kernel(session_id)
    if success:
        return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/kernels/{session_id}/restart")
async def restart_kernel(session_id: str):
    """Restart a kernel"""
    success = await kernel_service.restart_kernel(session_id)
    if success:
        return {"status": "ok"}
    raise HTTPException(status_code=404, detail="Session not found")


@app.get("/api/kernels/{session_id}/status")
async def get_kernel_status(session_id: str):
    """Get kernel session status"""
    status = kernel_service.get_session_status(session_id)
    if status:
        return status
    raise HTTPException(status_code=404, detail="Session not found")


@app.websocket("/api/kernels/{session_id}/ws")
async def kernel_websocket(websocket: WebSocket, session_id: str):
    """
    WebSocket endpoint for code execution with streaming output

    Client sends: {"type": "execute", "code": "..."}
    Server sends:
        - {"type": "output", "output": {...}} for each output
        - {"type": "status", "status": "busy"|"idle"}
        - {"type": "result", "result": {...}} when execution completes
    """
    await websocket.accept()

    try:
        while True:
            data = await websocket.receive_json()

            if data.get("type") == "execute":
                code = data.get("code", "")

                # Send busy status
                await websocket.send_json({"type": "status", "status": "busy"})

                async def send_output(output: dict):
                    await websocket.send_json({"type": "output", "output": output})

                # Execute code
                result = await kernel_service.execute_code(
                    session_id, code, send_output
                )

                # Send result and idle status
                await websocket.send_json({"type": "result", "result": result})
                await websocket.send_json({"type": "status", "status": "idle"})

    except WebSocketDisconnect:
        print(f"WebSocket disconnected for session {session_id}")
    except Exception as e:
        print(f"WebSocket error: {e}")
        try:
            await websocket.send_json({"type": "error", "error": str(e)})
        except:
            pass


# --- Notebook Operation Endpoints ---

@app.websocket("/api/notebook/{notebook_path:path}/ws")
async def notebook_operations_websocket(websocket: WebSocket, notebook_path: str):
    """
    WebSocket endpoint for real-time notebook operations.

    UI clients connect here to:
    1. Receive operations from MCP tools
    2. Send back operation results
    3. Optionally push local changes for sync

    Messages from server to UI:
        - {"type": "operation", "operation": {...}, "requestId": "..."}
        - {"type": "readNotebook", "requestId": "..."}

    Messages from UI to server:
        - {"type": "operationResult", "requestId": "...", "result": {...}}
        - {"type": "notebookData", "requestId": "...", "data": {...}}
    """
    await websocket.accept()

    # Resolve the path
    from pathlib import Path
    from urllib.parse import unquote
    resolved_path = str(Path(unquote(notebook_path)).resolve())

    # Register UI connection
    await operation_router.register_ui(websocket, resolved_path)

    try:
        while True:
            data = await websocket.receive_json()

            msg_type = data.get("type")

            if msg_type == "operationResult":
                # UI is responding to an operation we sent
                operation_router.handle_ui_response(resolved_path, data)

            elif msg_type == "notebookData":
                # UI is responding to a readNotebook request
                operation_router.handle_ui_response(resolved_path, data)

            elif msg_type == "ping":
                # Keep-alive
                await websocket.send_json({"type": "pong"})

    except WebSocketDisconnect:
        print(f"Notebook WebSocket disconnected for: {resolved_path}")
    except Exception as e:
        print(f"Notebook WebSocket error: {e}")
    finally:
        operation_router.unregister_ui(resolved_path)


@app.post("/api/notebook/operation")
async def apply_notebook_operation(request: NotebookOperationRequest):
    """
    Apply a notebook operation (insert, delete, update, move, etc.)

    This is the main entry point for MCP tools. Operations are routed to:
    - Connected UI via WebSocket (if available)
    - Headless manager (file-based) otherwise

    From the agent's perspective, both modes behave identically.
    """
    try:
        result = await operation_router.apply_operation(request.operation)
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/api/notebook/read")
async def read_notebook_via_router(
    path: str,
    include_outputs: bool = True,
    max_lines: int = None,
    max_chars: int = None
):
    """
    Read notebook state via operation router.

    If UI is connected, requests current state from UI.
    Otherwise reads from file.

    Args:
        path: Path to the notebook file
        include_outputs: Whether to include cell outputs (default: True)
        max_lines: Max lines per output for truncation (default: no truncation)
        max_chars: Max chars per output for truncation (default: no truncation)
    """
    try:
        result = await operation_router.read_notebook(
            path,
            include_outputs=include_outputs,
            max_lines=max_lines,
            max_chars=max_chars
        )
        return result
    except Exception as e:
        return {"success": False, "error": str(e)}


@app.get("/api/notebook/has-ui")
async def check_notebook_has_ui(path: str):
    """Check if a UI is connected for the given notebook path"""
    return {"hasUI": operation_router.has_ui(path), "path": path}


# --- Python Discovery Endpoints ---

@app.get("/api/python/environments")
async def list_python_environments(refresh: bool = False):
    """
    List all discovered Python environments
    Returns both Jupyter kernelspecs and discovered Python interpreters
    """
    from dataclasses import asdict

    # Get Jupyter kernelspecs
    kernelspecs = kernel_service.get_available_kernels()
    kernelspec_names = {k['name'] for k in kernelspecs}

    # Get discovered Python environments
    environments = python_discovery.discover(force_refresh=refresh)

    # Match discovered environments with existing kernelspecs
    for env in environments:
        # Check if this Python is associated with a registered kernel
        if env.kernel_name and env.kernel_name in kernelspec_names:
            env.kernel_name = env.kernel_name

    return {
        "kernelspecs": kernelspecs,
        "environments": [asdict(env) for env in environments],
        "cache_info": python_discovery.get_cache_info()
    }


@app.post("/api/python/install-kernel")
async def install_python_kernel(request: InstallKernelRequest):
    """Install ipykernel and register a Python environment as a Jupyter kernel"""
    try:
        result = python_discovery.install_kernel(
            python_path=request.python_path,
            kernel_name=request.kernel_name
        )
        return result
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/python/refresh")
async def refresh_python_environments():
    """Force refresh the Python environment cache"""
    environments = python_discovery.discover(force_refresh=True)
    return {
        "count": len(environments),
        "cache_info": python_discovery.get_cache_info()
    }


# --- LLM Endpoints ---

@app.get("/api/llm/providers")
async def list_providers():
    """List available LLM providers and models"""
    return {"providers": llm_service.get_available_providers()}


@app.post("/api/llm/generate")
async def generate(request: GenerateRequest):
    """Generate text/code from LLM"""
    try:
        config = LLMConfig(
            provider=request.provider,
            model=request.model,
            temperature=request.temperature
        )
        response = await llm_service.generate(
            prompt=request.prompt,
            system_prompt=request.system_prompt,
            config=config,
            images=request.images
        )
        return {"response": response}
    except NebulaError:
        raise  # Let the exception handler handle it
    except Exception as e:
        raise convert_sdk_error(e, request.provider)


@app.post("/api/llm/generate-structured")
async def generate_structured(request: GenerateStructuredRequest):
    """Generate structured JSON response from LLM"""
    try:
        config = LLMConfig(
            provider=request.provider,
            model=request.model,
            temperature=request.temperature
        )
        response = await llm_service.generate_structured(
            prompt=request.prompt,
            system_prompt=request.system_prompt,
            config=config
        )
        return {"response": response}
    except NebulaError:
        raise  # Let the exception handler handle it
    except Exception as e:
        raise convert_sdk_error(e, request.provider)


@app.post("/api/llm/chat")
async def chat(request: ChatRequest):
    """Chat with LLM including history"""
    try:
        config = LLMConfig(
            provider=request.provider,
            model=request.model,
            temperature=request.temperature
        )
        response = await llm_service.chat(
            message=request.message,
            history=request.history,
            system_prompt=request.system_prompt,
            config=config,
            images=request.images
        )
        return {"response": response}
    except NebulaError:
        raise  # Let the exception handler handle it
    except Exception as e:
        raise convert_sdk_error(e, request.provider)


# --- Filesystem Endpoints ---

@app.get("/api/fs/list")
async def list_directory(path: str = Query(default="~")):
    """List directory contents"""
    try:
        return fs_service.list_directory(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/fs/mtime")
async def get_directory_mtime(path: str = Query(default="~")):
    """Get directory modification time (lightweight change detection)"""
    try:
        return fs_service.get_directory_mtime(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/fs/file-mtime")
async def get_file_mtime(path: str):
    """Get file modification time (lightweight change detection)"""
    try:
        return fs_service.get_file_mtime(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/fs/read")
async def read_file(path: str):
    """Read file contents"""
    try:
        return fs_service.read_file(path)
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except IsADirectoryError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/fs/write")
async def write_file(request: WriteFileRequest):
    """Write content to a file"""
    try:
        fs_service.write_file(request.path, request.content, request.file_type)
        return {"status": "ok", "path": request.path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/fs/create")
async def create_file(request: CreateFileRequest):
    """Create a new file or directory"""
    try:
        info = fs_service.create_file(request.path, request.is_directory)
        return {"status": "ok", "file": info}
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/fs/delete")
async def delete_file(path: str):
    """Delete a file or directory"""
    try:
        fs_service.delete_file(path)
        return {"status": "ok"}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/fs/rename")
async def rename_file(request: RenameFileRequest):
    """Rename/move a file or directory"""
    try:
        info = fs_service.rename_file(request.old_path, request.new_path)
        return {"status": "ok", "file": info}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except FileExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/fs/upload")
async def upload_file(
    file: UploadFile = File(...),
    path: str = Form(...)
):
    """Upload a file to the specified directory"""
    try:
        info = await fs_service.upload_file(path, file)
        return {"status": "ok", "file": info}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Notebook-specific Endpoints ---

@app.get("/api/notebook/cells")
async def get_notebook_cells(path: str):
    """Read a notebook file and return cells in internal format"""
    try:
        result = fs_service.get_notebook_cells(path)
        return {"path": path, "cells": result["cells"], "kernelspec": result["kernelspec"], "mtime": result["mtime"]}
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notebook/save")
async def save_notebook(request: SaveNotebookRequest):
    """Save cells and optionally history to a notebook file"""
    try:
        result = fs_service.save_notebook_cells(request.path, request.cells, request.kernel_name)

        # Save history alongside notebook if provided
        if request.history is not None:
            fs_service.save_history(request.path, request.history)

        return {"status": "ok", "path": request.path, "mtime": result["mtime"]}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- History Persistence Endpoints ---

@app.get("/api/notebook/history")
async def get_notebook_history(notebook_path: str):
    """Load operation history for a notebook from .nebula directory"""
    try:
        history = fs_service.load_history(notebook_path)
        return {"notebook_path": notebook_path, "history": history}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notebook/history")
async def save_notebook_history(request: SaveHistoryRequest):
    """Save operation history for a notebook to .nebula directory"""
    try:
        fs_service.save_history(request.notebook_path, request.history)
        return {"status": "ok", "notebook_path": request.notebook_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Session State Persistence Endpoints ---

@app.get("/api/notebook/session")
async def get_notebook_session(notebook_path: str):
    """Load session state for a notebook from .nebula directory"""
    try:
        session = fs_service.load_session(notebook_path)
        return {"notebook_path": notebook_path, "session": session}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notebook/session")
async def save_notebook_session(request: SaveSessionRequest):
    """Save session state for a notebook to .nebula directory"""
    try:
        fs_service.save_session(request.notebook_path, request.session)
        return {"status": "ok", "notebook_path": request.notebook_path}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/notebook/permit-agent")
async def permit_agent_access(request: PermitAgentAccessRequest):
    """
    Grant or revoke agent permission to modify a notebook.

    For user-permitted notebooks (not agent-created), history must be enabled
    as a safety measure before the agent can make modifications.
    """
    try:
        result = fs_service.update_notebook_metadata(
            request.notebook_path,
            {"nebula": {"agent_permitted": request.permitted}}
        )
        if not result.get("success"):
            raise HTTPException(status_code=400, detail=result.get("error", "Failed to update notebook"))

        # Return current permission status
        metadata = fs_service.get_notebook_metadata(request.notebook_path)
        nebula = metadata.get("nebula", {})
        has_history = fs_service.has_history(request.notebook_path)

        return {
            "status": "ok",
            "notebook_path": request.notebook_path,
            "agent_permitted": nebula.get("agent_permitted", False),
            "agent_created": nebula.get("agent_created", False),
            "has_history": has_history,
            "can_agent_modify": nebula.get("agent_created", False) or (nebula.get("agent_permitted", False) and has_history)
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/notebook/agent-status")
async def get_agent_status(path: str):
    """
    Get the agent permission status for a notebook.

    Returns whether the agent can modify this notebook and why.
    """
    try:
        metadata = fs_service.get_notebook_metadata(path)
        nebula = metadata.get("nebula", {})
        has_history = fs_service.has_history(path)

        agent_created = nebula.get("agent_created", False)
        agent_permitted = nebula.get("agent_permitted", False)
        can_modify = agent_created or (agent_permitted and has_history)

        return {
            "notebook_path": path,
            "agent_created": agent_created,
            "agent_permitted": agent_permitted,
            "has_history": has_history,
            "can_agent_modify": can_modify,
            "reason": (
                "Agent created this notebook" if agent_created
                else "User permitted and history enabled" if can_modify
                else "User permitted but history not enabled" if agent_permitted
                else "Not permitted for agent modifications"
            )
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# --- Health Check ---

@app.get("/api/health")
async def health_check():
    """Health check endpoint - responds immediately even during initialization"""
    return {
        "status": "ok",
        "version": "1.0.0",
        "ready": kernel_service.is_ready,  # True once kernel discovery completes
        "llm_providers": list(llm_service.get_available_providers().keys())
    }


@app.get("/api/ready")
async def ready_check():
    """Readiness check - returns 503 if not fully initialized"""
    if not kernel_service.is_ready:
        raise HTTPException(
            status_code=503,
            detail="Service initializing, kernel discovery in progress"
        )
    return {"status": "ready"}


# --- Static File Serving ---
# Serve frontend either from dist/ (production) or proxy to Vite (development)
# This ensures port 3000 is always the single entry point

import httpx

# Global mode flag (set in main)
_dev_mode = False
_vite_url = "http://localhost:5173"


def setup_static_serving(dev_mode: bool = False):
    """Configure static file serving - either proxy to Vite (dev) or serve from dist (prod)"""
    global _dev_mode
    _dev_mode = dev_mode

    server_dir = Path(__file__).parent
    dist_dir = server_dir.parent / "dist"

    if dev_mode:
        # Development mode: proxy to Vite dev server for HMR
        @app.get("/{full_path:path}")
        async def proxy_to_vite(full_path: str):
            """Proxy non-API requests to Vite dev server"""
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404, detail="Not found")

            async with httpx.AsyncClient() as client:
                try:
                    url = f"{_vite_url}/{full_path}"
                    response = await client.get(url, follow_redirects=True)

                    # Get content type from response
                    content_type = response.headers.get("content-type", "text/html")

                    return Response(
                        content=response.content,
                        status_code=response.status_code,
                        media_type=content_type
                    )
                except httpx.ConnectError:
                    raise HTTPException(
                        status_code=503,
                        detail="Vite dev server not running. Start it with: npm run dev"
                    )

        # WebSocket proxy for Vite HMR
        @app.websocket("/{full_path:path}")
        async def proxy_ws_to_vite(websocket: WebSocket, full_path: str):
            """Proxy WebSocket connections to Vite for HMR"""
            # Skip API websockets - they're handled by earlier routes
            if full_path.startswith("api/"):
                await websocket.close()
                return

            await websocket.accept()

            import websockets
            vite_ws_url = f"ws://localhost:5173/{full_path}"

            try:
                async with websockets.connect(vite_ws_url) as vite_ws:
                    async def forward_to_vite():
                        try:
                            while True:
                                data = await websocket.receive_text()
                                await vite_ws.send(data)
                        except WebSocketDisconnect:
                            pass

                    async def forward_from_vite():
                        try:
                            async for message in vite_ws:
                                await websocket.send_text(message)
                        except:
                            pass

                    await asyncio.gather(forward_to_vite(), forward_from_vite())
            except Exception:
                await websocket.close()

        print(f"Development mode: proxying frontend to Vite at {_vite_url}")
        return True

    else:
        # Production mode: serve from dist directory
        if not dist_dir.exists():
            print(f"Warning: dist directory not found at {dist_dir}")
            print("Run 'npm run build' to create the production build")
            return False

        @app.get("/{full_path:path}")
        async def serve_spa(full_path: str):
            """Serve index.html for all non-API routes (SPA routing)"""
            if full_path.startswith("api/"):
                raise HTTPException(status_code=404, detail="Not found")

            file_path = dist_dir / full_path
            if file_path.is_file():
                return FileResponse(file_path)

            index_path = dist_dir / "index.html"
            if index_path.exists():
                return FileResponse(index_path)

            raise HTTPException(status_code=404, detail="Not found")

        print(f"Production mode: serving static files from {dist_dir}")
        return True


if __name__ == "__main__":
    import uvicorn
    import argparse

    parser = argparse.ArgumentParser(description="Nebula Notebook Backend Server")
    parser.add_argument("--dev", action="store_true",
                        help="Development mode (proxy to Vite for HMR)")
    parser.add_argument("--port", type=int, default=3000,
                        help="Port to run on (default: 3000)")
    parser.add_argument("--host", default="0.0.0.0",
                        help="Host to bind to (default: 0.0.0.0)")
    parser.add_argument("--vite-port", type=int, default=5173,
                        help="Vite dev server port (default: 5173)")
    args = parser.parse_args()

    # Update Vite URL if custom port
    if args.vite_port != 5173:
        _vite_url = f"http://localhost:{args.vite_port}"

    # Setup static serving
    setup_static_serving(dev_mode=args.dev)

    mode = "development" if args.dev else "production"
    print(f"Starting Nebula on port {args.port} ({mode} mode)")

    uvicorn.run(app, host=args.host, port=args.port)
