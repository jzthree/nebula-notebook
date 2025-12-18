"""
Session persistence layer using SQLite
Stores session metadata for recovery after server restarts
"""
import sqlite3
from pathlib import Path
from datetime import datetime
from typing import Optional, List
from dataclasses import dataclass
from contextlib import contextmanager
import threading

DB_PATH = Path(__file__).parent / "sessions.db"


@dataclass
class PersistedSession:
    """Session info that survives server restarts"""
    session_id: str
    kernel_name: str
    file_path: Optional[str]
    kernel_pid: Optional[int]
    status: str  # 'active', 'orphaned', 'terminated'
    created_at: float
    last_heartbeat: float
    connection_file: Optional[str]  # Jupyter connection file path


class SessionStore:
    """Thread-safe SQLite session store"""

    _local = threading.local()

    def __init__(self, db_path: Path = DB_PATH):
        self.db_path = db_path
        self._init_db()

    @contextmanager
    def _get_conn(self):
        """Thread-local connection management"""
        if not hasattr(self._local, 'conn') or self._local.conn is None:
            self._local.conn = sqlite3.connect(str(self.db_path))
            self._local.conn.row_factory = sqlite3.Row
        try:
            yield self._local.conn
        except Exception:
            self._local.conn.rollback()
            raise

    def _init_db(self):
        """Create tables if they don't exist"""
        with self._get_conn() as conn:
            conn.execute('''
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
            ''')
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_sessions_status
                ON sessions(status)
            ''')
            conn.execute('''
                CREATE INDEX IF NOT EXISTS idx_sessions_file_path
                ON sessions(file_path) WHERE file_path IS NOT NULL
            ''')
            conn.commit()

    def save_session(self, session: PersistedSession) -> None:
        """Insert or update a session"""
        with self._get_conn() as conn:
            conn.execute('''
                INSERT OR REPLACE INTO sessions
                (session_id, kernel_name, file_path, kernel_pid, status,
                 created_at, last_heartbeat, connection_file)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ''', (
                session.session_id, session.kernel_name, session.file_path,
                session.kernel_pid, session.status, session.created_at,
                session.last_heartbeat, session.connection_file
            ))
            conn.commit()

    def get_session(self, session_id: str) -> Optional[PersistedSession]:
        """Get a session by ID"""
        with self._get_conn() as conn:
            row = conn.execute(
                'SELECT * FROM sessions WHERE session_id = ?',
                (session_id,)
            ).fetchone()
            if row:
                return PersistedSession(**dict(row))
            return None

    def get_active_sessions(self) -> List[PersistedSession]:
        """Get all sessions marked as active"""
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE status = 'active'"
            ).fetchall()
            return [PersistedSession(**dict(row)) for row in rows]

    def get_orphaned_sessions(self) -> List[PersistedSession]:
        """Get sessions from previous server run (need reconnect/cleanup)"""
        with self._get_conn() as conn:
            rows = conn.execute(
                "SELECT * FROM sessions WHERE status = 'orphaned'"
            ).fetchall()
            return [PersistedSession(**dict(row)) for row in rows]

    def update_heartbeat(self, session_id: str) -> None:
        """Update the last_heartbeat timestamp"""
        with self._get_conn() as conn:
            conn.execute(
                'UPDATE sessions SET last_heartbeat = ? WHERE session_id = ?',
                (datetime.now().timestamp(), session_id)
            )
            conn.commit()

    def update_status(self, session_id: str, status: str) -> None:
        """Update session status"""
        with self._get_conn() as conn:
            conn.execute(
                'UPDATE sessions SET status = ? WHERE session_id = ?',
                (status, session_id)
            )
            conn.commit()

    def delete_session(self, session_id: str) -> None:
        """Remove a session from the database"""
        with self._get_conn() as conn:
            conn.execute(
                'DELETE FROM sessions WHERE session_id = ?',
                (session_id,)
            )
            conn.commit()

    def mark_all_orphaned(self) -> int:
        """Mark all active sessions as orphaned (called on startup)"""
        with self._get_conn() as conn:
            cursor = conn.execute(
                "UPDATE sessions SET status = 'orphaned' WHERE status = 'active'"
            )
            conn.commit()
            return cursor.rowcount

    def get_session_by_file(self, file_path: str) -> Optional[PersistedSession]:
        """Get active session associated with a file path"""
        with self._get_conn() as conn:
            row = conn.execute(
                "SELECT * FROM sessions WHERE file_path = ? AND status = 'active'",
                (file_path,)
            ).fetchone()
            if row:
                return PersistedSession(**dict(row))
            return None

    def cleanup_old_sessions(self, max_age_hours: float = 24.0) -> int:
        """Remove terminated/orphaned sessions older than max_age_hours"""
        cutoff = datetime.now().timestamp() - (max_age_hours * 3600)
        with self._get_conn() as conn:
            cursor = conn.execute(
                "DELETE FROM sessions WHERE status IN ('terminated', 'orphaned') AND last_heartbeat < ?",
                (cutoff,)
            )
            conn.commit()
            return cursor.rowcount


# Global instance
session_store = SessionStore()
