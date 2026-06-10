/**
 * Agent Terminal Service
 *
 * Bridges notebook UI affordances ("Fix with agent", per-cell prompts) to an
 * agentic CLI (Claude Code / Codex) running inside the notebook's terminal.
 *
 * Design notes (robustness):
 * - Prompts are injected into the terminal pty via the SAME WebSocket the
 *   terminal UI already uses (`{type:'input'}` messages), so there is no new
 *   backend surface and the user sees exactly what was sent.
 * - We never inject a prompt unless an agent CLI was explicitly launched (or
 *   the user marked it running). Injecting into a bare shell would execute the
 *   prompt as a shell command.
 * - Prompts are collapsed to a single line: raw newlines in pty stdin would
 *   submit a TUI prompt early. The text is written first, then Enter ("\r")
 *   after a short delay, which matches how interactive TUIs expect input.
 * - All failures return a typed reason so the UI can guide the user instead of
 *   failing silently.
 */

export type AgentStatus = 'none' | 'running';
export type AgentKind = 'claude' | 'codex' | 'manual';

export interface SendResult {
  ok: boolean;
  reason?: 'no-terminal' | 'not-connected' | 'agent-not-running';
}

type Sender = (data: string) => boolean;

interface AgentState {
  terminalId: string | null;
  status: AgentStatus;
  agentKind: AgentKind | null;
}

const ENTER_DELAY_MS = 150;
const MAX_ERROR_EXCERPT_CHARS = 280;

// Persisted "agent launched" flag, keyed by terminal id. Terminal ids are
// stable (named per notebook), so after a page refresh reattaches to the same
// pty we can restore agent status instead of asking the user to relaunch.
// sessionStorage scope: survives refresh, not shared across browser tabs.
const AGENT_FLAG_PREFIX = 'nebula-agent-running:';

function readAgentFlag(terminalId: string): AgentKind | null {
  try {
    const v = window.sessionStorage.getItem(AGENT_FLAG_PREFIX + terminalId);
    return v === 'claude' || v === 'codex' || v === 'manual' ? v : null;
  } catch { return null; }
}

