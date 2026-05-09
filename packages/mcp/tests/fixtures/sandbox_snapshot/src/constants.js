/**
 * Application-wide constants
 */

// Filter options for todo list
export const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'completed', label: 'Completed' },
];

// Priority levels and their sort order
export const PRIORITY_ORDER = {
  low: 1,
  medium: 2,
  high: 3,
};

export const VALID_PRIORITIES = ['low', 'medium', 'high'];
export const DEFAULT_PRIORITY = 'medium';

// Undo timeout in milliseconds
export const UNDO_TIMEOUT_MS = 6000;

// LocalStorage keys
export const STORAGE_KEYS = {
  TODOS: 'todos',
  THEME: 'theme',
  SHOW_STATS: 'showStats',
};

// Theme options
export const THEMES = {
  LIGHT: 'light',
  DARK: 'dark',
};
