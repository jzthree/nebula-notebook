> NOTE: This file was lightly edited by an automated tool demo (replace).

# Improvement Plan – Minimal React Todo App

This document outlines targeted, incremental improvements to the current implementation. The goal is to keep the app minimal while improving consistency, UX, and accessibility, and to add a quickstart README at the project root.

---

## 1. Prop Naming Consistency

### Current state
- `App.jsx` passes these props into `TodoList`:
  - `onToggleTodo={handleToggleTodo}`
  - `onDeleteTodo={handleDeleteTodo}`
- `TodoList.jsx` receives and forwards the same names:
  - `function TodoList({ todos, onToggleTodo, onDeleteTodo }) { ... }`
  - `<TodoItem ... onToggleTodo={onToggleTodo} onDeleteTodo={onDeleteTodo} />`
- `TodoItem.jsx` defines:
  - `function TodoItem({ todo, onToggleTodo, onDeleteTodo }) { ... }`

The architecture document in `docs/README.md` now also describes `TodoItem` props using these same names.

### Plan
1. **Chosen convention: keep the explicit names already used in code.**
   - `onToggleTodo`
   - `onDeleteTodo`
   - Rationale: these names are self-describing and align with the handlers in `App` (`handleToggleTodo`, `handleDeleteTodo`).

2. **Align documentation with implementation.**
   - `docs/README.md` section **3.5 `src/components/TodoItem.jsx`** now lists props as:
     - `todo: Todo`
     - `onToggleTodo: (id: string) => void`
     - `onDeleteTodo: (id: string) => void`
   - The behavior description references `props.onToggleTodo(todo.id)` and `props.onDeleteTodo(todo.id)`.

Both implementation and docs now consistently use `onToggleTodo` / `onDeleteTodo`.

---

## 2. Small UX Improvements

### 2.1 Items-left counter

**Goal:** Give users a quick sense of remaining work by showing how many active (not completed) todos are left.

**Current / Implemented state:**
- In `App.jsx`, the active count is derived as:
  - `const itemsLeft = todos.filter((todo) => !todo.completed).length;`
- A small status line is rendered near the filters, below the filter buttons and above the list:
  - `<p className="items-left" aria-live="polite">{itemsLeft} item{itemsLeft !== 1 ? 's' : ''} left</p>`
- Minimal styling exists in `styles.css`:
  - `.items-left { font-size: 0.85rem; color: #6b7280; text-align: center; margin-bottom: 8px; }`

**Rationale:**
- Very low implementation cost.
- Matches common todo app patterns (e.g., TodoMVC).
- Improves perceived usefulness without adding complexity.

### 2.2 Disable Add button when input is empty

**Goal:** Make it visually clear when adding is possible and prevent unnecessary form submissions.

**Current / Implemented state:**
1. In `TodoInput.jsx`, a boolean is computed for whether the input has non-whitespace content:
   - `const isEmpty = text.trim().length === 0;`
2. This is applied to the button:
   - `<button type="submit" className="add-button" disabled={isEmpty}>Add</button>`
3. Disabled styling exists in `styles.css`:
   - `.add-button:disabled { background: #9ca3af; cursor: not-allowed; box-shadow: none; }`

**Rationale:**
- The form already prevents empty submissions in `handleSubmit`; disabling the button makes this behavior discoverable.
- Reduces user confusion and accidental clicks.

### 2.3 Minor empty-state refinement (optional)

**Current:** `TodoList` shows `"No todos yet. Add one above!"` when empty.

**Plan (optional):**
- Keep the message but consider slightly softer copy or an icon if design evolves. No code change strictly required.

---

## 3. Basic Accessibility Improvements

The current implementation is close to accessible by default, but a few small changes improve screen reader and keyboard support.

### 3.1 Associate input with a label

**Current / Implemented state:**
- `TodoInput` uses a visually hidden `<label>` associated with the main input, and a reusable `.visually-hidden` class is defined in `styles.css`.
- Example structure in `TodoInput.jsx`:
  ```jsx
  <form className="todo-input" onSubmit={handleSubmit}>
    <label className="visually-hidden" htmlFor="new-todo-input">
      Add a new todo
    </label>
    <input
      id="new-todo-input"
      type="text"
      className="todo-input-field"
      placeholder="What needs to be done?"
      ...
    />
    <button type="submit" className="add-button" disabled={isEmpty}>
      Add
    </button>
  </form>
  ```
- The `.visually-hidden` utility in `styles.css` hides the label visually while keeping it available to screen readers.

**Rationale:**
- Screen readers announce a meaningful label instead of only the placeholder.

### 3.2 Improve checkbox labeling

