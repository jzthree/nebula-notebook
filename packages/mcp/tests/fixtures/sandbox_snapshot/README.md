# Minimal React Todo App

A small, single-page Todo application built with React. It demonstrates a clean component structure, unidirectional data flow, and basic state management for a typical todo list.

The app lets you add, complete, delete, and filter todos, and is intended as a minimal but realistic example of a React front end.

---

## Getting Started

This project assumes a standard modern React setup (for example, Vite, Create React App, or a similar tool). The exact tooling may vary, but the general steps are:

1. **Install dependencies**
   ```bash
   npm install
   # or
   yarn install
   ```

2. **Start the development server**
   ```bash
   npm run dev
   # or, depending on your setup
   npm start
   ```

3. **Open the app in your browser**
   - The dev server will print a local URL (commonly `http://localhost:5173` for Vite or `http://localhost:3000` for CRA).
   - Navigate to that URL to use the Todo app.

4. **Build for production** (optional)
   ```bash
   npm run build
   ```

Refer to your chosen tooling's documentation (Vite, CRA, etc.) for any additional commands or configuration.

---

## Features

- **Add todos**
  - Type a task into the input field and press **Enter** or click **Add**.
- **Toggle completion**
  - Click the checkbox next to a todo to mark it as completed or active.
- **Delete todos**
  - Remove a todo by clicking its **Delete** button.
- **Filter by status**
  - Use the **All / Active / Completed** buttons to filter which todos are shown.
- **Items-left counter**
  - Shows how many active (not completed) todos remain, updating automatically as you add, complete, or delete items.
- **Client-side persistence**
  - Todos are stored in `localStorage` so your list survives page reloads in the same browser. Persistence is best-effort and purely client-side; no backend is involved.
- **Clear completed action**
  - A `Clear completed` button lets you quickly remove all completed todos at once and is disabled when there are no completed items.
- **Basic accessibility helpers**
  - Labeled input using a visually hidden label, disabled Add button when the trimmed input is empty, a screen-reader-friendly `aria-label` on delete buttons, and an `aria-live="polite"` items-left counter. See `docs/IMPROVEMENTS.md` for more details.

All state is kept in the browser on the client side; no backend is required for this minimal version.

---

## Project Structure & Architecture

This README is a high-level overview for running and using the app. For a detailed description of the architecture, component responsibilities, and recommended file layout, see:

- [`docs/README.md`](docs/README.md)

Any notes about potential improvements, refactors, or design decisions beyond the current implementation should be captured in:

- `docs/IMPROVEMENTS.md` (as defined by the architecture documentation)

---
