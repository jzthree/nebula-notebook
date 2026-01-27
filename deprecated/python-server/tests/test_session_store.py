"""
Tests for session_store - SQLite session persistence
"""
import pytest
import tempfile
from pathlib import Path
from datetime import datetime

# Add parent directory to path for imports
import sys
sys.path.insert(0, str(Path(__file__).parent.parent))

from session_store import SessionStore, PersistedSession


@pytest.fixture
def temp_db():
    """Create a temporary database file for testing"""
    import uuid
    # Use uuid to ensure unique filename per test
    temp_path = Path(tempfile.gettempdir()) / f"test_session_{uuid.uuid4().hex}.db"
    yield temp_path
    # Cleanup after test
    temp_path.unlink(missing_ok=True)


@pytest.fixture
def session_store(temp_db):
    """Create a SessionStore with a temp database"""
    store = SessionStore(db_path=temp_db)
    yield store
    # Close any open connections
    if hasattr(store._local, 'conn') and store._local.conn:
        store._local.conn.close()
        store._local.conn = None


@pytest.fixture
def sample_session():
    """Create a sample PersistedSession for testing - NOT saved to store"""
    now = datetime.now().timestamp()
    return PersistedSession(
        session_id="test-session-123",
        kernel_name="python3",
        file_path="/path/to/notebook.ipynb",
        kernel_pid=12345,
        status="active",
        created_at=now,
        last_heartbeat=now,
        connection_file="/tmp/kernel-123.json"
    )


class TestSessionStoreCRUD:
    """Test basic CRUD operations"""

    def test_save_and_get_session(self, session_store, sample_session):
        """Test saving and retrieving a session"""
        session_store.save_session(sample_session)

        retrieved = session_store.get_session(sample_session.session_id)

        assert retrieved is not None
        assert retrieved.session_id == sample_session.session_id
        assert retrieved.kernel_name == sample_session.kernel_name
        assert retrieved.file_path == sample_session.file_path
        assert retrieved.kernel_pid == sample_session.kernel_pid
        assert retrieved.status == sample_session.status

    def test_get_nonexistent_session(self, session_store):
        """Test getting a session that doesn't exist returns None"""
        retrieved = session_store.get_session("nonexistent-id")
        assert retrieved is None

    def test_delete_session(self, session_store, sample_session):
        """Test deleting a session"""
        session_store.save_session(sample_session)

        # Verify it exists
        assert session_store.get_session(sample_session.session_id) is not None

        # Delete and verify it's gone
        session_store.delete_session(sample_session.session_id)
        assert session_store.get_session(sample_session.session_id) is None

    def test_update_session_via_save(self, session_store, sample_session):
        """Test that save_session updates existing session"""
        session_store.save_session(sample_session)

        # Modify and save again
        sample_session.status = "terminated"
        sample_session.kernel_pid = 99999
        session_store.save_session(sample_session)

        retrieved = session_store.get_session(sample_session.session_id)
        assert retrieved.status == "terminated"
        assert retrieved.kernel_pid == 99999