function writeAgentFlag(terminalId: string, kind: AgentKind | null): void {
  try {
    if (kind) window.sessionStorage.setItem(AGENT_FLAG_PREFIX + terminalId, kind);
    else window.sessionStorage.removeItem(AGENT_FLAG_PREFIX + terminalId);
  } catch { /* storage unavailable — degrade to in-memory only */ }
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

class AgentTerminalService {
  private senders = new Map<string, Sender>();
  private state: AgentState = { terminalId: null, status: 'none', agentKind: null };
  private listeners = new Set<() => void>();
  private panelOpener: (() => void) | null = null;
  private notebookPath: string | null = null;
  private serverBaseUrl: string | null = null;
  private repoRoot: string | null = null;

  // --- registration (called by TerminalInstance / TerminalPanel / Notebook) ---

  registerSender(terminalId: string, sender: Sender): void {
    this.senders.set(terminalId, sender);
    // Reconnection to the designated agent terminal (panel reopened, page
    // refreshed): the pty — and any agent in it — survived, so restore the
    // persisted status. setAgentTerminal can't do this when the id is
    // unchanged (it early-returns).
    if (terminalId === this.state.terminalId && this.state.status === 'none') {
      const restored = readAgentFlag(terminalId);
      if (restored) {
        this.state = { ...this.state, status: 'running', agentKind: restored };
      }
    }
    this.notify();
  }

  unregisterSender(terminalId: string): void {
    this.senders.delete(terminalId);
    // The pty connection is gone; any launched agent went with it.
    if (this.state.terminalId === terminalId && this.state.status === 'running') {
      this.state = { ...this.state, status: 'none', agentKind: null };
    }
    this.notify();
  }

  /** Designate which terminal is the agent terminal (the notebook panel's). */
  setAgentTerminal(terminalId: string | null): void {
    if (this.state.terminalId === terminalId) return;
    // Restore agent status across page refreshes: the named pty survives the
    // reload, so an agent launched before the refresh is still running in it.
    const restored = terminalId ? readAgentFlag(terminalId) : null;
    this.state = restored
      ? { terminalId, status: 'running', agentKind: restored }
      : { terminalId, status: 'none', agentKind: null };
    this.notify();
  }

  setPanelOpener(opener: (() => void) | null): void {
    this.panelOpener = opener;
  }

  setNotebookContext(path: string | null): void {
    this.notebookPath = path;
  }

  /**
   * Base URL the agent should pass to the MCP's connect_server. The agent CLI
   * runs in a pty ON the server machine, so http://localhost:<server-port> is
   * correct in every topology — browser-visible hostnames or SSH-tunnel ports
   * would be wrong from the pty's perspective.
   */
  setServerContext(baseUrl: string | null): void {
    this.serverBaseUrl = baseUrl;
  }

  /** Nebula repo location on the server, for a path-qualified setup command. */
  setRepoRoot(repoRoot: string | null): void {
    this.repoRoot = repoRoot;
  }

  /**
   * Exact command that registers the Nebula MCP with the agent CLIs. Users
   * don't know `npm run setup-mcp` must run from the Nebula repo, so qualify
   * it with the repo path when the server has told us where that is.
   */
  buildSetupMcpCommand(): string {
    return this.repoRoot
      ? `cd ${shellSingleQuote(this.repoRoot)} && npm run setup-mcp`
      : 'npm run setup-mcp  # run from your Nebula repo';
  }

  /**
   * Orientation prompt handed to a freshly started agent: which server to
   * connect_server to (the MCP intentionally ignores env config and requires
   * an explicit base_url per session) and which notebook this tab is driving.
   */
  buildBootstrapPrompt(): string {
    const parts: string[] = ['You are driving a Nebula notebook through the nebula-notebook MCP tools.'];
    parts.push(
      `If the nebula-notebook MCP tools are not available in this session, register them by running ` +
      `${this.buildSetupMcpCommand()} (the Nebula repo on the server) and then restart this CLI; ` +
      `if you are running on a different machine than the Nebula server, ask the user where their Nebula repo is.`
    );
    if (this.serverBaseUrl) {
      parts.push(
        `First call connect_server with base_url ${this.serverBaseUrl}; ` +
        'if that URL is not reachable from this machine, ask the user for the correct Nebula server URL.'
      );
    } else {
      parts.push('First call connect_server with this Nebula server’s base_url (ask the user for it).');
    }
    if (this.notebookPath) {
      parts.push(`This session is for the notebook ${this.notebookPath} — operate on that notebook unless told otherwise.`);
      parts.push('Read it now (read_notebook) to get oriented, then confirm you are connected and ready.');
    } else {
      parts.push('No notebook is open yet; confirm you are connected and wait for instructions.');
    }
    return sanitizePromptText(parts.join(' '));
  }

  // --- state / subscription (for React UIs) ---

  getState(): Readonly<AgentState> {
    return this.state;
  }

  isConnected(): boolean {
    return !!(this.state.terminalId && this.senders.has(this.state.terminalId));
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const l of this.listeners) l();
  }

  // --- actions ---

  openPanel(): void {
    this.panelOpener?.();
  }

  /**
   * Type the agent launch command into the terminal on the user's behalf.
   * The bootstrap context (server URL + notebook path) rides along as the
   * CLI's initial prompt argument, so the agent starts by connecting to the
   * right server and reading the right notebook — no guessing across tabs.
   */
  launchAgent(kind: 'claude' | 'codex'): SendResult {
    const send = this.getAgentSender();
    if (!send.ok) return send;
    send.sender(`${kind} ${shellSingleQuote(this.buildBootstrapPrompt())}\r`);
    this.state = { ...this.state, status: 'running', agentKind: kind };
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, kind);
    this.notify();
    return { ok: true };
  }

  /**
   * User already started an agent in the terminal by hand. Inject the same
   * bootstrap context the launch chips provide, so a manually started agent
   * still learns which server and notebook this tab is driving.
   */
  markRunning(): void {
    this.state = { ...this.state, status: 'running', agentKind: 'manual' };
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, 'manual');
    this.notify();
    this.sendPrompt(this.buildBootstrapPrompt());
  }

  /** Agent exited (user quit it, or terminal process ended). */
  markStopped(): void {
    // Always clear the persisted flag — the in-memory status may already have
    // been dropped by a WS close before the pty's exit event reaches us.
    if (this.state.terminalId) writeAgentFlag(this.state.terminalId, null);
    if (this.state.status === 'none') return;
    this.state = { ...this.state, status: 'none', agentKind: null };
    this.notify();
  }

  /**
   * Inject a prompt into the running agent. Sanitizes to a single line, writes
   * the text, then submits with Enter after a short delay.
   */
  sendPrompt(rawPrompt: string): SendResult {
    if (this.state.status !== 'running') {
      this.openPanel();
      return { ok: false, reason: 'agent-not-running' };
    }
    const send = this.getAgentSender();
    if (!send.ok) return send;

    const prompt = sanitizePromptText(rawPrompt);
    if (!prompt) return { ok: true }; // nothing to send

    send.sender(prompt);
    const terminalId = this.state.terminalId;
    setTimeout(() => {
      // Re-resolve at submit time: terminal may have closed in the interim.
      const sender = terminalId ? this.senders.get(terminalId) : undefined;
      sender?.('\r');
    }, ENTER_DELAY_MS);
    return { ok: true };
  }

  /** Compose + send a "fix this cell's error" prompt. */
  sendFixPrompt(args: { cellNumber: number; cellId: string; errorContent: string }): SendResult {
    const excerpt = sanitizeErrorExcerpt(args.errorContent);
    const where = this.notebookPath ? `notebook ${this.notebookPath}` : 'the open notebook';
    return this.sendPrompt(
      `In ${where}, cell ${args.cellNumber} (id ${args.cellId}) failed with: ${excerpt} — ` +
      `use the nebula-notebook MCP tools to read the cell and its full error output, fix the cell, ` +
      `and re-run it to verify the fix.`
    );
  }

  /** Compose + send a free-form per-cell prompt. */
  sendCellPrompt(args: { cellNumber: number; cellId: string; prompt: string }): SendResult {
    const where = this.notebookPath ? `notebook ${this.notebookPath}` : 'the open notebook';
    return this.sendPrompt(
      `In ${where}, regarding cell ${args.cellNumber} (id ${args.cellId}): ${args.prompt} — ` +
      `use the nebula-notebook MCP tools to read and edit the notebook; re-run the cell if you change it.`
    );
  }

  private getAgentSender(): { ok: true; sender: Sender } | { ok: false; reason: 'no-terminal' | 'not-connected' } {
    const id = this.state.terminalId;
    if (!id) {
      this.openPanel();
      return { ok: false, reason: 'no-terminal' };
    }
    const sender = this.senders.get(id);
    if (!sender) {
      this.openPanel();
      return { ok: false, reason: 'not-connected' };
    }
    // Wrap so a closed WS reports not-connected instead of silently dropping.
    return {
      ok: true,
      sender: (data: string) => sender(data),
    };
  }
}

