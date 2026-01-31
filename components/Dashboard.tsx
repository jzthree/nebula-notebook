/**
 * Dashboard - Landing page with file browser and running sessions
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  FolderOpen,
  FileText,
  Terminal,
  Play,
  Clock,
  ChevronRight,
  Plus,
  Home,
  RefreshCw,
} from 'lucide-react';
import {
  listDirectory,
  DirectoryListing,
  FileItem,
  createNotebook,
} from '../services/fileService';
import { listTerminals, TerminalInfo } from '../services/terminalService';

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

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000; // timestamp is in seconds

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

// Get icon for file type
function getFileIcon(item: FileItem): React.ReactNode {
  if (item.isDirectory) {
    return <FolderOpen className="w-5 h-5 text-amber-500" />;
  }
  if (item.extension === '.ipynb') {
    return <FileText className="w-5 h-5 text-orange-500" />;
  }
  return <FileText className="w-5 h-5 text-slate-400" />;
}

export const Dashboard: React.FC = () => {
  const [currentPath, setCurrentPath] = useState<string>('~');
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Load terminals
  const loadTerminals = useCallback(async () => {
    try {
      const result = await listTerminals();
      setTerminals(result);
    } catch {
      // Terminals may not be available, that's ok
      setTerminals([]);
    }
  }, []);

  // Initial load - use server's working directory
  useEffect(() => {
    const init = async () => {
      const cwd = await getServerCwd();
      loadDirectory(cwd);
      loadTerminals();
    };
    init();
  }, [loadDirectory, loadTerminals]);

  // Navigate to a directory
  const handleNavigate = (path: string) => {
    loadDirectory(path);
  };

  // Open a notebook
  const handleOpenNotebook = (path: string) => {
    window.location.href = `/?file=${encodeURIComponent(path)}`;
  };

  // Open a terminal
  const handleOpenTerminal = (name: string) => {
    window.open(`/?terminal=${encodeURIComponent(name)}`, '_blank');
  };

  // Create new notebook
  const handleNewNotebook = async () => {
    try {
      const name = `Untitled-${Date.now()}`;
      const notebook = await createNotebook(name, [
        {
          id: `cell-${Date.now()}`,
          type: 'code',
          content: '',
          outputs: [],
        },
      ], currentPath);
      handleOpenNotebook(notebook.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create notebook');
    }
  };

  // Build breadcrumb path
  const buildBreadcrumbs = () => {
    if (!listing) return [];

    const parts = listing.path.split('/').filter(Boolean);
    const breadcrumbs: { name: string; path: string }[] = [];

    // Handle home directory
    if (listing.path.startsWith('/Users/') || listing.path.startsWith('/home/')) {
      const homeIndex = parts.findIndex((_, i) => i >= 2);
      if (homeIndex > 0) {
        breadcrumbs.push({ name: '~', path: '~' });
        let path = '/' + parts.slice(0, homeIndex).join('/');
        for (let i = homeIndex; i < parts.length; i++) {
          path += '/' + parts[i];
          breadcrumbs.push({ name: parts[i], path });
        }
        return breadcrumbs;
      }
    }

    // Regular path
    let path = '';
    for (const part of parts) {
      path += '/' + part;
      breadcrumbs.push({ name: part, path });
    }
    return breadcrumbs;
  };

  const breadcrumbs = buildBreadcrumbs();
  const notebooks = listing?.items.filter(i => i.extension === '.ipynb') || [];
  const folders = listing?.items.filter(i => i.isDirectory) || [];
  const otherFiles = listing?.items.filter(i => !i.isDirectory && i.extension !== '.ipynb') || [];

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-orange-400 to-amber-500 flex items-center justify-center">
              <FileText className="w-5 h-5 text-white" />
            </div>
            <h1 className="text-xl font-semibold text-slate-800">Nebula Notebook</h1>
          </div>
          <button
            onClick={handleNewNotebook}
            className="flex items-center gap-2 px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            New Notebook
          </button>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* File Browser - Takes 2 columns */}
          <div className="lg:col-span-2 bg-white rounded-xl border border-slate-200 overflow-hidden">
            {/* Breadcrumb */}
            <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-1 text-sm">
              <button
                onClick={() => handleNavigate('~')}
                className="p-1 hover:bg-slate-100 rounded text-slate-500 hover:text-slate-700"
              >
                <Home className="w-4 h-4" />
              </button>
              {breadcrumbs.map((crumb, i) => (
                <React.Fragment key={crumb.path}>
                  <ChevronRight className="w-4 h-4 text-slate-300" />
                  <button
                    onClick={() => handleNavigate(crumb.path)}
                    className={`px-2 py-1 rounded hover:bg-slate-100 ${
                      i === breadcrumbs.length - 1
                        ? 'text-slate-800 font-medium'
                        : 'text-slate-500 hover:text-slate-700'
                    }`}
                  >
                    {crumb.name}
                  </button>
                </React.Fragment>
              ))}
              <div className="flex-1" />
              <button
                onClick={() => loadDirectory(currentPath)}
                className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600"
                title="Refresh"
              >
                <RefreshCw className="w-4 h-4" />
              </button>
            </div>

            {/* File List */}
            <div className="divide-y divide-slate-100">
              {isLoading ? (
                <div className="px-4 py-12 text-center text-slate-400">
                  Loading...
                </div>
              ) : error ? (
                <div className="px-4 py-12 text-center text-red-500">
                  {error}
                </div>
              ) : (
                <>
                  {/* Parent directory */}
                  {listing?.parent && (
                    <button
                      onClick={() => handleNavigate(listing.parent!)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <FolderOpen className="w-5 h-5 text-slate-400" />
                      <span className="text-slate-500">..</span>
                    </button>
                  )}

                  {/* Folders first */}
                  {folders.map((item) => (
                    <button
                      key={item.path}
                      onClick={() => handleNavigate(item.path)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-slate-50 text-left group"
                    >
                      {getFileIcon(item)}
                      <span className="flex-1 text-slate-700 group-hover:text-slate-900">
                        {item.name}
                      </span>
                      <span className="text-xs text-slate-400">
                        {formatRelativeTime(item.modified)}
                      </span>
                    </button>
                  ))}

                  {/* Notebooks */}
                  {notebooks.map((item) => (
                    <button
                      key={item.path}
                      onClick={() => handleOpenNotebook(item.path)}
                      className="w-full px-4 py-3 flex items-center gap-3 hover:bg-orange-50 text-left group"
                    >
                      {getFileIcon(item)}
                      <span className="flex-1 text-slate-700 group-hover:text-orange-600">
                        {item.name}
                      </span>
                      <span className="text-xs text-slate-400">{item.size}</span>
                      <span className="text-xs text-slate-400">
                        {formatRelativeTime(item.modified)}
                      </span>
                    </button>
                  ))}

                  {/* Other files (muted) */}
                  {otherFiles.map((item) => (
                    <div
                      key={item.path}
                      className="w-full px-4 py-3 flex items-center gap-3 text-left opacity-50"
                    >
                      {getFileIcon(item)}
                      <span className="flex-1 text-slate-500">{item.name}</span>
                      <span className="text-xs text-slate-400">{item.size}</span>
                    </div>
                  ))}

                  {/* Empty state */}
                  {folders.length === 0 && notebooks.length === 0 && otherFiles.length === 0 && (
                    <div className="px-4 py-12 text-center text-slate-400">
                      This folder is empty
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Sidebar - Running sessions */}
          <div className="space-y-6">
            {/* Running Terminals */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Terminal className="w-4 h-4 text-slate-500" />
                <h2 className="text-sm font-medium text-slate-700">Terminals</h2>
                <span className="text-xs text-slate-400">({terminals.length})</span>
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

            {/* Quick Actions */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100">
                <h2 className="text-sm font-medium text-slate-700">Quick Actions</h2>
              </div>
              <div className="p-4 space-y-2">
                <button
                  onClick={handleNewNotebook}
                  className="w-full px-4 py-2 flex items-center gap-3 text-left text-sm text-slate-600 hover:bg-slate-50 rounded-lg"
                >
                  <Plus className="w-4 h-4" />
                  New Notebook
                </button>
                <button
                  onClick={() => handleOpenTerminal('default')}
                  className="w-full px-4 py-2 flex items-center gap-3 text-left text-sm text-slate-600 hover:bg-slate-50 rounded-lg"
                >
                  <Terminal className="w-4 h-4" />
                  Open Terminal
                </button>
              </div>
            </div>

            {/* Recent tip */}
            <div className="bg-amber-50 rounded-xl border border-amber-100 p-4">
              <div className="flex items-start gap-3">
                <Clock className="w-5 h-5 text-amber-500 mt-0.5" />
                <div className="text-sm text-amber-800">
                  <p className="font-medium">Tip</p>
                  <p className="mt-1 text-amber-700">
                    Bookmark notebook URLs to open them directly next time.
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