class TestSessionStoreStatus:
    """Test status-related operations"""

    def test_get_active_sessions(self, session_store):
        """Test retrieving active sessions"""
        now = datetime.now().timestamp()

        # Create multiple sessions with different statuses
        active1 = PersistedSession("a1", "python3", None, 1, "active", now, now, None)
        active2 = PersistedSession("a2", "python3", None, 2, "active", now, now, None)
        orphaned = PersistedSession("o1", "python3", None, 3, "orphaned", now, now, None)
        terminated = PersistedSession("t1", "python3", None, 4, "terminated", now, now, None)

        for s in [active1, active2, orphaned, terminated]:
            session_store.save_session(s)

        active_sessions = session_store.get_active_sessions()

        assert len(active_sessions) == 2
        ids = {s.session_id for s in active_sessions}
        assert ids == {"a1", "a2"}

    def test_get_orphaned_sessions(self, session_store):
        """Test retrieving orphaned sessions"""
        now = datetime.now().timestamp()

        active = PersistedSession("a1", "python3", None, 1, "active", now, now, None)
        orphaned1 = PersistedSession("o1", "python3", None, 2, "orphaned", now, now, None)
        orphaned2 = PersistedSession("o2", "python3", None, 3, "orphaned", now, now, None)

        for s in [active, orphaned1, orphaned2]:
            session_store.save_session(s)

        orphaned_sessions = session_store.get_orphaned_sessions()

        assert len(orphaned_sessions) == 2
        ids = {s.session_id for s in orphaned_sessions}
        assert ids == {"o1", "o2"}

    def test_update_status(self, session_store, sample_session):
        """Test updating session status"""
        session_store.save_session(sample_session)

        session_store.update_status(sample_session.session_id, "terminated")

        retrieved = session_store.get_session(sample_session.session_id)
        assert retrieved.status == "terminated"

    def test_mark_all_orphaned(self, session_store):
        """Test marking all active sessions as orphaned"""
        now = datetime.now().timestamp()

        active1 = PersistedSession("a1", "python3", None, 1, "active", now, now, None)
        active2 = PersistedSession("a2", "python3", None, 2, "active", now, now, None)
        terminated = PersistedSession("t1", "python3", None, 3, "terminated", now, now, None)

        for s in [active1, active2, terminated]:
            session_store.save_session(s)

        # Mark all active as orphaned
        count = session_store.mark_all_orphaned()

        assert count == 2
        assert len(session_store.get_active_sessions()) == 0
        assert len(session_store.get_orphaned_sessions()) == 2

        # Terminated should stay terminated
        assert session_store.get_session("t1").status == "terminated"


class TestSessionStoreHeartbeat:
    """Test heartbeat-related operations"""

    def test_update_heartbeat(self, session_store, sample_session):
        """Test updating heartbeat timestamp"""
        session_store.save_session(sample_session)
        original_heartbeat = sample_session.last_heartbeat

        # Wait a tiny bit and update heartbeat
        import time
        time.sleep(0.01)
        session_store.update_heartbeat(sample_session.session_id)

        retrieved = session_store.get_session(sample_session.session_id)
        assert retrieved.last_heartbeat > original_heartbeat


class TestSessionStoreFilePath:
    """Test file path lookup operations"""

    def test_get_session_by_file(self, session_store):
        """Test getting session by file path"""
        now = datetime.now().timestamp()

        session = PersistedSession(
            "s1", "python3", "/path/to/notebook.ipynb",
            1, "active", now, now, None
        )
        session_store.save_session(session)

        retrieved = session_store.get_session_by_file("/path/to/notebook.ipynb")

        assert retrieved is not None
        assert retrieved.session_id == "s1"

    def test_get_session_by_file_only_active(self, session_store):
        """Test that get_session_by_file only returns active sessions"""
        now = datetime.now().timestamp()

        # Create orphaned session with file path
        session = PersistedSession(
            "s1", "python3", "/path/to/notebook.ipynb",
            1, "orphaned", now, now, None
        )
        session_store.save_session(session)

        # Should not return orphaned session
        retrieved = session_store.get_session_by_file("/path/to/notebook.ipynb")
        assert retrieved is None


class TestSessionStoreCleanup:
    """Test cleanup operations"""

    def test_cleanup_old_sessions(self, session_store):
        """Test cleaning up old terminated/orphaned sessions"""
        import time

        # Create sessions with old timestamps
        old_time = datetime.now().timestamp() - (25 * 3600)  # 25 hours ago
        now = datetime.now().timestamp()

        old_orphaned = PersistedSession("o1", "python3", None, 1, "orphaned", old_time, old_time, None)
        old_terminated = PersistedSession("t1", "python3", None, 2, "terminated", old_time, old_time, None)
        recent_orphaned = PersistedSession("o2", "python3", None, 3, "orphaned", now, now, None)
        active = PersistedSession("a1", "python3", None, 4, "active", old_time, old_time, None)

        for s in [old_orphaned, old_terminated, recent_orphaned, active]:
            session_store.save_session(s)

        # Cleanup with 24 hour max age
        deleted_count = session_store.cleanup_old_sessions(max_age_hours=24.0)

        assert deleted_count == 2  # old_orphaned and old_terminated

        # Verify what remains
        assert session_store.get_session("o1") is None  # deleted
        assert session_store.get_session("t1") is None  # deleted
        assert session_store.get_session("o2") is not None  # recent, kept
        assert session_store.get_session("a1") is not None  # active, kept
