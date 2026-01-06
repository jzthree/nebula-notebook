/**
 * Frontend Error Types
 *
 * Structured error types that match the backend error hierarchy.
 * Provides type-safe error handling and user-friendly messages.
 */

/**
 * Structured error response from the backend API.
 */
export interface APIError {
  status: number;
  error_code: string;
  detail: string;
  user_message: string;
}

/**
 * Error codes that can be retried automatically.
 */
export const RETRYABLE_ERROR_CODES = new Set([
  'LLM_RATE_LIMIT',
  'LLM_TIMEOUT',
  'LLM_PROVIDER_ERROR',
  'KERNEL_TIMEOUT',
]);

/**
 * Error codes that indicate authentication issues.
 */
export const AUTH_ERROR_CODES = new Set([
  'LLM_AUTH_FAILED',
  'SESSION_EXPIRED',
]);

/**
 * Base error class for Nebula frontend errors.
 *
 * Wraps API errors with additional context and provides
 * helper methods for error handling.
 */
export class NebulaError extends Error {
  constructor(
    message: string,
    public readonly errorCode: string,
    public readonly userMessage: string,
    public readonly isRetryable: boolean = false,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'NebulaError';
  }

  /**
   * Create a NebulaError from an API error response.
   */
  static fromAPIError(apiError: APIError): NebulaError {
    const isRetryable = RETRYABLE_ERROR_CODES.has(apiError.error_code);
    return new NebulaError(
      apiError.detail,
      apiError.error_code,
      apiError.user_message,
      isRetryable,
      apiError.status
    );
  }

  /**
   * Create a NebulaError from a fetch Response.
   * Parses the JSON body to extract error details.
   */
  static async fromResponse(response: Response): Promise<NebulaError> {
    try {
      const data = await response.json();
      if (data.error_code && data.user_message) {
        return NebulaError.fromAPIError({
          status: response.status,
          error_code: data.error_code,
          detail: data.detail || data.error_code,
          user_message: data.user_message,
        });
      }
      // Fallback for non-structured errors
      return new NebulaError(
        data.detail || response.statusText,
        'UNKNOWN_ERROR',
        data.detail || 'An unexpected error occurred',
        false,
        response.status
      );
    } catch {
      // JSON parsing failed
      return new NebulaError(
        response.statusText,
        'UNKNOWN_ERROR',
        'An unexpected error occurred',
        false,
        response.status
      );
    }
  }

  /**
   * Check if this error indicates an authentication issue.
   */
  isAuthError(): boolean {
    return AUTH_ERROR_CODES.has(this.errorCode);
  }
}

/**
 * Network error - connection failed.
 */
export class NetworkError extends NebulaError {
  constructor(message: string = 'Connection failed') {
    super(
      message,
      'NETWORK_ERROR',
      'Connection failed. Check your network.',
      true // Network errors are retryable
    );
    this.name = 'NetworkError';
  }
}

/**
 * Timeout error - request took too long.
 */
export class TimeoutError extends NebulaError {
  constructor(message: string = 'Request timed out') {
    super(
      message,
      'TIMEOUT',
      'Request timed out. Please try again.',
      true // Timeouts are retryable
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Configuration for retry behavior.
 */
export interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
}

/**
 * Default retry configuration.
 * - 3 retries max
 * - 1 second base delay
 * - 2x backoff (1s → 2s → 4s)
 * - 10% jitter to prevent thundering herd
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

/**
 * Calculate retry delay with exponential backoff and jitter.
 *
 * @param attempt - The retry attempt number (0-indexed)
 * @param config - Retry configuration
 * @returns Delay in milliseconds
 */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  const exponentialDelay = config.baseDelayMs * Math.pow(config.backoffMultiplier, attempt);
  const cappedDelay = Math.min(exponentialDelay, config.maxDelayMs);
  // Add ±10% jitter
  const jitter = cappedDelay * 0.1 * (Math.random() * 2 - 1);
  return Math.round(cappedDelay + jitter);
}

/**
 * Execute a function with automatic retry on retryable errors.
 *
 * @param fn - Async function to execute
 * @param config - Retry configuration
 * @param onRetry - Optional callback called before each retry (for UI feedback)
 * @returns Result of the function
 * @throws NebulaError after all retries exhausted
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  onRetry?: (attempt: number, delay: number, error: NebulaError) => void
): Promise<T> {
  let lastError: NebulaError | null = null;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Convert to NebulaError if needed
      const nebulaError = error instanceof NebulaError
        ? error
        : new NebulaError(
            error instanceof Error ? error.message : String(error),
            'UNKNOWN_ERROR',
            'An unexpected error occurred',
            false
          );

      lastError = nebulaError;

      // Don't retry if not retryable or this was the last attempt
      if (!nebulaError.isRetryable || attempt >= config.maxRetries) {
        throw nebulaError;
      }

      // Calculate delay and notify
      const delay = calculateRetryDelay(attempt, config);
      onRetry?.(attempt + 1, delay, nebulaError);

      // Wait before retrying
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  // Should not reach here, but TypeScript needs this
  throw lastError || new NebulaError('Unknown error', 'UNKNOWN_ERROR', 'An unexpected error occurred', false);
}

/**
 * Type guard to check if an error is a NebulaError.
 */
export function isNebulaError(error: unknown): error is NebulaError {
  return error instanceof NebulaError;
}

/**
 * Get a user-friendly message from any error.
 * Falls back to generic message for unknown errors.
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof NebulaError) {
    return error.userMessage;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return 'An unexpected error occurred';
}
