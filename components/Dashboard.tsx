/**
 * Dashboard - Landing page with file browser and running sessions
 *
 * Matches Nebula Notebook styling and reuses patterns from FileBrowser.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FolderOpen,
  Terminal,
  Play,
  ChevronRight,
  Plus,
  Home,
  RefreshCw,
  Folder,
  Book,
  Search,
  ArrowUp,
  Clock,
  ArrowDownAZ,
  Filter,
  Cpu,
  Upload,
  Lightbulb,
} from 'lucide-react';
import {
  listDirectory,
  DirectoryListing,
  FileItem,
  createNotebook,
  uploadFile,
  duplicateFile,
  downloadFile,
  deleteFile,
} from '../services/fileService';
import { listTerminals, TerminalInfo } from '../services/terminalService';
import { FileListItem } from './FileListItem';

// Kernel session from API
interface KernelSession {
  id: string;
  kernel_name: string;
  file_path: string | null;
  status: 'idle' | 'busy' | 'starting';
  execution_count: number;
  memory_mb: number | null;
  pid: number | null;
}

/**
 * Fetch server's working directory from health endpoint
 */
async function getServerCwd(): Promise<string> {
  try {
    const response = await fetch('/api/health');
    if (response.ok) {
      const data = await response.json();
      return data.cwd || '~';
    }
  } catch {
    // Fall back to home
  }
  return '~';
}

/**
 * Fetch active kernel sessions
 */
async function getKernelSessions(): Promise<KernelSession[]> {
  try {
    const response = await fetch('/api/kernels/sessions');
    if (response.ok) {
      const data = await response.json();
      return data.sessions || [];
    }
  } catch {
    // Ignore errors
  }
  return [];
}

// Get filename from path
function getFilename(path: string): string {
  return path.split('/').pop() || path;
}