/** POSIX single-quote: safe for paths/URLs with spaces or shell metacharacters. */
export function shellSingleQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/** Collapse to one line: raw newlines in pty stdin submit TUI prompts early. */
export function sanitizePromptText(text: string): string {
  return text
    .replace(ANSI_RE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** First meaningful line of an error (ANSI-stripped), truncated. */
export function sanitizeErrorExcerpt(errorContent: string): string {
  const cleaned = (errorContent || '').replace(ANSI_RE, '');
  // Prefer the last non-empty line: for Python tracebacks that's the
  // `ExceptionType: message` line, the most informative single line.
  const lines = cleaned.split('\n').map(l => l.trim()).filter(Boolean);
  const last = lines.length > 0 ? lines[lines.length - 1] : '';
  const oneLine = sanitizePromptText(last || cleaned);
  return oneLine.length > MAX_ERROR_EXCERPT_CHARS
    ? `${oneLine.slice(0, MAX_ERROR_EXCERPT_CHARS)}…`
    : oneLine;
}

export const agentTerminalService = new AgentTerminalService();

// Vite HMR: this module holds live singleton state (registered pty senders,
// agent status). Without self-accept, editing any importer chain re-instantiates
// the service mid-session — components end up talking to a fresh instance with
// no senders ("no agent running" despite a live agent). Self-accepting keeps
// the existing instance until a full reload.
if ((import.meta as { hot?: { accept: () => void } }).hot) {
  (import.meta as unknown as { hot: { accept: () => void } }).hot.accept();
}
