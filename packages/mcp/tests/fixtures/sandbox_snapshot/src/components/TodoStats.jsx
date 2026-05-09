import React from 'react';
import { isOverdue, isDueToday } from '../utils/dateHelpers.js';
import { normalizePriority } from '../utils/todoHelpers.js';

function TodoStats({ todos }) {
  // Calculate statistics
  const totalTodos = todos.length;
  const completedTodos = todos.filter((todo) => todo.completed).length;
  const activeTodos = totalTodos - completedTodos;
  const completionRate = totalTodos > 0 ? Math.round((completedTodos / totalTodos) * 100) : 0;

  // Priority breakdown (normalize to be resilient to older/invalid persisted data)
  const highPriority = todos.filter((todo) => normalizePriority(todo.priority) === 'high' && !todo.completed).length;
  const mediumPriority = todos.filter((todo) => normalizePriority(todo.priority) === 'medium' && !todo.completed).length;
  const lowPriority = todos.filter((todo) => normalizePriority(todo.priority) === 'low' && !todo.completed).length;

  // Due date calculations
  const overdueTasks = todos.filter((todo) => !todo.completed && isOverdue(todo.dueDate)).length;
  const tasksDueToday = todos.filter((todo) => !todo.completed && isDueToday(todo.dueDate)).length;


  return (
    <div className="todo-stats">
      <h2 className="stats-title">📊 Statistics</h2>
      
      <div className="stats-grid">
        {/* Total Todos */}
        <div className="stat-card">
          <div className="stat-icon">📝</div>
          <div className="stat-content">
            <div className="stat-label">Total Todos</div>
            <div className="stat-value">{totalTodos}</div>
          </div>
        </div>

        {/* Active Todos */}
        <div className="stat-card">
          <div className="stat-icon">⚡</div>
          <div className="stat-content">
            <div className="stat-label">Active</div>
            <div className="stat-value">{activeTodos}</div>
          </div>
        </div>

        {/* Completed Todos */}
        <div className="stat-card">
          <div className="stat-icon">✅</div>
          <div className="stat-content">
            <div className="stat-label">Completed</div>
            <div className="stat-value">{completedTodos}</div>
          </div>
        </div>

        {/* Overdue Tasks */}
        <div className="stat-card stat-card-warning">
          <div className="stat-icon">⚠️</div>
          <div className="stat-content">
            <div className="stat-label">Overdue</div>
            <div className="stat-value">{overdueTasks}</div>
          </div>
        </div>

        {/* Tasks Due Today */}
        <div className="stat-card stat-card-info">
          <div className="stat-icon">📅</div>
          <div className="stat-content">
            <div className="stat-label">Due Today</div>
            <div className="stat-value">{tasksDueToday}</div>
          </div>
        </div>
      </div>

      {/* Completion Progress Bar */}
      <div className="progress-section">
        <div className="progress-header">
          <span className="progress-label">Completion Rate</span>
          <span className="progress-percentage">{completionRate}%</span>
        </div>
        <div className="progress-bar-container">
          <div 
            className="progress-bar-fill" 
            style={{ width: `${completionRate}%` }}
            role="progressbar"
            aria-valuenow={completionRate}
            aria-valuemin="0"
            aria-valuemax="100"
            aria-label={`${completionRate}% of todos completed`}
          />
        </div>
      </div>

      {/* Priority Breakdown */}
      <div className="priority-breakdown">
        <h3 className="breakdown-title">Active Tasks by Priority</h3>
        <div className="priority-stats">
          <div className="priority-stat priority-stat-high">
            <span className="priority-stat-icon">🔴</span>
            <span className="priority-stat-label">High</span>
            <span className="priority-stat-value">{highPriority}</span>
          </div>
          <div className="priority-stat priority-stat-medium">
            <span className="priority-stat-icon">🟡</span>
            <span className="priority-stat-label">Medium</span>
            <span className="priority-stat-value">{mediumPriority}</span>
          </div>
          <div className="priority-stat priority-stat-low">
            <span className="priority-stat-icon">🟢</span>
            <span className="priority-stat-label">Low</span>
            <span className="priority-stat-value">{lowPriority}</span>
          </div>
        </div>
      </div>

      {/* Quick Insights */}
      {totalTodos > 0 && (
        <div className="quick-insights">
          {completionRate === 100 && (
            <div className="insight insight-success">
              🎉 Amazing! All tasks completed!
            </div>
          )}
          {overdueTasks > 0 && (
            <div className="insight insight-warning">
              ⏰ You have {overdueTasks} overdue task{overdueTasks !== 1 ? 's' : ''}
            </div>
          )}
          {tasksDueToday > 0 && (
            <div className="insight insight-info">
              📌 {tasksDueToday} task{tasksDueToday !== 1 ? 's' : ''} due today
            </div>
          )}
          {activeTodos === 0 && totalTodos > 0 && (
            <div className="insight insight-success">
              ✨ All caught up! Great work!
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default TodoStats;