**Current:**
- `TodoItem` wraps the checkbox and text in a `<label>`, which is good: clicking the text toggles the checkbox.

**Plan:**
- Keep this pattern; no change required.
- `aria-checked` is not needed because the native checkbox already exposes state.

### 3.3 Button types and semantics

**Current / Implemented state:**
- All buttons specify `type="button"` or `type="submit"` correctly.
- The delete button includes an `aria-label` that incorporates the todo text when available, for example:
  ```jsx
  <button
    type="button"
    className="delete-button"
    onClick={handleDelete}
    aria-label={todo.text ? `Delete todo: ${todo.text}` : 'Delete todo'}
  >
    Delete
  </button>
  ```

**Rationale:**
- Helps screen reader users distinguish between multiple delete buttons.

### 3.4 Live region for items-left counter

**Current / Implemented state:**
- The items-left counter is marked as a polite live region so screen readers announce changes when todos are added/removed/toggled:
  ```jsx
  <p className="items-left" aria-live="polite">
    {itemsLeft} item{itemsLeft !== 1 ? 's' : ''} left
  </p>
  ```

**Rationale:**
- Keeps users informed of state changes without requiring them to navigate back to the counter.

---

## 4. Client-side persistence and clear-completed action

### 4.1 LocalStorage persistence

**Goal:** Let users keep their todo list across page reloads in the same browser without introducing a backend.

**Current / Implemented state:**
- `App.jsx` initializes the `todos` state from `window.localStorage` using a lazy `useState` initializer:
  - Attempts to read the `"todos"` key and parse it as JSON.
  - Falls back to an empty array (`[]`) if the key is missing or if parsing fails.
- A `useEffect` watches `todos` and writes the current list back to `localStorage` whenever it changes:
  - `window.localStorage.setItem('todos', JSON.stringify(todos));`
- All `localStorage` access is wrapped in `try/catch` so the app continues to work even if storage is unavailable (e.g., private browsing, quota errors) or contains invalid data.

**Rationale:**
- Provides a nicer experience by keeping todos between reloads while remaining purely client-side.
- Avoids adding any backend or sync complexity; persistence is best-effort only.

### 4.2 Clear completed button

**Goal:** Provide a quick way to remove all completed todos at once.

**Current / Implemented state:**
- `App.jsx` defines a `handleClearCompleted` handler:
  ```jsx
  const handleClearCompleted = () => {
    setTodos((prev) => prev.filter((todo) => !todo.completed));
  };
  ```
- A `Clear completed` button is rendered near the filters and items-left counter:
  - Uses `type="button"`.
  - Reuses existing button styling patterns via a lightweight `clear-completed-button` class.
  - Is disabled when there are no completed todos, to avoid a no-op action.

**Rationale:**
- Matches common todo app behavior (e.g., TodoMVC) and makes cleanup faster for users with many completed items.

---

## 5. Top-level README.md (Quickstart)

### Goal
Provide a short, high-level `README.md` at the project root that:
- Explains what the project is.
- Shows basic setup and run commands.
- Points readers to `docs/README.md` for detailed architecture and design.

### Plan
1. Create `README.md` in the project root with:
   - **Title and description**: e.g., "Minimal React Todo App" and a one-paragraph summary.
   - **Prerequisites**: Node.js version assumption.
   - **Install & run**: generic commands that match the chosen tooling (e.g., Vite or CRA). If tooling is not finalized, keep it generic:
     - `npm install`
     - `npm run dev`
   - **Project structure overview**: brief bullet list referencing `src/` and `docs/`.
   - **Link to detailed docs**: a clear link to `docs/README.md`.

2. Keep the root README intentionally concise and defer deeper explanations to `docs/README.md` and `docs/IMPROVEMENTS.md`.

---

## 5. Summary of Concrete Actions

1. **Prop naming consistency**
   - Adopt `onToggleTodo` / `onDeleteTodo` as the single convention across code and docs.
   - `docs/README.md` documents `TodoItem` props using these names to match the implementation.

2. **UX improvements**
   - Derive an `itemsLeft` value in `App.jsx` and render a small counter near the filters, marked as a polite live region.
   - Disable the Add button in `TodoInput.jsx` when the trimmed input is empty; use `.add-button:disabled` styling in `styles.css`.

3. **Accessibility improvements**
   - Use a visually hidden label for the main todo input and a `.visually-hidden` CSS utility.
   - Add `aria-label` to the delete button and `aria-live="polite"` to the items-left counter.

4. **Documentation**
   - Maintain a concise top-level `README.md` with quickstart instructions and a link to `docs/README.md`.
   - Use this `docs/IMPROVEMENTS.md` as the living record of planned and implemented improvements.
