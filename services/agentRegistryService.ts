/**
 * Agent registry client — project-scoped agent sessions.
 *
 * Agents are keyed by the working directory they were launched in (default:
 * the notebook's directory) and DECOUPLED from notebooks: switching notebooks
 * never switches or kills an agent. The browser keeps a single "active agent"
 * pointer (localStorage); the server keeps the ledger of what exists —
 * live (pty running) or hibernated (pty gone, CLI trajectory on disk,
 * revivable with `claude --resume` / `codex resume`).
 */

export interface AgentRecord {
  terminalId: string;
  kind: 'claude' | 'codex';
  workdir: string;
  location: 'server' | 'remote';
  sessionId?: string;
  launchedFrom?: string;
  state: 'live' | 'hibernated';
  createdAt: number;
  lastLaunchAt: number;
}

const ACTIVE_AGENT_KEY = 'nebula-active-agent';

export function getActiveAgentId(): string | null {
  try { return window.localStorage.getItem(ACTIVE_AGENT_KEY) || null; } catch { return null; }
}

export function setActiveAgentId(id: string | null): void {
  try {
    if (id) window.localStorage.setItem(ACTIVE_AGENT_KEY, id);
    else window.localStorage.removeItem(ACTIVE_AGENT_KEY);
  } catch { /* storage unavailable — selection just won't persist */ }
}

/** Directory of a notebook path (the default agent workdir). */
export function notebookDirOf(notebookPath: string | null | undefined): string | null {
  if (!notebookPath) return null;
  const i = notebookPath.lastIndexOf('/');
  return i > 0 ? notebookPath.slice(0, i) : null;
}

/**
 * Stable pty name for an agent scoped to a workdir — mirrors the per-notebook
 * terminal naming scheme (hash prefix keeps distinct dirs distinct after the
 * server's 32-char normalization).
 */
export function agentTerminalNameFor(workdir: string): string {
  let hash = 0;
  for (let i = 0; i < workdir.length; i++) {
    hash = ((hash << 5) - hash + workdir.charCodeAt(i)) | 0;
  }
  const hex = (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
  const slug = (workdir.split('/').pop() || 'dir');
  return `agent-${hex}-${slug}`;
}

export async function listAgents(): Promise<AgentRecord[]> {
  try {
    const resp = await fetch('/api/agents');
    if (!resp.ok) return [];
    const data = await resp.json();
    return Array.isArray(data.agents) ? data.agents : [];
  } catch {
    return [];
  }
}

export async function registerAgent(rec: {
  terminalId: string; kind: 'claude' | 'codex'; workdir: string;
  location: 'server' | 'remote'; sessionId?: string; launchedFrom?: string;
}): Promise<void> {
  try {
    await fetch('/api/agents/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(rec),
    });
  } catch { /* registry is best-effort; the agent itself already runs */ }
}

export async function hibernateAgent(terminalId: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(terminalId)}/hibernate`, { method: 'POST' });
    return resp.ok;
  } catch { return false; }
}

export async function deleteAgent(terminalId: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/agents/${encodeURIComponent(terminalId)}`, { method: 'DELETE' });
    return resp.ok;
  } catch { return false; }
}
