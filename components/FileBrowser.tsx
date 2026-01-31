import React, { useState, useEffect, useMemo, useRef } from 'react';
import { NotebookMetadata } from '../types';
import {
  Plus,
  X,
  FolderOpen,
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
  deleteFile,
  duplicateFile,
  downloadFile,
  uploadFile,
  FileItem,
  DirectoryListing
} from '../services/fileService';
import { getSettings, saveSettings } from '../services/llmService';
import { useNotification } from './NotificationSystem';
import { DIRECTORY_POLL_INTERVAL_MS } from '../config';

interface Props {
  files: NotebookMetadata[];
  currentFileId: string | null;
  onSelect: (id: string) => void;
  onRefresh: () => void;
  isOpen: boolean;
  onClose: () => void;
}

export const FileBrowser: React.FC<Props> = ({
  files,
  currentFileId,
  onSelect,
  onRefresh,
  isOpen,
  onClose
}) => {
  const { toast, confirm } = useNotification();
  const [currentPath, setCurrentPath] = useState<string>(() => {
    const settings = getSettings();
    return settings.rootDirectory || '~';
  });
  const [loadedPath, setLoadedPath] = useState<string | null>(null); // Track which path items belong to
  const [loadedMtime, setLoadedMtime] = useState<number | null>(null); // Track directory mtime
  const [items, setItems] = useState<FileItem[]>([]);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [showNotebooksOnly, setShowNotebooksOnly] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'modified'>('modified');

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Load directory on first open or when path changes
  useEffect(() => {
    if (!isOpen) return;
    if (loadedPath === currentPath && !error) return; // Already loaded this path

    loadDirectory(currentPath);
  }, [isOpen, currentPath, loadedPath, error]);

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
      setItems([]);
      setLoadedPath(null); // Clear on error so we retry
      setLoadedMtime(null);
    } finally {
      setIsLoading(false);
    }
  };

  const handleNavigate = (path: string) => {
    setCurrentPath(path);
  };

  const handleGoUp = () => {
    if (parentPath) {
      setCurrentPath(parentPath);
    }
  };

  const handleGoHome = () => {
    const settings = getSettings();
    setCurrentPath(settings.rootDirectory || '~');
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
    const confirmed = await confirm({
      title: 'Delete File',
      message: `Are you sure you want to delete "${item.name}"?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    });
    if (confirmed) {
      try {
        await deleteFile(item.path);
        loadDirectory(currentPath);
        onRefresh();
      } catch (err: any) {
        toast(err.message || 'Failed to delete file', 'error');
      }
    }
  };

  const handleOpenNewTab = (path: string) => {
    const baseUrl = window.location.pathname;
    window.open(`${baseUrl}?file=${path}`, '_blank');
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
      <div className={`
        fixed top-0 left-0 h-full w-72 bg-slate-50 border-r border-slate-200 shadow-xl z-40 transform transition-transform duration-300 ease-in-out flex flex-col
        ${isOpen ? 'translate-x-0' : '-translate-x-full'}
      `}>
        {/* Hidden file input for upload */}
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          onChange={handleFileUpload}
          multiple
        />

        {/* Header */}
        <div className="p-4 border-b border-slate-200 bg-white flex justify-between items-center">
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
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded lg:hidden">
              <X className="w-4 h-4 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Path Navigation */}
        <div className="px-3 py-2 border-b border-slate-200 bg-white">
          <div className="flex items-center gap-1 mb-2">
            <button
              onClick={handleGoHome}
              className="p-1 hover:bg-slate-100 rounded text-slate-500"
              title="Go to root"
            >
              <Home className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={handleGoUp}
              disabled={!parentPath}
              className="p-1 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-30"
              title="Go up"
            >
              <ArrowUp className="w-3.5 h-3.5" />
            </button>
          </div>

          {/* Breadcrumbs */}
          <div className="flex items-center gap-1 text-xs text-slate-600 overflow-x-auto scrollbar-hide">
            {pathParts.map((part, idx) => {
              const fullPath = idx === 0 && part === '/'
                ? '/'
                : '/' + pathParts.slice(part === '/' ? 1 : 0, idx + 1).filter(p => p !== '/').join('/');

              return (
                <React.Fragment key={idx}>
                  {idx > 0 && <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />}
                  <button
                    onClick={() => handleNavigate(fullPath)}
                    className="hover:text-blue-600 hover:underline truncate max-w-[80px] flex-shrink-0"
                    title={fullPath}
                  >
                    {part === '/' ? 'Root' : part}
                  </button>
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* Toolbar & Search */}
        <div className="p-3 border-b border-slate-200 bg-white space-y-2">
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

          <div className="flex items-center justify-between">
            <span className="text-[10px] font-bold text-slate-400 uppercase">Files</span>
            <div className="flex items-center gap-1">
              <button
                onClick={() => setSortBy(sortBy === 'name' ? 'modified' : 'name')}
                className={`p-1 rounded flex items-center gap-1 text-[10px] font-medium transition-colors ${sortBy === 'modified' ? 'bg-purple-100 text-purple-700' : 'hover:bg-slate-100 text-slate-500'}`}
                title={sortBy === 'modified' ? 'Sorted by modified time' : 'Sorted by name'}
              >
                {sortBy === 'modified' ? <Clock className="w-3 h-3" /> : <ArrowDownAZ className="w-3 h-3" />}
              </button>
              <button
                onClick={() => setShowNotebooksOnly(!showNotebooksOnly)}
                className={`p-1 rounded flex items-center gap-1 text-[10px] font-medium transition-colors ${showNotebooksOnly ? 'bg-blue-100 text-blue-700' : 'hover:bg-slate-100 text-slate-500'}`}
                title="Filter Notebooks"
              >
                <Filter className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>

        {/* File List */}
        <div className="flex-1 overflow-y-auto p-2">
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
              onSelect={(path) => {
                onSelect(path);
                if (window.innerWidth < 1024) onClose();
              }}
              onOpenNewTab={handleOpenNewTab}
              onDuplicate={handleDuplicateItem}
              onDownload={handleDownloadItem}
              onDelete={handleDeleteItem}
              compact
            />
          ))}

          {!isLoading && !error && filteredItems.length === 0 && (
            <div className="text-center py-8 text-slate-400 text-xs">
              {searchQuery ? 'No matching files found.' : 'Empty directory.'}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 bg-white text-[10px] text-slate-400 flex justify-between">
          <span>{items.length} items</span>
          <span className="truncate max-w-[150px]" title={currentPath}>{currentPath}</span>
        </div>
      </div>
    </>
  );
};
