/**
 * Session Store
 *
 * SQLite-based persistence for kernel sessions.
 * Enables recovery after server restarts.
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import { PersistedSession } from './types';

export class SessionStore {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath || path.join(__dirname, '../../sessions.db');
    this.db = new Database(resolvedPath);
    this.initDb();
  }

  /**
   * Create tables if they don't exist
   */
  private initDb(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        kernel_name TEXT NOT NULL,
        file_path TEXT,
        kernel_pid INTEGER,
        server_id TEXT,
        server_instance_id TEXT,
        kernel_start_time TEXT,
        status TEXT DEFAULT 'active',
        created_at REAL NOT NULL,
        last_heartbeat REAL NOT NULL,
        connection_file TEXT,
        connection_config TEXT
      )
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notebook_kernel_prefs (
        file_path TEXT PRIMARY KEY,
        kernel_name TEXT NOT NULL,
        server_id TEXT,
        updated_at REAL NOT NULL
      )
    `);

    // Migration: add connection_config column if it doesn't exist
    try {
      this.db.exec('ALTER TABLE sessions ADD COLUMN connection_config TEXT');
    } catch {
      // Column already exists
    }
    try {
      this.db.exec('ALTER TABLE sessions ADD COLUMN server_id TEXT');
    } catch {
      // Column already exists
    }
    try {
      this.db.exec('ALTER TABLE sessions ADD COLUMN server_instance_id TEXT');
    } catch {
      // Column already exists
    }
    try {
      this.db.exec('ALTER TABLE sessions ADD COLUMN kernel_start_time TEXT');
    } catch {
      // Column already exists
    }

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_status
      ON sessions(status)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_file_path
      ON sessions(file_path) WHERE file_path IS NOT NULL
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_notebook_kernel_prefs_updated_at
      ON notebook_kernel_prefs(updated_at)
    `);
  }

  /**
   * Insert or update a session
   */
  saveSession(session: PersistedSession): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
      (session_id, kernel_name, file_path, kernel_pid,
       server_id, server_instance_id, kernel_start_time,
       status, created_at, last_heartbeat,
       connection_file, connection_config)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.sessionId,
      session.kernelName,
      session.filePath,
      session.kernelPid,
      session.serverId ?? null,
      session.serverInstanceId ?? null,
      session.kernelStartTime ?? null,
      session.status,
      session.createdAt,
      session.lastHeartbeat,
      session.connectionFile,
      session.connectionConfig
    );
  }

  /**
   * Get a session by ID
   */
  getSession(sessionId: string): PersistedSession | null {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE session_id = ?');
    const row = stmt.get(sessionId) as Record<string, unknown> | undefined;

    if (row) {
      return this.rowToSession(row);
    }
    return null;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): PersistedSession[] {
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE status = 'active'");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Get orphaned sessions (from previous server run)
   */
  getOrphanedSessions(serverId?: string): PersistedSession[] {
    if (serverId) {
      const stmt = this.db.prepare(
        "SELECT * FROM sessions WHERE status = 'orphaned' AND (server_id = ? OR server_id IS NULL)"
      );
      const rows = stmt.all(serverId) as Record<string, unknown>[];
      return rows.map(row => this.rowToSession(row));
    }
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE status = 'orphaned'");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Update heartbeat timestamp
   */
  updateHeartbeat(sessionId: string): void {
    const stmt = this.db.prepare(
      'UPDATE sessions SET last_heartbeat = ? WHERE session_id = ?'
    );
    stmt.run(Date.now() / 1000, sessionId);
  }

  /**
   * Update session status
   */
  updateStatus(sessionId: string, status: 'active' | 'orphaned' | 'terminated'): void {
    const stmt = this.db.prepare(
      'UPDATE sessions SET status = ? WHERE session_id = ?'
    );
    stmt.run(status, sessionId);
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM sessions WHERE session_id = ?');
    stmt.run(sessionId);
  }

  /**
   * Mark all active sessions as orphaned (called on startup)
   */
  markAllOrphaned(serverId?: string, serverInstanceId?: string): number {
    if (serverId && serverInstanceId) {
      const stmt = this.db.prepare(
        "UPDATE sessions SET status = 'orphaned' WHERE status = 'active' AND (server_id = ? OR server_id IS NULL) AND (server_instance_id IS NULL OR server_instance_id != ?)"
      );
      const result = stmt.run(serverId, serverInstanceId);
      return result.changes;
    }
    const stmt = this.db.prepare("UPDATE sessions SET status = 'orphaned' WHERE status = 'active'");
    const result = stmt.run();
    return result.changes;
  }

  /**
   * Get session by file path
   */
  getSessionByFile(filePath: string): PersistedSession | null {
    const stmt = this.db.prepare(
      "SELECT * FROM sessions WHERE file_path = ? AND status = 'active'"
    );
    const row = stmt.get(filePath) as Record<string, unknown> | undefined;

    if (row) {
      return this.rowToSession(row);
    }
    return null;
  }

  /**
   * Cleanup old terminated/orphaned sessions
   */
  cleanupOldSessions(maxAgeHours: number = 24): number {
    const cutoff = (Date.now() / 1000) - (maxAgeHours * 3600);
    const stmt = this.db.prepare(
      "DELETE FROM sessions WHERE status IN ('terminated', 'orphaned') AND last_heartbeat < ?"
    );
    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Get dead sessions (orphaned or terminated) - candidates for cleanup
   */
  getDeadSessions(serverId?: string): PersistedSession[] {
    if (serverId) {
      const stmt = this.db.prepare(
        "SELECT * FROM sessions WHERE status IN ('orphaned', 'terminated') AND (server_id = ? OR server_id IS NULL)"
      );
      const rows = stmt.all(serverId) as Record<string, unknown>[];
      return rows.map(row => this.rowToSession(row));
    }
    const stmt = this.db.prepare("SELECT * FROM sessions WHERE status IN ('orphaned', 'terminated')");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map(row => this.rowToSession(row));
  }

  /**
   * Delete specific sessions by ID
   */
  deleteSessions(sessionIds: string[]): number {
    if (sessionIds.length === 0) return 0;
    const placeholders = sessionIds.map(() => '?').join(',');
    const stmt = this.db.prepare(`DELETE FROM sessions WHERE session_id IN (${placeholders})`);
    const result = stmt.run(...sessionIds);
    return result.changes;
  }

  /**
   * Save kernel preference for a notebook file.
   */
  saveNotebookKernelPreference(filePath: string, kernelName: string, serverId?: string | null): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO notebook_kernel_prefs
      (file_path, kernel_name, server_id, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(filePath, kernelName, serverId ?? null, Date.now() / 1000);
  }

  /**
   * Get kernel preference for a notebook file.
   */
  getNotebookKernelPreference(filePath: string): { kernelName: string; serverId: string | null; updatedAt: number } | null {
    const stmt = this.db.prepare(
      'SELECT kernel_name, server_id, updated_at FROM notebook_kernel_prefs WHERE file_path = ?'
    );
    const row = stmt.get(filePath) as { kernel_name: string; server_id: string | null; updated_at: number } | undefined;
    if (!row) return null;
    return {
      kernelName: row.kernel_name,
      serverId: row.server_id ?? null,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Delete kernel preference for a notebook file.
   */
  deleteNotebookKernelPreference(filePath: string): void {
    const stmt = this.db.prepare('DELETE FROM notebook_kernel_prefs WHERE file_path = ?');
    stmt.run(filePath);
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Convert database row to PersistedSession
   */
  private rowToSession(row: Record<string, unknown>): PersistedSession {
    return {
      sessionId: row.session_id as string,
      kernelName: row.kernel_name as string,
      filePath: row.file_path as string | null,
      kernelPid: row.kernel_pid as number | null,
      serverId: row.server_id as string | null,
      serverInstanceId: row.server_instance_id as string | null,
      kernelStartTime: row.kernel_start_time as string | null,
      status: row.status as 'active' | 'orphaned' | 'terminated',
      createdAt: row.created_at as number,
      lastHeartbeat: row.last_heartbeat as number,
      connectionFile: row.connection_file as string | null,
      connectionConfig: row.connection_config as string | null,
    };
  }
}
