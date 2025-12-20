/**
 * Autosave State Machine
 *
 * A pure state machine for managing save operations.
 * Replaces multiple refs in useAutosave with explicit state transitions.
 *
 * States:
 *   idle → checking → waiting → saving → (idle | error)
 *
 * This state machine is pure - it returns new state and effects,
 * without performing any side effects directly.
 */

// Delay calculation constants
const MIN_AUTOSAVE_DELAY = 1000; // 1 second minimum
const MAX_AUTOSAVE_DELAY = 60000; // 60 seconds maximum
const CHECK_DELAY = 300; // Debounce delay before checking for changes
const RETRY_DELAY = 5000; // Delay before retrying after error

/**
 * Calculate autosave delay based on content size.
 *
 * Small notebooks (<100KB): 1-2 seconds
 * Medium notebooks (100KB-1MB): 2-5 seconds
 * Large notebooks (1MB-10MB): 5-15 seconds
 * Very large notebooks (10MB-100MB): 15-60 seconds
 */
export function getAutosaveDelay(sizeInBytes: number): number {
  const sizeInKB = sizeInBytes / 1024;
  const sizeInMB = sizeInKB / 1024;

  if (sizeInMB >= 100) {
    return MAX_AUTOSAVE_DELAY;
  } else if (sizeInMB >= 10) {
    return Math.min(15000 + (sizeInMB - 10) * 500, MAX_AUTOSAVE_DELAY);
  } else if (sizeInMB >= 1) {
    return 5000 + (sizeInMB - 1) * 1111;
  } else if (sizeInKB >= 100) {
    return 2000 + (sizeInKB - 100) * 3.33;
  } else {
    return MIN_AUTOSAVE_DELAY + sizeInKB * 10;
  }
}

// State types
export type AutosaveState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'waiting' }
  | { status: 'saving'; hasPendingChanges: boolean }
  | { status: 'error'; lastError: Error };

// Event types
export type AutosaveEvent =
  | { type: 'CELLS_CHANGED' }
  | { type: 'MANUAL_SAVE' }
  | { type: 'CHECK_COMPLETE'; hasChanges: boolean; contentSize?: number }
  | { type: 'TIMEOUT_FIRED' }
  | { type: 'SAVE_SUCCESS' }
  | { type: 'SAVE_ERROR'; error: Error }
  | { type: 'RETRY' };

// Effect types - side effects to be performed by the caller
export type AutosaveEffect =
  | { type: 'SCHEDULE_CHECK'; delay: number }
  | { type: 'SCHEDULE_SAVE'; delay: number }
  | { type: 'SCHEDULE_RETRY'; delay: number }
  | { type: 'CANCEL_PENDING_OPERATIONS' }
  | { type: 'PERFORM_SAVE' }
  | { type: 'UPDATE_SAVED_CONTENT' };

export interface ReducerResult {
  state: AutosaveState;
  effects: AutosaveEffect[];
}

/**
 * Get the initial state for the state machine.
 */
export function getInitialState(): AutosaveState {
  return { status: 'idle' };
}

/**
 * Pure reducer function for the autosave state machine.
 *
 * @param state - Current state
 * @param event - Event to process
 * @returns New state and effects to execute
 */
export function autosaveReducer(
  state: AutosaveState,
  event: AutosaveEvent
): ReducerResult {
  switch (state.status) {
    case 'idle':
      return handleIdleState(state, event);

    case 'checking':
      return handleCheckingState(state, event);

    case 'waiting':
      return handleWaitingState(state, event);

    case 'saving':
      return handleSavingState(state, event);

    case 'error':
      return handleErrorState(state, event);

    default:
      return { state, effects: [] };
  }
}

function handleIdleState(
  state: AutosaveState,
  event: AutosaveEvent
): ReducerResult {
  switch (event.type) {
    case 'CELLS_CHANGED':
      return {
        state: { status: 'checking' },
        effects: [{ type: 'SCHEDULE_CHECK', delay: CHECK_DELAY }],
      };

    case 'MANUAL_SAVE':
      return {
        state: { status: 'saving', hasPendingChanges: false },
        effects: [{ type: 'PERFORM_SAVE' }],
      };

    default:
      return { state, effects: [] };
  }
}

