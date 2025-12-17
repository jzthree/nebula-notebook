
import { useState, useCallback } from 'react';
import { Cell } from '../types';

// Maximum number of history steps to keep in memory
const MAX_HISTORY = 50;

interface UseUndoRedoResult {
  cells: Cell[];
  setCells: (newCells: Cell[] | ((prev: Cell[]) => Cell[])) => void; // Updates current state WITHOUT history
  pushState: (newCells: Cell[]) => void; // Updates current state AND pushes previous to history
  saveCheckpoint: () => void; // Saves current state to history without changing it (for sessions)
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  resetHistory: (initialCells: Cell[]) => void;
}

// Helper to strip heavy outputs to save memory
const cleanForHistory = (cells: Cell[]): Cell[] => {
  return cells.map(c => ({
    ...c,
    outputs: [], // We do not store outputs in history to keep it lightweight
    isExecuting: false
  }));
};

// Deep equality check for cell content (ignoring ephemeral props)
const areStatesEqual = (a: Cell[], b: Cell[]) => {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((cell, i) => {
    const other = b[i];
    return cell.id === other.id && 
           cell.type === other.type && 
           cell.content === other.content;
  });
};

export const useUndoRedo = (initialCells: Cell[]): UseUndoRedoResult => {
  // Past: Array of historical snapshots
  const [past, setPast] = useState<Cell[][]>([]);
  
  // Present: The actual current state
  const [present, setPresent] = useState<Cell[]>(initialCells);
  
  // Future: Array of snapshots we can redo into
  const [future, setFuture] = useState<Cell[][]>([]);

  const canUndo = past.length > 0;
  const canRedo = future.length > 0;

  // 1. Undo
  const undo = useCallback(() => {
    if (past.length === 0) return;

    const previous = past[past.length - 1];
    const newPast = past.slice(0, past.length - 1);

    // Push current "present" to future
    const cleanPresent = cleanForHistory(present);

    setPast(newPast);
    setFuture([cleanPresent, ...future]);
    setPresent(previous); // Previous state from history (already clean)
  }, [past, present, future]);

  // 2. Redo
  const redo = useCallback(() => {
    if (future.length === 0) return;

    const next = future[0];
    const newFuture = future.slice(1);

    const cleanPresent = cleanForHistory(present);

    setPast([...past, cleanPresent]);
    setFuture(newFuture);
    setPresent(next);
  }, [past, present, future]);

  // 3. Set Cells (No History) - used for typing characters
  const setCells = useCallback((newCells: Cell[] | ((prev: Cell[]) => Cell[])) => {
    setPresent(newCells);
  }, []);

  // 4. Push State (Commit to History) - used for structural changes
  const pushState = useCallback((newCells: Cell[]) => {
    setPast(prev => {
      const stateToSave = cleanForHistory(present);
      
      // Duplicate detection: If the state we are about to save is identical 
      // to the last saved state, don't push it.
      const lastSaved = prev.length > 0 ? prev[prev.length - 1] : [];
      if (areStatesEqual(lastSaved, stateToSave)) {
          return prev;
      }

      const newPast = [...prev, stateToSave];
      if (newPast.length > MAX_HISTORY) {
        newPast.shift(); // Remove oldest
      }
      return newPast;
    });
    setPresent(newCells);
    setFuture([]); // Clear redo stack on new branch
  }, [present]);

  // 5. Save Checkpoint - snapshots the *current* state to history
  const saveCheckpoint = useCallback(() => {
    pushState(present);
  }, [pushState, present]);

  // 6. Reset (Load File)
  const resetHistory = useCallback((cells: Cell[]) => {
    setPast([]);
    setFuture([]);
    setPresent(cells);
  }, []);

  return {
    cells: present,
    setCells,
    pushState,
    saveCheckpoint,
    undo,
    redo,
    canUndo,
    canRedo,
    resetHistory
  };
};
