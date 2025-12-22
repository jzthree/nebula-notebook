import { useEffect, useRef, useCallback, useState } from 'react';
import { Cell } from '../types';
import {
  AutosaveState,
  AutosaveEvent,
  AutosaveEffect,
  autosaveReducer,
  getInitialState,
} from './autosaveStateMachine';

export interface AutosaveStatus {
  status: 'saved' | 'saving' | 'unsaved' | 'error';
  lastSaved: number | null;
}

export interface UseAutosaveOptions {
  fileId: string | null;
  cells: Cell[];
  onSave: (fileId: string, cells: Cell[]) => Promise<void>;
  enabled?: boolean;
  hasRedoHistory?: boolean; // Block autosave when redo history exists (user has undone)
}

export function useAutosave({ fileId, cells, onSave, enabled = true, hasRedoHistory = false }: UseAutosaveOptions) {
  // UI status (derived from machine state)
  const [uiStatus, setUiStatus] = useState<AutosaveStatus>({
    status: 'saved',
    lastSaved: null,
  });

  // State machine state
  const [machineState, setMachineState] = useState<AutosaveState>(getInitialState);

  // Refs for timers and content tracking
  const checkTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const retryTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>('');
  const cellsRef = useRef(cells);

  // Ref for executeEffect to avoid stale closure in dispatch
  const executeEffectRef = useRef<(effect: AutosaveEffect) => void>(() => {});

  // Track if current save is manual (show "Saving..." only for manual saves)
  const isManualSaveRef = useRef(false);

  // Serialize cells for comparison (includes outputs to trigger save after execution)
  // Also includes scrolled, scrolledHeight and _metadata to trigger save when metadata changes
  const serializeCells = useCallback((cells: Cell[]) => {
    return JSON.stringify(cells.map(c => ({
      id: c.id,
      type: c.type,
      content: c.content,
      scrolled: c.scrolled,
      scrolledHeight: c.scrolledHeight,
      _metadata: c._metadata,
      outputs: c.outputs?.map(o => ({
        id: o.id,
        type: o.type,
        content: o.content,
      })),
    })));
  }, []);

  // Check if there are unsaved changes
  const hasUnsavedChanges = useCallback(() => {
    const currentContent = serializeCells(cells);
    return currentContent !== lastSavedContentRef.current;
  }, [cells, serializeCells]);

  // Cancel all pending operations
  const cancelPendingOperations = useCallback(() => {
    if (checkTimeoutRef.current) {
      clearTimeout(checkTimeoutRef.current);
      checkTimeoutRef.current = null;
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = null;
    }
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
  }, []);

  // Dispatch an event to the state machine and execute effects
  const dispatch = useCallback((event: AutosaveEvent) => {
    setMachineState(currentState => {
      const { state: newState, effects } = autosaveReducer(currentState, event);

      // Execute effects (scheduled in next tick to avoid state update conflicts)
      // Use ref to avoid stale closure - executeEffectRef always has the latest version
      if (effects.length > 0) {
        setTimeout(() => {
          effects.forEach(effect => executeEffectRef.current(effect));
        }, 0);
      }

      return newState;
    });
  }, []);

  // Perform the actual save operation
  const performSave = useCallback(async () => {
    if (!fileId || !enabled) {
      dispatch({ type: 'SAVE_SUCCESS' }); // No-op success
      return;
    }

    const currentContent = serializeCells(cells);
    if (currentContent === lastSavedContentRef.current) {
      dispatch({ type: 'SAVE_SUCCESS' }); // No actual changes
      return;
    }

    // Only show "Saving..." for manual saves - autosave is silent
    if (isManualSaveRef.current) {
      setUiStatus(prev => ({ status: 'saving', lastSaved: prev.lastSaved }));
    }

    try {
      await onSave(fileId, cells);
      lastSavedContentRef.current = currentContent;
      setUiStatus({ status: 'saved', lastSaved: Date.now() });
      dispatch({ type: 'SAVE_SUCCESS' });
    } catch (error) {
      console.error('Autosave failed:', error);
      setUiStatus(prev => ({ status: 'error', lastSaved: prev.lastSaved }));
      dispatch({ type: 'SAVE_ERROR', error: error instanceof Error ? error : new Error(String(error)) });
    } finally {
      // Reset manual save flag
      isManualSaveRef.current = false;
    }
  }, [fileId, cells, enabled, onSave, serializeCells, dispatch]);

  // Check for changes and report to state machine
  const checkForChanges = useCallback(() => {
    const currentContent = serializeCells(cells);
    const hasChanges = currentContent !== lastSavedContentRef.current;
    const contentSize = hasChanges ? new Blob([currentContent]).size : 0;

    if (!hasChanges) {
      setUiStatus(prev => prev.status === 'unsaved' ? { ...prev, status: 'saved' } : prev);
    }

    dispatch({ type: 'CHECK_COMPLETE', hasChanges, contentSize });
  }, [cells, serializeCells, dispatch]);

  // Execute a single effect
  const executeEffect = useCallback((effect: AutosaveEffect) => {
    switch (effect.type) {
      case 'SCHEDULE_CHECK':
        checkTimeoutRef.current = setTimeout(() => {
          checkForChanges();
        }, effect.delay);
        break;

      case 'SCHEDULE_SAVE':
        saveTimeoutRef.current = setTimeout(() => {
          dispatch({ type: 'TIMEOUT_FIRED' });
        }, effect.delay);
        break;

      case 'SCHEDULE_RETRY':
        retryTimeoutRef.current = setTimeout(() => {
          dispatch({ type: 'RETRY' });
        }, effect.delay);
        break;

      case 'CANCEL_PENDING_OPERATIONS':
        cancelPendingOperations();
        break;

      case 'PERFORM_SAVE':
        performSave();
        break;

      case 'UPDATE_SAVED_CONTENT':
        // Content already updated in performSave
        break;
    }
  }, [checkForChanges, cancelPendingOperations, performSave, dispatch]);

  // Keep executeEffect ref in sync to avoid stale closures
  executeEffectRef.current = executeEffect;

  // React to cells changes
  useEffect(() => {
    if (!fileId || !enabled) return;
    // Block autosave when redo history exists (user has undone)
    if (hasRedoHistory) return;

    // Quick reference check - if cells array reference hasn't changed, skip
    if (cells === cellsRef.current) return;
    cellsRef.current = cells;

    // Mark as unsaved immediately
    setUiStatus(prev => prev.status === 'unsaved' ? prev : { ...prev, status: 'unsaved' });

    // Dispatch cells changed event
    dispatch({ type: 'CELLS_CHANGED' });
  }, [cells, fileId, enabled, hasRedoHistory, dispatch]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cancelPendingOperations();
    };
  }, [cancelPendingOperations]);

  // Save immediately (for manual save)
  const saveNow = useCallback(async () => {
    cancelPendingOperations();

    // Check if there are actual changes to save
    const currentContent = serializeCells(cells);
    if (currentContent === lastSavedContentRef.current) {
      // No changes, but still refresh the timestamp to give visual feedback
      setUiStatus({ status: 'saved', lastSaved: Date.now() });
      return;
    }

    // Mark as manual save to show "Saving..." indicator
    isManualSaveRef.current = true;
    dispatch({ type: 'MANUAL_SAVE' });
  }, [cancelPendingOperations, cells, serializeCells, dispatch]);

  // Initialize last saved content when file changes
  useEffect(() => {
    if (fileId) {
      lastSavedContentRef.current = serializeCells(cells);
      setUiStatus({ status: 'saved', lastSaved: Date.now() });
      setMachineState(getInitialState());
    }
  }, [fileId]); // Only on fileId change, not cells

  // Warn before unload if there are unsaved changes
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges()) {
        e.preventDefault();
        e.returnValue = 'You have unsaved changes. Are you sure you want to leave?';
        return e.returnValue;
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges]);

  // Save on visibility change (tab switch)
  // Block when redo history exists to avoid losing redo on tab switch
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && hasUnsavedChanges() && !hasRedoHistory) {
        dispatch({ type: 'MANUAL_SAVE' });
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [hasUnsavedChanges, hasRedoHistory, dispatch]);

  return {
    status: uiStatus,
    saveNow,
    hasUnsavedChanges,
  };
}

// Format relative time
export function formatLastSaved(timestamp: number | null): string {
  if (!timestamp) return '';

  const seconds = Math.floor((Date.now() - timestamp) / 1000);

  if (seconds < 5) return 'Just now';
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  return new Date(timestamp).toLocaleDateString();
}
