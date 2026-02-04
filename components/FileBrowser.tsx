import React, { useState, useEffect, useMemo, useRef } from 'react';
import { NotebookMetadata } from '../types';
import {
  Plus,
  X,
  FolderOpen,
  FolderPlus,
  Filter,
  Search,
  ChevronRight,
  Home,
  Folder,
  ArrowUp,
  RefreshCw,
  ArrowDownAZ,
  Clock,
  Upload
} from 'lucide-react';
import { FileListItem } from './FileListItem';
import {
  listDirectory,
  getDirectoryMtime,
  createNotebook,
  createFolder,
  deleteFile,
  duplicateFile,
  downloadFile,
  uploadFile,
  renameFile,
  getRootDirectory,
  setRootDirectory,
  FileItem,
  DirectoryListing
} from '../services/fileService';
import { saveSettings } from '../services/llmService';
import { useNotification } from './NotificationSystem';
import { DIRECTORY_POLL_INTERVAL_MS } from '../config';

interface Props {
  files: NotebookMetadata[];
  currentFileId: string | null;
  onSelect: (id: string) => void;
  onOpenTextFile?: (path: string) => void;
  onOpenImageFile?: (path: string) => void;
  onRefresh: () => void;
  isOpen?: boolean;
  onClose?: () => void;
  /** 'sidebar' for sliding panel (Notebook), 'inline' for embedded (Dashboard) */
  variant?: 'sidebar' | 'inline';
  /** Initial directory path (defaults to server root) */
  initialPath?: string;
  /** Max height for inline variant (e.g., '60vh') */
  maxHeight?: string;
  /** Class name for the container */
  className?: string;
}

