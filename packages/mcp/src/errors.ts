/**
 * Error classification and handling utilities for nebula-tools
 *
 * Provides structured error types for better error handling and recovery strategies.
 */

/**
 * Error categories for classification
 */
export enum ErrorCategory {
  /** Network connectivity issues (connection refused, reset, DNS failures) */
  NETWORK = 'NETWORK',
  /** Request timeout exceeded */
  TIMEOUT = 'TIMEOUT',
  /** Server-side errors (5xx HTTP status) */
  SERVER = 'SERVER',
  /** Client-side errors (4xx HTTP status) */
  CLIENT = 'CLIENT',
  /** Validation errors (invalid input, out of range, etc.) */
  VALIDATION = 'VALIDATION',
  /** Kernel-related errors (not found, crashed, busy) */
  KERNEL = 'KERNEL',
  /** Notebook-related errors (parse failures, missing cells) */
  NOTEBOOK = 'NOTEBOOK',
  /** Code execution errors (runtime errors, exceptions) */
  EXECUTION = 'EXECUTION',
  /** Unknown or uncategorized errors */
  UNKNOWN = 'UNKNOWN',
}

/**
 * Whether an error is recoverable (can be retried or has a fallback)
 */
export type RecoverabilityStatus = 'recoverable' | 'non-recoverable' | 'potentially-recoverable';

/**
 * Structured error information
 */
export interface ClassifiedError {
  /** Original error message */
  message: string;
  /** Error category for programmatic handling */
  category: ErrorCategory;
  /** HTTP status code if applicable */
  statusCode?: number;
  /** Whether this error can be recovered from */
  recoverable: RecoverabilityStatus;
  /** Whether this error should be retried */
  retryable: boolean;
  /** Suggested retry delay in milliseconds (if retryable) */
  retryDelayMs?: number;
  /** Original error for debugging */
  originalError?: unknown;
}

/**
 * Classify an error into a structured format
 */
export function classifyError(error: unknown, statusCode?: number): ClassifiedError {
  const message = getErrorMessage(error);
  const lowerMessage = message.toLowerCase();

  // Priority 1: Check for AbortError (special timeout case from fetch)
  // This takes highest priority as it's a programmatic signal
  if (error instanceof Error && error.name === 'AbortError') {
    return {
      message,
      category: ErrorCategory.TIMEOUT,
      statusCode,
      recoverable: 'recoverable',
      retryable: true,
      retryDelayMs: 1000,
      originalError: error,
    };
  }

  // Priority 2: HTTP status codes take precedence over message-based classification
  // This ensures server responses are correctly classified
  if (statusCode !== undefined) {
    return classifyByStatusCode(message, statusCode, error);
  }

  // Priority 3: Check for timeout errors (message-based)
  if (isTimeoutError(lowerMessage)) {
    return {
      message,
      category: ErrorCategory.TIMEOUT,
      statusCode,
      recoverable: 'recoverable',
      retryable: true,
      retryDelayMs: 1000,
      originalError: error,
    };
  }

  // Priority 4: Check for network errors
  if (isNetworkError(lowerMessage)) {
    return {
      message,
      category: ErrorCategory.NETWORK,
      statusCode,
      recoverable: 'recoverable',
      retryable: true,
      retryDelayMs: 1000,
      originalError: error,
    };
  }

  // Priority 5: Check for kernel errors
  if (isKernelError(lowerMessage)) {
    return {
      message,
      category: ErrorCategory.KERNEL,
      recoverable: isKernelRecoverable(lowerMessage) ? 'potentially-recoverable' : 'non-recoverable',
      retryable: false,
      originalError: error,
    };
  }

  // Priority 6: Check for execution errors (before notebook to catch "in cell" context)
  if (isExecutionError(lowerMessage)) {
    return {
      message,
      category: ErrorCategory.EXECUTION,
      recoverable: 'non-recoverable',
      retryable: false,
      originalError: error,
    };
  }

  // Priority 7: Check for notebook errors
  if (isNotebookError(lowerMessage)) {
    return {
      message,
      category: ErrorCategory.NOTEBOOK,
      recoverable: 'non-recoverable',
      retryable: false,
      originalError: error,
    };
  }

  // Priority 8: Check for validation errors
  if (isValidationError(lowerMessage)) {
    return {
      message,
      category: ErrorCategory.VALIDATION,
      recoverable: 'non-recoverable',
      retryable: false,
      originalError: error,
    };
  }

  // Default to unknown
  return {
    message,
    category: ErrorCategory.UNKNOWN,
    statusCode,
    recoverable: 'potentially-recoverable',
    retryable: false,
    originalError: error,
  };
}

/**
 * Extract error message from various error types
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === 'string') {
    return error;
  }
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

/**
 * Check if error message indicates a timeout error
 */
function isTimeoutError(lowerMessage: string): boolean {
  return lowerMessage.includes('timeout') || lowerMessage.includes('timed out');
}

/**
 * Check if error is a network error
 */
