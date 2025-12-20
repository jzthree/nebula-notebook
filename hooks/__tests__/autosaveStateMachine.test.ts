/**
 * Tests for autosaveStateMachine - pure state machine for save operations
 */
import { describe, it, expect } from 'vitest';
import {
  AutosaveState,
  AutosaveEvent,
  autosaveReducer,
  getInitialState,
  getAutosaveDelay,
} from '../autosaveStateMachine';

describe('autosaveStateMachine', () => {
  describe('getInitialState', () => {
    it('returns idle state', () => {
      const state = getInitialState();
      expect(state.status).toBe('idle');
    });
  });

  describe('getAutosaveDelay', () => {
    it('uses minimum delay for tiny files', () => {
      const delay = getAutosaveDelay(1024); // 1KB
      expect(delay).toBeGreaterThanOrEqual(1000);
      expect(delay).toBeLessThanOrEqual(1500);
    });

    it('scales delay for medium files', () => {
      const delay = getAutosaveDelay(500 * 1024); // 500KB
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(5000);
    });

    it('uses higher delay for large files', () => {
      const delay = getAutosaveDelay(5 * 1024 * 1024); // 5MB
      expect(delay).toBeGreaterThanOrEqual(5000);
      expect(delay).toBeLessThanOrEqual(15000);
    });

    it('uses maximum delay for very large files', () => {
      const delay = getAutosaveDelay(100 * 1024 * 1024); // 100MB
      expect(delay).toBe(60000);
    });
  });

  describe('idle state transitions', () => {
    it('transitions to checking on CELLS_CHANGED', () => {
      const state: AutosaveState = { status: 'idle' };
      const event: AutosaveEvent = { type: 'CELLS_CHANGED' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('checking');
      expect(effects).toContainEqual({ type: 'SCHEDULE_CHECK', delay: 300 });
    });

    it('transitions to saving on MANUAL_SAVE', () => {
      const state: AutosaveState = { status: 'idle' };
      const event: AutosaveEvent = { type: 'MANUAL_SAVE' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('saving');
      expect(effects).toContainEqual({ type: 'PERFORM_SAVE' });
    });

    it('ignores other events', () => {
      const state: AutosaveState = { status: 'idle' };
      const event: AutosaveEvent = { type: 'TIMEOUT_FIRED' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState).toEqual(state);
      expect(effects).toEqual([]);
    });
  });

  describe('checking state transitions', () => {
    it('returns to idle when no changes detected', () => {
      const state: AutosaveState = { status: 'checking' };
      const event: AutosaveEvent = { type: 'CHECK_COMPLETE', hasChanges: false };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('idle');
      expect(effects).toEqual([]);
    });

    it('transitions to waiting when changes detected', () => {
      const state: AutosaveState = { status: 'checking' };
      const event: AutosaveEvent = { type: 'CHECK_COMPLETE', hasChanges: true, contentSize: 1000 };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('waiting');
      expect(effects.some((e) => e.type === 'SCHEDULE_SAVE')).toBe(true);
    });

    it('restarts checking on CELLS_CHANGED', () => {
      const state: AutosaveState = { status: 'checking' };
      const event: AutosaveEvent = { type: 'CELLS_CHANGED' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('checking');
      expect(effects).toContainEqual({ type: 'CANCEL_PENDING_OPERATIONS' });
      expect(effects).toContainEqual({ type: 'SCHEDULE_CHECK', delay: 300 });
    });

    it('transitions to saving on MANUAL_SAVE', () => {
      const state: AutosaveState = { status: 'checking' };
      const event: AutosaveEvent = { type: 'MANUAL_SAVE' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('saving');
      expect(effects).toContainEqual({ type: 'CANCEL_PENDING_OPERATIONS' });
      expect(effects).toContainEqual({ type: 'PERFORM_SAVE' });
    });
  });

  describe('waiting state transitions', () => {
    it('transitions to saving on TIMEOUT_FIRED', () => {
      const state: AutosaveState = { status: 'waiting' };
      const event: AutosaveEvent = { type: 'TIMEOUT_FIRED' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('saving');
      expect(effects).toContainEqual({ type: 'PERFORM_SAVE' });
    });

    it('restarts checking on CELLS_CHANGED', () => {
      const state: AutosaveState = { status: 'waiting' };
      const event: AutosaveEvent = { type: 'CELLS_CHANGED' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('checking');
      expect(effects).toContainEqual({ type: 'CANCEL_PENDING_OPERATIONS' });
      expect(effects).toContainEqual({ type: 'SCHEDULE_CHECK', delay: 300 });
    });

    it('transitions to saving on MANUAL_SAVE', () => {
      const state: AutosaveState = { status: 'waiting' };
      const event: AutosaveEvent = { type: 'MANUAL_SAVE' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('saving');
      expect(effects).toContainEqual({ type: 'CANCEL_PENDING_OPERATIONS' });
      expect(effects).toContainEqual({ type: 'PERFORM_SAVE' });
    });
  });

  describe('saving state transitions', () => {
    it('transitions to idle on SAVE_SUCCESS', () => {
      const state: AutosaveState = { status: 'saving', hasPendingChanges: false };
      const event: AutosaveEvent = { type: 'SAVE_SUCCESS' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('idle');
      expect(effects).toContainEqual({ type: 'UPDATE_SAVED_CONTENT' });
    });

    it('transitions to checking on SAVE_SUCCESS when pending changes exist', () => {
      const state: AutosaveState = { status: 'saving', hasPendingChanges: true };
      const event: AutosaveEvent = { type: 'SAVE_SUCCESS' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('checking');
      expect(effects).toContainEqual({ type: 'UPDATE_SAVED_CONTENT' });
      expect(effects).toContainEqual({ type: 'SCHEDULE_CHECK', delay: 300 });
    });

    it('transitions to error on SAVE_ERROR', () => {
      const state: AutosaveState = { status: 'saving', hasPendingChanges: false };
      const error = new Error('Network error');
      const event: AutosaveEvent = { type: 'SAVE_ERROR', error };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('error');
      expect((newState as { status: 'error'; lastError: Error }).lastError).toBe(error);
      expect(effects).toContainEqual({ type: 'SCHEDULE_RETRY', delay: 5000 });
    });

    it('marks pending changes on CELLS_CHANGED during save', () => {
      const state: AutosaveState = { status: 'saving', hasPendingChanges: false };
      const event: AutosaveEvent = { type: 'CELLS_CHANGED' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('saving');
      expect((newState as { status: 'saving'; hasPendingChanges: boolean }).hasPendingChanges).toBe(true);
      expect(effects).toEqual([]);
    });

    it('ignores MANUAL_SAVE during active save', () => {
      const state: AutosaveState = { status: 'saving', hasPendingChanges: false };
      const event: AutosaveEvent = { type: 'MANUAL_SAVE' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState).toEqual(state);
      expect(effects).toEqual([]);
    });
  });

  describe('error state transitions', () => {
    it('transitions to checking on RETRY', () => {
      const state: AutosaveState = { status: 'error', lastError: new Error('Failed') };
      const event: AutosaveEvent = { type: 'RETRY' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('checking');
      expect(effects).toContainEqual({ type: 'SCHEDULE_CHECK', delay: 300 });
    });

    it('transitions to checking on CELLS_CHANGED', () => {
      const state: AutosaveState = { status: 'error', lastError: new Error('Failed') };
      const event: AutosaveEvent = { type: 'CELLS_CHANGED' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('checking');
      expect(effects).toContainEqual({ type: 'CANCEL_PENDING_OPERATIONS' });
      expect(effects).toContainEqual({ type: 'SCHEDULE_CHECK', delay: 300 });
    });

    it('transitions to saving on MANUAL_SAVE', () => {
      const state: AutosaveState = { status: 'error', lastError: new Error('Failed') };
      const event: AutosaveEvent = { type: 'MANUAL_SAVE' };

      const { state: newState, effects } = autosaveReducer(state, event);

      expect(newState.status).toBe('saving');
      expect(effects).toContainEqual({ type: 'CANCEL_PENDING_OPERATIONS' });
      expect(effects).toContainEqual({ type: 'PERFORM_SAVE' });
    });
  });

  describe('state machine completeness', () => {
    const allStates: AutosaveState['status'][] = ['idle', 'checking', 'waiting', 'saving', 'error'];
    const allEvents: AutosaveEvent['type'][] = [
      'CELLS_CHANGED',
      'MANUAL_SAVE',
      'CHECK_COMPLETE',
      'TIMEOUT_FIRED',
      'SAVE_SUCCESS',
      'SAVE_ERROR',
      'RETRY',
    ];

    // Ensure the state machine handles all state/event combinations without throwing
    for (const status of allStates) {
      for (const eventType of allEvents) {
        it(`handles ${eventType} in ${status} state without throwing`, () => {
          const state = createState(status);
          const event = createEvent(eventType);

          expect(() => autosaveReducer(state, event)).not.toThrow();
        });
      }
    }
  });
});

// Helper functions for creating test states and events
function createState(status: AutosaveState['status']): AutosaveState {
  switch (status) {
    case 'idle':
      return { status: 'idle' };
    case 'checking':
      return { status: 'checking' };
    case 'waiting':
      return { status: 'waiting' };
    case 'saving':
      return { status: 'saving', hasPendingChanges: false };
    case 'error':
      return { status: 'error', lastError: new Error('Test error') };
  }
}

function createEvent(type: AutosaveEvent['type']): AutosaveEvent {
  switch (type) {
    case 'CELLS_CHANGED':
      return { type: 'CELLS_CHANGED' };
    case 'MANUAL_SAVE':
      return { type: 'MANUAL_SAVE' };
    case 'CHECK_COMPLETE':
      return { type: 'CHECK_COMPLETE', hasChanges: true, contentSize: 1000 };
    case 'TIMEOUT_FIRED':
      return { type: 'TIMEOUT_FIRED' };
    case 'SAVE_SUCCESS':
      return { type: 'SAVE_SUCCESS' };
    case 'SAVE_ERROR':
      return { type: 'SAVE_ERROR', error: new Error('Test error') };
    case 'RETRY':
      return { type: 'RETRY' };
  }
}