export const Dashboard: React.FC = () => {
  // File browser state
  const [currentPath, setCurrentPath] = useState<string>('~');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortBy, setSortBy] = useState<'name' | 'modified'>('modified');
  const [showNotebooksOnly, setShowNotebooksOnly] = useState(false);

  // Sessions state
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [kernelSessions, setKernelSessions] = useState<KernelSession[]>([]);

  // Upload state
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Load directory contents
  const loadDirectory = useCallback(async (path: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await listDirectory(path);
      setListing(result);
      setCurrentPath(result.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load directory');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Load sessions (terminals + kernels)
  const loadSessions = useCallback(async () => {
    const [terms, kernels] = await Promise.all([
      listTerminals().catch(() => []),
      getKernelSessions(),
    ]);
    setTerminals(terms);
    setKernelSessions(kernels);
  }, []);

  // Initial load
  useEffect(() => {
    const init = async () => {
      const cwd = await getServerCwd();
      loadDirectory(cwd);
      loadSessions();
    };
    init();
  }, [loadDirectory, loadSessions]);

  // Poll sessions every 5 seconds
  useEffect(() => {
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // Navigate to a directory
  const handleNavigate = (path: string) => {
    loadDirectory(path);
  };

  // Open a notebook
  const handleOpenNotebook = (path: string) => {
    window.location.href = `/?file=${encodeURIComponent(path)}`;
  };

  // Open notebook in new tab
  const handleOpenNotebookNewTab = (path: string) => {
    window.open(`/?file=${encodeURIComponent(path)}`, '_blank');
  };

  // Open a terminal
  const handleOpenTerminal = (name: string) => {
    window.open(`/?terminal=${encodeURIComponent(name)}`, '_blank');
  };

  // Create new notebook
  const handleNewNotebook = async () => {
    const name = prompt('Enter notebook name:');
    if (name) {
      try {
        const notebook = await createNotebook(name, [
          {
            id: `cell-${Date.now()}`,
            type: 'code',
            content: '',
            outputs: [],
          },
        ], currentPath);
        // Open in new tab
        window.open(`/?file=${encodeURIComponent(notebook.id)}`, '_blank');
        loadDirectory(currentPath);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create notebook');
      }
    }
  };

  // Handle file upload
  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    setIsUploading(true);
    try {
      for (const file of Array.from(files)) {
        await uploadFile(currentPath, file);
      }
      loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to upload file');
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  // Handle file duplicate
  const handleDuplicate = async (item: FileItem) => {
    try {
      await duplicateFile(item.path);
      loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to duplicate file');
    }
  };

  // Handle file download
  const handleDownload = async (item: FileItem) => {
    try {
      await downloadFile(item.path, item.name);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to download file');
    }
  };

  // Handle file delete
  const handleDelete = async (item: FileItem) => {
    if (!confirm(`Delete "${item.name}"?`)) return;
    try {
      await deleteFile(item.path);
      loadDirectory(currentPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete file');
    }
  };

  // Filter and sort items
  const filteredItems = useMemo(() => {
    if (!listing) return [];
    return listing.items
      .filter(item => {
        if (showNotebooksOnly && !item.isDirectory && item.extension !== '.ipynb') return false;
        if (searchQuery && !item.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
        return true;
      })
      .sort((a, b) => {
        // Folders first
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;

        if (sortBy === 'modified') {
          return b.modified - a.modified;
        } else {
          if (a.extension === '.ipynb' && b.extension !== '.ipynb') return -1;
          if (a.extension !== '.ipynb' && b.extension === '.ipynb') return 1;
          return a.name.localeCompare(b.name);
        }
      });
  }, [listing, showNotebooksOnly, searchQuery, sortBy]);

  // Path breadcrumbs
  const pathParts = currentPath.split('/').filter(Boolean);
  if (currentPath.startsWith('/')) {
    pathParts.unshift('/');
  }

  // Active notebooks (kernels with file paths)
  const activeNotebooks = kernelSessions.filter(s => s.file_path);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Hidden file input */}
      <input
        type="file"
        ref={fileInputRef}
        className="hidden"
        onChange={handleFileUpload}
        multiple
      />

      {/* Header - matches Notebook header style */}
      <header className="bg-slate-50/90 backdrop-blur border-b border-slate-200 px-4 py-3 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Nebula logo - standard avatar style */}
            <svg className="w-9 h-9" viewBox="0 0 32 32">
              <defs>
                <linearGradient id="nebula-logo-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style={{ stopColor: '#8b5cf6' }} />
                  <stop offset="50%" style={{ stopColor: '#6366f1' }} />
                  <stop offset="100%" style={{ stopColor: '#3b82f6' }} />
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="6" fill="url(#nebula-logo-grad)" />
              <path d="M8 10h16 M8 16h12 M8 22h14" stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
              <circle cx="24" cy="22" r="3" fill="#fbbf24" />
            </svg>
            <div>
              <h1 className="text-lg font-bold text-slate-800">Nebula Notebook</h1>
              <p className="text-xs text-slate-500">Interactive Computing Environment</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => handleOpenTerminal('default')}
              className="flex items-center gap-2 px-3 py-2 text-slate-600 hover:bg-slate-100 rounded-lg text-sm font-medium transition-colors"
            >
              <Terminal className="w-4 h-4" />
              <span className="hidden sm:inline">Terminal</span>
            </button>
            <button
              onClick={handleNewNotebook}
              className="flex items-center gap-2 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white rounded-lg text-sm font-medium transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New Notebook</span>
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
          {/* File Browser - Takes 3 columns */}
          <div className="lg:col-span-3 bg-white rounded-xl border border-slate-200 overflow-hidden">
            {/* Browser Header */}
            <div className="p-4 border-b border-slate-200 bg-white">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-slate-800 flex items-center gap-2 text-sm uppercase tracking-wider">
                  <FolderOpen className="w-4 h-4 text-slate-500" />
                  Explorer
                </h2>
                <div className="flex items-center gap-1">
                  <button
                    onClick={handleNewNotebook}
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
                </div>
              </div>

              {/* Path Navigation */}
              <div className="flex items-center gap-1 mb-3">
                <button
                  onClick={() => handleNavigate('~')}
                  className="p-1 hover:bg-slate-100 rounded text-slate-500"
                  title="Go to home"
                >
                  <Home className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => listing?.parent && handleNavigate(listing.parent)}
                  disabled={!listing?.parent}
                  className="p-1 hover:bg-slate-100 rounded text-slate-500 disabled:opacity-30"
                  title="Go up"
                >
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <div className="flex items-center gap-1 text-xs text-slate-600 overflow-x-auto scrollbar-hide ml-2">
                  {pathParts.map((part, idx) => {
                    const fullPath = idx === 0 && part === '/'
                      ? '/'
                      : '/' + pathParts.slice(part === '/' ? 1 : 0, idx + 1).filter(p => p !== '/').join('/');
                    return (
                      <React.Fragment key={idx}>
                        {idx > 0 && <ChevronRight className="w-3 h-3 text-slate-400 flex-shrink-0" />}
                        <button
                          onClick={() => handleNavigate(fullPath)}
                          className="hover:text-blue-600 hover:underline truncate max-w-[100px] flex-shrink-0"
                          title={fullPath}
                        >
                          {part === '/' ? 'Root' : part}
                        </button>
                      </React.Fragment>
                    );
                  })}
                </div>
              </div>

              {/* Search & Filters */}
              <div className="flex items-center gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Search files..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-8 pr-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400"
                  />
                </div>
                <button
                  onClick={() => setSortBy(sortBy === 'name' ? 'modified' : 'name')}
                  className={`p-2 rounded-lg flex items-center gap-1 text-xs font-medium transition-colors ${
                    sortBy === 'modified' ? 'bg-purple-100 text-purple-700' : 'hover:bg-slate-100 text-slate-500'
                  }`}
                  title={sortBy === 'modified' ? 'Sorted by modified time' : 'Sorted by name'}
                >
                  {sortBy === 'modified' ? <Clock className="w-4 h-4" /> : <ArrowDownAZ className="w-4 h-4" />}
                </button>
                <button
                  onClick={() => setShowNotebooksOnly(!showNotebooksOnly)}
                  className={`p-2 rounded-lg flex items-center gap-1 text-xs font-medium transition-colors ${
                    showNotebooksOnly ? 'bg-purple-100 text-purple-700' : 'hover:bg-slate-100 text-slate-500'
                  }`}
                  title="Show notebooks only"
                >
                  <Filter className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* File List */}
            <div className="divide-y divide-slate-100 max-h-[60vh] overflow-y-auto">
              {isLoading && !listing ? (
                <div className="px-4 py-12 text-center text-slate-400">Loading...</div>
              ) : error ? (
                <div className="px-4 py-12 text-center text-red-500">{error}</div>
              ) : (
                <>
                  {/* Parent directory */}
                  {listing?.parent && (
                    <button
                      onClick={() => handleNavigate(listing.parent!)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <Folder className="w-4 h-4 text-slate-400" />
                      <span className="text-sm text-slate-500">..</span>
                    </button>
                  )}

                  {filteredItems.map((item) => (
                    <FileListItem
                      key={item.path}
                      item={item}
                      onNavigate={handleNavigate}
                      onSelect={handleOpenNotebook}
                      onOpenNewTab={handleOpenNotebookNewTab}
                      onDuplicate={handleDuplicate}
                      onDownload={handleDownload}
                      onDelete={handleDelete}
                    />
                  ))}

                  {filteredItems.length === 0 && (
                    <div className="px-4 py-12 text-center text-slate-400 text-sm">
                      {searchQuery ? 'No matching files found.' : 'Empty directory.'}
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Footer */}
            <div className="px-4 py-2 border-t border-slate-100 bg-slate-50 text-xs text-slate-400 flex justify-between">
              <span>{listing?.items.length || 0} items</span>
              <span className="truncate max-w-[200px]" title={currentPath}>{currentPath}</span>
            </div>
          </div>

          {/* Sidebar */}
          <div className="space-y-6">
            {/* Quick Stats */}
            <div className="bg-white rounded-xl border border-slate-200 p-4">
              <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Overview</h3>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-slate-500 mb-1">
                    <Cpu className="w-4 h-4" />
                    <span className="text-xs">Kernels</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-800">{kernelSessions.length}</div>
                </div>
                <div className="bg-slate-50 rounded-lg p-3">
                  <div className="flex items-center gap-2 text-slate-500 mb-1">
                    <Terminal className="w-4 h-4" />
                    <span className="text-xs">Terminals</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-800">{terminals.length}</div>
                </div>
              </div>
            </div>

            {/* Active Notebooks */}
            {activeNotebooks.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                  <Book className="w-4 h-4 text-orange-500" />
                  <h3 className="text-sm font-medium text-slate-700">Active Notebooks</h3>
                </div>
                <div className="divide-y divide-slate-100 max-h-[200px] overflow-y-auto">
                  {activeNotebooks.map((session) => (
                    <button
                      key={session.id}
                      onClick={() => handleOpenNotebookNewTab(session.file_path!)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        session.status === 'busy' ? 'bg-amber-500 animate-pulse' : 'bg-green-500'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-700 truncate">
                          {getFilename(session.file_path!).replace('.ipynb', '')}
                        </div>
                        <div className="text-xs text-slate-400 flex gap-2">
                          <span>{session.kernel_name}</span>
                          {session.memory_mb && <span>· {Math.round(session.memory_mb)}MB</span>}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Terminals */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-slate-500" />
                  <h3 className="text-sm font-medium text-slate-700">Terminals</h3>
                </div>
                <button
                  onClick={() => handleOpenTerminal(`term-${Date.now()}`)}
                  className="p-1 hover:bg-slate-100 rounded text-slate-500"
                  title="New Terminal"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>
              <div className="divide-y divide-slate-100">
                {terminals.length === 0 ? (
                  <div className="px-4 py-6 text-center text-sm text-slate-400">
                    No active terminals
                  </div>
                ) : (
                  terminals.map((term) => (
                    <button
                      key={term.id}
                      onClick={() => handleOpenTerminal(term.id)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <Play className="w-4 h-4 text-green-500" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-700 truncate">{term.id}</div>
                        <div className="text-xs text-slate-400">PID: {term.pid}</div>
                      </div>
                    </button>
                  ))
                )}
              </div>
            </div>

            {/* Tips */}
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-4">
              <div className="flex items-start gap-3">
                <Lightbulb className="w-5 h-5 text-amber-500 mt-0.5 flex-shrink-0" />
                <div className="text-xs text-slate-600 space-y-2">
                  <p className="font-medium text-slate-700">Tips for Jupyter Users</p>
                  <ul className="space-y-1.5">
                    <li><code className="bg-slate-200 px-1 rounded">E</code> / <code className="bg-slate-200 px-1 rounded">D</code> keys queue/dequeue cells for batch execution</li>
                    <li><code className="bg-slate-200 px-1 rounded">Ctrl+`</code> toggles the integrated terminal</li>
                    <li><code className="bg-slate-200 px-1 rounded">?terminal=name</code> in URL for persistent terminals</li>
                    <li>Click notebook name to rename inline</li>
                    <li>History panel shows full edit timeline with restore</li>
                    <li>AI chat sidebar has full notebook context</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
