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
        status TEXT DEFAULT 'active',
        created_at REAL NOT NULL,
        last_heartbeat REAL NOT NULL,
        connection_file TEXT
      )
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_status
      ON sessions(status)
    `);

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_file_path
      ON sessions(file_path) WHERE file_path IS NOT NULL
    `);
  }

  /**
   * Insert or update a session
   */
  saveSession(session: PersistedSession): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions
      (session_id, kernel_name, file_path, kernel_pid, status,
       created_at, last_heartbeat, connection_file)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.sessionId,
      session.kernelName,
      session.filePath,
      session.kernelPid,
      session.status,
      session.createdAt,
      session.lastHeartbeat,
      session.connectionFile
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
  getOrphanedSessions(): PersistedSession[] {
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
  markAllOrphaned(): number {
    const stmt = this.db.prepare(
      "UPDATE sessions SET status = 'orphaned' WHERE status = 'active'"
    );
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
      status: row.status as 'active' | 'orphaned' | 'terminated',
      createdAt: row.created_at as number,
      lastHeartbeat: row.last_heartbeat as number,
      connectionFile: row.connection_file as string | null,
    };
  }
}
