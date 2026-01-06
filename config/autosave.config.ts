/**
 * Autosave Configuration
 *
 * Timing constants for the autosave state machine.
 * These control how quickly changes are saved and how the system
 * responds to errors.
 */

/** Minimum autosave delay in milliseconds (1 second) */
export const MIN_AUTOSAVE_DELAY_MS = 1000;

/** Maximum autosave delay in milliseconds (60 seconds) */
export const MAX_AUTOSAVE_DELAY_MS = 60000;

/** Debounce delay before checking for changes (300ms) */
export const AUTOSAVE_CHECK_DELAY_MS = 300;

/** Delay before retrying after a save error (5 seconds) */
export const AUTOSAVE_RETRY_DELAY_MS = 5000;
