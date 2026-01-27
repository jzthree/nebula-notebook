"""
Tests for the Nebula error hierarchy.

TDD: These tests define expected error behavior.
"""
import pytest
from errors import (
    NebulaError,
    KernelError,
    KernelNotFoundError,
    KernelStartupError,
    KernelTimeoutError,
    KernelPermissionError,
    KernelInvalidError,
    LLMError,
    LLMAuthenticationError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMProviderError,
    LLMInvalidRequestError,
    FileSystemError,
    FileNotFoundError_,
    FilePermissionError,
    FileExistsError_,
    FileConflictError,
    SessionError,
    SessionNotFoundError,
    SessionExpiredError,
    ValidationError,
)


class TestNebulaErrorBase:
    """Test the base NebulaError class."""

    def test_default_status_code(self):
        """Default status code should be 500."""
        error = NebulaError()
        assert error.status_code == 500

    def test_default_error_code(self):
        """Default error code should be INTERNAL_ERROR."""
        error = NebulaError()
        assert error.error_code == "INTERNAL_ERROR"

    def test_custom_detail(self):
        """Custom detail should be stored."""
        error = NebulaError(detail="Something went wrong")
        assert error.detail == "Something went wrong"
        assert str(error) == "Something went wrong"

    def test_custom_user_message(self):
        """Custom user message should override default."""
        error = NebulaError(user_message="Please try again")
        assert error.user_message == "Please try again"

    def test_to_dict(self):
        """to_dict should return proper structure."""
        error = NebulaError(detail="Technical detail", user_message="User message")
        result = error.to_dict()
        assert result["error_code"] == "INTERNAL_ERROR"
        assert result["detail"] == "Technical detail"
        assert result["user_message"] == "User message"


class TestKernelErrors:
    """Test kernel-related errors."""

    def test_kernel_not_found_status_code(self):
        """KernelNotFoundError should return 404."""
        error = KernelNotFoundError()
        assert error.status_code == 404
        assert error.error_code == "KERNEL_NOT_FOUND"

    def test_kernel_startup_error_status_code(self):
        """KernelStartupError should return 500."""
        error = KernelStartupError()
        assert error.status_code == 500
        assert error.error_code == "KERNEL_STARTUP_FAILED"

    def test_kernel_timeout_status_code(self):
        """KernelTimeoutError should return 504."""
        error = KernelTimeoutError()
        assert error.status_code == 504
        assert error.error_code == "KERNEL_TIMEOUT"

    def test_kernel_permission_status_code(self):
        """KernelPermissionError should return 403."""
        error = KernelPermissionError()
        assert error.status_code == 403
        assert error.error_code == "KERNEL_PERMISSION_DENIED"

    def test_kernel_invalid_status_code(self):
        """KernelInvalidError should return 400."""
        error = KernelInvalidError()
        assert error.status_code == 400
        assert error.error_code == "KERNEL_INVALID"

    def test_kernel_errors_inherit_from_kernel_error(self):
        """All kernel errors should inherit from KernelError."""
        assert issubclass(KernelNotFoundError, KernelError)
        assert issubclass(KernelStartupError, KernelError)
        assert issubclass(KernelTimeoutError, KernelError)
        assert issubclass(KernelPermissionError, KernelError)
        assert issubclass(KernelInvalidError, KernelError)


class TestLLMErrors:
    """Test LLM-related errors."""

    def test_llm_auth_error_status_code(self):
        """LLMAuthenticationError should return 401."""
        error = LLMAuthenticationError()
        assert error.status_code == 401
        assert error.error_code == "LLM_AUTH_FAILED"

    def test_llm_rate_limit_status_code(self):
        """LLMRateLimitError should return 429."""
        error = LLMRateLimitError()
        assert error.status_code == 429
        assert error.error_code == "LLM_RATE_LIMIT"

    def test_llm_timeout_status_code(self):
        """LLMTimeoutError should return 504."""
        error = LLMTimeoutError()
        assert error.status_code == 504
        assert error.error_code == "LLM_TIMEOUT"

    def test_llm_provider_error_status_code(self):
        """LLMProviderError should return 502."""
        error = LLMProviderError()
        assert error.status_code == 502
        assert error.error_code == "LLM_PROVIDER_ERROR"

    def test_llm_invalid_request_status_code(self):
        """LLMInvalidRequestError should return 400."""
        error = LLMInvalidRequestError()
        assert error.status_code == 400
        assert error.error_code == "LLM_INVALID_REQUEST"

    def test_llm_errors_inherit_from_llm_error(self):
        """All LLM errors should inherit from LLMError."""
        assert issubclass(LLMAuthenticationError, LLMError)
        assert issubclass(LLMRateLimitError, LLMError)
        assert issubclass(LLMTimeoutError, LLMError)
        assert issubclass(LLMProviderError, LLMError)
        assert issubclass(LLMInvalidRequestError, LLMError)


