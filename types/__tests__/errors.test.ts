/**
 * Tests for frontend error types.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  NebulaError,
  NetworkError,
  TimeoutError,
  APIError,
  RETRYABLE_ERROR_CODES,
  AUTH_ERROR_CODES,
  calculateRetryDelay,
  withRetry,
  DEFAULT_RETRY_CONFIG,
  isNebulaError,
  getErrorMessage,
} from '../errors';

describe('NebulaError', () => {
  describe('constructor', () => {
    it('should create error with all properties', () => {
      const error = new NebulaError(
        'Technical detail',
        'TEST_ERROR',
        'User-friendly message',
        true,
        500
      );

      expect(error.message).toBe('Technical detail');
      expect(error.errorCode).toBe('TEST_ERROR');
      expect(error.userMessage).toBe('User-friendly message');
      expect(error.isRetryable).toBe(true);
      expect(error.statusCode).toBe(500);
      expect(error.name).toBe('NebulaError');
    });

    it('should default isRetryable to false', () => {
      const error = new NebulaError('msg', 'CODE', 'user msg');
      expect(error.isRetryable).toBe(false);
    });
  });

  describe('fromAPIError', () => {
    it('should create NebulaError from API response', () => {
      const apiError: APIError = {
        status: 429,
        error_code: 'LLM_RATE_LIMIT',
        detail: 'Rate limit exceeded',
        user_message: 'Please wait and try again',
      };

      const error = NebulaError.fromAPIError(apiError);

      expect(error.errorCode).toBe('LLM_RATE_LIMIT');
      expect(error.userMessage).toBe('Please wait and try again');
      expect(error.statusCode).toBe(429);
      expect(error.isRetryable).toBe(true); // Rate limit is retryable
    });

    it('should mark non-retryable errors correctly', () => {
      const apiError: APIError = {
        status: 401,
        error_code: 'LLM_AUTH_FAILED',
        detail: 'Invalid API key',
        user_message: 'Check your API key',
      };

      const error = NebulaError.fromAPIError(apiError);
      expect(error.isRetryable).toBe(false);
    });
  });

  describe('fromResponse', () => {
    it('should parse structured error response', async () => {
      const mockResponse = {
        status: 429,
        statusText: 'Too Many Requests',
        json: async () => ({
          error_code: 'LLM_RATE_LIMIT',
          detail: 'Rate limit exceeded',
          user_message: 'Please wait',
        }),
      } as Response;

      const error = await NebulaError.fromResponse(mockResponse);

      expect(error.errorCode).toBe('LLM_RATE_LIMIT');
      expect(error.statusCode).toBe(429);
    });

    it('should handle non-structured error response', async () => {
      const mockResponse = {
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => ({
          detail: 'Something went wrong',
        }),
      } as Response;

      const error = await NebulaError.fromResponse(mockResponse);

      expect(error.errorCode).toBe('UNKNOWN_ERROR');
      expect(error.statusCode).toBe(500);
    });

    it('should handle JSON parse failure', async () => {
      const mockResponse = {
        status: 500,
        statusText: 'Internal Server Error',
        json: async () => {
          throw new Error('Invalid JSON');
        },
      } as unknown as Response;

      const error = await NebulaError.fromResponse(mockResponse);

      expect(error.errorCode).toBe('UNKNOWN_ERROR');
      expect(error.message).toBe('Internal Server Error');
    });
  });

  describe('isAuthError', () => {
    it('should return true for auth errors', () => {
      const error = new NebulaError('msg', 'LLM_AUTH_FAILED', 'user msg');
      expect(error.isAuthError()).toBe(true);
    });

    it('should return false for non-auth errors', () => {
      const error = new NebulaError('msg', 'LLM_RATE_LIMIT', 'user msg');
      expect(error.isAuthError()).toBe(false);
    });
  });
});

describe('NetworkError', () => {
  it('should have correct defaults', () => {
    const error = new NetworkError();

    expect(error.errorCode).toBe('NETWORK_ERROR');
    expect(error.isRetryable).toBe(true);
    expect(error.name).toBe('NetworkError');
  });

  it('should accept custom message', () => {
    const error = new NetworkError('Custom connection error');
    expect(error.message).toBe('Custom connection error');
  });
});

describe('TimeoutError', () => {
  it('should have correct defaults', () => {
    const error = new TimeoutError();

    expect(error.errorCode).toBe('TIMEOUT');
    expect(error.isRetryable).toBe(true);
    expect(error.name).toBe('TimeoutError');
  });
});

describe('RETRYABLE_ERROR_CODES', () => {
  it('should include rate limit error', () => {
    expect(RETRYABLE_ERROR_CODES.has('LLM_RATE_LIMIT')).toBe(true);
  });

  it('should include timeout errors', () => {
    expect(RETRYABLE_ERROR_CODES.has('LLM_TIMEOUT')).toBe(true);
    expect(RETRYABLE_ERROR_CODES.has('KERNEL_TIMEOUT')).toBe(true);
  });

  it('should include provider error', () => {
    expect(RETRYABLE_ERROR_CODES.has('LLM_PROVIDER_ERROR')).toBe(true);
  });

  it('should not include auth errors', () => {
    expect(RETRYABLE_ERROR_CODES.has('LLM_AUTH_FAILED')).toBe(false);
  });
});

describe('AUTH_ERROR_CODES', () => {
  it('should include LLM auth failure', () => {
    expect(AUTH_ERROR_CODES.has('LLM_AUTH_FAILED')).toBe(true);
  });

  it('should include session expired', () => {
    expect(AUTH_ERROR_CODES.has('SESSION_EXPIRED')).toBe(true);
  });
});

describe('calculateRetryDelay', () => {
  it('should return base delay for first attempt', () => {
    const delay = calculateRetryDelay(0, DEFAULT_RETRY_CONFIG);
    // With ±10% jitter, delay should be between 900-1100ms
    expect(delay).toBeGreaterThanOrEqual(900);
    expect(delay).toBeLessThanOrEqual(1100);
  });

  it('should increase delay exponentially', () => {
    const delay0 = calculateRetryDelay(0, { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 1000 });
    const delay1 = calculateRetryDelay(1, { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 1000 });
    const delay2 = calculateRetryDelay(2, { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 1000 });

    // Approximately: 1000, 2000, 4000 (with jitter)
    expect(delay1).toBeGreaterThan(delay0);
    expect(delay2).toBeGreaterThan(delay1);
  });

  it('should cap delay at maxDelayMs', () => {
    const config = { ...DEFAULT_RETRY_CONFIG, maxDelayMs: 5000 };
    const delay = calculateRetryDelay(10, config);

    // Should not exceed max + 10% jitter
    expect(delay).toBeLessThanOrEqual(5500);
  });
});

describe('withRetry', () => {
  it('should succeed on first attempt', async () => {
    const fn = vi.fn().mockResolvedValue('success');

    const result = await withRetry(fn);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should retry on retryable error', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new NebulaError('error', 'LLM_RATE_LIMIT', 'msg', true))
      .mockResolvedValue('success');

    const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 10 };
    const result = await withRetry(fn, config);

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('should not retry non-retryable errors', async () => {
    const fn = vi.fn().mockRejectedValue(
      new NebulaError('error', 'LLM_AUTH_FAILED', 'msg', false)
    );

    const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 10 };

    await expect(withRetry(fn, config)).rejects.toThrow(NebulaError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('should call onRetry callback', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new NebulaError('error', 'LLM_RATE_LIMIT', 'msg', true))
      .mockResolvedValue('success');
    const onRetry = vi.fn();

    const config = { ...DEFAULT_RETRY_CONFIG, baseDelayMs: 10 };
    await withRetry(fn, config, onRetry);

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(
      1,
      expect.any(Number),
      expect.any(NebulaError)
    );
  });

  it('should throw after max retries', async () => {
    const error = new NebulaError('error', 'LLM_RATE_LIMIT', 'msg', true);
    const fn = vi.fn().mockRejectedValue(error);

    const config = { ...DEFAULT_RETRY_CONFIG, maxRetries: 2, baseDelayMs: 10 };

    await expect(withRetry(fn, config)).rejects.toThrow(NebulaError);
    expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
  });

  it('should convert non-NebulaError to NebulaError', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('Regular error'));

    const config = { ...DEFAULT_RETRY_CONFIG, maxRetries: 0 };

    await expect(withRetry(fn, config)).rejects.toThrow(NebulaError);
  });
});

describe('isNebulaError', () => {
  it('should return true for NebulaError', () => {
    const error = new NebulaError('msg', 'CODE', 'user msg');
    expect(isNebulaError(error)).toBe(true);
  });

  it('should return true for subclasses', () => {
    const error = new NetworkError();
    expect(isNebulaError(error)).toBe(true);
  });

  it('should return false for regular Error', () => {
    const error = new Error('msg');
    expect(isNebulaError(error)).toBe(false);
  });

  it('should return false for non-errors', () => {
    expect(isNebulaError('string')).toBe(false);
    expect(isNebulaError(null)).toBe(false);
    expect(isNebulaError(undefined)).toBe(false);
  });
});

describe('getErrorMessage', () => {
  it('should return userMessage for NebulaError', () => {
    const error = new NebulaError('technical', 'CODE', 'User message');
    expect(getErrorMessage(error)).toBe('User message');
  });

  it('should return message for regular Error', () => {
    const error = new Error('Regular message');
    expect(getErrorMessage(error)).toBe('Regular message');
  });

  it('should return generic message for unknown errors', () => {
    expect(getErrorMessage('string error')).toBe('An unexpected error occurred');
    expect(getErrorMessage(null)).toBe('An unexpected error occurred');
  });
});
