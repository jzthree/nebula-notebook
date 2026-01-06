"""
Nebula Notebook Backend Configuration

Centralized configuration with environment variable overrides.
All configuration values can be overridden via NEBULA_* environment variables.
"""
import os
from typing import TypeVar

T = TypeVar('T', int, float)


def _get_env_float(name: str, default: float) -> float:
    """Get a float from environment variable, with fallback to default."""
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        print(f"Warning: Invalid value for {name}: {value}, using default {default}")
        return default


def _get_env_int(name: str, default: int) -> int:
    """Get an int from environment variable, with fallback to default."""
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        print(f"Warning: Invalid value for {name}: {value}, using default {default}")
        return default


# =============================================================================
# Kernel Service Configuration
# =============================================================================

# Timeout for kernel startup (waiting for kernel_info_reply)
KERNEL_STARTUP_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_KERNEL_STARTUP_TIMEOUT", 30.0
)

# Timeout for graceful kernel shutdown before forcing
KERNEL_SHUTDOWN_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_KERNEL_SHUTDOWN_TIMEOUT", 5.0
)

# Timeout for shell message responses
KERNEL_MSG_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_KERNEL_MSG_TIMEOUT", 0.5
)

# Polling interval when waiting for kernel operations
KERNEL_POLLING_INTERVAL_SECONDS: float = _get_env_float(
    "NEBULA_KERNEL_POLLING_INTERVAL", 0.1
)


# =============================================================================
# Python Discovery Configuration
# =============================================================================

# How long to cache discovered Python environments (hours)
DISCOVERY_CACHE_TTL_HOURS: int = _get_env_int(
    "NEBULA_DISCOVERY_CACHE_TTL_HOURS", 24
)

# Timeout for checking Python version
DISCOVERY_VERSION_CHECK_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_DISCOVERY_VERSION_CHECK_TIMEOUT", 5.0
)

# Timeout for checking if ipykernel is installed
DISCOVERY_IPYKERNEL_CHECK_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_DISCOVERY_IPYKERNEL_CHECK_TIMEOUT", 10.0
)

# Timeout for listing conda environments
DISCOVERY_CONDA_LIST_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_DISCOVERY_CONDA_LIST_TIMEOUT", 30.0
)

# Number of parallel workers for environment discovery
DISCOVERY_PARALLEL_WORKERS: int = _get_env_int(
    "NEBULA_DISCOVERY_PARALLEL_WORKERS", 10
)

# Timeout for installing ipykernel via pip
DISCOVERY_KERNEL_INSTALL_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_DISCOVERY_KERNEL_INSTALL_TIMEOUT", 120.0
)

# Timeout for registering kernel with Jupyter
DISCOVERY_REGISTRATION_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_DISCOVERY_REGISTRATION_TIMEOUT", 60.0
)


# =============================================================================
# Session Management Configuration
# =============================================================================

# Maximum age of sessions before cleanup (hours)
SESSION_MAX_AGE_HOURS: float = _get_env_float(
    "NEBULA_SESSION_MAX_AGE_HOURS", 24.0
)

# Timeout for backend shutdown cleanup
BACKEND_SHUTDOWN_TIMEOUT_SECONDS: float = _get_env_float(
    "NEBULA_BACKEND_SHUTDOWN_TIMEOUT", 5.0
)


# =============================================================================
# LLM Configuration
# =============================================================================

# Default maximum tokens for LLM responses
LLM_DEFAULT_MAX_TOKENS: int = _get_env_int(
    "NEBULA_LLM_MAX_TOKENS", 4096
)

# Default temperature for LLM requests
LLM_DEFAULT_TEMPERATURE: float = _get_env_float(
    "NEBULA_LLM_TEMPERATURE", 0.2
)
