import React, { useEffect, useRef, useState } from 'react';
import { getTodayString, isOverdue } from '../utils/dateHelpers.js';

// TodoInput manages only local input state and delegates todo creation
// to its parent via the onAddTodo callback.
function TodoInput({ onAddTodo }) {
  const [text, setText] = useState('');
  const [priority, setPriority] = useState('medium');
  const [dueDate, setDueDate] = useState('');
  const inputRef = useRef(null);
  const isEmpty = text.trim().length === 0; // controls disabled state of the Add button

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
    }
  }, []);

  const submitCurrentText = () => {
    const trimmed = text.trim();
    if (!trimmed) return;

    // Allow submitting an existing overdue date (e.g., from manual edit),
    // but prevent creating a *new* todo with an overdue dueDate.
    const normalizedDueDate = dueDate || null;
    const safeDueDate = normalizedDueDate && isOverdue(normalizedDueDate) ? null : normalizedDueDate;

    if (typeof onAddTodo === 'function') {
      onAddTodo(trimmed, priority, safeDueDate);
    }
    setText('');
    setPriority('medium');
    setDueDate('');
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  const handleSubmit = (event) => {
    event.preventDefault();
    submitCurrentText();
  };

  const handleKeyDown = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setText('');
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submitCurrentText();
    }
  };

  return (
    <form className="todo-input" onSubmit={handleSubmit}>
      <label className="visually-hidden" htmlFor="new-todo-input">
        Add a new todo
      </label>
      <input
        id="new-todo-input"
        type="text"
        className="todo-input-field"
        placeholder="What needs to be done?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        ref={inputRef}
      />
      <label className="visually-hidden" htmlFor="todo-priority-select">
        Todo priority
      </label>
      <select
        id="todo-priority-select"
        className="priority-select"
        value={priority}
        onChange={(e) => setPriority(e.target.value)}
      >
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
      <label className="visually-hidden" htmlFor="todo-due-date-input">
        Due date (optional)
      </label>
      <input
        id="todo-due-date-input"
        type="date"
        className="due-date-input"
        value={dueDate}
        onChange={(e) => setDueDate(e.target.value)}
        min={getTodayString()}
      />
      <button type="submit" className="add-button" disabled={isEmpty}>
        Add
      </button>
    </form>
  );
}

export default TodoInput;
