# Minimal React Todo App – Architecture & Design

## 1. Overview

This document describes the high-level architecture and file layout for a minimal React Todo application. The app allows users to:

- Add new todos
- Toggle completion status of existing todos
- Delete todos
- (Optional) Filter todos by **All / Active / Completed**

Implementation is assumed to use a standard React tooling setup (e.g., Vite, Create React App, or similar) that will be defined and executed separately by DevOps.

---

## 2. Project Structure

A minimal file layout for the app:

```text
project-root/
  docs/
    README.md              # This architecture & usage document

  src/
    main.jsx               # React entry point, renders <App /> into the DOM
    App.jsx                # Top-level component managing todo state & behavior

    components/
      TodoInput.jsx        # Input field + button to add new todos
      TodoList.jsx         # Renders list of todos
      TodoItem.jsx         # Single todo item with checkbox & delete button

    styles.css             # Basic styling for the app

  index.html               # Root HTML file (created by tooling, e.g., Vite)
  package.json             # Dependencies & scripts (created by tooling)
  ...                      # Tooling-specific config files (e.g., vite.config.js)
```

If using TypeScript, the main entry file would be `main.tsx` instead of `main.jsx`, and component files could be `.tsx` as well. The architectural responsibilities remain the same.

---

## 3. File Responsibilities

### 3.1 `src/main.jsx` (or `src/main.tsx`)

**Responsibility:**
- Bootstraps the React application.
- Renders the root `<App />` component into the DOM.
- Imports global styles.

**Key points:**
- No business logic or todo-specific logic here.
- Only concerns: React root creation, attaching to `#root` in `index.html`, and global CSS import.

### 3.2 `src/App.jsx`

**Responsibility:**
- Top-level stateful component that owns the todo list state and behavior.
- Manages:
  - The array of todos.
  - Optional filter state (All / Active / Completed).
- Passes data and event handlers down to child components via props.

**Core concerns:**
- **State & data model:**
  - Holds `todos` in `useState`.
  - Optionally holds `filter` in `useState`.
- **Handlers:**
  - `handleAddTodo(text: string)` – create a new todo and append to state.
  - `handleToggleTodo(id: string)` – toggle `completed` for a given todo.
  - `handleDeleteTodo(id: string)` – remove a todo from state.
  - `handleChangeFilter(filter: 'all' | 'active' | 'completed')` – update filter state (optional feature).
- **Derived data:**
  - Computes `visibleTodos` based on `todos` and `filter`.
  - Computes `itemsLeft` as the count of active (not completed) todos.

**Child components used:**
- `<TodoInput onAddTodo={handleAddTodo} />`
- `<TodoList todos={visibleTodos} onToggleTodo={handleToggleTodo} onDeleteTodo={handleDeleteTodo} />`
- Optional filter controls (could be inline in `App` or extracted later):
  - Simple buttons or radio controls to switch between All / Active / Completed.

### 3.3 `src/components/TodoInput.jsx`

**Responsibility:**
- Provides a text input and a button to add new todos.
- Handles user input and submission events.

**Behavior:**
- Maintains local input value in component state.
- On **Enter key** press or **Add button** click:
  - Validates that the input is not empty/whitespace.
  - Calls `props.onAddTodo(text)`.
  - Clears the input field after successful add.
- Disables the Add button when the trimmed input is empty, and applies disabled styling.
- Associates the input with a visually hidden label for accessibility.

**Props:**
- `onAddTodo: (text: string) => void`

### 3.4 `src/components/TodoList.jsx`

**Responsibility:**
- Renders a list of todos.
- Delegates individual item rendering and behavior to `TodoItem`.

**Behavior:**
- Receives an array of todos and handler functions from `App`.
- Maps over `todos` and renders `<TodoItem />` for each.
- Handles empty state (e.g., show a message when there are no todos to display).

**Props:**
- `todos: Todo[]`
- `onToggleTodo: (id: string) => void`
- `onDeleteTodo: (id: string) => void`

### 3.5 `src/components/TodoItem.jsx`

**Responsibility:**
- Represents a single todo item.
- Provides UI controls to toggle completion and delete the todo.

**Behavior:**
- Renders:
  - A checkbox (or similar control) bound to `todo.completed`.
  - The todo text, styled differently when completed (e.g., line-through).
  - A delete button/icon with a screen-reader-friendly label.
- On checkbox change:
  - Calls `props.onToggleTodo(todo.id)`.
- On delete button click:
  - Calls `props.onDeleteTodo(todo.id)`.

**Props:**
- `todo: Todo`
- `onToggleTodo: (id: string) => void`
- `onDeleteTodo: (id: string) => void`

### 3.6 `src/styles.css`

**Responsibility:**
- Provides basic styling for the app.

**Typical contents:**
- Global resets or minimal base styles.
- Layout for the main app container (centering, max width, padding).
- Styles for:
  - Input and button in `TodoInput`.
  - Todo list and items (spacing, borders, hover states).
  - Completed todos (e.g., gray text, line-through).
  - Optional filter controls (active state highlighting).
  - Items-left counter text.
  - Accessibility utilities such as `.visually-hidden`.

---

## 4. State & Data Model

### 4.1 Todo Type

Each todo item has the following shape:

```ts
// Conceptual type (applies to JS and TS)
type Todo = {
  id: string;        // Unique identifier (e.g., generated via Date.now() or a UUID helper)
  text: string;      // The user-entered todo description
  completed: boolean; // Whether the todo is marked as done
};
```

