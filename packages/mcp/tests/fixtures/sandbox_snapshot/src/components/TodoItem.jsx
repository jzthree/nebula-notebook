import React, { useEffect, useRef, useState } from 'react';
import { normalizePriority } from '../utils/todoHelpers.js';
import { formatDueDate, getDueDateStatus, getTodayString, isOverdue } from '../utils/dateHelpers.js';

function TodoItem({ todo, onToggleTodo, onDeleteTodo, onChangeTodoPriority, onEditTodo }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draftText, setDraftText] = useState(todo?.text ?? '');
  const [draftDueDate, setDraftDueDate] = useState(todo?.dueDate ?? '');
  const editInputRef = useRef(null);

  useEffect(() => {
    setDraftText(todo?.text ?? '');
    setDraftDueDate(todo?.dueDate ?? '');
  }, [todo?.text, todo?.dueDate]);

  useEffect(() => {
    if (isEditing && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select?.();
    }
  }, [isEditing]);

  const handleToggle = () => {
    if (typeof onToggleTodo === 'function') {
      onToggleTodo(todo.id);
    }
  };

  const handleDelete = () => {
    if (typeof onDeleteTodo === 'function') {
      onDeleteTodo(todo.id);
    }
  };

  const effectivePriority = normalizePriority(todo?.priority);

  const handlePriorityChange = (event) => {
    const newPriority = event.target.value;
    if (typeof onChangeTodoPriority === 'function') {
      onChangeTodoPriority(todo.id, newPriority);
    }
  };

  const startEdit = () => {
    setDraftText(todo?.text ?? '');
    setDraftDueDate(todo?.dueDate ?? '');
    setIsEditing(true);
  };

  const cancelEdit = () => {
    setDraftText(todo?.text ?? '');
    setDraftDueDate(todo?.dueDate ?? '');
    setIsEditing(false);
  };

  const saveEdit = () => {
    const trimmed = (draftText ?? '').trim();
    if (!trimmed) return;

    const normalizedDueDate = draftDueDate || null;
    if (normalizedDueDate && isOverdue(normalizedDueDate)) return;

    if (typeof onEditTodo === 'function') {
      onEditTodo(todo.id, trimmed, normalizedDueDate);
    }
    setIsEditing(false);
  };

  const clearDueDate = () => {
    setDraftDueDate('');
  };

  const handleEditKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      saveEdit();
    }
  };

  const dueDateStatus = getDueDateStatus(todo.dueDate);

  const handleRowKeyDown = (event) => {
    if (isEditing) return;

    if (event.key === 'Enter') {
      event.preventDefault();
      handleToggle();
      return;
    }

    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      handleDelete();
      return;
    }

    if (event.key === 'e' || event.key === 'E') {
      event.preventDefault();
      startEdit();
    }
  };

  return (
    <li
      className={`todo-item priority-${effectivePriority} ${
        dueDateStatus ? `due-status-${dueDateStatus}` : ''
      }`}
      tabIndex={0}
      role="group"
      aria-label={todo.text ? `Todo: ${todo.text}` : 'Todo'}
      onKeyDown={handleRowKeyDown}
    >
      <div className="todo-item-content">
        <input
          type="checkbox"
          checked={!!todo.completed}
          onChange={handleToggle}
          aria-label={todo.text ? `Toggle todo: ${todo.text}` : 'Toggle todo'}
        />

        {isEditing ? (
          <div className="todo-edit-fields" onKeyDown={handleEditKeyDown}>
            <input
              ref={editInputRef}
              type="text"
              className="todo-edit-input"
              value={draftText}
              onChange={(e) => setDraftText(e.target.value)}
              aria-label="Edit todo text"
            />
            <div className="todo-edit-date-row">
              <input
                type="date"
                className="todo-edit-date"
                value={draftDueDate || ''}
                onChange={(e) => setDraftDueDate(e.target.value)}
                aria-label="Edit due date"
                min={getTodayString()}
              />
              <button
                type="button"
                className="todo-edit-date-clear"
                onClick={clearDueDate}
                disabled={!draftDueDate}
                aria-label="Clear due date"
              >
                Clear
              </button>
            </div>
            {draftDueDate && isOverdue(draftDueDate) && (
              <p className="todo-edit-date-warning" role="status">
                Due date can’t be in the past.
              </p>
            )}
          </div>
        ) : (
          <>
            <span className={todo.completed ? 'todo-text completed' : 'todo-text'}>
              {todo.text}
            </span>
            {todo.dueDate && (
              <span className={`due-date-badge due-date-${dueDateStatus}`}>
                {dueDateStatus === 'overdue' && '⚠️ '}
                {dueDateStatus === 'due-today' && '📅 '}
                Due {formatDueDate(todo.dueDate)}
              </span>
            )}
            <span className={`priority-badge priority-badge-${effectivePriority}`}>
              {effectivePriority === 'high'
                ? 'High'
                : effectivePriority === 'low'
                  ? 'Low'
                  : 'Medium'}
            </span>
          </>
        )}
      </div>

      <select
        className="priority-select-item"
        aria-label="Change todo priority"
        value={effectivePriority}
        onChange={handlePriorityChange}
        disabled={isEditing}
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>

      {isEditing ? (
        <>
          <button type="button" className="edit-save-button" onClick={saveEdit}>
            Save
          </button>
          <button type="button" className="edit-cancel-button" onClick={cancelEdit}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="edit-button" onClick={startEdit}>
          Edit
        </button>
      )}

      <button
        type="button"
        className="delete-button"
        onClick={handleDelete}
        aria-label={todo.text ? `Delete todo: ${todo.text}` : 'Delete todo'}
        disabled={isEditing}
      >
        Delete
      </button>
    </li>
  );
}

export default TodoItem;
