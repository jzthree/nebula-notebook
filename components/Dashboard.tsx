/**
 * Dashboard - Landing page with file browser and running sessions
 *
 * Uses FileBrowser component in inline mode for file browsing.
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Terminal,
  Play,
  ChevronRight,
  ChevronLeft,
  Plus,
  Book,
  Cpu,
  Lightbulb,
  History,
  AlertTriangle,
  Trash2,
  X,
} from 'lucide-react';
import { listTerminals, TerminalInfo } from '../services/terminalService';
import { getDeadKernelSessions, cleanupDeadKernelSessions, DeadSession } from '../services/kernelService';
import { FileBrowser } from './FileBrowser';
import { ResourcePanel } from './ResourcePanel';

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

// Tips for Jupyter users (including hidden settings)
const TIPS = [
  { text: <>Use the <strong>Nebula MCP server</strong> to let AI agents run code and analyze data in your notebooks</> },
  { text: <><code className="bg-slate-200 px-1 rounded">E</code> / <code className="bg-slate-200 px-1 rounded">D</code> keys queue/dequeue cells for batch execution</> },
  { text: <><code className="bg-slate-200 px-1 rounded">Ctrl+`</code> toggles the integrated terminal</> },
  { text: <><code className="bg-slate-200 px-1 rounded">?terminal=name</code> in URL for persistent named terminals</> },
  { text: <>Click notebook name to rename inline</> },
  { text: <>History panel shows full edit timeline with restore</> },
  { text: <>AI chat sidebar has full notebook context</> },
  { text: <>Enable <strong>Show Line Numbers</strong> in settings for code cells</> },
  { text: <>Enable <strong>Show Cell IDs</strong> in settings to see cell identifiers</> },
  { text: <>Enable <strong>Notify on Long Run</strong> to get browser notifications when cells finish</> },
  { text: <>Enable <strong>Sound Notifications</strong> to hear when jobs complete</> },
  { text: <>Each notebook gets a unique <strong>colorful icon</strong> generated from its name</> },
  { text: <>Press <code className="bg-slate-200 px-1 rounded">Esc</code> to enter cell mode, then <code className="bg-slate-200 px-1 rounded">Ctrl/Cmd+Shift+↑/↓</code> to move cells</> },
  { text: <>Press <code className="bg-slate-200 px-1 rounded">Esc</code> to enter cell mode, then <code className="bg-slate-200 px-1 rounded">Delete</code> or <code className="bg-slate-200 px-1 rounded">Backspace</code> to delete cells</> },
];

// Recently opened notebooks storage key
const RECENT_NOTEBOOKS_KEY = 'nebula-recent-notebooks';
const MAX_RECENT = 5;

interface RecentNotebook {
  path: string;
  name: string;
  openedAt: number;
}

// Get recently opened notebooks from localStorage
function getRecentNotebooks(): RecentNotebook[] {
  try {
    const stored = localStorage.getItem(RECENT_NOTEBOOKS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore parse errors
  }
  return [];
}

// Add a notebook to recent list
export function addRecentNotebook(path: string, name: string): void {
  const recent = getRecentNotebooks();
  // Remove if already exists
  const filtered = recent.filter(r => r.path !== path);
  // Add to front
  filtered.unshift({ path, name, openedAt: Date.now() });
  // Keep only MAX_RECENT
  const trimmed = filtered.slice(0, MAX_RECENT);
  localStorage.setItem(RECENT_NOTEBOOKS_KEY, JSON.stringify(trimmed));
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
  // Server working directory
  const [serverCwd, setServerCwd] = useState<string>('~');

  // Sessions state
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [kernelSessions, setKernelSessions] = useState<KernelSession[]>([]);

  // Tips carousel state (random initial index)
  const [tipIndex, setTipIndex] = useState(() => Math.floor(Math.random() * TIPS.length));

  // Recently opened notebooks
  const [recentNotebooks, setRecentNotebooks] = useState<RecentNotebook[]>([]);

  // Dead kernel sessions (orphaned/terminated)
  const [deadSessions, setDeadSessions] = useState<DeadSession[]>([]);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [cleanupDismissed, setCleanupDismissed] = useState(false);
  const [cleanupNotice, setCleanupNotice] = useState<string | null>(null);

  // Dummy refresh counter (to pass to FileBrowser)
  const [refreshCounter, setRefreshCounter] = useState(0);

  // Load sessions (terminals + kernels)
  const loadSessions = useCallback(async () => {
    const [terms, kernels] = await Promise.all([
      listTerminals().catch(() => []),
      getKernelSessions(),
    ]);
    setTerminals(terms);
    setKernelSessions(kernels);
  }, []);

  // Check for dead sessions
  const checkDeadSessions = useCallback(async (): Promise<DeadSession[] | null> => {
    try {
      const dead = await getDeadKernelSessions();
      setDeadSessions(dead);
      return dead;
    } catch {
      // Ignore errors - older servers might not have this endpoint
      return null;
    }
  }, []);

  // Cleanup dead sessions
  const handleCleanupDeadSessions = useCallback(async () => {
    setIsCleaningUp(true);
    setCleanupNotice(null);
    try {
      await cleanupDeadKernelSessions();
      const remaining = await checkDeadSessions();
      if (remaining && remaining.length > 0) {
        setCleanupNotice(
          `${remaining.length} kernel${remaining.length === 1 ? '' : 's'} could not be terminated. You may need to stop them manually.`
        );
      }
    } catch {
      // Ignore errors
    } finally {
      setIsCleaningUp(false);
    }
  }, [checkDeadSessions]);

  // Initial load
  useEffect(() => {
    const init = async () => {
      const cwd = await getServerCwd();
      setServerCwd(cwd);
      loadSessions();
      setRecentNotebooks(getRecentNotebooks());
      checkDeadSessions();
    };
    init();
  }, [loadSessions, checkDeadSessions]);

  // Poll sessions every 5 seconds
  useEffect(() => {
    const interval = setInterval(loadSessions, 5000);
    return () => clearInterval(interval);
  }, [loadSessions]);

  // Open a notebook
  const handleOpenNotebook = (path: string) => {
    const name = getFilename(path).replace('.ipynb', '');
    addRecentNotebook(path, name);
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

  // Create new notebook - handled by FileBrowser
  const handleNewNotebook = () => {
    // FileBrowser handles this, but we provide a header button too
    // We can trigger it by incrementing refresh which causes FileBrowser to re-render
    // Actually, clicking this should use the same prompt flow as FileBrowser
    const name = prompt('Enter notebook name:');
    if (name) {
      // Import and call createNotebook
      import('../services/fileService').then(({ createNotebook }) => {
        createNotebook(name, [{ id: `cell-${Date.now()}`, type: 'code', content: '', outputs: [] }], serverCwd)
          .then((notebook) => {
            window.open(`/?file=${encodeURIComponent(notebook.id)}`, '_blank');
            setRefreshCounter(c => c + 1);
          })
          .catch((err) => {
            alert(err.message || 'Failed to create notebook');
          });
      });
    }
  };

  // Tip navigation
  const nextTip = () => setTipIndex((i) => (i + 1) % TIPS.length);
  const prevTip = () => setTipIndex((i) => (i - 1 + TIPS.length) % TIPS.length);

  // Active notebooks (kernels with file paths)
  const activeNotebooks = kernelSessions.filter(s => s.file_path);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header - matches Notebook header style */}
      <header className="bg-slate-50/90 backdrop-blur border-b border-slate-200 px-4 py-3 sticky top-0 z-20">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            {/* Nebula logo */}
            <svg className="w-9 h-9" viewBox="0 0 32 32">
              <defs>
                <linearGradient id="nebula-logo-bg" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style={{ stopColor: '#8b5cf6' }} />
                  <stop offset="50%" style={{ stopColor: '#6366f1' }} />
                  <stop offset="100%" style={{ stopColor: '#3b82f6' }} />
                </linearGradient>
              </defs>
              <rect width="32" height="32" rx="6" fill="url(#nebula-logo-bg)" />
              <path d="M8 10h16M8 16h12M8 22h14" stroke="white" strokeWidth="2.5" strokeLinecap="round" />
            </svg>
            <div>
              <h1 className="text-lg font-bold text-slate-800">Nebula Notebook</h1>
              <p className="text-xs text-slate-500">AI-native Interactive Computing Environment</p>
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

      {/* Dead Sessions Cleanup Banner */}
      {deadSessions.length > 0 && !cleanupDismissed && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-4">
            <div className="flex items-center gap-3 text-sm text-amber-800">
              <AlertTriangle className="w-4 h-4 flex-shrink-0" />
              <div className="flex flex-col gap-0.5">
                <span>
                  Found <strong>{deadSessions.length}</strong> orphaned kernel session{deadSessions.length !== 1 ? 's' : ''} from a previous server run
                </span>
                {cleanupNotice && (
                  <span className="text-[0.6875rem] text-amber-700">{cleanupNotice}</span>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleCleanupDeadSessions}
                disabled={isCleaningUp}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded text-xs font-medium transition-colors disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                {isCleaningUp ? 'Cleaning...' : 'Clean Up'}
              </button>
              <button
                onClick={() => setCleanupDismissed(true)}
                className="p-1.5 text-amber-600 hover:bg-amber-100 rounded transition-colors"
                title="Dismiss"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-6xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 items-start lg:items-stretch">
          {/* File Browser + Resources - Takes 3 columns */}
          <div className="lg:col-span-3 space-y-4">
            <FileBrowser
              files={[]}
              currentFileId={null}
              onSelect={handleOpenNotebook}
              onRefresh={() => setRefreshCounter(c => c + 1)}
              variant="inline"
              initialPath={serverCwd}
              maxHeight="55vh"
            />
            {/* System Resources - aligned with file browser */}
            <ResourcePanel />
          </div>

          {/* Sidebar - fills vertical space */}
          <div className="flex flex-col gap-4">
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


            {/* Recently Opened */}
            {recentNotebooks.length > 0 && (
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                  <History className="w-4 h-4 text-slate-500" />
                  <h3 className="text-sm font-medium text-slate-700">Recently Opened</h3>
                </div>
                <div className="divide-y divide-slate-100 max-h-[9.375rem] overflow-y-auto">
                  {recentNotebooks.map((notebook) => (
                    <button
                      key={notebook.path}
                      onClick={() => handleOpenNotebook(notebook.path)}
                      className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-slate-50 text-left"
                    >
                      <Book className="w-4 h-4 text-orange-500 flex-shrink-0" />
                      <span className="text-sm text-slate-700 truncate">{notebook.name}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Active Notebooks */}
            <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
              <div className="px-4 py-3 border-b border-slate-100 flex items-center gap-2">
                <Book className="w-4 h-4 text-orange-500" />
                <h3 className="text-sm font-medium text-slate-700">Active Notebooks</h3>
              </div>
              <div className="divide-y divide-slate-100 max-h-[12.5rem] overflow-y-auto">
                {activeNotebooks.length === 0 ? (
                  <div className="px-4 py-4 text-center text-xs text-slate-400">
                    No active notebooks
                  </div>
                ) : (
                  activeNotebooks.map((session) => (
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
                  ))
                )}
              </div>
            </div>

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
              <div className="divide-y divide-slate-100 max-h-[12.5rem] overflow-y-auto">
                {terminals.length === 0 ? (
                  <div className="px-4 py-4 text-center text-xs text-slate-400">
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

            {/* Tips Carousel - pushed to bottom */}
            <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 mt-auto">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-amber-500" />
                  <span className="text-xs font-medium text-slate-700">Pro Tip</span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={prevTip}
                    className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600"
                    title="Previous tip"
                  >
                    <ChevronLeft className="w-4 h-4" />
                  </button>
                  <span className="text-[0.625rem] text-slate-400 w-8 text-center">
                    {tipIndex + 1}/{TIPS.length}
                  </span>
                  <button
                    onClick={nextTip}
                    className="p-1 hover:bg-slate-200 rounded text-slate-400 hover:text-slate-600"
                    title="Next tip"
                  >
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
              <div className="text-xs text-slate-600 min-h-[2.5rem]">
                {TIPS[tipIndex].text}
              </div>
            </div>
          </div>
        </div>
      </div>

    </div>
  );
};