class TestFileSystemErrors:
    """Test filesystem-related errors."""

    def test_file_not_found_status_code(self):
        """FileNotFoundError_ should return 404."""
        error = FileNotFoundError_()
        assert error.status_code == 404
        assert error.error_code == "FILE_NOT_FOUND"

    def test_file_permission_status_code(self):
        """FilePermissionError should return 403."""
        error = FilePermissionError()
        assert error.status_code == 403
        assert error.error_code == "FILE_PERMISSION_DENIED"

    def test_file_exists_status_code(self):
        """FileExistsError_ should return 409."""
        error = FileExistsError_()
        assert error.status_code == 409
        assert error.error_code == "FILE_EXISTS"

    def test_file_conflict_status_code(self):
        """FileConflictError should return 409."""
        error = FileConflictError()
        assert error.status_code == 409
        assert error.error_code == "FILE_CONFLICT"

    def test_fs_errors_inherit_from_filesystem_error(self):
        """All filesystem errors should inherit from FileSystemError."""
        assert issubclass(FileNotFoundError_, FileSystemError)
        assert issubclass(FilePermissionError, FileSystemError)
        assert issubclass(FileExistsError_, FileSystemError)
        assert issubclass(FileConflictError, FileSystemError)


class TestSessionErrors:
    """Test session-related errors."""

    def test_session_not_found_status_code(self):
        """SessionNotFoundError should return 404."""
        error = SessionNotFoundError()
        assert error.status_code == 404
        assert error.error_code == "SESSION_NOT_FOUND"

    def test_session_expired_status_code(self):
        """SessionExpiredError should return 401."""
        error = SessionExpiredError()
        assert error.status_code == 401
        assert error.error_code == "SESSION_EXPIRED"


class TestValidationError:
    """Test validation errors."""

    def test_validation_error_status_code(self):
        """ValidationError should return 400."""
        error = ValidationError()
        assert error.status_code == 400
        assert error.error_code == "VALIDATION_ERROR"

    def test_validation_error_with_detail(self):
        """ValidationError should accept custom detail."""
        error = ValidationError(detail="Missing required field: name")
        assert error.detail == "Missing required field: name"


class TestErrorHierarchy:
    """Test overall error hierarchy structure."""

    def test_all_errors_inherit_from_nebula_error(self):
        """All error types should inherit from NebulaError."""
        error_types = [
            KernelError,
            KernelNotFoundError,
            KernelStartupError,
            LLMError,
            LLMAuthenticationError,
            LLMRateLimitError,
            FileSystemError,
            FileNotFoundError_,
            SessionError,
            ValidationError,
        ]
        for error_type in error_types:
            assert issubclass(error_type, NebulaError), f"{error_type} should inherit from NebulaError"

    def test_all_errors_have_user_message(self):
        """All error types should have a user_message."""
        error_types = [
            NebulaError,
            KernelNotFoundError,
            KernelStartupError,
            KernelTimeoutError,
            LLMAuthenticationError,
            LLMRateLimitError,
            LLMTimeoutError,
            FileNotFoundError_,
            FilePermissionError,
            SessionNotFoundError,
            ValidationError,
        ]
        for error_type in error_types:
            error = error_type()
            assert error.user_message, f"{error_type} should have a user_message"
            assert len(error.user_message) > 0

    def test_status_codes_are_valid_http_codes(self):
        """All status codes should be valid HTTP status codes."""
        error_types = [
            KernelNotFoundError,
            KernelStartupError,
            KernelTimeoutError,
            KernelPermissionError,
            LLMAuthenticationError,
            LLMRateLimitError,
            LLMTimeoutError,
            LLMProviderError,
            FileNotFoundError_,
            FilePermissionError,
            FileExistsError_,
            SessionNotFoundError,
            SessionExpiredError,
            ValidationError,
        ]
        valid_status_codes = {400, 401, 403, 404, 409, 429, 500, 502, 504}
        for error_type in error_types:
            error = error_type()
            assert error.status_code in valid_status_codes, f"{error_type} has invalid status code {error.status_code}"
