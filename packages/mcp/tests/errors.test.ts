/**
 * Tests for error classification system
 */

import { describe, it, expect } from 'vitest';
import {
  classifyError,
  ErrorCategory,
  getErrorMessage,
  formatErrorMessage,
  shouldRetry,
  calculateRetryDelay,
  ClassifiedError,
} from '../src/errors.js';

describe('Error Classification System', () => {
  describe('getErrorMessage', () => {
    it('should extract message from Error object', () => {
      const error = new Error('Test error message');
      expect(getErrorMessage(error)).toBe('Test error message');
    });

    it('should return string errors as-is', () => {
      expect(getErrorMessage('String error')).toBe('String error');
    });

    it('should extract message from object with message property', () => {
      expect(getErrorMessage({ message: 'Object error' })).toBe('Object error');
    });

    it('should convert other types to string', () => {
      expect(getErrorMessage(42)).toBe('42');
      expect(getErrorMessage(null)).toBe('null');
      expect(getErrorMessage(undefined)).toBe('undefined');
    });
  });

  describe('classifyError - Network Errors', () => {
    it('should classify ECONNREFUSED as network error', () => {
      const result = classifyError(new Error('connect ECONNREFUSED 127.0.0.1:8000'));
      expect(result.category).toBe(ErrorCategory.NETWORK);
      expect(result.recoverable).toBe('recoverable');
      expect(result.retryable).toBe(true);
    });

    it('should classify ECONNRESET as network error', () => {
      const result = classifyError(new Error('read ECONNRESET'));
      expect(result.category).toBe(ErrorCategory.NETWORK);
      expect(result.retryable).toBe(true);
    });

    it('should classify DNS errors as network error', () => {
      const result = classifyError(new Error('getaddrinfo ENOTFOUND localhost'));
      expect(result.category).toBe(ErrorCategory.NETWORK);
    });

    it('should classify generic network errors', () => {
      const result = classifyError(new Error('Network request failed'));
      expect(result.category).toBe(ErrorCategory.NETWORK);
    });

    it('should classify socket errors as network error', () => {
      const result = classifyError(new Error('socket hang up'));
      expect(result.category).toBe(ErrorCategory.NETWORK);
    });

    it('should classify connection refused as network error', () => {
      const result = classifyError(new Error('Connection refused'));
      expect(result.category).toBe(ErrorCategory.NETWORK);
    });
  });

  describe('classifyError - Timeout Errors', () => {
    it('should classify AbortError as timeout', () => {
      const error = new Error('The operation was aborted');
      error.name = 'AbortError';
      const result = classifyError(error);
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
      expect(result.recoverable).toBe('recoverable');
      expect(result.retryable).toBe(true);
    });

    it('should classify timeout message as timeout', () => {
      const result = classifyError(new Error('Request timeout after 30000ms'));
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
    });

    it('should classify "timed out" as timeout', () => {
      const result = classifyError(new Error('Connection timed out'));
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
    });
  });

  describe('classifyError - HTTP Status Codes', () => {
    describe('Server Errors (5xx)', () => {
      it('should classify 500 as server error', () => {
        const result = classifyError(new Error('Internal Server Error'), 500);
        expect(result.category).toBe(ErrorCategory.SERVER);
        expect(result.statusCode).toBe(500);
        expect(result.recoverable).toBe('recoverable');
        expect(result.retryable).toBe(true);
      });

      it('should classify 502 as server error', () => {
        const result = classifyError(new Error('Bad Gateway'), 502);
        expect(result.category).toBe(ErrorCategory.SERVER);
      });

      it('should classify 503 as server error', () => {
        const result = classifyError(new Error('Service Unavailable'), 503);
        expect(result.category).toBe(ErrorCategory.SERVER);
        expect(result.retryable).toBe(true);
      });

      it('should classify 504 as server error', () => {
        const result = classifyError(new Error('Gateway Timeout'), 504);
        expect(result.category).toBe(ErrorCategory.SERVER);
      });
    });

    describe('Client Errors (4xx)', () => {
      it('should classify 400 as client error', () => {
        const result = classifyError(new Error('Bad Request'), 400);
        expect(result.category).toBe(ErrorCategory.CLIENT);
        expect(result.statusCode).toBe(400);
        expect(result.recoverable).toBe('non-recoverable');
        expect(result.retryable).toBe(false);
      });

      it('should classify 404 as client error', () => {
        const result = classifyError(new Error('Not Found'), 404);
        expect(result.category).toBe(ErrorCategory.CLIENT);
        expect(result.retryable).toBe(false);
      });

      it('should classify 401 as client error', () => {
        const result = classifyError(new Error('Unauthorized'), 401);
        expect(result.category).toBe(ErrorCategory.CLIENT);
        expect(result.retryable).toBe(false);
      });

      it('should classify 429 as rate limiting (retryable)', () => {
        const result = classifyError(new Error('Too Many Requests'), 429);
        expect(result.category).toBe(ErrorCategory.CLIENT);
        expect(result.statusCode).toBe(429);
        expect(result.recoverable).toBe('recoverable');
        expect(result.retryable).toBe(true);
        expect(result.retryDelayMs).toBeGreaterThan(1000); // Should have longer delay
      });

      it('should classify 408 as timeout', () => {
        const result = classifyError(new Error('Request Timeout'), 408);
        expect(result.category).toBe(ErrorCategory.TIMEOUT);
        expect(result.retryable).toBe(true);
      });
    });
  });

  describe('classifyError - Kernel Errors', () => {
    it('should classify kernel not found as kernel error', () => {
      const result = classifyError(new Error('Kernel not found'));
      expect(result.category).toBe(ErrorCategory.KERNEL);
      expect(result.recoverable).toBe('non-recoverable');
    });

    it('should classify session not found as kernel error', () => {
      const result = classifyError(new Error('Session not found: abc-123'));
      expect(result.category).toBe(ErrorCategory.KERNEL);
    });

    it('should classify busy kernel as potentially recoverable', () => {
      const result = classifyError(new Error('Kernel is busy'));
      expect(result.category).toBe(ErrorCategory.KERNEL);
      expect(result.recoverable).toBe('potentially-recoverable');
    });

    it('should classify starting kernel as potentially recoverable', () => {
      const result = classifyError(new Error('Kernel is starting'));
      expect(result.category).toBe(ErrorCategory.KERNEL);
      expect(result.recoverable).toBe('potentially-recoverable');
    });

    it('should classify kernel crash as non-recoverable', () => {
      const result = classifyError(new Error('Kernel crashed'));
      expect(result.category).toBe(ErrorCategory.KERNEL);
      expect(result.recoverable).toBe('non-recoverable');
    });
  });

  describe('classifyError - Notebook Errors', () => {
    it('should classify notebook parse error', () => {
      const result = classifyError(new Error('Failed to parse notebook'));
      expect(result.category).toBe(ErrorCategory.NOTEBOOK);
      expect(result.recoverable).toBe('non-recoverable');
      expect(result.retryable).toBe(false);
    });

    it('should classify invalid JSON as notebook error', () => {
      const result = classifyError(new Error('Invalid JSON in notebook'));
      expect(result.category).toBe(ErrorCategory.NOTEBOOK);
    });

    it('should classify cell index errors as notebook error', () => {
      const result = classifyError(new Error('Cell index 5 out of range'));
      expect(result.category).toBe(ErrorCategory.NOTEBOOK);
    });

    it('should classify nbformat errors as notebook error', () => {
      const result = classifyError(new Error('Unsupported nbformat version'));
      expect(result.category).toBe(ErrorCategory.NOTEBOOK);
    });
  });

  describe('classifyError - Execution Errors', () => {
    it('should classify execution failure', () => {
      const result = classifyError(new Error('Execution failed'));
      expect(result.category).toBe(ErrorCategory.EXECUTION);
      expect(result.recoverable).toBe('non-recoverable');
    });

    it('should classify runtime error', () => {
      const result = classifyError(new Error('Runtime error in cell'));
      expect(result.category).toBe(ErrorCategory.EXECUTION);
    });

    it('should classify Python exception', () => {
      const result = classifyError(new Error('Exception: NameError'));
      expect(result.category).toBe(ErrorCategory.EXECUTION);
    });

    it('should classify traceback as execution error', () => {
      const result = classifyError(new Error('Traceback (most recent call last)'));
      expect(result.category).toBe(ErrorCategory.EXECUTION);
    });
  });

  describe('classifyError - Validation Errors', () => {
    it('should classify invalid input', () => {
      const result = classifyError(new Error('Invalid parameter value'));
      expect(result.category).toBe(ErrorCategory.VALIDATION);
      expect(result.recoverable).toBe('non-recoverable');
      expect(result.retryable).toBe(false);
    });

    it('should classify out of range errors', () => {
      const result = classifyError(new Error('Index out of range'));
      expect(result.category).toBe(ErrorCategory.VALIDATION);
    });

    it('should classify missing required fields', () => {
      const result = classifyError(new Error('Required field missing'));
      expect(result.category).toBe(ErrorCategory.VALIDATION);
    });
  });

  describe('classifyError - Unknown Errors', () => {
    it('should classify unrecognized errors as unknown', () => {
      const result = classifyError(new Error('Something unexpected happened'));
      expect(result.category).toBe(ErrorCategory.UNKNOWN);
      expect(result.recoverable).toBe('potentially-recoverable');
      expect(result.retryable).toBe(false);
    });

    it('should preserve original error', () => {
      const originalError = new Error('Original error');
      const result = classifyError(originalError);
      expect(result.originalError).toBe(originalError);
    });
  });

  describe('formatErrorMessage', () => {
    it('should format network error', () => {
      const error: ClassifiedError = {
        message: 'Connection refused',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      };
      expect(formatErrorMessage(error)).toBe('Network error: Connection refused');
    });

    it('should format error with status code', () => {
      const error: ClassifiedError = {
        message: 'Not Found',
        category: ErrorCategory.CLIENT,
        statusCode: 404,
        recoverable: 'non-recoverable',
        retryable: false,
      };
      expect(formatErrorMessage(error)).toBe('Client error (404): Not Found');
    });

    it('should format server error', () => {
      const error: ClassifiedError = {
        message: 'Internal error',
        category: ErrorCategory.SERVER,
        statusCode: 500,
        recoverable: 'recoverable',
        retryable: true,
      };
      expect(formatErrorMessage(error)).toBe('Server error (500): Internal error');
    });

    it('should format timeout error', () => {
      const error: ClassifiedError = {
        message: 'Request took too long',
        category: ErrorCategory.TIMEOUT,
        recoverable: 'recoverable',
        retryable: true,
      };
      expect(formatErrorMessage(error)).toBe('Request timed out: Request took too long');
    });

    it('should format kernel error', () => {
      const error: ClassifiedError = {
        message: 'Kernel not found',
        category: ErrorCategory.KERNEL,
        recoverable: 'non-recoverable',
        retryable: false,
      };
      expect(formatErrorMessage(error)).toBe('Kernel error: Kernel not found');
    });
  });

  describe('shouldRetry', () => {
    it('should return true for retryable errors within max retries', () => {
      const error: ClassifiedError = {
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      };
      expect(shouldRetry(error, 0, 3)).toBe(true);
      expect(shouldRetry(error, 1, 3)).toBe(true);
      expect(shouldRetry(error, 2, 3)).toBe(true);
    });

    it('should return false when max retries exceeded', () => {
      const error: ClassifiedError = {
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      };
      expect(shouldRetry(error, 3, 3)).toBe(false);
      expect(shouldRetry(error, 4, 3)).toBe(false);
    });

    it('should return false for non-retryable errors', () => {
      const error: ClassifiedError = {
        message: 'Client error',
        category: ErrorCategory.CLIENT,
        recoverable: 'non-recoverable',
        retryable: false,
      };
      expect(shouldRetry(error, 0, 3)).toBe(false);
    });
  });

  describe('calculateRetryDelay', () => {
    it('should use base delay for first retry', () => {
      const error: ClassifiedError = {
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
        retryDelayMs: 1000,
      };
      const delay = calculateRetryDelay(error, 0);
      // First retry: 1000 * 2^0 = 1000, plus up to 30% jitter
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1300);
    });

    it('should apply exponential backoff', () => {
      const error: ClassifiedError = {
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
        retryDelayMs: 1000,
      };

      const delay0 = calculateRetryDelay(error, 0);
      const delay1 = calculateRetryDelay(error, 1);
      const delay2 = calculateRetryDelay(error, 2);

      // Each retry should be roughly double (accounting for jitter)
      expect(delay1).toBeGreaterThan(delay0);
      expect(delay2).toBeGreaterThan(delay1);
    });

    it('should cap delay at 30 seconds', () => {
      const error: ClassifiedError = {
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
        retryDelayMs: 5000,
      };
      const delay = calculateRetryDelay(error, 10); // Very high attempt number
      expect(delay).toBeLessThanOrEqual(30000);
    });

    it('should use default delay if not specified', () => {
      const error: ClassifiedError = {
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      };
      const delay = calculateRetryDelay(error, 0);
      expect(delay).toBeGreaterThanOrEqual(1000);
    });
  });

  describe('Error Classification Priority', () => {
    it('should prioritize timeout over network for AbortError', () => {
      const error = new Error('Network request aborted');
      error.name = 'AbortError';
      const result = classifyError(error);
      expect(result.category).toBe(ErrorCategory.TIMEOUT);
    });

    it('should prioritize HTTP status over message content', () => {
      // Even if message mentions network, status code takes precedence
      const result = classifyError(new Error('Network issue caused server error'), 500);
      expect(result.category).toBe(ErrorCategory.SERVER);
    });
  });
});
