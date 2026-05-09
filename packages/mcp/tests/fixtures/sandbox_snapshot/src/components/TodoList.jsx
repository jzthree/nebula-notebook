import React from 'react';
import TodoItem from './TodoItem.jsx';

function TodoList({ todos, onToggleTodo, onDeleteTodo, onChangeTodoPriority, onEditTodo }) {
  if (!todos || todos.length === 0) {
    return <p className="empty-state">No todos yet. Add one above!</p>;
  }

  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <TodoItem
          key={todo.id}
          todo={todo}
          onToggleTodo={onToggleTodo}
          onDeleteTodo={onDeleteTodo}
          onChangeTodoPriority={onChangeTodoPriority}
          onEditTodo={onEditTodo}
        />
      ))}
    </ul>
  );
}

export default TodoList;
