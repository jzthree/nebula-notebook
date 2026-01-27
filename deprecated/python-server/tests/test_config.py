"""
Tests for server configuration module.

TDD: These tests define expected configuration behavior.
"""
import pytest
import os


class TestConfigDefaults:
    """Test that all configuration values have sensible defaults."""

    def test_kernel_startup_timeout_default(self):
        """Kernel startup timeout should default to 30 seconds."""
        from config import KERNEL_STARTUP_TIMEOUT_SECONDS
        assert KERNEL_STARTUP_TIMEOUT_SECONDS == 30.0

    def test_kernel_shutdown_timeout_default(self):
        """Kernel shutdown timeout should default to 5 seconds."""
        from config import KERNEL_SHUTDOWN_TIMEOUT_SECONDS
        assert KERNEL_SHUTDOWN_TIMEOUT_SECONDS == 5.0

    def test_kernel_msg_timeout_default(self):
        """Kernel message timeout should default to 0.5 seconds."""
        from config import KERNEL_MSG_TIMEOUT_SECONDS
        assert KERNEL_MSG_TIMEOUT_SECONDS == 0.5

    def test_kernel_polling_interval_default(self):
        """Kernel polling interval should default to 0.1 seconds."""
        from config import KERNEL_POLLING_INTERVAL_SECONDS
        assert KERNEL_POLLING_INTERVAL_SECONDS == 0.1

    def test_discovery_cache_ttl_default(self):
        """Discovery cache TTL should default to 24 hours."""
        from config import DISCOVERY_CACHE_TTL_HOURS
        assert DISCOVERY_CACHE_TTL_HOURS == 24

    def test_discovery_version_check_timeout_default(self):
        """Version check timeout should default to 5 seconds."""
        from config import DISCOVERY_VERSION_CHECK_TIMEOUT_SECONDS
        assert DISCOVERY_VERSION_CHECK_TIMEOUT_SECONDS == 5

    def test_discovery_ipykernel_check_timeout_default(self):
        """ipykernel check timeout should default to 10 seconds."""
        from config import DISCOVERY_IPYKERNEL_CHECK_TIMEOUT_SECONDS
        assert DISCOVERY_IPYKERNEL_CHECK_TIMEOUT_SECONDS == 10

    def test_discovery_conda_list_timeout_default(self):
        """Conda list timeout should default to 30 seconds."""
        from config import DISCOVERY_CONDA_LIST_TIMEOUT_SECONDS
        assert DISCOVERY_CONDA_LIST_TIMEOUT_SECONDS == 30

    def test_discovery_parallel_workers_default(self):
        """Parallel workers should default to 10."""
        from config import DISCOVERY_PARALLEL_WORKERS
        assert DISCOVERY_PARALLEL_WORKERS == 10

    def test_discovery_kernel_install_timeout_default(self):
        """Kernel install timeout should default to 120 seconds."""
        from config import DISCOVERY_KERNEL_INSTALL_TIMEOUT_SECONDS
        assert DISCOVERY_KERNEL_INSTALL_TIMEOUT_SECONDS == 120

    def test_discovery_registration_timeout_default(self):
        """Kernel registration timeout should default to 60 seconds."""
        from config import DISCOVERY_REGISTRATION_TIMEOUT_SECONDS
        assert DISCOVERY_REGISTRATION_TIMEOUT_SECONDS == 60

    def test_session_max_age_default(self):
        """Session max age should default to 24 hours."""
        from config import SESSION_MAX_AGE_HOURS
        assert SESSION_MAX_AGE_HOURS == 24.0

    def test_backend_shutdown_timeout_default(self):
        """Backend shutdown timeout should default to 5 seconds."""
        from config import BACKEND_SHUTDOWN_TIMEOUT_SECONDS
        assert BACKEND_SHUTDOWN_TIMEOUT_SECONDS == 5.0

    def test_llm_default_max_tokens(self):
        """LLM max tokens should default to 4096."""
        from config import LLM_DEFAULT_MAX_TOKENS
        assert LLM_DEFAULT_MAX_TOKENS == 4096

    def test_llm_default_temperature(self):
        """LLM temperature should default to 0.2."""
        from config import LLM_DEFAULT_TEMPERATURE
        assert LLM_DEFAULT_TEMPERATURE == 0.2


