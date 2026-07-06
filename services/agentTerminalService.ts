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

import { getSettings } from './settingsService';
import { markOnboardingStep } from './onboardingService';

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
    // Only the WebSocket dropped — the pty (and any agent running in it)
    // survives server-side, and TerminalInstance auto-reconnects. Keep the
    // running status so the UI doesn't flap to the launch chips mid-outage;
    // isConnected() goes false, which gates prompt injection and lets the
    // panel show a "reconnecting" state. Real agent exits arrive as the
    // pty 'exit' event (markStopped), and a dead server surfaces as the
    // terminal's "session no longer exists" message.
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
   * Command that registers the Nebula MCP with the agent CLIs. The npx form
   * works on any machine with Node (no repo checkout, no paths) — the
   * nebula-notebook-mcp package is published exactly for this.
   */
  buildSetupMcpCommand(): string {
    return 'npx nebula-notebook-mcp setup-mcp';
  }

  // --- remote-agent mode (run the agent on the user's machine) ---

  /**
   * Remote-agent settings, when the mode is enabled and complete. The agent
   * CLI then runs on the USER'S machine — its RAM and its network (for when
   * the server host is memory-tight or blocks the agent's API) — while its
   * terminal lives in this panel via an `ssh -R` reverse channel carried by
   * the user's own tunnel.
   */
  getRemoteAgentConfig(): { port: number; user: string; localUrl: string } | null {
    const s = getSettings();
    if (!s.remoteAgentEnabled || !s.remoteAgentPort || !s.remoteAgentUser?.trim()) return null;
    return {
      port: s.remoteAgentPort,
      user: s.remoteAgentUser.trim(),
      localUrl: (s.remoteAgentLocalUrl || 'http://localhost:3000').replace(/\/$/, ''),
    };
  }

  /**
   * The tunnel command the user runs ON THEIR machine: their usual -L forward
   * plus the -R reverse channel that lets a Nebula terminal ssh back. It must
   * terminate on the server's host so the pty can reach 127.0.0.1:<port>.
   */
  buildTunnelCommand(serverHost: string | null, serverPort: number | null): string {
    const s = getSettings();
    let localPort = '3000';
    try { localPort = new URL(s.remoteAgentLocalUrl || 'http://localhost:3000').port || '80'; } catch { /* keep default */ }
    const jump = s.remoteAgentJumpHost?.trim() ? ` -J ${s.remoteAgentJumpHost.trim()}` : '';
    return `ssh${jump} -L ${localPort}:localhost:${serverPort ?? 3000} -R ${s.remoteAgentPort ?? '<port>'}:localhost:22 ${serverHost || '<server-host>'}`;
  }

  /**
   * Same tunnel as buildTunnelCommand, but as a Burrow definition — Burrow
   * (macOS menu-bar SSH tunnel manager) then supervises it: auto-connect,
   * auto-reconnect, status dot. One-time add; connect from the menu bar.
   */
  buildBurrowCommand(serverHost: string | null, serverPort: number | null): string {
    const s = getSettings();
    let localPort = '3000';
    try { localPort = new URL(s.remoteAgentLocalUrl || 'http://localhost:3000').port || '80'; } catch { /* keep default */ }
    const jump = s.remoteAgentJumpHost?.trim() ? ` --jump ${s.remoteAgentJumpHost.trim()}` : '';
    return `burrow add --name nebula-agent --host ${serverHost || '<server-host>'}${jump} ` +
      `--local ${localPort}:localhost:${serverPort ?? 3000} --remote ${s.remoteAgentPort ?? '<port>'}:localhost:22`;
  }

  /**
   * The line typed into the Nebula terminal to start the agent on the user's
   * machine: ssh back over the reverse channel, set NEBULA_URL as seen from
   * there, run the agent with the bootstrap prompt as its first argument.
   * accept-new pins the host key on first use without an interactive prompt.
   */
  buildRemoteLaunchCommand(kind: 'claude' | 'codex'): string | null {
    const cfg = this.getRemoteAgentConfig();
    if (!cfg) return null;
    const agentCmd = `NEBULA_URL=${cfg.localUrl} ${kind} ${shellSingleQuote(this.buildBootstrapPrompt(true))}`;
    // Tunnel drops kill the ssh session — so run the agent inside tmux on the
    // user's machine when available: `tmux new -A` attaches to a surviving
    // session on relaunch (the command only runs on CREATE), so a network
    // blip + clicking the launch button again resumes the same agent.
    const inner = `if command -v tmux >/dev/null 2>&1; then tmux new -A -s nebula-agent ${shellSingleQuote(agentCmd)}; else ${agentCmd}; fi`;
    // `ssh host cmd` runs a non-login, non-interactive shell on the user's
    // machine — PATH additions from .zprofile/.zshrc (homebrew, nvm, npm -g)
    // are absent and the agent CLI isn't found. Re-enter the user's own shell
    // as login+interactive so their PATH is what their terminals see.
    const remoteCmd = `exec "$SHELL" -l -i -c ${shellSingleQuote(inner)}`;
    // ProxyCommand=none: IPA/SSSD-managed clusters wrap ALL ssh in
    // sss_ssh_knownhostsproxy via the system ssh_config, which breaks a plain
    // loopback hop — this connection must go straight to 127.0.0.1:<port>.
    return `ssh -t -p ${cfg.port} -o ProxyCommand=none -o StrictHostKeyChecking=accept-new ${cfg.user}@localhost ${shellSingleQuote(remoteCmd)}`;
  }

  /**
   * Orientation prompt handed to a freshly started agent: which server to
   * connect_server to (the MCP intentionally ignores env config and requires
   * an explicit base_url per session) and which notebook this tab is driving.
   * `remote` = the agent runs on the user's machine (remote-agent mode), so
   * URLs must be the ones visible from THERE (the -L forward), and `nebula`
   * may not be on PATH.
   */
  buildBootstrapPrompt(remote = false): string {
    const cfg = remote ? this.getRemoteAgentConfig() : null;
    const baseUrl = remote ? (cfg?.localUrl || 'http://localhost:3000') : this.serverBaseUrl;
    const parts: string[] = ['You are driving a Nebula notebook.'];
    // CLI-first: Nebula terminals have the `nebula` CLI on PATH with
    // NEBULA_URL pre-set — cheaper and more composable for shell-capable
    // agents than loading the MCP toolset. MCP remains the fallback.
    parts.push(
      (remote
        ? `PREFERRED: use the \`nebula\` CLI (NEBULA_URL is already set to ${baseUrl}, your SSH-forwarded Nebula server; notebook paths are paths on the SERVER, not this machine). ` +
          'If `nebula` is not on PATH, use `npx -p nebula-notebook-mcp nebula …`. '
        : 'PREFERRED: use the `nebula` CLI available in this terminal (NEBULA_URL is already set). ') +
      'Start with `nebula --help`; key commands: `nebula nb read <path>` (list cells), ' +
      '`nebula run <path> <cell-id>` (execute AND get output in one call), ' +
      '`nebula nb edit <path> <cell-id> --content-file -`, `nebula nb search <path> <query>`, ' +
      '`nebula kernel status|restart|interrupt <path>`. ' +
      'Exit code 9 = edit conflict (the current content is printed — retry against it). ' +
      'For long-running cells: `nebula run` blocks until the cell finishes — launch it as a background shell task ' +
      '(`--max-wait 0` = no time limit) and the process exit is your completion signal; never poll.'
    );
    parts.push(
      `FALLBACK (only if the nebula CLI is missing): use the nebula-notebook MCP tools — register with ` +
      `${this.buildSetupMcpCommand()} and restart this CLI` +
      (!remote && this.repoRoot ? ` (the server's Nebula repo is at ${this.repoRoot} if you need the source)` : '') +
      (baseUrl
        ? `, then call connect_server with base_url ${baseUrl}; if that URL is not reachable from this machine, ask the user for the correct Nebula server URL.`
        : ', then call connect_server with this Nebula server’s base_url (ask the user for it).')
    );
    if (this.notebookPath) {
      parts.push(`This session is for the notebook ${this.notebookPath} — operate on that notebook unless told otherwise.`);
      parts.push('Read it now (nebula nb read) to get oriented, then confirm you are ready.');
    } else {
      parts.push('No notebook is open yet; confirm you are ready and wait for instructions.');
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
    // Remote-agent mode: the launch line hops back to the user's machine over
    // the reverse SSH channel and runs the agent there instead.
    const remoteLine = this.buildRemoteLaunchCommand(kind);
    send.sender(remoteLine ? `${remoteLine}\r` : `${kind} ${shellSingleQuote(this.buildBootstrapPrompt())}\r`);
    markOnboardingStep('launchedAgent');
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
    markOnboardingStep('launchedAgent');
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
