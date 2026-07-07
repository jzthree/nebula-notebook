/**
 * TerminalPanel - Single terminal per notebook
 *
 * Terminal is created lazily when first opened and closed when notebook changes.
 * This is better suited for agentic use where each notebook has its own terminal context.
 */

import React, { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';
import {
  Terminal,
  X,
  AlertCircle,
  Bot,
} from 'lucide-react';
import { TerminalInstance } from './TerminalInstance';
import {
  getOrCreateNamedTerminal,
  closeTerminal,
  getTerminalServerInfo,
  checkReverseTunnel,
  TerminalInfo,
} from '../services/terminalService';
import { agentTerminalService } from '../services/agentTerminalService';
import { getSettings, saveSettings, ensureRemoteAgentPort } from '../services/settingsService';
import { fetchEnvironment, serverIsRemote } from '../services/environmentService';
import { probeRemoteBins } from '../services/aiAutocompleteService';
import { RemoteAgentSetupModal } from './RemoteAgentSetupModal';

/**
 * Stable per-notebook terminal name, so a page refresh reattaches to the SAME
 * server-side pty (with scrollback replay and any running process — e.g. an
 * agent — intact) instead of leaking the old pty and creating a fresh one.
 * The server normalizes names to [a-z0-9_-] and caps at 32 chars, so we lead
 * with a short hash of the full path to keep distinct notebooks distinct.
 */
function terminalNameFor(notebookPath: string | null | undefined, role: 'shell' | 'agent'): string {
  const path = notebookPath || 'scratch';
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  const slug = (path.split('/').pop() || 'nb').replace(/\.ipynb$/i, '');
  return `nb-${hex}-${role}-${slug}`;
}

export type TerminalPanelTab = 'shell' | 'agent';

interface TerminalPanelProps {
  isOpen: boolean;
  onClose: () => void;
  notebookPath?: string | null; // Current notebook path for cwd
  defaultHeight?: number;
  /** Controlled tab (Notebook lifts this so toolbar buttons can target a tab). */
  activeTab?: TerminalPanelTab;
  onTabChange?: (tab: TerminalPanelTab) => void;
}

const MIN_HEIGHT = 100;
const MAX_HEIGHT = 800;
const DEFAULT_HEIGHT = 300;

export const TerminalPanel: React.FC<TerminalPanelProps> = ({
  isOpen,
  onClose,
  notebookPath,
  defaultHeight = DEFAULT_HEIGHT,
  activeTab,
  onTabChange,
}) => {
  const [height, setHeight] = useState(defaultHeight);
  // Two independent ptys per notebook: a plain shell, and the agent's terminal.
  // Keeping them separate preserves normal terminal use while an agent runs.
  const [shellTerm, setShellTerm] = useState<TerminalInfo | null>(null);
  const [agentTerm, setAgentTerm] = useState<TerminalInfo | null>(null);
  const [internalTab, setInternalTab] = useState<TerminalPanelTab>('shell');
  const tab = activeTab ?? internalTab;
  const setTab = onTabChange ?? setInternalTab;
  const [isResizing, setIsResizing] = useState(false);
  const [serverAvailable, setServerAvailable] = useState<boolean | null>(null);
  const [serverHostInfo, setServerHostInfo] = useState<{ hostname: string | null; port: number | null }>({ hostname: null, port: null });
  // Remote-agent mode: reverse channel status. null = not applicable / unknown.
  // ready = listener up AND nothing said "not ssh" (banner unknown counts as OK).
  const [reverseTunnel, setReverseTunnel] = useState<{ up: boolean; ssh: boolean | null } | null>(null);
  const reverseTunnelUp = reverseTunnel === null ? null : (reverseTunnel.up && reverseTunnel.ssh !== false);
  // Bumped when this panel changes agent settings, so remoteAgentCfg recomputes.
  const [, setSettingsNonce] = useState(0);
  // Is the Nebula server remote from the user? Only then does "run the agent on
  // this server vs. my machine" mean anything; on a local install the server IS
  // your machine, so the whole where-choice collapses away. Defaults to false
  // (local) until the environment is known.
  const [serverRemote, setServerRemote] = useState<boolean>(serverIsRemote());
  useEffect(() => { fetchEnvironment().then((env) => setServerRemote(serverIsRemote(env))); }, []);
  // Remote-agent setup dialog (connection details for the reverse channel).
  const [showRemoteSetup, setShowRemoteSetup] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (isOpen) setEverOpened(true);
  }, [isOpen]);

  const panelRef = useRef<HTMLDivElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const resizeRafRef = useRef<number | null>(null);
  const currentNotebookRef = useRef<string | null>(null);

  // Agent state: this panel's terminal doubles as the agent terminal.
  const agentState = useSyncExternalStore(
    useCallback((cb) => agentTerminalService.subscribe(cb), []),
    () => agentTerminalService.getState()
  );
  const agentConnected = useSyncExternalStore(
    useCallback((cb) => agentTerminalService.subscribe(cb), []),
    () => agentTerminalService.isConnected()
  );

  // Only the Agent tab's pty receives injected prompts — the shell stays a
  // plain terminal.
  useEffect(() => {
    agentTerminalService.setAgentTerminal(agentTerm?.id ?? null);
  }, [agentTerm]);

  // Close terminals when notebook changes
  useEffect(() => {
    const prevNotebook = currentNotebookRef.current;
    currentNotebookRef.current = notebookPath ?? null;

    if (prevNotebook && prevNotebook !== notebookPath) {
      if (shellTerm) {
        closeTerminal(shellTerm.id).catch(console.error);
        setShellTerm(null);
      }
      if (agentTerm) {
        agentTerminalService.markStopped(); // pty is being killed — clear persisted flag
        closeTerminal(agentTerm.id).catch(console.error);
        setAgentTerm(null);
      }
    }
  }, [notebookPath, shellTerm, agentTerm]);

  // Check server availability when panel opens (also learns the server's
  // Nebula repo path for the path-qualified MCP setup command, and its
  // hostname/port for the remote-agent tunnel command)
  useEffect(() => {
    if (!isOpen) return;

    const checkServer = async () => {
      const info = await getTerminalServerInfo();
      setServerAvailable(info.available);
      setServerHostInfo({ hostname: info.hostname, port: info.port });
      agentTerminalService.setRepoRoot(info.repoRoot);
    };

    checkServer();
  }, [isOpen]);

  // Remote-agent mode: watch whether the user's reverse SSH channel is up so
  // the launch chips can target their machine (or guide them to connect it).
  // Gate remote-agent mode on the server actually being remote: a local install
  // never shows tunnel UI or the "my machine" option (it IS your machine).
  const remoteAgentCfg = serverRemote ? agentTerminalService.getRemoteAgentConfig() : null;
  const remoteAgentPort = remoteAgentCfg?.port ?? null;
  useEffect(() => {
    if (!isOpen || tab !== 'agent' || !remoteAgentPort) {
      setReverseTunnel(null);
      return;
    }
    let stopped = false;
    const check = async () => {
      const status = await checkReverseTunnel(remoteAgentPort);
      if (!stopped) setReverseTunnel(status);
    };
    check();
    const interval = setInterval(check, 5000);
    return () => { stopped = true; clearInterval(interval); };
  }, [isOpen, tab, remoteAgentPort]);

  // Lazily create the active tab's terminal when the panel is open
  const activeTerm = tab === 'agent' ? agentTerm : shellTerm;
  useEffect(() => {
    if (!isOpen || !serverAvailable || activeTerm || isLoading) return;

    const createNewTerminal = async () => {
      setIsLoading(true);
      try {
        // Get cwd from notebook path (parent directory)
        let cwd: string | undefined;
        if (notebookPath) {
          const lastSlash = notebookPath.lastIndexOf('/');
          if (lastSlash > 0) {
            cwd = notebookPath.substring(0, lastSlash);
          }
        }

        // Named get-or-create: after a refresh this reattaches to the existing
        // pty (server replays scrollback) instead of spawning a new one.
        const newTerminal = await getOrCreateNamedTerminal(terminalNameFor(notebookPath, tab), { cwd });
        if (tab === 'agent') setAgentTerm(newTerminal);
        else setShellTerm(newTerminal);
      } catch (error) {
        console.error('[TerminalPanel] Failed to create terminal:', error);
      } finally {
        setIsLoading(false);
      }
    };

    createNewTerminal();
  }, [isOpen, serverAvailable, activeTerm, isLoading, notebookPath, tab]);

  // Handle terminal exit — clear so a new one can be created on demand
  const handleShellExit = useCallback((_code: number) => setShellTerm(null), []);
  const handleAgentExit = useCallback((_code: number) => {
    // The pty itself died, so the agent is definitively gone — clear the
    // persisted running flag before dropping the terminal designation.
    agentTerminalService.markStopped();
    setAgentTerm(null);
  }, []);

  // Trigger terminal resize (all mounted ptys; hidden ones no-op safely)
  const triggerTerminalResize = useCallback(() => {
    if (panelRef.current) {
      panelRef.current.querySelectorAll('[data-terminal-container]').forEach((container) => {
        if ((container as any).__terminalResize) {
          (container as any).__terminalResize();
        }
      });
    }
  }, []);

  const scheduleTerminalResize = useCallback(() => {
    if (resizeRafRef.current !== null) return;
    if (typeof window === 'undefined') return;
    resizeRafRef.current = window.requestAnimationFrame(() => {
      resizeRafRef.current = null;
      triggerTerminalResize();
    });
  }, [triggerTerminalResize]);

  // Trigger terminal resize when height changes (after React updates DOM)
  useEffect(() => {
    if (!isOpen) return;
    scheduleTerminalResize();
  }, [height, isOpen, scheduleTerminalResize]);

  // Resize handling
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);

    const startY = e.clientY;
    const startHeight = height;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const deltaY = startY - moveEvent.clientY;
      const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeight + deltaY));
      setHeight(newHeight);
      scheduleTerminalResize();
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      resizeCleanupRef.current = null;
      scheduleTerminalResize();
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    resizeCleanupRef.current = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [height, triggerTerminalResize]);

  // Cleanup resize listeners on unmount
  useEffect(() => {
    return () => {
      if (resizeCleanupRef.current) {
        resizeCleanupRef.current();
      }
      if (resizeRafRef.current !== null) {
        window.cancelAnimationFrame(resizeRafRef.current);
      }
    };
  }, []);

  // After the first open, stay mounted (hidden) when closed: the terminal
  // WebSockets stay alive, so a running agent keeps receiving injected
  // prompts and its status isn't lost on close/reopen.
  if (!isOpen && !everOpened) return null;

  // Get notebook name for display
  const notebookName = notebookPath
    ? notebookPath.split('/').pop()?.replace(/\.(ipynb|qmd)$/i, '') || 'Terminal'
    : 'Terminal';

  return (
    <div
      ref={panelRef}
      data-testid="terminal-panel"
      className={`flex-none flex flex-col bg-transparent overflow-hidden ${isOpen ? '' : 'hidden'}`}
      style={{ height: `${height}px` }}
    >
      {/* Resize Handle - transparent hit area, cursor indicates draggable */}
      <div
        data-testid="terminal-resize-handle"
        className="h-2 cursor-ns-resize flex-shrink-0 bg-slate-200/30 hover:bg-slate-300/50 transition-colors"
        onMouseDown={handleResizeStart}
      />

      {/* Compact Header — Shell / Agent tabs; empty area click closes */}
      <div
        className="flex items-center justify-between px-2 py-0.5 bg-slate-100 border-b border-slate-200 flex-shrink-0 cursor-pointer hover:bg-slate-200 transition-colors"
        onClick={onClose}
      >
        <div className="flex items-center gap-1 text-xs font-medium text-slate-600">
          <button
            onClick={(e) => { e.stopPropagation(); setTab('shell'); }}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
              tab === 'shell' ? 'bg-white shadow-sm text-slate-800' : 'text-slate-500 hover:text-slate-700'
            }`}
            title={`Plain terminal for ${notebookName}`}
          >
            <Terminal className="w-3 h-3" />
            <span>{notebookName}</span>
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); setTab('agent'); }}
            className={`flex items-center gap-1.5 px-2 py-0.5 rounded transition-colors ${
              tab === 'agent' ? 'bg-white shadow-sm text-purple-700' : 'text-slate-500 hover:text-purple-600'
            }`}
            title="Agent terminal — Claude Code / Codex driving this notebook"
          >
            <Bot className="w-3 h-3" />
            <span>Agent</span>
            {agentState.status === 'running' && <span className="w-1.5 h-1.5 rounded-full bg-green-500"></span>}
          </button>
        </div>
        <button
          onClick={onClose}
          className="p-0.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded transition-colors"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Remote-agent tunnel guide — reverse channel not connected yet */}
      {tab === 'agent' && agentTerm && agentState.status !== 'running' && remoteAgentCfg && reverseTunnelUp === false && (
        <div className="flex items-center gap-2 px-2 py-1 bg-amber-50 border-b border-amber-200 flex-shrink-0 text-xs">
          <Bot className="w-3.5 h-3.5 text-amber-600 flex-shrink-0" />
          <span className="text-amber-800 font-medium flex-shrink-0">
            {reverseTunnel?.up && reverseTunnel.ssh === false
              ? <>Tunnel is up, but nothing answered SSH on your machine — enable Remote Login (macOS: System Settings → Sharing).</>
              : <>Waiting for your machine (reverse port {remoteAgentCfg.port}) — connect the tunnel:</>}
          </span>
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(agentTerminalService.buildBurrowCommand(serverHostInfo.hostname, serverHostInfo.port)); } catch { /* clipboard optional */ }
            }}
            className="px-1.5 py-0.5 rounded bg-amber-600 text-white font-medium hover:bg-amber-700 flex-shrink-0"
            title={`Using Burrow (recommended — supervised, auto-reconnect): run once on your machine, then connect from the menu bar.\n${agentTerminalService.buildBurrowCommand(serverHostInfo.hostname, serverHostInfo.port)}`}
          >
            copy Burrow command
          </button>
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(agentTerminalService.buildTunnelCommand(serverHostInfo.hostname, serverHostInfo.port)); } catch { /* clipboard optional */ }
          }}
            className="text-amber-700 hover:text-amber-900 underline decoration-dotted flex-shrink-0"
            title={`Plain ssh alternative (replaces your usual port-forward):\n${agentTerminalService.buildTunnelCommand(serverHostInfo.hostname, serverHostInfo.port)}`}
          >
            copy ssh command
          </button>
          <button
            onClick={() => setShowRemoteSetup(true)}
            className="text-amber-700 hover:text-amber-900 underline decoration-dotted flex-shrink-0"
            title="Ports, username, jump host, and the full setup guide"
          >
            setup…
          </button>
          <span className="ml-auto text-amber-500 flex-shrink-0 hidden sm:inline">auto-detects · rechecking every 5s</span>
          <button
            onClick={() => { saveSettings({ remoteAgentEnabled: false }); setSettingsNonce(n => n + 1); }}
            className="text-amber-600 hover:text-amber-800 underline decoration-dotted flex-shrink-0"
            title="Run the agent on this server instead"
          >
            use this server
          </button>
        </div>
      )}

      {/* Agent guidance bar — the on-ramp for driving the notebook with an agent */}
      {tab === 'agent' && agentTerm && agentState.status !== 'running' && !(remoteAgentCfg && reverseTunnelUp === false) && (
        <div className="flex items-center gap-2 px-2 py-1 bg-purple-50 border-b border-purple-100 flex-shrink-0 text-xs">
          <Bot className="w-3.5 h-3.5 text-purple-600 flex-shrink-0" />
          <span className="text-purple-800 font-medium truncate">
            Drive <span className="font-semibold">{notebookName}</span> with
          </span>
          {agentTerminalService.getResumableKind() === 'claude' && (
            <button
              onClick={() => agentTerminalService.launchAgent('claude', { resume: true })}
              disabled={!agentConnected}
              className="px-2 py-0.5 rounded bg-purple-700 text-white font-medium hover:bg-purple-800 disabled:opacity-40 transition-colors"
              title="claude --continue: reopen the previous conversation in this notebook's directory and keep going"
            >
              ⟳ Resume Claude
            </button>
          )}
          <button
            onClick={() => agentTerminalService.launchAgent('claude')}
            disabled={!agentConnected}
            className="px-2 py-0.5 rounded bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-40 transition-colors"
            title={remoteAgentCfg ? 'Start Claude Code on YOUR machine (over the reverse tunnel) and drive this notebook' : 'Type `claude` into this terminal and start driving the notebook'}
          >
            Claude Code
          </button>
          <button
            onClick={() => agentTerminalService.launchAgent('codex')}
            disabled={!agentConnected}
            className="px-2 py-0.5 rounded bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-40 transition-colors"
            title={remoteAgentCfg ? 'Start Codex on YOUR machine (over the reverse tunnel) and drive this notebook' : 'Type `codex` into this terminal and start driving the notebook'}
          >
            Codex
          </button>
          {/* Where the agent runs is only a question when the server is remote.
              On a local install the server IS your machine — no selector. */}
          {serverRemote && (
            <>
              <span className="text-purple-600 flex-shrink-0">on</span>
              <select
                value={remoteAgentCfg ? 'mine' : 'server'}
                onChange={(e) => {
                  if (e.target.value === 'mine') {
                    const s = getSettings();
                    const port = s.remoteAgentPort ?? ensureRemoteAgentPort();
                    // One where-choice drives BOTH the agent terminal and
                    // autocomplete: agentRunsOn is what the autocomplete transport
                    // reads (see aiAutocompleteService).
                    saveSettings({ remoteAgentEnabled: true, remoteAgentPort: port, agentRunsOn: 'mine' });
                    // Missing username → the mode can't compose the ssh-back line;
                    // open the setup dialog to finish configuration.
                    if (!s.remoteAgentUser?.trim()) setShowRemoteSetup(true);
                    else probeRemoteBins(); // discover the user's claude/codex for autocomplete
                  } else {
                    saveSettings({ remoteAgentEnabled: false, agentRunsOn: 'server' });
                  }
                  setSettingsNonce(n => n + 1);
                }}
                className="px-1 py-0.5 rounded border border-purple-300 bg-white text-purple-800 font-medium cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-400"
                title="Where the agent process runs. 'my machine' hops back over your SSH tunnel — the agent uses your computer's memory and network but lives in this panel."
              >
                <option value="server">This server</option>
                <option value="mine">Local machine</option>
              </select>
            </>
          )}
          {remoteAgentCfg && reverseTunnelUp && (
            <button
              onClick={() => setShowRemoteSetup(true)}
              className="text-green-600 hover:text-green-800 flex-shrink-0"
              title={`Reverse tunnel connected (port ${remoteAgentCfg.port}) — click for setup details`}
            >
              ✓ tunnel
            </button>
          )}
          <button
            onClick={async () => {
              try { await navigator.clipboard.writeText(agentTerminalService.buildSetupMcpCommand()); } catch { /* clipboard optional */ }
            }}
            className="text-purple-400 hover:text-purple-600 hidden sm:inline underline decoration-dotted"
            title={`Requires the Nebula MCP. Click to copy the setup command:\n${agentTerminalService.buildSetupMcpCommand()}`}
          >
            needs Nebula MCP? copy setup command
          </button>
          <span className="ml-auto flex items-center gap-2 flex-shrink-0">
            <button
              onClick={async () => {
                try { await navigator.clipboard.writeText(agentTerminalService.buildBootstrapPrompt()); } catch { /* clipboard optional */ }
              }}
              className="text-purple-500 hover:text-purple-700 underline decoration-dotted"
              title="Copy the orientation prompt (server URL + notebook) to paste into a Claude Code / Codex session running anywhere — e.g. your own terminal on another machine"
            >
              copy context
            </button>
            <button
              onClick={() => agentTerminalService.markRunning()}
              className="text-purple-500 hover:text-purple-700 underline decoration-dotted"
              title="I already started an agent in this terminal myself"
            >
              already running
            </button>
          </span>
        </div>
      )}
      {tab === 'agent' && agentTerm && agentState.status === 'running' && (
        agentConnected ? (
          <div className="flex items-center gap-2 px-2 py-1 bg-green-50 border-b border-green-100 flex-shrink-0 text-xs">
            <span className="w-2 h-2 rounded-full bg-green-500 flex-shrink-0"></span>
            <span className="text-green-800 truncate">
              Agent active{agentState.agentKind && agentState.agentKind !== 'manual' ? ` (${agentState.agentKind})` : ''} · driving <span className="font-semibold">{notebookName}</span> — type instructions here, or use “Fix with agent” on a failing cell
            </span>
            <button
              onClick={() => agentTerminalService.markStopped()}
              className="ml-auto text-green-600 hover:text-green-800 underline decoration-dotted flex-shrink-0"
              title="The agent exited — show launch options again"
            >
              agent exited?
            </button>
          </div>
        ) : (
          // Connection to the pty dropped (network blip / tunnel flap). The
          // agent keeps running server-side; the terminal auto-reconnects.
          <div className="flex items-center gap-2 px-2 py-1 bg-amber-50 border-b border-amber-100 flex-shrink-0 text-xs">
            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse flex-shrink-0"></span>
            <span className="text-amber-800 truncate">
              Connection lost — reconnecting to the agent terminal… the agent keeps running; prompts resume when reconnected
            </span>
            <button
              onClick={() => agentTerminalService.markStopped()}
              className="ml-auto text-amber-600 hover:text-amber-800 underline decoration-dotted flex-shrink-0"
              title="Give up on this agent session — show launch options again"
            >
              reset
            </button>
          </div>
        )
      )}

      {/* Terminal Content */}
      <div className="flex-1 min-h-0 relative bg-slate-50">
        {serverAvailable === false && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <AlertCircle className="w-8 h-8 mx-auto mb-2 text-amber-500" />
              <p className="text-sm font-medium">Terminal server not available</p>
              <p className="text-xs mt-1">
                Run <code className="bg-slate-200 px-1.5 py-0.5 rounded">npm run terminal</code> to start
              </p>
            </div>
          </div>
        )}

        {serverAvailable && !activeTerm && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <Terminal className="w-8 h-8 mx-auto mb-2" />
              <p className="text-sm">Creating {tab === 'agent' ? 'agent ' : ''}terminal...</p>
            </div>
          </div>
        )}

        {/* Both ptys stay mounted once created; tabs just switch visibility */}
        {shellTerm && (
          <div data-terminal-container className={`absolute inset-0 ${tab === 'shell' ? '' : 'hidden'}`}>
            <TerminalInstance
              terminalId={shellTerm.id}
              isActive={tab === 'shell'}
              onExit={handleShellExit}
            />
          </div>
        )}
        {agentTerm && (
          <div data-terminal-container className={`absolute inset-0 ${tab === 'agent' ? '' : 'hidden'}`}>
            <TerminalInstance
              terminalId={agentTerm.id}
              isActive={tab === 'agent'}
              onExit={handleAgentExit}
            />
          </div>
        )}
      </div>

      {showRemoteSetup && (
        <RemoteAgentSetupModal
          onClose={() => { setShowRemoteSetup(false); setSettingsNonce(n => n + 1); }}
        />
      )}
    </div>
  );
};
