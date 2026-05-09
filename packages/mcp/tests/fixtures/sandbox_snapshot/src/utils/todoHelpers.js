/**
 * Utility functions for todo operations
 */

import { VALID_PRIORITIES, DEFAULT_PRIORITY } from '../constants.js';

/**
 * Normalize priority to a valid value
 * @param {string} priority - Priority value to normalize
 * @returns {'low'|'medium'|'high'} Valid priority value
 */
export function normalizePriority(priority) {
  if (VALID_PRIORITIES.includes(priority)) {
    return priority;
  }
  return DEFAULT_PRIORITY;
}