class TestConfigValidation:
    """Test that configuration values are valid."""

    def test_all_timeouts_are_positive(self):
        """All timeout values should be positive numbers."""
        from config import (
            KERNEL_STARTUP_TIMEOUT_SECONDS,
            KERNEL_SHUTDOWN_TIMEOUT_SECONDS,
            KERNEL_MSG_TIMEOUT_SECONDS,
            KERNEL_POLLING_INTERVAL_SECONDS,
            DISCOVERY_VERSION_CHECK_TIMEOUT_SECONDS,
            DISCOVERY_IPYKERNEL_CHECK_TIMEOUT_SECONDS,
            DISCOVERY_CONDA_LIST_TIMEOUT_SECONDS,
            DISCOVERY_KERNEL_INSTALL_TIMEOUT_SECONDS,
            DISCOVERY_REGISTRATION_TIMEOUT_SECONDS,
            BACKEND_SHUTDOWN_TIMEOUT_SECONDS,
        )
        timeouts = [
            KERNEL_STARTUP_TIMEOUT_SECONDS,
            KERNEL_SHUTDOWN_TIMEOUT_SECONDS,
            KERNEL_MSG_TIMEOUT_SECONDS,
            KERNEL_POLLING_INTERVAL_SECONDS,
            DISCOVERY_VERSION_CHECK_TIMEOUT_SECONDS,
            DISCOVERY_IPYKERNEL_CHECK_TIMEOUT_SECONDS,
            DISCOVERY_CONDA_LIST_TIMEOUT_SECONDS,
            DISCOVERY_KERNEL_INSTALL_TIMEOUT_SECONDS,
            DISCOVERY_REGISTRATION_TIMEOUT_SECONDS,
            BACKEND_SHUTDOWN_TIMEOUT_SECONDS,
        ]
        for timeout in timeouts:
            assert timeout > 0, f"Timeout {timeout} should be positive"

    def test_parallel_workers_is_positive_integer(self):
        """Parallel workers should be a positive integer."""
        from config import DISCOVERY_PARALLEL_WORKERS
        assert isinstance(DISCOVERY_PARALLEL_WORKERS, int)
        assert DISCOVERY_PARALLEL_WORKERS > 0

    def test_llm_temperature_in_valid_range(self):
        """LLM temperature should be between 0 and 2."""
        from config import LLM_DEFAULT_TEMPERATURE
        assert 0 <= LLM_DEFAULT_TEMPERATURE <= 2

    def test_llm_max_tokens_is_positive(self):
        """LLM max tokens should be positive."""
        from config import LLM_DEFAULT_MAX_TOKENS
        assert LLM_DEFAULT_MAX_TOKENS > 0


class TestEnvironmentVariableOverrides:
    """Test that configuration values can be overridden via environment variables."""

    def test_kernel_startup_timeout_from_env(self, monkeypatch):
        """NEBULA_KERNEL_STARTUP_TIMEOUT should override default."""
        monkeypatch.setenv("NEBULA_KERNEL_STARTUP_TIMEOUT", "45")
        # Need to reload the module to pick up new env var
        import importlib
        import config
        importlib.reload(config)
        assert config.KERNEL_STARTUP_TIMEOUT_SECONDS == 45.0
        # Reset
        monkeypatch.delenv("NEBULA_KERNEL_STARTUP_TIMEOUT", raising=False)
        importlib.reload(config)

    def test_discovery_cache_ttl_from_env(self, monkeypatch):
        """NEBULA_DISCOVERY_CACHE_TTL_HOURS should override default."""
        monkeypatch.setenv("NEBULA_DISCOVERY_CACHE_TTL_HOURS", "48")
        import importlib
        import config
        importlib.reload(config)
        assert config.DISCOVERY_CACHE_TTL_HOURS == 48
        # Reset
        monkeypatch.delenv("NEBULA_DISCOVERY_CACHE_TTL_HOURS", raising=False)
        importlib.reload(config)

    def test_llm_max_tokens_from_env(self, monkeypatch):
        """NEBULA_LLM_MAX_TOKENS should override default."""
        monkeypatch.setenv("NEBULA_LLM_MAX_TOKENS", "8192")
        import importlib
        import config
        importlib.reload(config)
        assert config.LLM_DEFAULT_MAX_TOKENS == 8192
        # Reset
        monkeypatch.delenv("NEBULA_LLM_MAX_TOKENS", raising=False)
        importlib.reload(config)

    def test_invalid_env_value_uses_default(self, monkeypatch):
        """Invalid environment variable should fall back to default."""
        monkeypatch.setenv("NEBULA_KERNEL_STARTUP_TIMEOUT", "not_a_number")
        import importlib
        import config
        importlib.reload(config)
        # Should fall back to default of 30.0
        assert config.KERNEL_STARTUP_TIMEOUT_SECONDS == 30.0
        # Reset
        monkeypatch.delenv("NEBULA_KERNEL_STARTUP_TIMEOUT", raising=False)
        importlib.reload(config)