export const FileBrowser: React.FC<Props> = ({
  files,
  currentFileId,
  onSelect,
  onOpenTextFile,
  onOpenImageFile,
  onRefresh,
  isOpen = true,
  onClose,
  variant = 'sidebar',
  initialPath,
  maxHeight = '60vh',
  className = '',
}) => {
  const { toast, confirm } = useNotification();
  const defaultSidebarWidth = 320;
  const computeParentPath = (path: string): string | null => {
    const trimmed = path.trim();
    if (!trimmed || trimmed === '~' || trimmed === '/') {
      return null;
    }

    const withoutTrailing = trimmed.endsWith('/') && trimmed.length > 1
      ? trimmed.replace(/\/+$/, '')
      : trimmed;

    if (withoutTrailing === '~') {
      return null;
    }

    if (withoutTrailing.startsWith('~/')) {
      const lastSlash = withoutTrailing.lastIndexOf('/');
      if (lastSlash <= 1) {
        return '~';
      }
      return withoutTrailing.slice(0, lastSlash);
    }

    const lastSlash = withoutTrailing.lastIndexOf('/');
    if (lastSlash <= 0) {
      return '/';
    }
    return withoutTrailing.slice(0, lastSlash);
  };
  const [currentPath, setCurrentPath] = useState<string>(() => initialPath || '~');
  const [rootPath, setRootPath] = useState<string>('~');
  const [pathInput, setPathInput] = useState<string>(initialPath || '~');
  const [showPathInput, setShowPathInput] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = localStorage.getItem('nebula-filebrowser-width');
      const parsed = saved ? Number(saved) : NaN;
      return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultSidebarWidth;
    } catch {
      return defaultSidebarWidth;
    }
  });
  const isResizingRef = useRef(false);
  const [loadedPath, setLoadedPath] = useState<string | null>(null); // Track which path items belong to
  const [loadedMtime, setLoadedMtime] = useState<number | null>(null); // Track directory mtime
  const [items, setItems] = useState<FileItem[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showNotebooksOnly, setShowNotebooksOnly] = useState(() => {
    try {
      return localStorage.getItem('nebula-filter-notebooks-only') === 'true';
    } catch {
      return false;
    }
  });
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'modified'>('modified');
  const maxTextEditorBytes = 2 * 1024 * 1024;
  const isEditableTextFile = (filePath: string): boolean => {
    const lower = filePath.toLowerCase();
    return [
      '.py', '.json', '.txt', '.md', '.yaml', '.yml', '.js', '.ts', '.tsx', '.css', '.csv', '.log', '.toml', '.ini'
    ].some(ext => lower.endsWith(ext));
  };

  // Persist notebook filter preference
  const toggleNotebooksOnly = () => {
    const newValue = !showNotebooksOnly;
    setShowNotebooksOnly(newValue);
    try {
      localStorage.setItem('nebula-filter-notebooks-only', String(newValue));
    } catch {
      // Ignore storage errors
    }
  };

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  // Inline rename state
  const [editingItem, setEditingItem] = useState<FileItem | null>(null);
  const [editValue, setEditValue] = useState('');

  // Update path when initialPath changes
  useEffect(() => {
    if (initialPath && initialPath !== currentPath) {
      setCurrentPath(initialPath);
    }
  }, [initialPath]);

  // Keep path input in sync with current path
  useEffect(() => {
    setPathInput(currentPath);
  }, [currentPath]);

  // Load server root on mount
  useEffect(() => {
    let isMounted = true;
    getRootDirectory()
      .then((root) => {
        if (!isMounted) return;
        setRootPath(root);
        saveSettings({ rootDirectory: root });
        if (!initialPath) {
          setCurrentPath(root);
        }
      })
      .catch(() => {
        // Ignore root fetch errors; fall back to ~
      });
    return () => {
      isMounted = false;
    };
  }, []);

  // Clamp sidebar width on window resize
  useEffect(() => {
    const handleResize = () => {
      const minWidth = 240;
      const maxWidth = Math.max(minWidth, Math.min(560, window.innerWidth - 80));
      setSidebarWidth(prev => Math.min(Math.max(prev, minWidth), maxWidth));
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    if (variant !== 'sidebar') return;
    document.documentElement.style.setProperty('--nebula-filebrowser-width', `${sidebarWidth}px`);
  }, [sidebarWidth, variant]);

  // Load directory on first open or when path changes
  useEffect(() => {
    if (!isOpen) return;
    if (loadedPath === currentPath) return; // Already loaded this path

    loadDirectory(currentPath);
  }, [isOpen, currentPath, loadedPath]);

  // Poll mtime every 5 seconds - only refresh if directory changed
  useEffect(() => {
    if (!isOpen) return;

    const checkForChanges = async () => {
      try {
        const { mtime } = await getDirectoryMtime(currentPath);
        if (loadedMtime !== null && mtime !== loadedMtime) {
          // Directory changed - do silent refresh
          const listing = await listDirectory(currentPath);
          setItems(listing.items);
          setParentPath(listing.parent);
          setLoadedMtime(listing.mtime);
        }
      } catch {
        // Ignore errors on background check
      }
    };

    const interval = setInterval(checkForChanges, DIRECTORY_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isOpen, currentPath, loadedMtime]);

  const loadDirectory = async (path: string) => {
    setIsLoading(true);
    setError(null);

    try {
      const listing = await listDirectory(path);
      setItems(listing.items);
      setParentPath(listing.parent);
      setCurrentPath(listing.path);
      setLoadedPath(listing.path); // Mark this path as loaded
      setLoadedMtime(listing.mtime); // Store mtime for change detection
    } catch (err: any) {
      setError(err.message || 'Failed to load directory');
      if (path === currentPath) {
        setItems([]);
        setParentPath(computeParentPath(path));
        setLoadedMtime(null);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleNavigate = (path: string) => {
    // If there's an error, force reload even if same path
    if (error) {
      setError(null);
      setLoadedPath(null);
    }
    setCurrentPath(path);
  };

  const handleGoUp = () => {
    if (parentPath) {
      handleNavigate(parentPath);
    }
  };

  const handleGoHome = () => {
    handleNavigate(rootPath || '~');
  };

  const handlePathSubmit = () => {
    const nextPath = pathInput.trim();
    if (nextPath) {
      loadDirectory(nextPath);
    }
  };

  const handleSetRoot = async () => {
    const nextRoot = pathInput.trim() || currentPath;
    try {
      const updated = await setRootDirectory(nextRoot);
      setRootPath(updated);
      saveSettings({ rootDirectory: updated });
      setCurrentPath(updated);
      toast(`Root set to ${updated}`, 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to set root directory', 'error');
    }
  };

  const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    isResizingRef.current = true;
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    const minWidth = 240;
    const maxWidth = Math.max(minWidth, Math.min(560, window.innerWidth - 80));
    let latestWidth = startWidth;
    let rafId: number | null = null;

    const onMove = (moveEvent: MouseEvent | PointerEvent) => {
      if (!isResizingRef.current) return;
      const delta = moveEvent.clientX - startX;
      latestWidth = Math.min(Math.max(startWidth + delta, minWidth), maxWidth);
      if (rafId !== null) return;
      rafId = window.requestAnimationFrame(() => {
        rafId = null;
        setSidebarWidth(latestWidth);
      });
    };

    const onUp = () => {
      if (!isResizingRef.current) return;
      isResizingRef.current = false;
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
        rafId = null;
      }
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        localStorage.setItem('nebula-filebrowser-width', String(latestWidth));
      } catch {
        // Ignore storage errors
      }
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(defaultSidebarWidth);
    try {
      localStorage.setItem('nebula-filebrowser-width', String(defaultSidebarWidth));
    } catch {
      // Ignore storage errors
    }
  };

  const handleCreate = async () => {
    const name = prompt('Enter notebook name:');
    if (name) {
      try {
        const result = await createNotebook(name, [], currentPath);
        loadDirectory(currentPath);
        onRefresh();
        // Open the newly created notebook in a new browser tab
        if (result?.id) {
          const url = new URL(window.location.href);
          url.searchParams.set('file', result.id);
          window.open(url.toString(), '_blank');
        }
      } catch (err: any) {
        toast(err.message || 'Failed to create notebook', 'error');
      }
    }
  };

  const handleCreateFolder = async () => {
    const name = prompt('Enter folder name:');
    if (name) {
      try {
        await createFolder(currentPath, name);
        loadDirectory(currentPath);
        onRefresh();
        toast(`Created folder "${name}"`, 'success');
      } catch (err: any) {
        toast(err.message || 'Failed to create folder', 'error');
      }
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadFile(currentPath, file);
      }
      toast(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`, 'success');
      loadDirectory(currentPath);
      onRefresh();
    } catch (err: any) {
      toast(err.message || 'Failed to upload file', 'error');
    } finally {
      setIsUploading(false);
      // Reset input so same file can be uploaded again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Drag-and-drop upload handlers
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadFile(currentPath, file);
      }
      toast(`Uploaded ${files.length} file${files.length > 1 ? 's' : ''}`, 'success');
      loadDirectory(currentPath);
      onRefresh();
    } catch (err: any) {
      toast(err.message || 'Failed to upload file', 'error');
    } finally {
      setIsUploading(false);
    }
  };

  // Wrapper handlers for FileListItem (no event parameter)
  const handleDuplicateItem = async (item: FileItem) => {
    try {
      await duplicateFile(item.path);
      loadDirectory(currentPath);
      onRefresh();
      toast(`Duplicated ${item.name}`, 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to duplicate file', 'error');
    }
  };

  const handleDownloadItem = async (item: FileItem) => {
    try {
      await downloadFile(item.path, item.name);
      toast(`Downloaded ${item.name}`, 'success');
    } catch (err: any) {
      toast(err.message || 'Failed to download file', 'error');
    }
  };

  const handleDeleteItem = async (item: FileItem) => {
    const itemType = item.isDirectory ? 'folder' : 'file';
    const confirmed = await confirm({
      title: `Delete ${item.isDirectory ? 'Folder' : 'File'}`,
      message: `Are you sure you want to delete "${item.name}"?${item.isDirectory ? ' This will delete all contents.' : ''}`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (confirmed) {
      try {
        await deleteFile(item.path);
        loadDirectory(currentPath);
        onRefresh();
        toast(`Deleted ${item.name}`, 'success');
      } catch (err: any) {
        toast(err.message || `Failed to delete ${itemType}`, 'error');
      }
    }
  };

  // Inline rename handlers
  const handleStartEdit = (item: FileItem) => {
    setEditingItem(item);
    setEditValue(item.name);
  };

  const handleCancelEdit = () => {
    setEditingItem(null);
    setEditValue('');
  };

  const handleConfirmEdit = async () => {
    if (!editingItem) return;

    const newName = editValue.trim();
    if (!newName || newName === editingItem.name) {
      handleCancelEdit();
      return;
    }

    const itemType = editingItem.isDirectory ? 'folder' : 'file';
    try {
      const parentDir = editingItem.path.substring(0, editingItem.path.lastIndexOf('/'));
      const newPath = `${parentDir}/${newName}`;
      await renameFile(editingItem.path, newPath);
      loadDirectory(currentPath);
      onRefresh();
      toast(`Renamed to "${newName}"`, 'success');
    } catch (err: any) {
      toast(err.message || `Failed to rename ${itemType}`, 'error');
    } finally {
      handleCancelEdit();
    }
  };

  const handleRenameItem = async (item: FileItem, newName: string) => {
    // This is called from FileListItem but we use inline editing now
    // Keep for compatibility but actual rename happens in handleConfirmEdit
  };

  const handleOpenNewTab = (path: string) => {
    const baseUrl = window.location.pathname;
    const lower = path.toLowerCase();
    if (lower.endsWith('.html') || lower.endsWith('.htm')) {
      window.open(`${baseUrl}?html=${encodeURIComponent(path)}`, '_blank', 'noopener,noreferrer');
      return;
    }
    if (isEditableTextFile(path)) {
      const item = items.find(entry => entry.path === path);
      if (item && item.sizeBytes > maxTextEditorBytes) {
        toast(`File is too large to open in editor (${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB).`, 'warning');
        return;
      }
      window.open(`${baseUrl}?text=${encodeURIComponent(path)}`, '_blank', 'noopener,noreferrer');
      return;
    }
    window.open(`${baseUrl}?file=${path}`, '_blank');
  };

  const handleOpenTextFile = (item: FileItem) => {
    if (item.sizeBytes > maxTextEditorBytes) {
      toast(`File is too large to open in editor (${(item.sizeBytes / (1024 * 1024)).toFixed(1)} MB).`, 'warning');
      return;
    }
    if (onOpenTextFile) {
      onOpenTextFile(item.path);
    } else {
      handleOpenNewTab(item.path);
    }
  };

  const handleOpenImageFile = (item: FileItem) => {
    if (onOpenImageFile) {
      onOpenImageFile(item.path);
      return;
    }
    const downloadUrl = `/api/fs/download?path=${encodeURIComponent(item.path)}`;
    window.open(downloadUrl, '_blank', 'noopener,noreferrer');
  };

  const handleSelectFile = (path: string) => {
    onSelect(path);
    // Close sidebar on mobile for sidebar variant
    if (variant === 'sidebar' && window.innerWidth < 1024 && onClose) {
      onClose();
    }
  };

  const filteredItems = useMemo(() => {
    return items
      .filter(item => {
        if (showNotebooksOnly && !item.isDirectory && item.extension !== '.ipynb') return false;
        if (searchQuery && !item.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        // Folders first
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;

        // Then sort by selected criteria
        if (sortBy === 'modified') {
          // Most recent first
          return b.modified - a.modified;
        } else {
          // Notebooks first, then alphabetically
          if (a.extension === '.ipynb' && b.extension !== '.ipynb') return -1;
          if (a.extension !== '.ipynb' && b.extension === '.ipynb') return 1;
          return a.name.localeCompare(b.name);
        }
      });
  }, [items, showNotebooksOnly, searchQuery, sortBy]);

  // Path breadcrumbs
  const pathParts = currentPath.split('/').filter(Boolean);
  if (currentPath.startsWith('/')) {
    pathParts.unshift('/');
  }

  // Shared content for both variants
  const browserContent = (
    <>
      {/* Hidden file input for upload */}
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={handleFileUpload}
        multiple
      />

      {/* Header */}
      <div className={`p-4 border-b border-slate-200 bg-white flex justify-between items-center ${variant === 'inline' ? 'rounded-t-xl' : ''}`}>
        <h2 className="font-semibold text-slate-800 flex items-center gap-2 text-sm uppercase tracking-wider">
          <FolderOpen className="w-4 h-4 text-slate-500" />
          Explorer
        </h2>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCreate}
            className="p-1.5 hover:bg-slate-100 rounded text-slate-600"
            title="New Notebook"
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            onClick={handleCreateFolder}
            className="p-1.5 hover:bg-slate-100 rounded text-slate-600"
            title="New Folder"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
            className="p-1.5 hover:bg-slate-100 rounded text-slate-600 disabled:opacity-50"
            title="Upload files"
          >
            <Upload className={`w-4 h-4 ${isUploading ? 'animate-pulse' : ''}`} />
          </button>
          <button
            onClick={() => loadDirectory(currentPath)}
            className="p-1.5 hover:bg-slate-100 rounded text-slate-600"
            title="Refresh"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
          {variant === 'sidebar' && onClose && (
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded lg:hidden">
              <X className="w-4 h-4 text-slate-500" />
            </button>
          )}
        </div>
      </div>

      {/* Path Navigation - combined row */}
      <div className="px-3 py-2 border-b border-slate-200 bg-white">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1 text-xs text-slate-600 overflow-x-auto scrollbar-hide min-w-0">
            <button
              onClick={handleGoHome}
              className="p-1 hover:bg-slate-100 rounded text-slate-500 flex-shrink-0"
              title="Go to root"
            >
              <Home className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleGoUp}
              disabled={!parentPath}
              className="p-1 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-30 flex-shrink-0"
              title="Go up"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
            <div className="w-[1px] h-4 bg-slate-200 mx-1 flex-shrink-0" />
            {pathParts.map((part, idx) => {
              const fullPath = idx === 0 && part === '/'
                ? '/'
                : '/' + pathParts.slice(part === '/' ? 1 : 0, idx + 1).filter(p => p !== '/').join('/');

              return (
                <React.Fragment key={idx}>
                  {idx > 0 && <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />}
                  <button
                    onClick={() => handleNavigate(fullPath)}
                    className="hover:text-blue-600 hover:underline truncate max-w-[6.25rem] flex-shrink-0"
                    title={fullPath}
                  >
                    {part === '/' ? 'Root' : part}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
          <button
            onClick={() => setShowPathInput((prev) => !prev)}
            className={`px-2 py-1 text-[0.625rem] border rounded flex items-center gap-1 flex-shrink-0 ${
              showPathInput ? 'bg-blue-50 text-blue-700 border-blue-200' : 'text-slate-600 border-slate-200 hover:bg-slate-100'
            }`}
            title="Toggle path entry"
          >
            <Folder className="w-3 h-3" />
            Path
          </button>
        </div>
        {showPathInput && (
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handlePathSubmit();
                }
              }}
              placeholder="Type a path…"
              className="flex-1 min-w-0 px-2 py-1 text-[0.6875rem] bg-slate-50 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              onClick={handlePathSubmit}
              className="px-2 py-1 text-[0.625rem] text-slate-600 border border-slate-200 rounded hover:bg-slate-100"
            >
              Go
            </button>
            <button
              onClick={handleSetRoot}
              className="px-2 py-1 text-[0.625rem] text-slate-600 border border-slate-200 rounded hover:bg-slate-100"
              title="Set current path as server root"
            >
              Set Root
            </button>
          </div>
        )}
      </div>

      {/* Toolbar & Search */}
      <div className="p-3 border-b border-slate-200 bg-white space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[0.625rem] font-bold text-slate-400 uppercase">Files</span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setShowSearch((prev) => !prev)}
              className={`p-1 rounded flex items-center gap-1 text-[0.625rem] font-medium transition-colors ${
                showSearch ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-500'
              }`}
              title="Toggle search"
            >
              <Search className="w-3 h-3" />
            </button>
            <button
              onClick={() => setSortBy(sortBy === 'name' ? 'modified' : 'name')}
              className={`p-1 rounded flex items-center gap-1 text-[0.625rem] font-medium transition-colors ${sortBy === 'modified' ? 'bg-purple-100 text-purple-700' : 'hover:bg-slate-100 text-slate-500'}`}
              title={sortBy === 'modified' ? 'Sorted by modified time' : 'Sorted by name'}
            >
              {sortBy === 'modified' ? <Clock className="w-3 h-3" /> : <ArrowDownAZ className="w-3 h-3" />}
            </button>
            <button
              onClick={toggleNotebooksOnly}
              className={`p-1 rounded flex items-center gap-1 text-[0.625rem] font-medium transition-colors ${showNotebooksOnly ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-500'}`}
              title="Filter Notebooks"
            >
              <Filter className="w-3 h-3" />
            </button>
          </div>
        </div>
        {showSearch && (
          <div className="relative">
            <Search className="w-3 h-3 absolute left-2.5 top-2.5 text-slate-400" />
            <input
              type="text"
              placeholder="Search files..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-2 py-1.5 text-xs bg-slate-50 border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        )}
      </div>

      {/* File List */}
      <div
        className="flex-1 overflow-y-auto p-2 relative"
        style={variant === 'inline' ? { maxHeight, minHeight: maxHeight } : undefined}
      >
        {/* Drag overlay */}
        {isDragging && (
          <div className="absolute inset-0 flex items-center justify-center bg-blue-50/80 border-2 border-dashed border-blue-400 rounded-lg z-10 pointer-events-none">
            <div className="text-center">
              <Upload className="w-8 h-8 text-blue-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-blue-600">Drop files to upload</p>
            </div>
          </div>
        )}

        {error && (
          <div className="text-center py-4 text-red-500 text-xs">
            {error}
          </div>
        )}

        {/* Only show loading screen on initial load (no items yet) */}
        {isLoading && items.length === 0 && (
          <div className="text-center py-8 text-slate-400 text-xs">
            Loading...
          </div>
        )}

        {/* Show files even during background refresh */}
        {!error && filteredItems.map(item => (
          <FileListItem
            key={item.id}
            item={item}
            isCurrentFile={item.path === currentFileId}
            onNavigate={handleNavigate}
            onSelect={handleSelectFile}
            onOpenNewTab={handleOpenNewTab}
            onOpenTextFile={handleOpenTextFile}
            onOpenImageFile={handleOpenImageFile}
            onRename={handleRenameItem}
            onDuplicate={handleDuplicateItem}
            onDownload={handleDownloadItem}
            onDelete={handleDeleteItem}
            compact={variant === 'sidebar'}
            isEditing={editingItem?.id === item.id}
            editValue={editingItem?.id === item.id ? editValue : ''}
            onEditChange={setEditValue}
            onStartEdit={handleStartEdit}
            onCancelEdit={handleCancelEdit}
            onConfirmEdit={handleConfirmEdit}
          />
        ))}

        {!isLoading && !error && filteredItems.length === 0 && (
          <div className="text-center py-8 text-slate-400 text-xs">
            {searchQuery ? 'No matching files found.' : 'Empty directory.'}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className={`p-3 border-t border-slate-200 bg-white text-[0.625rem] text-slate-400 flex justify-between ${variant === 'inline' ? 'rounded-b-xl' : ''}`}>
        <span>{items.length} items</span>
        <span className="truncate max-w-[12.5rem]" title={currentPath}>{currentPath}</span>
      </div>
    </>
  );

  // Inline variant - simple div wrapper
  if (variant === 'inline') {
    return (
      <div
        className={`bg-white rounded-xl border-2 overflow-hidden flex flex-col transition-colors ${
          isDragging ? 'border-blue-400 bg-blue-50/30' : 'border-slate-200'
        } ${className}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {browserContent}
      </div>
    );
  }

  // Sidebar variant - sliding panel with backdrop
  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/20 backdrop-blur-sm z-30 lg:hidden"
          onClick={onClose}
        />
      )}

      {/* Sidebar Panel */}
      <div
        className={`
          fixed top-0 left-0 h-full border-r shadow-xl z-40 transform transition-transform duration-300 ease-in-out flex flex-col
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
          ${isDragging ? 'bg-blue-50/50 border-blue-400 border-2' : 'bg-slate-50 border-slate-200'}
          ${className}
        `}
        style={{ width: sidebarWidth }}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div
          className="absolute inset-y-0 right-0 w-1.5 cursor-col-resize bg-slate-200/30 hover:bg-slate-300/50 z-50 transition-colors pointer-events-auto"
          onPointerDown={startResize}
          onDoubleClick={resetSidebarWidth}
        />
        {browserContent}
      </div>
    </>
  );
};
