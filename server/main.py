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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

from kernel_service import kernel_service
from llm_service import llm_service, LLMConfig
from fs_service import fs_service
from python_discovery import python_discovery
from session_store import session_store


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


class InstallKernelRequest(BaseModel):
    python_path: str
    kernel_name: Optional[str] = None


class GenerateStructuredRequest(BaseModel):
    prompt: str
    system_prompt: str
    provider: str = "google"
    model: str = "gemini-2.5-flash"
    temperature: float = 0.2


# --- Lifespan ---

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup - respond to requests immediately, initialize in background
    print("Starting Nebula Notebook Backend...")

    # Mark any previously active sessions as orphaned (from crashed server)
    orphaned_count = session_store.mark_all_orphaned()
    if orphaned_count > 0:
        print(f"Marked {orphaned_count} sessions as orphaned from previous run")

    # Clean up old orphaned/terminated sessions (older than 24 hours)
    cleaned_count = session_store.cleanup_old_sessions(max_age_hours=24.0)
    if cleaned_count > 0:
        print(f"Cleaned up {cleaned_count} old sessions")

    # Start background initialization (don't await - let it run in background)
    asyncio.create_task(kernel_service.initialize_async())

    yield
    # Shutdown with timeout
    print("Shutting down... Cleaning up kernels...")
    try:
        await asyncio.wait_for(kernel_service.cleanup(), timeout=5.0)
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

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, specify exact origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# --- Kernel Endpoints ---

@app.get("/api/kernels")
async def list_kernels():
    """List available kernelspecs"""
    return {"kernels": kernel_service.get_available_kernels()}


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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
