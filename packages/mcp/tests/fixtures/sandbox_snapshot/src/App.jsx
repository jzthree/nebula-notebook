import React, { useEffect, useMemo, useRef, useState } from 'react';
import TodoInput from './components/TodoInput.jsx';
import TodoList from './components/TodoList.jsx';
import TodoStats from './components/TodoStats.jsx';
import { FILTERS, PRIORITY_ORDER, UNDO_TIMEOUT_MS, STORAGE_KEYS, THEMES } from './constants.js';
import { normalizePriority } from './utils/todoHelpers.js';
import { getDueDateSortValue } from './utils/dateHelpers.js';

function App() {
  const [todos, setTodos] = useState(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEYS.TODOS);
      const parsed = stored ? JSON.parse(stored) : [];
      if (!Array.isArray(parsed)) return [];
      return parsed.map((todo) => ({
        ...todo,
        priority: normalizePriority(todo.priority),
      }));
    } catch {
      return [];
    }
  });
  const [filter, setFilter] = useState('all'); // 'all' | 'active' | 'completed'
  const [searchQuery, setSearchQuery] = useState('');
  const [theme, setTheme] = useState(() => {
    if (typeof window === 'undefined') return THEMES.LIGHT;
    const stored = window.localStorage.getItem(STORAGE_KEYS.THEME);
    if (stored === THEMES.DARK || stored === THEMES.LIGHT) return stored;
    // Fallback to system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return THEMES.DARK;
    }
    return THEMES.LIGHT;
  });
  const [showStats, setShowStats] = useState(() => {
    if (typeof window === 'undefined') return false;
    const stored = window.localStorage.getItem(STORAGE_KEYS.SHOW_STATS);
    return stored === 'true';
  });

  // Undo state for destructive actions (delete / clear completed)
  const [undoState, setUndoState] = useState(null);
  // { message: string, prevTodos: Todo[], createdAt: number }
  const undoTimerRef = useRef(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.TODOS, JSON.stringify(todos));
    } catch {
      // Best-effort persistence; ignore errors (e.g., private mode or quota issues)
    }
  }, [todos]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.THEME, theme);
    } catch {
      // ignore
    }
    if (typeof document !== 'undefined') {
      document.documentElement.dataset.theme = theme;
    }
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEYS.SHOW_STATS, showStats.toString());
    } catch {
      // ignore
    }
  }, [showStats]);

  useEffect(() => {
    // Clear any existing timer when undoState changes
    if (undoTimerRef.current) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }

    if (!undoState) return;

    undoTimerRef.current = window.setTimeout(() => {
      setUndoState(null);
    }, UNDO_TIMEOUT_MS);

    return () => {
      if (undoTimerRef.current) {
        window.clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, [undoState]);

  const showUndo = (message, prevTodos) => {
    setUndoState({ message, prevTodos, createdAt: Date.now() });
  };

  const handleUndo = () => {
    if (!undoState) return;
    setTodos(undoState.prevTodos);
    setUndoState(null);
  };

  const handleDismissUndo = () => {
    setUndoState(null);
  };

  const generateTodoId = () => {
    // Prefer collision-resistant IDs when available.
    // Fallback keeps behavior stable in older environments.
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  };

  const handleAddTodo = (text, priority, dueDate) => {
    const trimmed = text.trim();
    if (!trimmed) return;

    const newTodo = {
      id: generateTodoId(),
      text: trimmed,
      completed: false,
      priority: normalizePriority(priority),
      dueDate: dueDate || null,
    };

    setTodos((prev) => [newTodo, ...prev]);
  };

  const handleToggleTodo = (id) => {
    setTodos((prev) =>
      prev.map((todo) =>
        todo.id === id ? { ...todo, completed: !todo.completed } : todo
      )
    );
  };

  const handleDeleteTodo = (id) => {
    setTodos((prev) => {
      const next = prev.filter((todo) => todo.id !== id);
      if (next.length !== prev.length) {
        showUndo('Todo deleted.', prev);
      }
      return next;
    });
  };

  const handleClearCompleted = () => {
    setTodos((prev) => {
      const next = prev.filter((todo) => !todo.completed);
      if (next.length !== prev.length) {
        showUndo('Completed todos cleared.', prev);
      }
      return next;
    });
  };

  const handleChangeTodoPriority = (id, priority) => {
    const normalized = normalizePriority(priority);
    setTodos((prev) =>
      prev.map((todo) =>
        todo.id === id ? { ...todo, priority: normalized } : todo
      )
    );
  };

  const handleEditTodo = (id, nextText, nextDueDate) => {
    const trimmed = (nextText ?? '').trim();
    if (!trimmed) return;

    setTodos((prev) =>
      prev.map((todo) =>
        todo.id === id
          ? {
              ...todo,
              text: trimmed,
              dueDate: nextDueDate || null,
            }
          : todo
      )
    );
  };

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const filteredTodos = useMemo(() => {
    return todos
      .filter((todo) => {
        if (filter === 'active') return !todo.completed;
        if (filter === 'completed') return todo.completed;
        return true; // 'all'
      })
      .filter((todo) => {
        if (!normalizedSearch) return true;
        const text = (todo.text || '').toLowerCase();
        return text.includes(normalizedSearch);
      })
      .map((todo, index) => ({ todo, index }))
      .sort((a, b) => {
        // First sort by due date status
        const aDueDatePriority = getDueDateSortValue(a.todo.dueDate);
        const bDueDatePriority = getDueDateSortValue(b.todo.dueDate);

        if (aDueDatePriority !== bDueDatePriority) {
          return aDueDatePriority - bDueDatePriority;
        }

        // Then by priority level
        const aPriority = PRIORITY_ORDER[normalizePriority(a.todo.priority)];
        const bPriority = PRIORITY_ORDER[normalizePriority(b.todo.priority)];
        if (aPriority !== bPriority) {
          return bPriority - aPriority; // high > medium > low
        }

        // Finally preserve original order for equal priority and due date
        return a.index - b.index;
      })
      .map((entry) => entry.todo);
  }, [todos, filter, normalizedSearch]);

  const itemsLeft = useMemo(() => todos.filter((todo) => !todo.completed).length, [todos]);
  const hasCompleted = useMemo(() => todos.some((todo) => todo.completed), [todos]);

  const toggleTheme = () => {
    setTheme((prev) => (prev === THEMES.DARK ? THEMES.LIGHT : THEMES.DARK));
  };

  const toggleStats = () => {
    setShowStats((prev) => !prev);
  };

  return (
    <main className="app-main">
      <div className="app-container">
        <header className="app-header">
          <h1 className="app-title">Todo App</h1>
          <div className="header-buttons">
            <button
              type="button"
              className="stats-toggle-button"
              onClick={toggleStats}
              aria-label={showStats ? 'Hide statistics' : 'Show statistics'}
              aria-pressed={showStats}
            >
              📊 Stats
            </button>
            <button
              type="button"
              className="theme-toggle-button"
              onClick={toggleTheme}
              aria-label={theme === THEMES.DARK ? 'Switch to light theme' : 'Switch to dark theme'}
            >
              {theme === THEMES.DARK ? '☀️ Light' : '🌙 Dark'}
            </button>
          </div>
        </header>

        {showStats && <TodoStats todos={todos} />}

        <TodoInput onAddTodo={handleAddTodo} />

        <div className="filters">
          {FILTERS.map((option) => (
            <button
              key={option.id}
              type="button"
              className={
                filter === option.id ? 'filter-button active' : 'filter-button'
              }
              aria-pressed={filter === option.id}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="search-bar">
          <label className="visually-hidden" htmlFor="todo-search-input">
            Search todos
          </label>
          <input
            id="todo-search-input"
            type="search"
            className="search-input"
            placeholder="Search by text..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        <p className="items-left" aria-live="polite">
          {itemsLeft} item{itemsLeft !== 1 ? 's' : ''} left
        </p>

        <button
          type="button"
          className="clear-completed-button"
          onClick={handleClearCompleted}
          disabled={!hasCompleted}
        >
          Clear completed
        </button>

        <TodoList
          todos={filteredTodos}
          onToggleTodo={handleToggleTodo}
          onDeleteTodo={handleDeleteTodo}
          onChangeTodoPriority={handleChangeTodoPriority}
          onEditTodo={handleEditTodo}
        />

        {undoState && (
          <div className="undo-toast" role="status" aria-live="polite">
            <span className="undo-message">{undoState.message}</span>
            <div className="undo-actions">
              <button type="button" className="undo-button" onClick={handleUndo}>
                Undo
              </button>
              <button
                type="button"
                className="undo-dismiss"
                onClick={handleDismissUndo}
                aria-label="Dismiss"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}

export default App;
