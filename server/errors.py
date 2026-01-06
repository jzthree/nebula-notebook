"""
Nebula Notebook Backend Error Hierarchy

Custom exception classes for structured error handling.
Each exception type includes:
- status_code: HTTP status code to return
- error_code: Machine-readable error code for frontend
- user_message: Human-readable message for display
"""


class NebulaError(Exception):
    """Base exception for all Nebula backend errors.

    Subclasses should override class attributes to customize behavior.
    Instance attributes can be set in __init__ to override defaults.
    """
    status_code: int = 500
    error_code: str = "INTERNAL_ERROR"
    user_message: str = "An unexpected error occurred"

    def __init__(self, detail: str = None, user_message: str = None):
        """Initialize the error.

        Args:
            detail: Technical detail for logging (default: user_message)
            user_message: User-friendly message (overrides class default)
        """
        self.detail = detail or self.user_message
        if user_message:
            self.user_message = user_message
        super().__init__(self.detail)

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON response."""
        return {
            "error_code": self.error_code,
            "detail": self.detail,
            "user_message": self.user_message,
        }


# =============================================================================
# Kernel Errors
# =============================================================================

class KernelError(NebulaError):
    """Base class for kernel-related errors."""
    error_code = "KERNEL_ERROR"
    user_message = "A kernel error occurred"


class KernelNotFoundError(KernelError):
    """Kernel session not found."""
    status_code = 404
    error_code = "KERNEL_NOT_FOUND"
    user_message = "Kernel session not found"


class KernelStartupError(KernelError):
    """Failed to start kernel."""
    status_code = 500
    error_code = "KERNEL_STARTUP_FAILED"
    user_message = "Failed to start kernel. Check that Python is installed correctly."


class KernelTimeoutError(KernelError):
    """Kernel operation timed out."""
    status_code = 504
    error_code = "KERNEL_TIMEOUT"
    user_message = "Kernel operation timed out. The kernel may be busy or unresponsive."


class KernelPermissionError(KernelError):
    """Permission denied to start kernel."""
    status_code = 403
    error_code = "KERNEL_PERMISSION_DENIED"
    user_message = "Permission denied to start kernel"


class KernelInvalidError(KernelError):
    """Invalid kernel specification."""
    status_code = 400
    error_code = "KERNEL_INVALID"
    user_message = "Invalid kernel specification"


# =============================================================================
# LLM Errors
# =============================================================================

class LLMError(NebulaError):
    """Base class for LLM-related errors."""
    error_code = "LLM_ERROR"
    user_message = "An error occurred with the AI service"


class LLMAuthenticationError(LLMError):
    """Invalid API key or authentication failure."""
    status_code = 401
    error_code = "LLM_AUTH_FAILED"
    user_message = "Invalid API key. Please check your API key in Settings."


class LLMRateLimitError(LLMError):
    """Rate limit exceeded - can be retried."""
    status_code = 429
    error_code = "LLM_RATE_LIMIT"
    user_message = "Rate limit exceeded. Please wait a moment and try again."


class LLMTimeoutError(LLMError):
    """LLM request timed out."""
    status_code = 504
    error_code = "LLM_TIMEOUT"
    user_message = "AI request timed out. Please try again."


class LLMProviderError(LLMError):
    """LLM provider returned an error."""
    status_code = 502
    error_code = "LLM_PROVIDER_ERROR"
    user_message = "The AI service returned an error. Please try again."


class LLMInvalidRequestError(LLMError):
    """Invalid request to LLM (e.g., content too long)."""
    status_code = 400
    error_code = "LLM_INVALID_REQUEST"
    user_message = "Invalid request to AI service. The content may be too long."


# =============================================================================
# File System Errors
# =============================================================================

class FileSystemError(NebulaError):
    """Base class for filesystem-related errors."""
    error_code = "FS_ERROR"
    user_message = "A file system error occurred"


class FileNotFoundError_(FileSystemError):
    """File or directory not found.

    Note: Named with underscore to avoid shadowing builtin.
    """
    status_code = 404
    error_code = "FILE_NOT_FOUND"
    user_message = "File or directory not found"


class FilePermissionError(FileSystemError):
    """Permission denied for file operation."""
    status_code = 403
    error_code = "FILE_PERMISSION_DENIED"
    user_message = "Permission denied. Check file permissions."


class FileExistsError_(FileSystemError):
    """File already exists (for create operations).

    Note: Named with underscore to avoid shadowing builtin.
    """
    status_code = 409
    error_code = "FILE_EXISTS"
    user_message = "A file with this name already exists"


class FileConflictError(FileSystemError):
    """File was modified externally (conflict detected)."""
    status_code = 409
    error_code = "FILE_CONFLICT"
    user_message = "File was modified by another process. Please reload or choose to overwrite."


# =============================================================================
# Session Errors
# =============================================================================

class SessionError(NebulaError):
    """Base class for session-related errors."""
    error_code = "SESSION_ERROR"
    user_message = "A session error occurred"


class SessionNotFoundError(SessionError):
    """Session not found."""
    status_code = 404
    error_code = "SESSION_NOT_FOUND"
    user_message = "Session not found"


class SessionExpiredError(SessionError):
    """Session has expired."""
    status_code = 401
    error_code = "SESSION_EXPIRED"
    user_message = "Your session has expired. Please refresh the page."


# =============================================================================
# Validation Errors
# =============================================================================

class ValidationError(NebulaError):
    """Invalid request data."""
    status_code = 400
    error_code = "VALIDATION_ERROR"
    user_message = "Invalid request data"