function isNetworkError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('network') ||
    lowerMessage.includes('econnrefused') ||
    lowerMessage.includes('econnreset') ||
    lowerMessage.includes('enotfound') ||
    lowerMessage.includes('connection refused') ||
    lowerMessage.includes('connection reset') ||
    lowerMessage.includes('dns') ||
    lowerMessage.includes('socket')
  );
}

/**
 * Check if error is a kernel error
 */
function isKernelError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('kernel') ||
    lowerMessage.includes('session not found') ||
    lowerMessage.includes('session_id')
  );
}

/**
 * Check if kernel error is potentially recoverable
 */
function isKernelRecoverable(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('busy') ||
    lowerMessage.includes('starting') ||
    lowerMessage.includes('restarting')
  );
}

/**
 * Check if error is a notebook error
 */
function isNotebookError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('notebook') ||
    lowerMessage.includes('parse') ||
    lowerMessage.includes('invalid json') ||
    lowerMessage.includes('cell') ||
    lowerMessage.includes('nbformat')
  );
}

/**
 * Check if error is an execution error
 */
function isExecutionError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('execution') ||
    lowerMessage.includes('runtime error') ||
    lowerMessage.includes('exception') ||
    lowerMessage.includes('traceback')
  );
}

/**
 * Check if error is a validation error
 */
function isValidationError(lowerMessage: string): boolean {
  return (
    lowerMessage.includes('invalid') ||
    lowerMessage.includes('out of range') ||
    lowerMessage.includes('required') ||
    lowerMessage.includes('missing')
  );
}

/**
 * Classify error by HTTP status code
 */
function classifyByStatusCode(message: string, statusCode: number, originalError: unknown): ClassifiedError {
  if (statusCode >= 500) {
    return {
      message,
      category: ErrorCategory.SERVER,
      statusCode,
      recoverable: 'recoverable',
      retryable: true,
      retryDelayMs: 1000 * Math.min(Math.ceil(statusCode / 100), 5),
      originalError,
    };
  }

  if (statusCode >= 400) {
    // Specific client error handling
    if (statusCode === 404) {
      return {
        message,
        category: ErrorCategory.CLIENT,
        statusCode,
        recoverable: 'non-recoverable',
        retryable: false,
        originalError,
      };
    }
    if (statusCode === 429) {
      // Rate limiting - recoverable with backoff
      return {
        message,
        category: ErrorCategory.CLIENT,
        statusCode,
        recoverable: 'recoverable',
        retryable: true,
        retryDelayMs: 5000,
        originalError,
      };
    }
    if (statusCode === 408) {
      // Request timeout
      return {
        message,
        category: ErrorCategory.TIMEOUT,
        statusCode,
        recoverable: 'recoverable',
        retryable: true,
        retryDelayMs: 1000,
        originalError,
      };
    }
    return {
      message,
      category: ErrorCategory.CLIENT,
      statusCode,
      recoverable: 'non-recoverable',
      retryable: false,
      originalError,
    };
  }

  // Non-error status codes shouldn't reach here, but handle gracefully
  return {
    message,
    category: ErrorCategory.UNKNOWN,
    statusCode,
    recoverable: 'potentially-recoverable',
    retryable: false,
    originalError,
  };
}

/**
 * Create a user-friendly error message from a classified error
 */
export function formatErrorMessage(error: ClassifiedError): string {
  const categoryDescriptions: Record<ErrorCategory, string> = {
    [ErrorCategory.NETWORK]: 'Network error',
    [ErrorCategory.TIMEOUT]: 'Request timed out',
    [ErrorCategory.SERVER]: 'Server error',
    [ErrorCategory.CLIENT]: 'Client error',
    [ErrorCategory.VALIDATION]: 'Validation error',
    [ErrorCategory.KERNEL]: 'Kernel error',
    [ErrorCategory.NOTEBOOK]: 'Notebook error',
    [ErrorCategory.EXECUTION]: 'Execution error',
    [ErrorCategory.UNKNOWN]: 'Error',
  };

  const prefix = categoryDescriptions[error.category];
  const statusSuffix = error.statusCode ? ` (${error.statusCode})` : '';

  return `${prefix}${statusSuffix}: ${error.message}`;
}

/**
 * Check if an error should trigger a retry
 */
export function shouldRetry(error: ClassifiedError, attemptNumber: number, maxRetries: number): boolean {
  if (!error.retryable) {
    return false;
  }
  return attemptNumber < maxRetries;
}

/**
 * Calculate retry delay with exponential backoff
 */
export function calculateRetryDelay(error: ClassifiedError, attemptNumber: number): number {
  const baseDelay = error.retryDelayMs || 1000;
  // Exponential backoff with jitter
  const exponentialDelay = baseDelay * Math.pow(2, attemptNumber);
  const jitter = Math.random() * 0.3 * exponentialDelay;
  return Math.min(exponentialDelay + jitter, 30000); // Cap at 30 seconds
}
