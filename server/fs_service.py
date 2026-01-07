"""
Filesystem Service - Real filesystem operations
"""
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
        """Delete a file or directory"""
        path = self._normalize_path(path)

        if not os.path.exists(path):
            raise FileNotFoundError(f"Path not found: {path}")

        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)

        return True

    def rename_file(self, old_path: str, new_path: str) -> Dict[str, Any]:
        """Rename/move a file or directory"""
        old_path = self._normalize_path(old_path)
        new_path = self._normalize_path(new_path)

        if not os.path.exists(old_path):
            raise FileNotFoundError(f"Path not found: {old_path}")

        if os.path.exists(new_path):
            raise FileExistsError(f"Destination already exists: {new_path}")

        shutil.move(old_path, new_path)

        return self._get_file_info(new_path).__dict__

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

    def save_notebook_cells(self, path: str, cells: List[Dict[str, Any]], kernel_name: str = None) -> Dict[str, Any]:
        """
        Save cells to a notebook file

        Converts from our Cell format to .ipynb format.
        Returns: { "success": bool, "mtime": float }

        Args:
            path: Path to save the notebook
            cells: List of cells in internal format
            kernel_name: Optional kernel name to save in metadata (defaults to python3)
        """
        path = self._normalize_path(path)

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

        notebook = {
            "cells": nb_cells,
            "metadata": {
                "kernelspec": {
                    "display_name": display_name,
                    "language": "python",
                    "name": kernel_name
                },
                "language_info": {
                    "name": "python",
                    "version": "3.11"
                }
            },
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

    # --- Cell-level operations ---

    def _find_cell_index(self, cells: List[Dict], cell_id: str = None, cell_index: int = None) -> int:
        """
        Find cell index by ID or validate provided index.

        Args:
            cells: List of cells in internal format
            cell_id: Cell ID to find (preferred)
            cell_index: Cell index to validate (alternative)

        Returns:
            The cell index

        Raises:
            ValueError: If neither cell_id nor cell_index provided
            FileNotFoundError: If cell not found or index out of range
        """
        if cell_id is not None:
            for i, cell in enumerate(cells):
                if cell.get("id") == cell_id:
                    return i
            raise FileNotFoundError(f"Cell with id '{cell_id}' not found")

        if cell_index is not None:
            if cell_index < 0 or cell_index >= len(cells):
                raise FileNotFoundError(f"Cell index {cell_index} out of range (0-{len(cells) - 1})")
            return cell_index

        raise ValueError("Either cell_id or cell_index must be provided")

    def update_cell(
        self,
        path: str,
        cell_id: str = None,
        cell_index: int = None,
        content: str = None,
        cell_type: str = None,
        metadata: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Update a single cell's content, type, or metadata.

        Args:
            path: Path to the notebook file
            cell_id: Cell ID to update (preferred)
            cell_index: Cell index to update (alternative)
            content: New cell content (optional)
            cell_type: New cell type - "code" or "markdown" (optional)
            metadata: Metadata to merge with existing (optional)

        Returns:
            { cell_id, cell_index, mtime }

        Raises:
            FileNotFoundError: If notebook or cell not found
            ValueError: If invalid cell_type or no identifier provided
        """
        # Validate cell_type if provided
        if cell_type is not None and cell_type not in ("code", "markdown"):
            raise ValueError(f"Invalid cell_type: {cell_type}. Must be 'code' or 'markdown'")

        # Read the notebook
        notebook_data = self.get_notebook_cells(path)
        cells = notebook_data["cells"]

        # Find the cell
        idx = self._find_cell_index(cells, cell_id, cell_index)
        cell = cells[idx]

        # Update fields
        if content is not None:
            cell["content"] = content
        if cell_type is not None:
            cell["type"] = cell_type
        if metadata is not None:
            # Merge metadata with existing _metadata
            existing_metadata = cell.get("_metadata", {})
            existing_metadata.update(metadata)
            cell["_metadata"] = existing_metadata

        # Save the notebook
        result = self.save_notebook_cells(path, cells, notebook_data.get("kernelspec"))

        return {
            "cell_id": cell["id"],
            "cell_index": idx,
            "mtime": result["mtime"]
        }

    def insert_cell(
        self,
        path: str,
        index: int,
        cell_type: str = "code",
        content: str = "",
        cell_id: str = None,
        metadata: Dict[str, Any] = None
    ) -> Dict[str, Any]:
        """
        Insert a new cell at the specified position.

        Args:
            path: Path to the notebook file
            index: Position to insert (-1 = append)
            cell_type: Cell type - "code" or "markdown" (default: "code")
            content: Cell content (default: "")
            cell_id: Optional client-provided cell ID
            metadata: Optional cell metadata

        Returns:
            { cell_id, cell_index, total_cells, mtime }

        Raises:
            FileNotFoundError: If notebook not found
            ValueError: If invalid cell_type or index
        """
        import uuid

        # Validate cell_type
        if cell_type not in ("code", "markdown"):
            raise ValueError(f"Invalid cell_type: {cell_type}. Must be 'code' or 'markdown'")

        # Read the notebook
        notebook_data = self.get_notebook_cells(path)
        cells = notebook_data["cells"]

        # Handle append case (-1)
        if index == -1:
            index = len(cells)
        elif index < 0 or index > len(cells):
            raise ValueError(f"Invalid index {index} for notebook with {len(cells)} cells")

        # Generate cell ID if not provided
        if cell_id is None:
            cell_id = str(uuid.uuid4())

        # Create the new cell
        new_cell = {
            "id": cell_id,
            "type": cell_type,
            "content": content,
            "outputs": [],
            "isExecuting": False,
            "executionCount": None
        }

        if metadata:
            new_cell["_metadata"] = metadata

        # Insert the cell
        cells.insert(index, new_cell)

        # Save the notebook
        result = self.save_notebook_cells(path, cells, notebook_data.get("kernelspec"))

        return {
            "cell_id": cell_id,
            "cell_index": index,
            "total_cells": len(cells),
            "mtime": result["mtime"]
        }

    def delete_cell(
        self,
        path: str,
        cell_id: str = None,
        cell_index: int = None
    ) -> Dict[str, Any]:
        """
        Delete a cell by ID or index.

        Args:
            path: Path to the notebook file
            cell_id: Cell ID to delete (preferred)
            cell_index: Cell index to delete (alternative)

        Returns:
            { deleted_cell_id, total_cells, mtime }

        Raises:
            FileNotFoundError: If notebook or cell not found
            ValueError: If no identifier provided
        """
        # Read the notebook
        notebook_data = self.get_notebook_cells(path)
        cells = notebook_data["cells"]

        # Find the cell
        idx = self._find_cell_index(cells, cell_id, cell_index)

        # Remove the cell
        deleted_cell = cells.pop(idx)

        # Save the notebook
        result = self.save_notebook_cells(path, cells, notebook_data.get("kernelspec"))

        return {
            "deleted_cell_id": deleted_cell["id"],
            "total_cells": len(cells),
            "mtime": result["mtime"]
        }

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
