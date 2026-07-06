/**
 * Tests for Circuit Breaker Pattern
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CircuitBreaker,
  CircuitState,
  createCircuitBreaker,
  type CircuitBreakerEvent,
} from '../src/circuit-breaker.js';
import { ErrorCategory } from '../src/errors.js';

describe('Circuit Breaker', () => {
  let breaker: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    breaker = createCircuitBreaker({
      failureThreshold: 3,
      resetTimeout: 10000,
      successThreshold: 2,
      failureWindow: 30000,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initial State', () => {
    it('should start in CLOSED state', () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should allow requests in CLOSED state', () => {
      expect(breaker.isAllowed()).toBe(true);
    });

    it('should have zero failure count initially', () => {
      const metrics = breaker.getMetrics();
      expect(metrics.failureCount).toBe(0);
      expect(metrics.successCount).toBe(0);
    });
  });

  describe('createCircuitBreaker', () => {
    it('should create circuit breaker with default options', () => {
      const defaultBreaker = createCircuitBreaker();
      expect(defaultBreaker).toBeInstanceOf(CircuitBreaker);
      expect(defaultBreaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should create circuit breaker with custom options', () => {
      const customBreaker = createCircuitBreaker({
        failureThreshold: 10,
        resetTimeout: 60000,
        name: 'custom-breaker',
      });
      expect(customBreaker).toBeInstanceOf(CircuitBreaker);
    });
  });

  describe('Failure Recording', () => {
    it('should record failures that match trip categories', () => {
      breaker.recordFailure({
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });

      const metrics = breaker.getMetrics();
      expect(metrics.failureCount).toBe(1);
    });

    it('should ignore failures that do not match trip categories', () => {
      breaker.recordFailure({
        message: 'Validation error',
        category: ErrorCategory.VALIDATION,
        recoverable: 'non-recoverable',
        retryable: false,
      });

      const metrics = breaker.getMetrics();
      expect(metrics.failureCount).toBe(0);
    });

    it('should open circuit when failure threshold is reached', () => {
      // Record failures up to threshold
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: `Network error ${i}`,
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should not open circuit before threshold is reached', () => {
      for (let i = 0; i < 2; i++) {
        breaker.recordFailure({
          message: `Network error ${i}`,
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should count failures within the time window', () => {
      breaker.recordFailure({
        message: 'Error 1',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });

      // Advance time beyond failure window
      vi.advanceTimersByTime(35000);

      // Old failure should be expired
      const metrics = breaker.getMetrics();
      expect(metrics.failureCount).toBe(0);
    });
  });

  describe('State Transitions', () => {
    it('should transition from CLOSED to OPEN on threshold', () => {
      const events: CircuitBreakerEvent[] = [];
      breaker.onEvent((event) => events.push(event));

      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      const stateChange = events.find(
        (e) => e.type === 'state_change' && e.to === CircuitState.OPEN
      );
      expect(stateChange).toBeDefined();
      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should transition from OPEN to HALF_OPEN after reset timeout', () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      // Advance time past reset timeout
      vi.advanceTimersByTime(10001);

      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
    });

    it('should transition from HALF_OPEN to CLOSED on success threshold', () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      // Wait for half-open
      vi.advanceTimersByTime(10001);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Record successful operations
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);
      breaker.recordSuccess();
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it('should transition from HALF_OPEN to OPEN on failure', () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      // Wait for half-open
      vi.advanceTimersByTime(10001);
      expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

      // Record a failure
      breaker.recordFailure({
        message: 'Still failing',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('execute()', () => {
    it('should execute operation when circuit is closed', async () => {
      const operation = vi.fn().mockResolvedValue('success');

      const result = await breaker.execute(operation);

      expect(operation).toHaveBeenCalled();
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data).toBe('success');
      }
    });

    it('should reject operation when circuit is open', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      const operation = vi.fn().mockResolvedValue('success');
      const result = await breaker.execute(operation);

      expect(operation).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      if (result.success === false) {
        expect(result.rejectedByCircuit).toBe(true);
        expect(result.error).toContain('Circuit breaker is open');
      }
    });

    it('should allow operation when circuit is half-open', async () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      // Wait for half-open
      vi.advanceTimersByTime(10001);

      const operation = vi.fn().mockResolvedValue('success');
      const result = await breaker.execute(operation);

      expect(operation).toHaveBeenCalled();
      expect(result.success).toBe(true);
    });

    it('should record failure on operation error', async () => {
      const operation = vi.fn().mockRejectedValue(new Error('Network failure'));

      const result = await breaker.execute(operation);

      expect(result.success).toBe(false);
      if (result.success === false) {
        expect(result.rejectedByCircuit).toBe(false);
        expect(result.classifiedError).toBeDefined();
      }

      const metrics = breaker.getMetrics();
      expect(metrics.failureCount).toBe(1);
    });

    it('should record success on operation success', async () => {
      // Open and wait for half-open
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }
      vi.advanceTimersByTime(10001);

      const operation = vi.fn().mockResolvedValue('success');
      await breaker.execute(operation);
      await breaker.execute(operation);

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('Manual Controls', () => {
    it('should reset circuit to closed state', () => {
      // Open the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }
      expect(breaker.getState()).toBe(CircuitState.OPEN);

      breaker.reset();

      expect(breaker.getState()).toBe(CircuitState.CLOSED);
      expect(breaker.getMetrics().failureCount).toBe(0);
    });

    it('should force circuit open', () => {
      expect(breaker.getState()).toBe(CircuitState.CLOSED);

      breaker.forceOpen();

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
  });

  describe('Event Listeners', () => {
    it('should emit state_change events', () => {
      const events: CircuitBreakerEvent[] = [];
      breaker.onEvent((event) => events.push(event));

      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      const stateChanges = events.filter((e) => e.type === 'state_change');
      expect(stateChanges.length).toBe(1);
      expect(stateChanges[0]).toEqual({
        type: 'state_change',
        from: CircuitState.CLOSED,
        to: CircuitState.OPEN,
        reason: expect.stringContaining('Failure threshold reached'),
      });
    });

    it('should emit failure_recorded events', () => {
      const events: CircuitBreakerEvent[] = [];
      breaker.onEvent((event) => events.push(event));

      breaker.recordFailure({
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });

      const failureEvents = events.filter((e) => e.type === 'failure_recorded');
      expect(failureEvents.length).toBe(1);
      expect(failureEvents[0]).toEqual({
        type: 'failure_recorded',
        error: expect.objectContaining({ category: ErrorCategory.NETWORK }),
        failureCount: 1,
      });
    });

    it('should emit request_rejected events', async () => {
      const events: CircuitBreakerEvent[] = [];
      breaker.onEvent((event) => events.push(event));

      // Open the circuit
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      await breaker.execute(() => Promise.resolve('test'));

      const rejectEvents = events.filter((e) => e.type === 'request_rejected');
      expect(rejectEvents.length).toBe(1);
      expect(rejectEvents[0]).toEqual({
        type: 'request_rejected',
        state: CircuitState.OPEN,
      });
    });

    it('should allow removing event listeners', () => {
      const events: CircuitBreakerEvent[] = [];
      const unsubscribe = breaker.onEvent((event) => events.push(event));

      breaker.recordFailure({
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });
      expect(events.length).toBe(1);

      unsubscribe();

      breaker.recordFailure({
        message: 'Network error 2',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });
      expect(events.length).toBe(1); // No new events
    });

    it('should handle listener errors gracefully', () => {
      breaker.onEvent(() => {
        throw new Error('Listener error');
      });

      // Should not throw
      expect(() => {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }).not.toThrow();
    });
  });

  describe('Custom Trip Categories', () => {
    it('should trip on custom categories', () => {
      const customBreaker = createCircuitBreaker({
        failureThreshold: 2,
        tripOnCategories: [ErrorCategory.KERNEL],
      });

      customBreaker.recordFailure({
        message: 'Kernel error',
        category: ErrorCategory.KERNEL,
        recoverable: 'non-recoverable',
        retryable: false,
      });
      customBreaker.recordFailure({
        message: 'Kernel error 2',
        category: ErrorCategory.KERNEL,
        recoverable: 'non-recoverable',
        retryable: false,
      });

      expect(customBreaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should not trip on excluded categories', () => {
      const customBreaker = createCircuitBreaker({
        failureThreshold: 2,
        tripOnCategories: [ErrorCategory.KERNEL],
      });

      // Network errors should be ignored
      customBreaker.recordFailure({
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });
      customBreaker.recordFailure({
        message: 'Network error 2',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });

      expect(customBreaker.getState()).toBe(CircuitState.CLOSED);
    });
  });

  describe('Metrics', () => {
    it('should track openedAt timestamp', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      const metrics = breaker.getMetrics();
      expect(metrics.openedAt).toBe(new Date('2024-01-01T00:00:00Z').getTime());
    });

    it('should track lastFailureTime', () => {
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      breaker.recordFailure({
        message: 'Network error',
        category: ErrorCategory.NETWORK,
        recoverable: 'recoverable',
        retryable: true,
      });

      const metrics = breaker.getMetrics();
      expect(metrics.lastFailureTime).toBe(new Date('2024-01-01T00:00:00Z').getTime());
    });

    it('should reset metrics on manual reset', () => {
      for (let i = 0; i < 3; i++) {
        breaker.recordFailure({
          message: 'Network error',
          category: ErrorCategory.NETWORK,
          recoverable: 'recoverable',
          retryable: true,
        });
      }

      breaker.reset();

      const metrics = breaker.getMetrics();
      expect(metrics.failureCount).toBe(0);
      expect(metrics.successCount).toBe(0);
      expect(metrics.openedAt).toBe(0);
    });
  });

  describe('Integration with Error Classification', () => {
    it('should classify errors during execute()', async () => {
      const networkError = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      const operation = vi.fn().mockRejectedValue(networkError);

      const result = await breaker.execute(operation);

      expect(result.success).toBe(false);
      if (result.success === false) {
        expect(result.classifiedError?.category).toBe(ErrorCategory.NETWORK);
      }
    });

    it('should trip circuit on classified network errors', async () => {
      const networkError = new Error('connect ECONNREFUSED 127.0.0.1:8000');
      const operation = vi.fn().mockRejectedValue(networkError);

      for (let i = 0; i < 3; i++) {
        await breaker.execute(operation);
      }

      expect(breaker.getState()).toBe(CircuitState.OPEN);
    });

    it('should not trip on validation errors', async () => {
      const validationError = new Error('Invalid parameter: index out of range');
      const operation = vi.fn().mockRejectedValue(validationError);

      for (let i = 0; i < 3; i++) {
        await breaker.execute(operation);
      }

      // Validation errors don't trip the circuit by default
      expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });
  });
});