function handleCheckingState(
  state: AutosaveState,
  event: AutosaveEvent
): ReducerResult {
  switch (event.type) {
    case 'CHECK_COMPLETE':
      if (!event.hasChanges) {
        return {
          state: { status: 'idle' },
          effects: [],
        };
      }
      const delay = getAutosaveDelay(event.contentSize || 0);
      return {
        state: { status: 'waiting' },
        effects: [{ type: 'SCHEDULE_SAVE', delay }],
      };

    case 'CELLS_CHANGED':
      // Restart checking with new cells
      return {
        state: { status: 'checking' },
        effects: [
          { type: 'CANCEL_PENDING_OPERATIONS' },
          { type: 'SCHEDULE_CHECK', delay: CHECK_DELAY },
        ],
      };

    case 'MANUAL_SAVE':
      return {
        state: { status: 'saving', hasPendingChanges: false },
        effects: [
          { type: 'CANCEL_PENDING_OPERATIONS' },
          { type: 'PERFORM_SAVE' },
        ],
      };

    default:
      return { state, effects: [] };
  }
}

function handleWaitingState(
  state: AutosaveState,
  event: AutosaveEvent
): ReducerResult {
  switch (event.type) {
    case 'TIMEOUT_FIRED':
      return {
        state: { status: 'saving', hasPendingChanges: false },
        effects: [{ type: 'PERFORM_SAVE' }],
      };

    case 'CELLS_CHANGED':
      // Restart the debounce cycle
      return {
        state: { status: 'checking' },
        effects: [
          { type: 'CANCEL_PENDING_OPERATIONS' },
          { type: 'SCHEDULE_CHECK', delay: CHECK_DELAY },
        ],
      };

    case 'MANUAL_SAVE':
      return {
        state: { status: 'saving', hasPendingChanges: false },
        effects: [
          { type: 'CANCEL_PENDING_OPERATIONS' },
          { type: 'PERFORM_SAVE' },
        ],
      };

    default:
      return { state, effects: [] };
  }
}

function handleSavingState(
  state: { status: 'saving'; hasPendingChanges: boolean },
  event: AutosaveEvent
): ReducerResult {
  switch (event.type) {
    case 'SAVE_SUCCESS':
      if (state.hasPendingChanges) {
        // Immediately check for more changes
        return {
          state: { status: 'checking' },
          effects: [
            { type: 'UPDATE_SAVED_CONTENT' },
            { type: 'SCHEDULE_CHECK', delay: CHECK_DELAY },
          ],
        };
      }
      return {
        state: { status: 'idle' },
        effects: [{ type: 'UPDATE_SAVED_CONTENT' }],
      };

    case 'SAVE_ERROR':
      return {
        state: { status: 'error', lastError: event.error },
        effects: [{ type: 'SCHEDULE_RETRY', delay: RETRY_DELAY }],
      };

    case 'CELLS_CHANGED':
      // Mark that we need to save again after current save completes
      return {
        state: { status: 'saving', hasPendingChanges: true },
        effects: [],
      };

    case 'MANUAL_SAVE':
      // Already saving, ignore
      return { state, effects: [] };

    default:
      return { state, effects: [] };
  }
}

function handleErrorState(
  state: AutosaveState,
  event: AutosaveEvent
): ReducerResult {
  switch (event.type) {
    case 'RETRY':
      return {
        state: { status: 'checking' },
        effects: [{ type: 'SCHEDULE_CHECK', delay: CHECK_DELAY }],
      };

    case 'CELLS_CHANGED':
      // User made changes, try again
      return {
        state: { status: 'checking' },
        effects: [
          { type: 'CANCEL_PENDING_OPERATIONS' },
          { type: 'SCHEDULE_CHECK', delay: CHECK_DELAY },
        ],
      };

    case 'MANUAL_SAVE':
      return {
        state: { status: 'saving', hasPendingChanges: false },
        effects: [
          { type: 'CANCEL_PENDING_OPERATIONS' },
          { type: 'PERFORM_SAVE' },
        ],
      };

    default:
      return { state, effects: [] };
  }
}
