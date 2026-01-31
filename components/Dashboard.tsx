/**
 * Dashboard - Landing page with file browser and running sessions
 *
 * Matches Nebula Notebook styling and reuses patterns from FileBrowser.
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FolderOpen,
  FileText,
  Terminal,
  Play,
  ChevronRight,
  Plus,
  Home,
  RefreshCw,
  Folder,
  FileCode,
  Book,
  Search,
  ArrowUp,
  Clock,
  ArrowDownAZ,
  Filter,
  Cpu,
  Activity,
  ExternalLink,
  Zap,
  Upload,
} from 'lucide-react';
import {
  listDirectory,
  DirectoryListing,
  FileItem,
  createNotebook,
  uploadFile,
} from '../services/fileService';
import { listTerminals, TerminalInfo } from '../services/terminalService';

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

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

// Get file icon matching FileBrowser style
function getFileIcon(item: FileItem) {
  if (item.isDirectory) return <Folder className="w-4 h-4 text-blue-500" />;
  if (item.extension === '.ipynb') return <Book className="w-4 h-4 text-orange-500" />;
  if (item.extension === '.py') return <FileCode className="w-4 h-4 text-blue-500" />;
  if (item.extension === '.csv') return <FileText className="w-4 h-4 text-green-500" />;
  if (item.extension === '.json') return <FileCode className="w-4 h-4 text-yellow-500" />;
  return <FileText className="w-4 h-4 text-slate-400" />;
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
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center shadow-sm">
              <Zap className="w-5 h-5 text-white" />
            </div>
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
              className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New Notebook</span>
            </button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-6">
        {/* Active Sessions Bar */}
        {(activeNotebooks.length > 0 || terminals.length > 0) && (
          <div className="mb-6 bg-white rounded-xl border border-slate-200 p-4">
            <h2 className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-3">Active Sessions</h2>
            <div className="flex flex-wrap gap-2">
              {activeNotebooks.map((session) => (
                <button
                  key={session.id}
                  onClick={() => handleOpenNotebookNewTab(session.file_path!)}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-orange-50 border border-slate-200 hover:border-orange-200 rounded-lg transition-colors group"
                >
                  <span className={`w-2 h-2 rounded-full ${
                    session.status === 'busy' ? 'bg-amber-500 animate-pulse' : 'bg-green-500'
                  }`} />
                  <Book className="w-4 h-4 text-orange-500" />
                  <span className="text-sm text-slate-700 group-hover:text-orange-600 max-w-[150px] truncate">
                    {getFilename(session.file_path!).replace('.ipynb', '')}
                  </span>
                  {session.memory_mb && (
                    <span className="text-xs text-slate-400">{Math.round(session.memory_mb)}MB</span>
                  )}
                </button>
              ))}
              {terminals.map((term) => (
                <button
                  key={term.id}
                  onClick={() => handleOpenTerminal(term.id)}
                  className="flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 border border-slate-200 rounded-lg transition-colors group"
                >
                  <span className="w-2 h-2 rounded-full bg-green-500" />
                  <Terminal className="w-4 h-4 text-slate-500" />
                  <span className="text-sm text-slate-700 max-w-[150px] truncate">{term.id}</span>
                </button>
              ))}
            </div>
          </div>
        )}

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
                    showNotebooksOnly ? 'bg-orange-100 text-orange-700' : 'hover:bg-slate-100 text-slate-500'
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
                    <div
                      key={item.path}
                      onClick={() => item.isDirectory ? handleNavigate(item.path) : item.extension === '.ipynb' && handleOpenNotebook(item.path)}
                      className={`
                        group relative flex items-center px-4 py-3 cursor-pointer transition-all
                        ${item.extension === '.ipynb' ? 'hover:bg-orange-50' : 'hover:bg-slate-50'}
                        ${!item.isDirectory && item.extension !== '.ipynb' ? 'opacity-60' : ''}
                      `}
                    >
                      <div className="flex items-center gap-3 flex-1 min-w-0">
                        {getFileIcon(item)}
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className={`text-sm truncate ${item.extension === '.ipynb' ? 'text-slate-800 group-hover:text-orange-600' : 'text-slate-700'}`}>
                            {item.name}
                          </span>
                          {!item.isDirectory && (
                            <span className="text-xs text-slate-400">
                              {formatRelativeTime(item.modified)} · {item.size}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Hover actions for notebooks */}
                      {item.extension === '.ipynb' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleOpenNotebookNewTab(item.path);
                          }}
                          className="opacity-0 group-hover:opacity-100 p-1.5 hover:bg-orange-100 rounded text-orange-500 transition-opacity"
                          title="Open in new tab"
                        >
                          <ExternalLink className="w-4 h-4" />
                        </button>
                      )}
                    </div>
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

            {/* Running Kernels */}
            {kernelSessions.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                  <Activity className="w-4 h-4 text-green-500" />
                  <h3 className="text-sm font-medium text-slate-700">Running Kernels</h3>
                </div>
                <div className="divide-y divide-slate-100 max-h-[200px] overflow-y-auto">
                  {kernelSessions.map((session) => (
                    <button
                      key={session.id}
                      onClick={() => session.file_path && handleOpenNotebookNewTab(session.file_path)}
                      disabled={!session.file_path}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left disabled:opacity-50 disabled:cursor-default"
                    >
                      <span className={`w-2 h-2 rounded-full flex-shrink-0 ${
                        session.status === 'busy' ? 'bg-amber-500 animate-pulse' : 'bg-green-500'
                      }`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm text-slate-700 truncate">
                          {session.file_path ? getFilename(session.file_path).replace('.ipynb', '') : session.kernel_name}
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

            {/* Tip */}
            <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-xl border border-orange-100 p-4">
              <div className="flex items-start gap-3">
                <Zap className="w-5 h-5 text-orange-500 mt-0.5" />
                <div className="text-sm text-orange-800">
                  <p className="font-medium">Pro Tip</p>
                  <p className="mt-1 text-orange-700 text-xs">
                    Bookmark notebook URLs for quick access. Use <code className="bg-orange-100 px-1 rounded">?terminal=name</code> for persistent named terminals.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