### 4.2 State Ownership

- `App` is the **single source of truth** for todos.
- `App` uses React's `useState` hook to manage an array of `Todo` objects:

  ```js
  const [todos, setTodos] = useState<Todo[]>([]); // Type annotation optional in JS
  ```

- Optional filter state is also owned by `App`:

  ```js
  const [filter, setFilter] = useState('all'); // 'all' | 'active' | 'completed'
  ```

- Child components (`TodoInput`, `TodoList`, `TodoItem`) are **stateless with respect to the todo list** and receive data/handlers via props.

### 4.3 Data Flow

- **Downward data flow:**
  - `App` passes `todos` (or `visibleTodos`) and callbacks to `TodoList`.
  - `TodoList` passes individual `todo` objects and callbacks to `TodoItem`.
  - `App` passes `onAddTodo` to `TodoInput`.

- **Upward events:**
  - `TodoInput` calls `onAddTodo(text)` → `App` updates `todos`.
  - `TodoItem` calls `onToggleTodo(id)` → `App` updates `todos`.
  - `TodoItem` calls `onDeleteTodo(id)` → `App` updates `todos`.
  - Optional filter controls in `App` call `setFilter(newFilter)`.

This unidirectional data flow keeps the architecture simple and predictable.

---

## 5. Behavior Details

### 5.1 Add Todo

**User interactions:**
- Type text into the input field.
- Either:
  - Press the **Enter** key, or
  - Click the **Add** button.

**Flow:**
1. `TodoInput` captures the current input value.
2. On submit (Enter or button click):
   - If the text is empty or only whitespace, do nothing (or optionally show a subtle validation hint).
   - Otherwise, call `onAddTodo(text)`.
3. `App`'s `handleAddTodo`:
   - Creates a new `Todo` object: `{ id, text, completed: false }`.
   - Appends it to the existing `todos` array via `setTodos`.
4. `TodoInput` clears its local input state.

### 5.2 Toggle Completion

**User interactions:**
- Click the checkbox next to a todo item.

**Flow:**
1. `TodoItem` handles the checkbox change event.
2. Calls `onToggleTodo(todo.id)`.
3. `App`'s `handleToggleTodo`:
   - Maps over `todos` and flips the `completed` flag for the matching `id`.
   - Updates state with the new array.
4. UI re-renders, showing the todo as completed (e.g., line-through) or active.

### 5.3 Delete Todo

**User interactions:**
- Click the delete button/icon on a todo item.

**Flow:**
1. `TodoItem` handles the delete button click.
2. Calls `onDeleteTodo(todo.id)`.
3. `App`'s `handleDeleteTodo`:
   - Filters out the todo with the given `id` from the `todos` array.
   - Updates state with the filtered array.
4. UI re-renders without the deleted todo.

### 5.4 Optional: Filter (All / Active / Completed)

**User interactions:**
- Click one of the filter controls (e.g., buttons labeled **All**, **Active**, **Completed**).

**Flow:**
1. User clicks a filter button.
2. `App` calls `setFilter('all' | 'active' | 'completed')`.
3. `App` derives `visibleTodos` from `todos` and `filter`:
   - `all`: show all todos.
   - `active`: show todos where `completed === false`.
   - `completed`: show todos where `completed === true`.
4. `TodoList` renders `visibleTodos`.

**UI hints:**
- Highlight the active filter button.
- Show a small counter (e.g., "3 items left") near the filters, updated automatically as todos change.

---

## 6. Basic Usage Description (End-User Perspective)

When the user opens the app in a browser:

1. They see:
   - A title (e.g., "Todo List").
   - An input field with a placeholder (e.g., "What needs to be done?").
   - An **Add** button next to the input.
   - An empty list area (or a message like "No todos yet").
   - Filter controls: **All**, **Active**, **Completed**.
   - A small "items left" counter showing how many active todos remain.

2. To **add a todo**:
   - Type a description into the input.
   - Press **Enter** or click **Add**.
   - The new todo appears in the list below, initially unchecked (not completed).

3. To **mark a todo as completed**:
   - Click the checkbox next to the todo.
   - The text style changes (e.g., gray with a line-through) to indicate completion.

4. To **mark a completed todo as active again**:
   - Click the checkbox again to uncheck it.
   - The text returns to the normal style.

5. To **delete a todo**:
   - Click the delete button/icon associated with that todo.
   - The todo is removed from the list.

6. To **filter todos**:
   - Click **All** to see every todo.
   - Click **Active** to see only todos that are not completed.
   - Click **Completed** to see only todos that are done.

7. As todos are added, completed, or deleted, the items-left counter updates automatically and is exposed as a polite live region for screen readers.

All changes are kept in memory for the current browser session (no persistence is assumed in this minimal design).

---

## 7. Tooling & Setup (High-Level Note)

This document focuses on architecture and component responsibilities. The actual project setup (tooling, bundler, dev server, etc.) is expected to be handled via a standard React setup, for example:

- **Vite** (`npm create vite@latest` with a React template)
- or **Create React App**
- or another modern React-compatible build tool.

DevOps will define and document the exact setup steps (e.g., `npm install`, `npm run dev`, build commands, environment configuration). Once the tooling is in place, the files and structure described above can be created under the `src/` directory to implement this minimal Todo app.
