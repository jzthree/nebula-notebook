/**
 * Agent registry — the server-side ledger of agent sessions (Claude Code /
 * Codex CLIs running inside terminal ptys).
 *
 * Agents are project-scoped (keyed by the working directory they were
 * launched in) and decoupled from notebooks: switching notebooks never kills
 * or switches an agent; the user does, through the agent manager. Records
 * persist to disk so agents survive as *resumable* entities even when their
 * pty dies (browser gone, server restart, user hibernates them): the CLI's
 * own on-disk trajectory (`claude --resume <id>` / `codex resume`) can
 * reconstruct the conversation — the registry just remembers what exists,
 * where, and how to revive it. The client owns launch/revive command
 * construction (it knows about remote-agent mode); the server owns truth
 * about what is live.
 *
 * States: 'live' (pty exists) → 'hibernated' (pty gone, trajectory on disk).
 * All records load as 'hibernated' on boot — ptys never survive a restart.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ptyManager } from './pty-manager';

export interface AgentRecord {
  /** Terminal (pty) id the agent runs in — stable, derived from workdir. */
  terminalId: string;
  kind: 'claude' | 'codex';
  /** Directory the agent was launched in — the project scope. */
  workdir: string;
  /** Where the CLI process runs: this server, or the user's machine over the reverse channel. */
  location: 'server' | 'remote';
  /** Claude --session-id (resume pointer). Codex resumes via its own picker. */
  sessionId?: string;
  /** Notebook that launched it (informational only — agents are not bound to notebooks). */
  launchedFrom?: string;
  state: 'live' | 'hibernated';
  createdAt: number;
  lastLaunchAt: number;
}

const STATE_FILE = path.join(os.homedir(), '.nebula', 'agents.json');
const MAX_RECORDS = 50; // oldest hibernated records beyond this are dropped

class AgentRegistry {
  private records = new Map<string, AgentRecord>();
  private exitUnsubs = new Map<string, () => void>();
  private loaded = false;

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(STATE_FILE)) {
        const list = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as AgentRecord[];
        for (const r of list) {
          if (!r?.terminalId) continue;
          // Ptys never survive a server restart — everything reloads hibernated.
          r.state = 'hibernated';
          this.records.set(r.terminalId, r);
        }
      }
    } catch (err) {
      console.error('[AgentRegistry] failed to load state:', err);
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(STATE_FILE);
      fs.mkdirSync(dir, { recursive: true });
      const all = [...this.records.values()].sort((a, b) => b.lastLaunchAt - a.lastLaunchAt);
      const live = all.filter((r) => r.state === 'live');
      const hibernated = all.filter((r) => r.state !== 'live').slice(0, MAX_RECORDS - live.length);
      const tmp = `${STATE_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify([...live, ...hibernated], null, 2));
      fs.renameSync(tmp, STATE_FILE);
    } catch (err) {
      console.error('[AgentRegistry] failed to persist state:', err);
    }
  }

  /** Register (or re-register on revive) an agent launched in a terminal. */
  register(rec: Omit<AgentRecord, 'state' | 'createdAt' | 'lastLaunchAt'>): AgentRecord {
    this.ensureLoaded();
    const existing = this.records.get(rec.terminalId);
    const record: AgentRecord = {
      ...rec,
      state: 'live',
      createdAt: existing?.createdAt ?? Date.now(),
      lastLaunchAt: Date.now(),
    };
    this.records.set(rec.terminalId, record);

    // When the pty dies for any reason (user exits the CLI and closes the
    // terminal, hibernate, server-side kill), the agent is not gone — its
    // trajectory is on disk. Mark it hibernated, ready to revive.
    this.exitUnsubs.get(rec.terminalId)?.();
    const unsub = ptyManager.addExitListener(rec.terminalId, () => {
      const r = this.records.get(rec.terminalId);
      if (r && r.state === 'live') {
        r.state = 'hibernated';
        this.persist();
      }
      this.exitUnsubs.delete(rec.terminalId);
    });
    this.exitUnsubs.set(rec.terminalId, unsub);
    this.persist();
    return record;
  }

  /** List all agents, reconciling 'live' against actual pty existence. */
  list(): AgentRecord[] {
    this.ensureLoaded();
    for (const r of this.records.values()) {
      if (r.state === 'live' && !ptyManager.get(r.terminalId)) {
        r.state = 'hibernated';
      }
    }
    return [...this.records.values()].sort((a, b) => b.lastLaunchAt - a.lastLaunchAt);
  }

  /** Hibernate: close the pty; the record (and on-disk trajectory) remain. */
  hibernate(terminalId: string): boolean {
    this.ensureLoaded();
    const r = this.records.get(terminalId);
    if (!r) return false;
    if (ptyManager.get(terminalId)) ptyManager.kill(terminalId); // exit listener marks hibernated
    r.state = 'hibernated';
    this.persist();
    return true;
  }

  /** Forget the agent entirely (pty closed; registry record removed). */
  remove(terminalId: string): boolean {
    this.ensureLoaded();
    const r = this.records.get(terminalId);
    if (!r) return false;
    this.exitUnsubs.get(terminalId)?.();
    this.exitUnsubs.delete(terminalId);
    if (ptyManager.get(terminalId)) ptyManager.kill(terminalId);
    this.records.delete(terminalId);
    this.persist();
    return true;
  }
}

export const agentRegistry = new AgentRegistry();
