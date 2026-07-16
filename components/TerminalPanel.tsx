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
  listTerminals,
  getTerminalServerInfo,
  checkReverseTunnel,
  TerminalInfo,
} from '../services/terminalService';
import { agentTerminalService } from '../services/agentTerminalService';
import { useNotification } from './NotificationSystem';
import { getSettings, saveSettings, ensureRemoteAgentPort } from '../services/settingsService';
import { fetchEnvironment, serverIsRemote } from '../services/environmentService';
import { probeRemoteBins } from '../services/aiAutocompleteService';
import { RemoteAgentSetupModal } from './RemoteAgentSetupModal';
import {
  AgentRecord, agentTerminalNameFor, deleteAgent, getActiveAgentId,
  hibernateAgent, listAgents, notebookDirOf, registerAgent, setActiveAgentId,
} from '../services/agentRegistryService';

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

/**
 * Mirror of the server's terminal-name → id normalization (pty-manager), so we
 * can recognize this notebook's surviving ptys in the terminal list after a
 * refresh without a per-name round trip.
 */
function normalizeTerminalName(name: string): string {
  const normalized = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 32);
  return normalized || 'default';
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
  // Delayed visibility for the "opening terminal" overlay: after a refresh the
  // panel almost always REATTACHES to the surviving pty (not create a new one),
  // and a fast reattach shouldn't flash a "Creating…" spinner.
  const [showPendingOverlay, setShowPendingOverlay] = useState(false);
  const [everOpened, setEverOpened] = useState(false);
  useEffect(() => {
    if (isOpen) setEverOpened(true);
  }, [isOpen]);

  // ---- Project-scoped agents (decoupled from notebooks) ----
  // The Agent tab attaches to the browser's ACTIVE agent wherever it lives;
  // notebooks never auto-switch it. No active agent -> a fresh one scoped to
  // this notebook's directory (workdir editable before launch).
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [activeAgentId, setActiveAgent] = useState<string | null>(() => getActiveAgentId());
  const [workdirOverride, setWorkdirOverride] = useState<string | null>(null);
  const [showAgentManager, setShowAgentManager] = useState(false);
  const [showWorkdirMenu, setShowWorkdirMenu] = useState(false);
  const { promptText } = useNotification();
  const notebookDir = notebookDirOf(notebookPath);
  const agentWorkdir = workdirOverride ?? notebookDir ?? '~';
  const activeAgentRecord = activeAgentId ? agents.find((a) => a.terminalId === activeAgentId) ?? null : null;

  const refreshAgents = useCallback(async () => {
    setAgents(await listAgents());
  }, []);
  useEffect(() => {
    if (!isOpen || tab !== 'agent') return;
    refreshAgents();
  }, [isOpen, tab, refreshAgents]);

  const selectAgent = useCallback((id: string | null) => {
    setActiveAgentId(id);
    setActiveAgent(id);
    setAgentTerm(null); // re-resolve the pty to the newly selected agent
  }, []);

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

  // On notebook switch, DETACH from the old notebook's shell (each notebook
  // keeps its own persistent shell pty under a stable name) but NEVER touch
  // the agent: agents are project-scoped and the user decides when to switch
  // them (agent manager / "new agent here" chip). With an active agent the
  // same pty stays attached across notebooks — that's the point. Without one,
  // re-resolve so the launch card targets the new notebook's directory.
  useEffect(() => {
    const prevNotebook = currentNotebookRef.current;
    currentNotebookRef.current = notebookPath ?? null;
    if (prevNotebook && prevNotebook !== notebookPath) {
      setShellTerm(null);
      setWorkdirOverride(null);
      if (!getActiveAgentId()) setAgentTerm(null);
    }
  }, [notebookPath]);

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
  const pendingTerm = isOpen && serverAvailable === true && !activeTerm;
  useEffect(() => {
    if (!pendingTerm) { setShowPendingOverlay(false); return; }
    const t = setTimeout(() => setShowPendingOverlay(true), 250);
    return () => clearTimeout(t);
  }, [pendingTerm]);
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
        // Shell: per-notebook. Agent: the ACTIVE agent's pty wherever it
        // lives, else a fresh pty scoped to the chosen workdir.
        if (tab === 'agent') {
          const active = getActiveAgentId();
          const record = active ? (await listAgents()).find((a) => a.terminalId === active) : null;
          const name = record ? record.terminalId : agentTerminalNameFor(agentWorkdir);
          const agentCwd = record ? record.workdir : agentWorkdir;
          const newTerminal = await getOrCreateNamedTerminal(name, { cwd: agentCwd });
          // Hand this browser the resume pointer recorded server-side, so
          // "Resume" works even if the agent was launched from another browser.
          if (record?.sessionId) agentTerminalService.adoptSessionId(newTerminal.id, record.sessionId);
          setAgentTerm(newTerminal);
        } else {
          const newTerminal = await getOrCreateNamedTerminal(terminalNameFor(notebookPath, tab), { cwd });
          setShellTerm(newTerminal);
        }
      } catch (error) {
        console.error('[TerminalPanel] Failed to create terminal:', error);
      } finally {
        setIsLoading(false);
      }
    };

    createNewTerminal();
  }, [isOpen, serverAvailable, activeTerm, isLoading, notebookPath, tab, agentWorkdir]);

  // After a refresh (or switching back to a notebook), reattach BOTH of this
  // notebook's surviving ptys eagerly — not just the visible tab's. Reattachment
  // used to be lazy (on tab switch), which is invisible on a local server but on
  // a remote one puts the whole create→WS→replay round trip at the moment you
  // switch tabs ("Opening terminal…", then a settle delay). Only ptys that
  // already exist server-side are reattached; nothing is created eagerly, so
  // never-opened tabs still cost nothing.
  const eagerReattachKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isOpen || !serverAvailable) return;
    const key = notebookPath ?? 'scratch';
    if (eagerReattachKeyRef.current === key) return;
    eagerReattachKeyRef.current = key;
    let cancelled = false;
    (async () => {
      try {
        const existing = new Set((await listTerminals()).map((t) => t.id));
        const shellName = terminalNameFor(notebookPath, 'shell');
        if (existing.has(normalizeTerminalName(shellName))) {
          const info = await getOrCreateNamedTerminal(shellName, {});
          if (cancelled) return;
          // Keep whichever instance the lazy path may have set in the meantime.
          setShellTerm((prev) => prev ?? info);
        }
        // Agent: reattach the active agent's pty if it survived (project-
        // scoped — same pty regardless of which notebook we're in).
        const active = getActiveAgentId();
        const agentName = active ?? agentTerminalNameFor(agentWorkdir);
        if (existing.has(normalizeTerminalName(agentName))) {
          const info = await getOrCreateNamedTerminal(agentName, {});
          if (cancelled) return;
          setAgentTerm((prev) => prev ?? info);
        }
      } catch { /* best-effort: the lazy path still covers the active tab */ }
    })();
    return () => { cancelled = true; };
  }, [isOpen, serverAvailable, notebookPath]);

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
          {tab === 'agent' && (
            <button
              onClick={(e) => { e.stopPropagation(); setShowAgentManager((v) => !v); refreshAgents(); }}
              className={`px-1.5 py-0.5 rounded transition-colors text-[0.6875rem] ${showAgentManager ? 'bg-white shadow-sm text-purple-700' : 'text-slate-400 hover:text-purple-600'}`}
              title="Agent manager — every agent on this server, live or hibernated. Agents persist until YOU hibernate or delete them."
            >
              {agents.filter((a) => a.state === 'live').length > 0
                ? `agents (${agents.filter((a) => a.state === 'live').length})`
                : 'agents'}
            </button>
          )}
        </div>
        <button
          onClick={onClose}
          className="p-0.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded transition-colors"
          title="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Agent manager — the ledger of agents; nothing here is auto-killed */}
      {tab === 'agent' && showAgentManager && (
        <div className="border-b border-slate-200 bg-slate-50 flex-shrink-0 max-h-40 overflow-y-auto text-xs">
          {agents.length === 0 ? (
            <div className="px-3 py-2 text-slate-400">No agents yet — launch one below. Agents persist (hibernated ones can be revived) until you delete them.</div>
          ) : (
            agents.map((a) => {
              const isActive = a.terminalId === activeAgentId;
              const dirName = a.workdir.split('/').pop() || a.workdir;
              return (
                <div key={a.terminalId} className={`flex items-center gap-2 px-3 py-1 border-b border-slate-100 last:border-b-0 ${isActive ? 'bg-purple-50' : ''}`}>
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.state === 'live' ? 'bg-green-500' : 'bg-slate-300'}`} title={a.state} />
                  <span className="font-medium text-slate-700 flex-shrink-0">{a.kind}</span>
                  <span className="text-slate-500 truncate" title={a.workdir}>{dirName}</span>
                  {a.location === 'remote' && <span className="px-1 rounded bg-blue-100 text-blue-700 text-[0.625rem] flex-shrink-0">your machine</span>}
                  {isActive && <span className="px-1 rounded bg-purple-100 text-purple-700 text-[0.625rem] flex-shrink-0">attached</span>}
                  <span className="flex-1" />
                  {!isActive && (
                    <button
                      onClick={() => { selectAgent(a.terminalId); setShowAgentManager(false); }}
                      className="px-1.5 py-0.5 rounded border border-purple-200 bg-white text-purple-700 hover:bg-purple-100 flex-shrink-0"
                      title={a.state === 'live' ? 'Attach this tab to the running agent' : 'Attach — then use Resume to revive the conversation'}
                    >
                      {a.state === 'live' ? 'attach' : 'revive…'}
                    </button>
                  )}
                  {a.state === 'live' && (
                    <button
                      onClick={async () => { await hibernateAgent(a.terminalId); if (isActive) selectAgent(null); refreshAgents(); }}
                      className="px-1.5 py-0.5 rounded border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 flex-shrink-0"
                      title="Stop the process but keep the conversation on disk — revive it any time with Resume"
                    >
                      hibernate
                    </button>
                  )}
                  <button
                    onClick={async () => { await deleteAgent(a.terminalId); if (isActive) selectAgent(null); refreshAgents(); }}
                    className="px-1.5 py-0.5 rounded border border-red-100 bg-white text-red-500 hover:bg-red-50 flex-shrink-0"
                    title="Kill the process and forget this agent (its CLI transcript remains on disk)"
                  >
                    delete
                  </button>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Working elsewhere chip — the agent follows YOU, not the notebook.
          Only offer (never force) a project-local agent when dirs differ. */}
      {tab === 'agent' && !showAgentManager && activeAgentRecord && notebookDir && activeAgentRecord.workdir !== notebookDir && (
        <div className="flex items-center gap-2 px-2 py-1 bg-indigo-50 border-b border-indigo-100 flex-shrink-0 text-xs">
          <Bot className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
          <span className="text-indigo-800 truncate">
            This agent works in <span className="font-mono" title={activeAgentRecord.workdir}>{activeAgentRecord.workdir.split('/').pop()}</span> — this notebook lives elsewhere. It can still read and edit it.
          </span>
          <span className="flex-1" />
          <button
            onClick={() => { selectAgent(null); setWorkdirOverride(null); }}
            className="px-1.5 py-0.5 rounded border border-indigo-200 bg-white text-indigo-700 hover:bg-indigo-100 flex-shrink-0"
            title="Detach and set up a fresh agent scoped to this notebook's directory (the current agent keeps running — find it under agents)"
          >
            new agent here
          </button>
        </div>
      )}

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

      {/* Launch failed — show the shell error, keep the launch buttons for retry */}
      {tab === 'agent' && agentTerm && agentState.status === 'failed' && (
        <div className="flex items-start gap-2 px-2 py-1 bg-red-50 border-b border-red-100 flex-shrink-0 text-xs text-red-700">
          <span className="flex-shrink-0">⚠</span>
          <span className="min-w-0">
            Agent didn’t start: <span className="font-mono break-all">{agentState.launchError || 'unknown error'}</span>
            {/(not found|not recognized|no such file|permission denied|cannot execute)/i.test(agentState.launchError || '') && (
              <> — check it’s installed{remoteAgentCfg ? ' on your machine' : ' on this server'} and on PATH, then try again.</>
            )}
          </span>
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
              onClick={() => agentTerminalService.launchAgent('claude', { resume: true, workdir: agentWorkdir })}
              disabled={!agentConnected}
              className="px-2 py-0.5 rounded bg-purple-700 text-white font-medium hover:bg-purple-800 disabled:opacity-40 transition-colors"
              title="Resume this agent's own conversation (claude --resume) and keep going"
            >
              ⟳ Resume Claude
            </button>
          )}
          <button
            onClick={() => agentTerminalService.launchAgent('claude', { workdir: agentWorkdir })}
            disabled={!agentConnected}
            className="px-2 py-0.5 rounded bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-40 transition-colors"
            title={remoteAgentCfg ? 'Start Claude Code on YOUR machine (over the reverse tunnel) and drive this notebook' : 'Type `claude` into this terminal and start driving the notebook'}
          >
            Claude Code
          </button>
          <button
            onClick={() => agentTerminalService.launchAgent('codex', { workdir: agentWorkdir })}
            disabled={!agentConnected}
            className="px-2 py-0.5 rounded bg-purple-600 text-white font-medium hover:bg-purple-700 disabled:opacity-40 transition-colors"
            title={remoteAgentCfg ? 'Start Codex on YOUR machine (over the reverse tunnel) and drive this notebook' : 'Type `codex` into this terminal and start driving the notebook'}
          >
            Codex
          </button>
          <button
            onClick={() => agentTerminalService.launchAgent(agentState.agentKind === 'codex' ? 'codex' : 'claude', { continueProject: true, workdir: agentWorkdir })}
            disabled={!agentConnected}
            className="px-2 py-0.5 rounded border border-purple-300 bg-white text-purple-700 font-medium hover:bg-purple-100 disabled:opacity-40 transition-colors"
            title={'Pick up an existing conversation from this project directory — including ones you started outside Nebula (claude --continue / codex resume)'}
          >
            Continue project…
          </button>
          <div className="relative flex-shrink-0">
            <button
              onClick={() => setShowWorkdirMenu((v) => !v)}
              className="px-1.5 py-0.5 rounded border border-purple-200 bg-white text-purple-700 hover:bg-purple-100 font-mono max-w-[10rem] truncate"
              title={`Project scope: ${agentWorkdir}${remoteAgentCfg ? ' (mirrored into ~/.nebula/agent on your machine)' : ''} — click to change`}
            >
              in {agentWorkdir.split('/').pop() || agentWorkdir} ▾
            </button>
            {showWorkdirMenu && (
              <div className="absolute bottom-full mb-1 left-0 z-20 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[14rem] max-w-[22rem] text-xs">
                <div className="px-3 py-1 text-[0.625rem] uppercase tracking-wide text-slate-400">Agent project folder</div>
                {notebookDir && (
                  <button
                    onClick={() => { setWorkdirOverride(null); setShowWorkdirMenu(false); if (!getActiveAgentId()) setAgentTerm(null); }}
                    className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentWorkdir === notebookDir ? 'text-purple-700 font-medium' : 'text-slate-700'}`}
                  >
                    <div>This notebook’s folder{agentWorkdir === notebookDir ? ' ✓' : ''}</div>
                    <div className="font-mono text-slate-400 truncate">{notebookDir}</div>
                  </button>
                )}
                {[...new Set(agents.map((a) => a.workdir))]
                  .filter((d) => d && d !== notebookDir)
                  .slice(0, 6)
                  .map((d) => (
                    <button
                      key={d}
                      onClick={() => { setWorkdirOverride(d); setShowWorkdirMenu(false); if (!getActiveAgentId()) setAgentTerm(null); }}
                      className={`w-full text-left px-3 py-1 hover:bg-purple-50 ${agentWorkdir === d ? 'text-purple-700 font-medium' : 'text-slate-700'}`}
                    >
                      <div>{d.split('/').pop()}{agentWorkdir === d ? ' ✓' : ''} <span className="text-slate-400">(existing agent)</span></div>
                      <div className="font-mono text-slate-400 truncate">{d}</div>
                    </button>
                  ))}
                <button
                  onClick={async () => {
                    setShowWorkdirMenu(false);
                    const dir = await promptText({
                      title: 'Agent project folder',
                      message: remoteAgentCfg
                        ? 'Server path that defines this agent’s project scope (the agent itself runs in a mirrored folder on your machine).'
                        : 'Directory the agent will run in — its project scope.',
                      placeholder: notebookDir || '/path/to/project',
                      defaultValue: agentWorkdir,
                      confirmLabel: 'Use folder',
                    });
                    if (dir) { setWorkdirOverride(dir); if (!getActiveAgentId()) setAgentTerm(null); }
                  }}
                  className="w-full text-left px-3 py-1 text-slate-700 hover:bg-purple-50 border-t border-slate-100"
                >
                  Other folder…
                </button>
              </div>
            )}
          </div>
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
              try { await navigator.clipboard.writeText(agentTerminalService.buildSetupSkillCommand()); } catch { /* clipboard optional */ }
            }}
            className="text-purple-400 hover:text-purple-600 hidden sm:inline underline decoration-dotted"
            title={`Drive Nebula from an agent on another machine. Recommended — the nebula CLI as a Claude Code skill (lighter than MCP, per-notebook, no server process). Click to copy:\n${agentTerminalService.buildSetupSkillCommand()}\n\nPrefer MCP? ${agentTerminalService.buildSetupMcpCommand()}`}
          >
            agent on another machine? copy CLI skill setup
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

        {showPendingOverlay && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-50">
            <div className="text-center text-slate-500">
              <Terminal className="w-8 h-8 mx-auto mb-2" />
              <p className="text-sm">Opening {tab === 'agent' ? 'agent ' : ''}terminal…</p>
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
