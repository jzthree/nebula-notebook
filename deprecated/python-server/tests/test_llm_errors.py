"""
Tests for LLM service error handling.

TDD: These tests define expected error wrapping behavior.
"""
import pytest
from unittest.mock import MagicMock
from errors import (
    LLMAuthenticationError,
    LLMRateLimitError,
    LLMTimeoutError,
    LLMProviderError,
    LLMInvalidRequestError,
    convert_sdk_error,
)


class TestConvertSdkError:
    """Test the SDK error conversion function."""

    def test_convert_openai_auth_error(self):
        """OpenAI AuthenticationError should convert to LLMAuthenticationError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "AuthenticationError"
        mock_error.status_code = 401
        mock_error.__str__ = lambda self: "Invalid API key"

        result = convert_sdk_error(mock_error, "openai")

        assert isinstance(result, LLMAuthenticationError)
        assert result.status_code == 401
        assert "API key" in result.user_message

    def test_convert_openai_rate_limit_error(self):
        """OpenAI RateLimitError should convert to LLMRateLimitError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "RateLimitError"
        mock_error.status_code = 429
        mock_error.__str__ = lambda self: "Rate limit exceeded"

        result = convert_sdk_error(mock_error, "openai")

        assert isinstance(result, LLMRateLimitError)
        assert result.status_code == 429

    def test_convert_openai_timeout_error(self):
        """OpenAI timeout should convert to LLMTimeoutError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "APITimeoutError"
        mock_error.__str__ = lambda self: "Request timed out"

        result = convert_sdk_error(mock_error, "openai")

        assert isinstance(result, LLMTimeoutError)
        assert result.status_code == 504

    def test_convert_openai_bad_request_error(self):
        """OpenAI BadRequestError should convert to LLMInvalidRequestError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "BadRequestError"
        mock_error.status_code = 400
        mock_error.__str__ = lambda self: "Invalid request"

        result = convert_sdk_error(mock_error, "openai")

        assert isinstance(result, LLMInvalidRequestError)
        assert result.status_code == 400

    def test_convert_openai_internal_server_error(self):
        """OpenAI InternalServerError should convert to LLMProviderError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "InternalServerError"
        mock_error.status_code = 500
        mock_error.__str__ = lambda self: "Server error"

        result = convert_sdk_error(mock_error, "openai")

        assert isinstance(result, LLMProviderError)
        assert result.status_code == 502

    def test_convert_anthropic_auth_error(self):
        """Anthropic AuthenticationError should convert to LLMAuthenticationError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "AuthenticationError"
        mock_error.status_code = 401
        mock_error.__str__ = lambda self: "Invalid API key"

        result = convert_sdk_error(mock_error, "anthropic")

        assert isinstance(result, LLMAuthenticationError)
        assert result.status_code == 401

    def test_convert_anthropic_rate_limit_error(self):
        """Anthropic RateLimitError should convert to LLMRateLimitError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "RateLimitError"
        mock_error.status_code = 429
        mock_error.__str__ = lambda self: "Rate limit exceeded"

        result = convert_sdk_error(mock_error, "anthropic")

        assert isinstance(result, LLMRateLimitError)
        assert result.status_code == 429

    def test_convert_google_rate_limit_error(self):
        """Google RESOURCE_EXHAUSTED should convert to LLMRateLimitError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "ClientError"
        mock_error.__str__ = lambda self: "429 RESOURCE_EXHAUSTED: Rate limit exceeded"

        result = convert_sdk_error(mock_error, "google")

        assert isinstance(result, LLMRateLimitError)
        assert result.status_code == 429

    def test_convert_google_auth_error(self):
        """Google authentication error should convert to LLMAuthenticationError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "ClientError"
        mock_error.__str__ = lambda self: "API key not valid"

        result = convert_sdk_error(mock_error, "google")

        assert isinstance(result, LLMAuthenticationError)
        assert result.status_code == 401

    def test_convert_google_timeout(self):
        """Google timeout error should convert to LLMTimeoutError."""
        mock_error = MagicMock()
        mock_error.__class__.__name__ = "ReadTimeout"
        mock_error.__str__ = lambda self: "Request timed out"

        result = convert_sdk_error(mock_error, "google")

        assert isinstance(result, LLMTimeoutError)
        assert result.status_code == 504

    def test_convert_unknown_error_preserves_message(self):
        """Unknown errors should convert to LLMProviderError with original message."""
        mock_error = Exception("Something unexpected happened")

        result = convert_sdk_error(mock_error, "openai")

        assert isinstance(result, LLMProviderError)
        assert "Something unexpected happened" in result.detail

    def test_convert_api_key_not_found(self):
        """ValueError for missing API key should convert to LLMAuthenticationError."""
        error = ValueError("OPENAI_API_KEY not found in environment")

        result = convert_sdk_error(error, "openai")

        assert isinstance(result, LLMAuthenticationError)
        assert result.status_code == 401


class TestLLMErrorResponseFormat:
    """Test that LLM errors produce correct response format."""

    def test_llm_auth_error_to_dict(self):
        """LLMAuthenticationError should serialize correctly."""
        error = LLMAuthenticationError(detail="Invalid API key provided")
        result = error.to_dict()

        assert result["error_code"] == "LLM_AUTH_FAILED"
        assert result["detail"] == "Invalid API key provided"
        assert "API key" in result["user_message"]

    def test_llm_rate_limit_error_to_dict(self):
        """LLMRateLimitError should serialize correctly."""
        error = LLMRateLimitError(detail="Too many requests")
        result = error.to_dict()

        assert result["error_code"] == "LLM_RATE_LIMIT"
        assert result["detail"] == "Too many requests"

    def test_llm_timeout_error_to_dict(self):
        """LLMTimeoutError should serialize correctly."""
        error = LLMTimeoutError(detail="Request took too long")
        result = error.to_dict()

        assert result["error_code"] == "LLM_TIMEOUT"
        assert result["detail"] == "Request took too long"
