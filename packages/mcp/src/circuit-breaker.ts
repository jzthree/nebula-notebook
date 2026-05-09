/**
 * Circuit Breaker Pattern Implementation
 *
 * Prevents cascading failures by temporarily disabling requests to a failing service.
 * When a service fails repeatedly, the circuit "opens" and subsequent requests
 * fail immediately without attempting the operation, allowing the service time to recover.
 *
 * States:
 * - CLOSED: Normal operation, requests pass through
 * - OPEN: Service is failing, requests fail immediately
 * - HALF_OPEN: Testing if service has recovered
 */

import { classifyError, ErrorCategory, type ClassifiedError } from './errors.js';

/**
 * Circuit breaker states
 */
export enum CircuitState {
  /** Normal operation - requests pass through */
  CLOSED = 'CLOSED',
  /** Service is failing - requests fail immediately */
  OPEN = 'OPEN',
  /** Testing recovery - limited requests pass through */
  HALF_OPEN = 'HALF_OPEN',
}

/**
 * Circuit breaker configuration options
 */
export interface CircuitBreakerOptions {
  /** Number of failures before opening the circuit (default: 5) */
  failureThreshold?: number;
  /** Time in ms to wait before trying again after opening (default: 30000) */
  resetTimeout?: number;
  /** Number of successful requests needed to close circuit from half-open (default: 2) */
  successThreshold?: number;
  /** Time window in ms for counting failures (default: 60000) */
  failureWindow?: number;
  /** Categories of errors that should trip the circuit (default: NETWORK, TIMEOUT, SERVER) */
  tripOnCategories?: ErrorCategory[];
  /** Optional name for this circuit breaker (for logging) */
  name?: string;
}

/**
 * Circuit breaker event types
 */
export type CircuitBreakerEvent =
  | { type: 'state_change'; from: CircuitState; to: CircuitState; reason: string }
  | { type: 'failure_recorded'; error: ClassifiedError; failureCount: number }
  | { type: 'success_recorded'; successCount: number }
  | { type: 'request_rejected'; state: CircuitState };

/**
 * Event listener type
 */
export type CircuitBreakerListener = (event: CircuitBreakerEvent) => void;

/**
 * Result of a circuit breaker execution
 */
export type CircuitBreakerResult<T> =
  | { success: true; data: T }
  | { success: false; error: string; rejectedByCircuit: boolean; classifiedError?: ClassifiedError };

/**
 * Circuit Breaker implementation
 */
