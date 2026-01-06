/**
 * Polling Configuration
 *
 * Constants for background polling, reconnection, and timing tolerances.
 */

/** Directory change detection polling interval (milliseconds) */
export const DIRECTORY_POLL_INTERVAL_MS = 5000;

/** WebSocket reconnection attempt interval (milliseconds) */
export const WEBSOCKET_RECONNECT_INTERVAL_MS = 1000;

/**
 * Tolerance for mtime comparison (seconds).
 *
 * This small tolerance handles:
 * - Floating-point precision issues during JSON serialization
 * - Sub-second filesystem timing differences
 */
export const MTIME_TOLERANCE_SECONDS = 0.5;
