/**
 * Date utility functions for todo due date handling
 */

/**
 * Get today's date in YYYY-MM-DD format
 * @returns {string} Today's date
 */
export function getTodayString() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Check if a due date is overdue (before today)
 * @param {string|null} dueDate - Date string in YYYY-MM-DD format
 * @returns {boolean} True if overdue
 */
export function isOverdue(dueDate) {
  if (!dueDate) return false;
  return dueDate < getTodayString();
}

/**
 * Check if a due date is today
 * @param {string|null} dueDate - Date string in YYYY-MM-DD format
 * @returns {boolean} True if due today
 */
export function isDueToday(dueDate) {
  if (!dueDate) return false;
  return dueDate === getTodayString();
}

/**
 * Format a due date for display
 * @param {string|null} dueDate - Date string in YYYY-MM-DD format
 * @returns {string|null} Formatted date string or null
 */
export function formatDueDate(dueDate) {
  if (!dueDate) return null;
  const date = new Date(dueDate + 'T00:00:00');
  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined,
  });
}

/**
 * Get the due date status category
 * @param {string|null} dueDate - Date string in YYYY-MM-DD format
 * @returns {'overdue'|'due-today'|'upcoming'|null} Status category
 */
export function getDueDateStatus(dueDate) {
  if (!dueDate) return null;
  if (isOverdue(dueDate)) return 'overdue';
  if (isDueToday(dueDate)) return 'due-today';
  return 'upcoming';
}

/**
 * Get a numeric sort value for due date priority
 * Used for sorting todos by due date urgency
 * @param {string|null} dueDate - Date string in YYYY-MM-DD format
 * @returns {number} Sort priority (1=highest, 4=lowest)
 */
export function getDueDateSortValue(dueDate) {
  if (!dueDate) return 4; // No due date = lowest priority

  if (isOverdue(dueDate)) return 1; // Overdue = highest priority
  if (isDueToday(dueDate)) return 2; // Due today = second priority
  return 3; // Future due date = third priority
}