export class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failures: number[] = []; // Timestamps of failures within the window
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private openedAt: number = 0;

  private readonly failureThreshold: number;
  private readonly resetTimeout: number;
  private readonly successThreshold: number;
  private readonly failureWindow: number;
  private readonly tripOnCategories: Set<ErrorCategory>;
  private readonly name: string;

  private listeners: CircuitBreakerListener[] = [];

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 5;
    this.resetTimeout = options.resetTimeout ?? 30000;
    this.successThreshold = options.successThreshold ?? 2;
    this.failureWindow = options.failureWindow ?? 60000;
    this.tripOnCategories = new Set(
      options.tripOnCategories ?? [ErrorCategory.NETWORK, ErrorCategory.TIMEOUT, ErrorCategory.SERVER]
    );
    this.name = options.name ?? 'default';
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    this.checkStateTransition();
    return this.state;
  }

  /**
   * Get circuit breaker metrics
   */
  getMetrics(): {
    state: CircuitState;
    failureCount: number;
    successCount: number;
    lastFailureTime: number;
    openedAt: number;
  } {
    this.checkStateTransition();
    return {
      state: this.state,
      failureCount: this.getRecentFailureCount(),
      successCount: this.successCount,
      lastFailureTime: this.lastFailureTime,
      openedAt: this.openedAt,
    };
  }

  /**
   * Check if the circuit allows requests
   */
  isAllowed(): boolean {
    this.checkStateTransition();
    return this.state !== CircuitState.OPEN;
  }

  /**
   * Execute an operation through the circuit breaker
   */
  async execute<T>(operation: () => Promise<T>): Promise<CircuitBreakerResult<T>> {
    this.checkStateTransition();

    // If circuit is open, reject immediately
    if (this.state === CircuitState.OPEN) {
      this.emit({ type: 'request_rejected', state: this.state });
      return {
        success: false,
        error: `Circuit breaker is open (${this.name}). Service temporarily unavailable.`,
        rejectedByCircuit: true,
      };
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return { success: true, data: result };
    } catch (error) {
      const classified = classifyError(error);
      this.recordFailure(classified);
      return {
        success: false,
        error: classified.message,
        rejectedByCircuit: false,
        classifiedError: classified,
      };
    }
  }

  /**
   * Record a successful operation
   */
  recordSuccess(): void {
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      this.emit({ type: 'success_recorded', successCount: this.successCount });

      if (this.successCount >= this.successThreshold) {
        this.transitionTo(CircuitState.CLOSED, 'Success threshold reached');
      }
    } else if (this.state === CircuitState.CLOSED) {
      // In closed state, success helps decay the failure count
      this.emit({ type: 'success_recorded', successCount: this.successCount });
    }
  }

  /**
   * Record a failed operation
   */
  recordFailure(error: ClassifiedError): void {
    // Only trip on configured categories
    if (!this.tripOnCategories.has(error.category)) {
      return;
    }

    const now = Date.now();
    this.failures.push(now);
    this.lastFailureTime = now;

    // Clean up old failures outside the window
    this.failures = this.failures.filter((t) => now - t < this.failureWindow);

    this.emit({
      type: 'failure_recorded',
      error,
      failureCount: this.failures.length,
    });

    if (this.state === CircuitState.HALF_OPEN) {
      // Any failure in half-open state reopens the circuit
      this.transitionTo(CircuitState.OPEN, 'Failure in half-open state');
    } else if (this.state === CircuitState.CLOSED && this.failures.length >= this.failureThreshold) {
      // Threshold reached in closed state
      this.transitionTo(CircuitState.OPEN, `Failure threshold reached (${this.failures.length}/${this.failureThreshold})`);
    }
  }

  /**
   * Manually reset the circuit breaker to closed state
   */
  reset(): void {
    this.failures = [];
    this.successCount = 0;
    this.lastFailureTime = 0;
    this.openedAt = 0;
    if (this.state !== CircuitState.CLOSED) {
      this.transitionTo(CircuitState.CLOSED, 'Manual reset');
    }
  }

  /**
   * Force the circuit open (for testing or emergency)
   */
  forceOpen(): void {
    if (this.state !== CircuitState.OPEN) {
      this.transitionTo(CircuitState.OPEN, 'Forced open');
    }
  }

  /**
   * Add an event listener
   */
  onEvent(listener: CircuitBreakerListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Check if state should transition based on time
   */
  private checkStateTransition(): void {
    if (this.state === CircuitState.OPEN) {
      const now = Date.now();
      if (now - this.openedAt >= this.resetTimeout) {
        this.transitionTo(CircuitState.HALF_OPEN, 'Reset timeout elapsed');
      }
    }
  }

  /**
   * Transition to a new state
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    const oldState = this.state;
    this.state = newState;

    if (newState === CircuitState.OPEN) {
      this.openedAt = Date.now();
    } else if (newState === CircuitState.HALF_OPEN) {
      this.successCount = 0;
    } else if (newState === CircuitState.CLOSED) {
      this.failures = [];
      this.successCount = 0;
      this.openedAt = 0;
    }

    this.emit({ type: 'state_change', from: oldState, to: newState, reason });
  }

  /**
   * Get count of failures within the window
   */
  private getRecentFailureCount(): number {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < this.failureWindow);
    return this.failures.length;
  }

  /**
   * Emit an event to listeners
   */
  private emit(event: CircuitBreakerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Ignore listener errors
      }
    }
  }
}

/**
 * Create a new circuit breaker instance
 */
export function createCircuitBreaker(options?: CircuitBreakerOptions): CircuitBreaker {
  return new CircuitBreaker(options);
}
