"""
Filesystem Service - Real filesystem operations
"""
from __future__ import annotations
import os
import json
import shutil
from pathlib import Path
from typing import List, Optional, Dict, Any
from dataclasses import dataclass
from datetime import datetime


@dataclass
class FileInfo:
    """Information about a file or directory"""
    name: str
    path: str
    is_directory: bool
    size: int
    modified: float
    extension: str


def load_nebula_config() -> Optional[str]:
    """Load root directory from .nebula-config.json if it exists"""
    config_path = Path(__file__).parent.parent / '.nebula-config.json'
    try:
        if config_path.exists():
            with open(config_path) as f:
                config = json.load(f)
                return config.get('rootDirectory')
    except Exception:
        pass
    return None


class FilesystemService:
    """Service for real filesystem operations"""

    def __init__(self, default_root: Optional[str] = None):
        # Priority: explicit arg > config file > home directory
        self.default_root = default_root or load_nebula_config() or str(Path.home())

    def _normalize_path(self, path: str) -> str:
        """Normalize and expand path"""
        # Use configured root directory for ~ instead of actual home
        if path == "~" or path == "":
            return self.default_root
        if path.startswith("~/"):
            path = os.path.join(self.default_root, path[2:])
        elif path.startswith("~"):
            path = os.path.expanduser(path)
        return os.path.abspath(path)

    def _get_file_info(self, path: str) -> FileInfo:
        """Get file info for a path"""
        stat = os.stat(path)
        name = os.path.basename(path)
        is_dir = os.path.isdir(path)

        return FileInfo(
            name=name,
            path=path,
            is_directory=is_dir,
            size=stat.st_size if not is_dir else 0,
            modified=stat.st_mtime,
            extension=os.path.splitext(name)[1] if not is_dir else ""
        )

    def _format_size(self, size: int) -> str:
        """Format file size for display"""
        if size < 1024:
            return f"{size}B"
        elif size < 1024 * 1024:
            return f"{size / 1024:.1f}KB"
        elif size < 1024 * 1024 * 1024:
            return f"{size / (1024 * 1024):.1f}MB"
        else:
            return f"{size / (1024 * 1024 * 1024):.1f}GB"

    def get_directory_mtime(self, path: str) -> Dict[str, Any]:
        """
        Get directory modification time (lightweight check for changes)

        Returns:
            {
                "path": str,
                "mtime": float
            }
        """
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"Path not found: {path}")

        if not os.path.isdir(path):
            raise NotADirectoryError(f"Not a directory: {path}")

        stat = os.stat(path)
        return {
            "path": path,
            "mtime": stat.st_mtime
        }

    def get_file_mtime(self, path: str) -> Dict[str, Any]:
        """
        Get file modification time (lightweight check for changes)

        Returns:
            {
                "path": str,
                "mtime": float
            }
        """
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"File not found: {path}")

        stat = os.stat(path)
        return {
            "path": path,
            "mtime": stat.st_mtime
        }

    def list_directory(self, path: str) -> Dict[str, Any]:
        """
        List contents of a directory

        Returns:
            {
                "path": str,
                "parent": str | None,
                "mtime": float,
                "items": [FileInfo...]
            }
        """
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"Path not found: {path}")

        if not os.path.isdir(path):
            raise NotADirectoryError(f"Not a directory: {path}")

        items = []
        try:
            for name in os.listdir(path):
                # Skip hidden files
                if name.startswith('.'):
                    continue

                full_path = os.path.join(path, name)
                try:
                    info = self._get_file_info(full_path)
                    items.append({
                        "id": full_path,
                        "name": info.name,
                        "path": info.path,
                        "isDirectory": info.is_directory,
                        "size": self._format_size(info.size),
                        "sizeBytes": info.size,
                        "modified": info.modified,
                        "extension": info.extension,
                        "fileType": "folder" if info.is_directory else self._get_file_type(info.extension)
                    })
                except (PermissionError, OSError):
                    # Skip files we can't access
                    continue

        except PermissionError:
            raise PermissionError(f"Permission denied: {path}")

        # Sort: directories first, then by name
        items.sort(key=lambda x: (not x["isDirectory"], x["name"].lower()))

        # Get parent directory
        parent = os.path.dirname(path) if path != "/" else None

        # Get directory mtime for change detection
        dir_stat = os.stat(path)

        return {
            "path": path,
            "parent": parent,
            "mtime": dir_stat.st_mtime,
            "items": items
        }

    def _get_file_type(self, extension: str) -> str:
        """Determine file type from extension"""
        extension = extension.lower()
        if extension == ".ipynb":
            return "notebook"
        elif extension in [".py", ".js", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".toml", ".md", ".txt"]:
            return "code"
        elif extension in [".csv", ".tsv", ".xlsx", ".xls"]:
            return "data"
        elif extension in [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp"]:
            return "image"
        elif extension in [".pdf"]:
            return "document"
        else:
            return "file"

    def read_file(self, path: str) -> Dict[str, Any]:
        """Read a file's contents"""
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"File not found: {path}")

        if os.path.isdir(path):
            raise IsADirectoryError(f"Path is a directory: {path}")

        extension = os.path.splitext(path)[1].lower()

        # Handle different file types
        if extension == ".ipynb":
            # Read notebook file
            with open(path, 'r', encoding='utf-8') as f:
                notebook = json.load(f)
            return {
                "path": path,
                "type": "notebook",
                "content": notebook
            }
        else:
            # Read as text
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    content = f.read()
                return {
                    "path": path,
                    "type": "text",
                    "content": content
                }
            except UnicodeDecodeError:
                # Binary file
                return {
                    "path": path,
                    "type": "binary",
                    "content": None,
                    "message": "Binary file cannot be displayed"
                }

    def write_file(self, path: str, content: Any, file_type: str = "text") -> bool:
        """Write content to a file"""
        path = self._normalize_path(path)

        # Create parent directories if needed
        parent_dir = os.path.dirname(path)
        if parent_dir and not os.path.exists(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)

        if file_type == "notebook":
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(content, f, indent=2)
        else:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(content)

        return True

    def create_file(self, path: str, is_directory: bool = False) -> Dict[str, Any]:
        """Create a new file or directory"""
        path = self._normalize_path(path)

        if os.path.exists(path):
            raise FileExistsError(f"Path already exists: {path}")

        if is_directory:
            os.makedirs(path)
        else:
            # Create parent directories if needed
            parent_dir = os.path.dirname(path)
            if parent_dir and not os.path.exists(parent_dir):
                os.makedirs(parent_dir, exist_ok=True)

            # Create empty file
            extension = os.path.splitext(path)[1].lower()
            if extension == ".ipynb":
                # Create empty notebook
                notebook = {
                    "cells": [],
                    "metadata": {
                        "kernelspec": {
                            "display_name": "Python 3",
                            "language": "python",
                            "name": "python3"
                        }
                    },
                    "nbformat": 4,
                    "nbformat_minor": 5
                }
                with open(path, 'w', encoding='utf-8') as f:
                    json.dump(notebook, f, indent=2)
            else:
                Path(path).touch()

        return self._get_file_info(path).__dict__

    def delete_file(self, path: str) -> bool:
        """Delete a file or directory. For notebooks, also deletes history and session files."""
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"Path not found: {path}")

        # For notebooks, also delete history and session files
        ext = os.path.splitext(path)[1].lower()
        if ext == '.ipynb' and not os.path.isdir(path):
            self._delete_notebook_metadata(path)

        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)

        return True

    def _delete_notebook_metadata(self, path: str) -> None:
        """Delete notebook-related metadata files (history, session)."""
        history_path = self._get_history_path(path)
        session_path = self._get_session_path(path)

        if os.path.exists(history_path):
            os.remove(history_path)

        if os.path.exists(session_path):
            os.remove(session_path)

    def rename_file(self, old_path: str, new_path: str) -> Dict[str, Any]:
        """Rename/move a file or directory. For notebooks, also renames history and session files."""
        old_path = self._normalize_path(old_path)
        new_path = self._normalize_path(new_path)

        if not os.path.exists(old_path):
            raise FileNotFoundError(f"Path not found: {old_path}")

        if os.path.exists(new_path):
            raise FileExistsError(f"Destination already exists: {new_path}")

        # For notebooks, also rename history and session files
        ext = os.path.splitext(old_path)[1].lower()
        if ext == '.ipynb':
            self._rename_notebook_metadata(old_path, new_path)

        shutil.move(old_path, new_path)

        return self._get_file_info(new_path).__dict__

    def _rename_notebook_metadata(self, old_path: str, new_path: str) -> None:
        """Rename notebook-related metadata files (history, session)."""
        # Get old history/session paths
        old_history = self._get_history_path(old_path)
        old_session = self._get_session_path(old_path)

        # Get new history/session paths
        new_history = self._get_history_path(new_path)
        new_session = self._get_session_path(new_path)

        # Create destination .nebula directory if needed
        new_nebula_dir = os.path.dirname(new_history)
        if not os.path.exists(new_nebula_dir):
            os.makedirs(new_nebula_dir, exist_ok=True)

        # Rename history file if it exists
        if os.path.exists(old_history):
            shutil.move(old_history, new_history)

        # Rename session file if it exists
        if os.path.exists(old_session):
            shutil.move(old_session, new_session)

    def duplicate_file(self, path: str) -> Dict[str, Any]:
        """Duplicate a file with _copy suffix. For notebooks, also duplicates history."""
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"File not found: {path}")

        if os.path.isdir(path):
            raise IsADirectoryError(f"Cannot duplicate directories: {path}")

        # Generate new filename with _copy suffix
        parent_dir = os.path.dirname(path)
        filename = os.path.basename(path)
        name, ext = os.path.splitext(filename)

        # Find a unique name
        new_name = f"{name}_copy{ext}"
        new_path = os.path.join(parent_dir, new_name)
        counter = 2
        while os.path.exists(new_path):
            new_name = f"{name}_copy_{counter}{ext}"
            new_path = os.path.join(parent_dir, new_name)
            counter += 1

        # Copy the file
        shutil.copy2(path, new_path)

        # For notebooks, also duplicate history and session files
        if ext.lower() == '.ipynb':
            self._duplicate_notebook_metadata(path, new_path)

        # Return file info in the format expected by the frontend
        info = self._get_file_info(new_path)
        return {
            "id": new_path,
            "name": info.name,
            "path": info.path,
            "isDirectory": info.is_directory,
            "size": self._format_size(info.size),
            "sizeBytes": info.size,
            "modified": info.modified,
            "extension": info.extension,
            "fileType": self._get_file_type(info.extension)
        }

    def _duplicate_notebook_metadata(self, src_path: str, dest_path: str) -> None:
        """Duplicate notebook-related metadata files (history, session)."""
        # Get history file paths
        src_history = self._get_history_path(src_path)
        dest_history = self._get_history_path(dest_path)

        # Get session file paths
        src_session = self._get_session_path(src_path)
        dest_session = self._get_session_path(dest_path)

        # Create .nebula directory for destination if needed
        dest_nebula_dir = os.path.dirname(dest_history)
        if not os.path.exists(dest_nebula_dir):
            os.makedirs(dest_nebula_dir, exist_ok=True)

        # Copy history file if it exists
        if os.path.exists(src_history):
            shutil.copy2(src_history, dest_history)

        # Copy session file if it exists
        if os.path.exists(src_session):
            shutil.copy2(src_session, dest_session)

    async def upload_file(self, directory: str, file) -> Dict[str, Any]:
        """
        Upload a file to the specified directory.

        Args:
            directory: Target directory path
            file: FastAPI UploadFile object

        Returns:
            File info dict for the uploaded file
        """
        dir_path = self._normalize_path(directory)

        if not os.path.exists(dir_path):
            raise FileNotFoundError(f"Directory not found: {dir_path}")

        if not os.path.isdir(dir_path):
            raise NotADirectoryError(f"Not a directory: {dir_path}")

        # Build full file path
        file_path = os.path.join(dir_path, file.filename)

        # Read file content
        content = await file.read()

        # Write to disk
        with open(file_path, 'wb') as f:
            f.write(content)

        # Return file info
        info = self._get_file_info(file_path)
        return {
            "id": file_path,
            "name": info.name,
            "path": info.path,
            "isDirectory": info.is_directory,
            "size": self._format_size(info.size),
            "sizeBytes": info.size,
            "modified": info.modified,
            "extension": info.extension,
            "fileType": self._get_file_type(info.extension)
        }

    def get_notebook_cells(self, path: str) -> Dict[str, Any]:
        """
        Read a notebook and convert to internal cell format

        Converts from .ipynb format to our Cell format.
        Returns: { "cells": [...], "kernelspec": str, "mtime": float }
        """
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"Notebook not found: {path}")

        with open(path, 'r', encoding='utf-8') as f:
            notebook = json.load(f)

        # Extract kernelspec from metadata
        metadata = notebook.get("metadata", {})
        kernelspec = metadata.get("kernelspec", {})
        kernel_name = kernelspec.get("name", "python3")

        cells = []
        for i, nb_cell in enumerate(notebook.get("cells", [])):
            cell_type = nb_cell.get("cell_type", "code")
            if cell_type == "raw":
                cell_type = "code"

            # Convert source to string
            source = nb_cell.get("source", [])
            if isinstance(source, list):
                content = "".join(source)
            else:
                content = source

            # Preserve cell ID from metadata if available, otherwise generate new one
            cell_metadata = nb_cell.get("metadata", {})
            cell_id = cell_metadata.get("nebula_id") or nb_cell.get("id") or f"cell-{i}"

            # Convert outputs
            outputs = []
            for output in nb_cell.get("outputs", []):
                output_type = output.get("output_type", "")

                if output_type == "stream":
                    stream_name = output.get("name", "stdout")
                    text = output.get("text", [])
                    if isinstance(text, list):
                        text = "".join(text)
                    outputs.append({
                        "id": f"output-{i}-{len(outputs)}",
                        "type": "stderr" if stream_name == "stderr" else "stdout",
                        "content": text,
                        "timestamp": datetime.now().timestamp() * 1000
                    })

                elif output_type in ["execute_result", "display_data"]:
                    data = output.get("data", {})

                    if "image/png" in data:
                        outputs.append({
                            "id": f"output-{i}-{len(outputs)}",
                            "type": "image",
                            "content": data["image/png"],
                            "timestamp": datetime.now().timestamp() * 1000
                        })
                    elif "text/html" in data:
                        html = data["text/html"]
                        if isinstance(html, list):
                            html = "".join(html)
                        outputs.append({
                            "id": f"output-{i}-{len(outputs)}",
                            "type": "html",
                            "content": html,
                            "timestamp": datetime.now().timestamp() * 1000
                        })
                    elif "text/plain" in data:
                        text = data["text/plain"]
                        if isinstance(text, list):
                            text = "".join(text)
                        outputs.append({
                            "id": f"output-{i}-{len(outputs)}",
                            "type": "stdout",
                            "content": text,
                            "timestamp": datetime.now().timestamp() * 1000
                        })

                elif output_type == "error":
                    traceback = output.get("traceback", [])
                    # Jupyter traceback lines often end with \n, so just concatenate them
                    # (don't add extra \n between lines)
                    outputs.append({
                        "id": f"output-{i}-{len(outputs)}",
                        "type": "error",
                        "content": "".join(traceback),
                        "timestamp": datetime.now().timestamp() * 1000
                    })

            # Read scrolled property from cell metadata (Jupyter standard)
            scrolled = cell_metadata.get("scrolled")
            scrolled_height = cell_metadata.get("scrolled_height")

            cell_data = {
                "id": cell_id,
                "type": "markdown" if cell_type == "markdown" else "code",
                "content": content,
                "outputs": outputs,
                "isExecuting": False,
                "executionCount": nb_cell.get("execution_count")
            }

            # Only include scrolled if explicitly set (preserve undefined for default behavior)
            if scrolled is not None:
                cell_data["scrolled"] = scrolled

            # Only include scrolledHeight if explicitly set
            if scrolled_height is not None:
                cell_data["scrolledHeight"] = scrolled_height

            # Preserve unknown metadata from external tools
            # Exclude keys we handle specially (nebula_id, scrolled, scrolled_height)
            unknown_metadata = {k: v for k, v in cell_metadata.items()
                              if k not in ("nebula_id", "scrolled", "scrolled_height")}
            if unknown_metadata:
                cell_data["_metadata"] = unknown_metadata

            cells.append(cell_data)

        # Get file mtime
        stat = os.stat(path)
        return {
            "cells": cells,
            "kernelspec": kernel_name,
            "mtime": stat.st_mtime
        }

    def save_notebook_cells(self, path: str, cells: List[Dict[str, Any]], kernel_name: str = None, notebook_metadata: Dict[str, Any] = None) -> Dict[str, Any]:
        """
        Save cells to a notebook file

        Converts from our Cell format to .ipynb format.
        Returns: { "success": bool, "mtime": float }

        Args:
            path: Path to save the notebook
            cells: List of cells in internal format
            kernel_name: Optional kernel name to save in metadata (defaults to python3)
            notebook_metadata: Optional metadata to merge into notebook metadata (e.g., nebula namespace)
        """
        path = self._normalize_path(path)

        # Load existing notebook metadata if file exists
        existing_metadata = {}
        if os.path.exists(path):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    existing_nb = json.load(f)
                    existing_metadata = existing_nb.get("metadata", {})
            except (json.JSONDecodeError, IOError):
                pass  # File doesn't exist or isn't valid JSON, start fresh

        # Use provided kernel_name or default to python3
        if kernel_name is None:
            kernel_name = "python3"

        # Generate display name from kernel name
        display_name = kernel_name.replace("-", " ").replace("_", " ").title()
        if kernel_name == "python3":
            display_name = "Python 3"

        nb_cells = []
        for cell in cells:
            cell_type = cell.get("type", "code")

            # Convert outputs
            outputs = []
            for output in cell.get("outputs", []):
                output_type = output.get("type", "")

                if output_type in ["stdout", "stderr"]:
                    # Preserve newlines in stream output
                    text_content = output.get("content", "")
                    if text_content:
                        text_lines = text_content.split("\n")
                        text = [line + "\n" for line in text_lines[:-1]] + [text_lines[-1]] if text_lines else []
                    else:
                        text = []
                    outputs.append({
                        "output_type": "stream",
                        "name": output_type,
                        "text": text
                    })
                elif output_type == "image":
                    outputs.append({
                        "output_type": "display_data",
                        "data": {
                            "image/png": output.get("content", "")
                        },
                        "metadata": {}
                    })
                elif output_type == "html":
                    outputs.append({
                        "output_type": "display_data",
                        "data": {
                            "text/html": output.get("content", "")
                        },
                        "metadata": {}
                    })
                elif output_type == "error":
                    # Preserve newlines in traceback
                    tb_content = output.get("content", "")
                    if tb_content:
                        tb_lines = tb_content.split("\n")
                        traceback = [line + "\n" for line in tb_lines[:-1]] + [tb_lines[-1]] if tb_lines else []
                    else:
                        traceback = []
                    outputs.append({
                        "output_type": "error",
                        "ename": "Error",
                        "evalue": "",
                        "traceback": traceback
                    })

            # Jupyter format: source is list of strings, each ending with \n except last
            content = cell.get("content", "")
            if content:
                lines = content.split("\n")
                # Add \n back to all lines except the last
                source = [line + "\n" for line in lines[:-1]] + [lines[-1]] if lines else []
            else:
                source = []

            # Build cell metadata - start with preserved unknown metadata
            preserved_metadata = cell.get("_metadata", {})
            cell_metadata = {
                **preserved_metadata,  # Merge preserved metadata first
                "nebula_id": cell.get("id")  # Preserve cell ID for undo/redo history
            }

            # Include scrolled if explicitly set (Jupyter standard)
            scrolled = cell.get("scrolled")
            if scrolled is not None:
                cell_metadata["scrolled"] = scrolled

            # Include scrolledHeight if explicitly set (Nebula extension)
            scrolled_height = cell.get("scrolledHeight")
            if scrolled_height is not None:
                cell_metadata["scrolled_height"] = scrolled_height

            nb_cell = {
                "cell_type": cell_type,
                "source": source,
                "metadata": cell_metadata
            }

            if cell_type == "code":
                nb_cell["outputs"] = outputs
                nb_cell["execution_count"] = cell.get("executionCount")

            nb_cells.append(nb_cell)

        # Build notebook metadata: preserve existing, update kernelspec, merge custom metadata
        final_metadata = {
            **existing_metadata,  # Preserve existing metadata (including nebula namespace)
            "kernelspec": {
                "display_name": display_name,
                "language": "python",
                "name": kernel_name
            },
            "language_info": {
                "name": "python",
                "version": "3.11"
            }
        }

        # Merge custom notebook metadata (e.g., nebula namespace)
        if notebook_metadata:
            for key, value in notebook_metadata.items():
                if isinstance(value, dict) and isinstance(final_metadata.get(key), dict):
                    # Deep merge for dict values (like nebula namespace)
                    final_metadata[key] = {**final_metadata[key], **value}
                else:
                    final_metadata[key] = value

        notebook = {
            "cells": nb_cells,
            "metadata": final_metadata,
            "nbformat": 4,
            "nbformat_minor": 5
        }

        with open(path, 'w', encoding='utf-8') as f:
            json.dump(notebook, f, indent=2)

        # Get new mtime after save
        stat = os.stat(path)
        return {
            "success": True,
            "mtime": stat.st_mtime
        }

    def get_notebook_metadata(self, path: str) -> Dict[str, Any]:
        """
        Get notebook-level metadata (not cell metadata).
        Returns empty dict if file doesn't exist or isn't valid.
        """
        path = self._normalize_path(path)
        if not os.path.exists(path):
            return {}
        try:
            with open(path, 'r', encoding='utf-8') as f:
                notebook = json.load(f)
                return notebook.get("metadata", {})
        except (json.JSONDecodeError, IOError):
            return {}

    def update_notebook_metadata(self, path: str, metadata_updates: Dict[str, Any]) -> Dict[str, Any]:
        """
        Update notebook-level metadata without modifying cells.
        Deep-merges dict values (like nebula namespace).
        Returns: { "success": bool, "error"?: str }
        """
        path = self._normalize_path(path)
        if not os.path.exists(path):
            return {"success": False, "error": f"Notebook not found: {path}"}

        try:
            with open(path, 'r', encoding='utf-8') as f:
                notebook = json.load(f)
        except (json.JSONDecodeError, IOError) as e:
            return {"success": False, "error": f"Failed to read notebook: {e}"}

        # Deep merge metadata updates
        existing_metadata = notebook.get("metadata", {})
        for key, value in metadata_updates.items():
            if isinstance(value, dict) and isinstance(existing_metadata.get(key), dict):
                existing_metadata[key] = {**existing_metadata[key], **value}
            else:
                existing_metadata[key] = value

        notebook["metadata"] = existing_metadata

        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(notebook, f, indent=2)
            return {"success": True}
        except IOError as e:
            return {"success": False, "error": f"Failed to write notebook: {e}"}

    def is_agent_permitted(self, path: str) -> bool:
        """
        Check if a notebook is permitted for agent modifications.
        A notebook is permitted if:
        - It was created by an agent (nebula.agent_created = true), OR
        - User explicitly permitted it (nebula.agent_permitted = true)
        """
        metadata = self.get_notebook_metadata(path)
        nebula = metadata.get("nebula", {})
        return nebula.get("agent_created", False) or nebula.get("agent_permitted", False)

    def has_history(self, path: str) -> bool:
        """
        Check if a notebook has history tracking enabled.
        History exists if the .nebula/notebook.history.json file exists and is non-empty.
        """
        history_path = self._get_history_path(path)
        if not os.path.exists(history_path):
            return False
        try:
            with open(history_path, 'r', encoding='utf-8') as f:
                history = json.load(f)
                return len(history) > 0
        except (json.JSONDecodeError, IOError):
            return False

    def _get_history_path(self, notebook_path: str) -> str:
        """
        Get the history file path for a notebook.
        History is stored in .nebula subdirectory alongside the notebook.
        e.g., /path/to/notebook.ipynb -> /path/to/.nebula/notebook.history.json
        """
        notebook_path = self._normalize_path(notebook_path)
        parent_dir = os.path.dirname(notebook_path)
        notebook_name = os.path.basename(notebook_path)
        name_without_ext = os.path.splitext(notebook_name)[0]

        nebula_dir = os.path.join(parent_dir, '.nebula')
        return os.path.join(nebula_dir, f"{name_without_ext}.history.json")

    def save_history(self, notebook_path: str, history: List[Dict[str, Any]]) -> bool:
        """
        Save operation history for a notebook.
        Creates .nebula directory if it doesn't exist.
        """
        history_path = self._get_history_path(notebook_path)

        # Create .nebula directory if needed
        nebula_dir = os.path.dirname(history_path)
        if not os.path.exists(nebula_dir):
            os.makedirs(nebula_dir, exist_ok=True)

        with open(history_path, 'w', encoding='utf-8') as f:
            json.dump(history, f, indent=2)

        return True

    def load_history(self, notebook_path: str) -> List[Dict[str, Any]]:
        """
        Load operation history for a notebook.
        Returns empty list if no history file exists.
        """
        history_path = self._get_history_path(notebook_path)

        if not os.path.exists(history_path):
            return []

        try:
            with open(history_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            # If history file is corrupted, return empty list
            return []

    def _get_session_path(self, notebook_path: str) -> str:
        """
        Get the session state file path for a notebook.
        Session state is stored in .nebula subdirectory alongside the notebook.
        e.g., /path/to/notebook.ipynb -> /path/to/.nebula/notebook.session.json
        """
        notebook_path = self._normalize_path(notebook_path)
        parent_dir = os.path.dirname(notebook_path)
        notebook_name = os.path.basename(notebook_path)
        name_without_ext = os.path.splitext(notebook_name)[0]

        nebula_dir = os.path.join(parent_dir, '.nebula')
        return os.path.join(nebula_dir, f"{name_without_ext}.session.json")

    def save_session(self, notebook_path: str, session: Dict[str, Any]) -> bool:
        """
        Save session state for a notebook.
        Creates .nebula directory if it doesn't exist.
        """
        session_path = self._get_session_path(notebook_path)

        # Create .nebula directory if needed
        nebula_dir = os.path.dirname(session_path)
        if not os.path.exists(nebula_dir):
            os.makedirs(nebula_dir, exist_ok=True)

        with open(session_path, 'w', encoding='utf-8') as f:
            json.dump(session, f, indent=2)

        return True

    def load_session(self, notebook_path: str) -> Dict[str, Any]:
        """
        Load session state for a notebook.
        Returns empty dict if no session file exists.
        """
        session_path = self._get_session_path(notebook_path)

        if not os.path.exists(session_path):
            return {}

        try:
            with open(session_path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            # If session file is corrupted, return empty dict
            return {}


# Global instance
fs_service = FilesystemService()
