import { useEffect, useRef, useCallback, useState } from 'react';
import { Cell } from '../types';

const AUTOSAVE_DELAY = 1000; // 1 second debounce
const BACKUP_KEY_PREFIX = 'nebula-backup-';
const BACKUP_TIMESTAMP_KEY = 'nebula-backup-timestamp-';

export interface AutosaveStatus {
  status: 'saved' | 'saving' | 'unsaved' | 'error';
  lastSaved: number | null;
}

export interface UseAutosaveOptions {
  fileId: string | null;
  cells: Cell[];
  onSave: (fileId: string, cells: Cell[]) => Promise<void>;
  enabled?: boolean;
}

export function useAutosave({ fileId, cells, onSave, enabled = true }: UseAutosaveOptions) {
  const [status, setStatus] = useState<AutosaveStatus>({
    status: 'saved',
    lastSaved: null,
  });

  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastSavedContentRef = useRef<string>('');
  const isSavingRef = useRef(false);

  // Serialize cells for comparison
  const serializeCells = useCallback((cells: Cell[]) => {
    return JSON.stringify(cells.map(c => ({
      id: c.id,
      type: c.type,
      content: c.content,
      // Don't include outputs/execution state in comparison
    })));
  }, []);

  // Save to localStorage as backup
  const saveBackup = useCallback((fileId: string, cells: Cell[]) => {
    try {
      const backupKey = BACKUP_KEY_PREFIX + fileId;
      const timestampKey = BACKUP_TIMESTAMP_KEY + fileId;
      localStorage.setItem(backupKey, JSON.stringify(cells));
      localStorage.setItem(timestampKey, Date.now().toString());
    } catch (e) {
      console.warn('Failed to save backup to localStorage:', e);
    }
  }, []);

  // Get backup from localStorage
  const getBackup = useCallback((fileId: string): { cells: Cell[]; timestamp: number } | null => {
    try {
      const backupKey = BACKUP_KEY_PREFIX + fileId;
      const timestampKey = BACKUP_TIMESTAMP_KEY + fileId;
      const backup = localStorage.getItem(backupKey);
      const timestamp = localStorage.getItem(timestampKey);

      if (backup && timestamp) {
        return {
          cells: JSON.parse(backup),
          timestamp: parseInt(timestamp, 10),
        };
      }
    } catch (e) {
      console.warn('Failed to read backup from localStorage:', e);
    }
    return null;
  }, []);

  // Clear backup after successful save
  const clearBackup = useCallback((fileId: string) => {
    try {
      localStorage.removeItem(BACKUP_KEY_PREFIX + fileId);
      localStorage.removeItem(BACKUP_TIMESTAMP_KEY + fileId);
    } catch (e) {
      // Ignore
    }
  }, []);

  // Check if there are unsaved changes
  const hasUnsavedChanges = useCallback(() => {
    const currentContent = serializeCells(cells);
    return currentContent !== lastSavedContentRef.current;
  }, [cells, serializeCells]);

  // Perform the actual save
  const performSave = useCallback(async () => {
    if (!fileId || !enabled || isSavingRef.current) return;

    const currentContent = serializeCells(cells);
    if (currentContent === lastSavedContentRef.current) {
      return; // No changes
    }

    isSavingRef.current = true;
    setStatus({ status: 'saving', lastSaved: status.lastSaved });

    try {
      // Save backup first (in case main save fails)
      saveBackup(fileId, cells);

      // Perform main save
      await onSave(fileId, cells);

      // Update tracking
      lastSavedContentRef.current = currentContent;
      const now = Date.now();
      setStatus({ status: 'saved', lastSaved: now });

      // Clear backup after successful save
      clearBackup(fileId);
    } catch (error) {
      console.error('Autosave failed:', error);
      setStatus({ status: 'error', lastSaved: status.lastSaved });
    } finally {
      isSavingRef.current = false;
    }
  }, [fileId, cells, enabled, onSave, serializeCells, saveBackup, clearBackup, status.lastSaved]);

  // Debounced save effect
  useEffect(() => {
    if (!fileId || !enabled) return;

    const currentContent = serializeCells(cells);
    if (currentContent === lastSavedContentRef.current) {
      return; // No changes
    }

    // Mark as unsaved
    setStatus(prev => ({ ...prev, status: 'unsaved' }));

    // Clear existing timeout
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Set new timeout for debounced save
    saveTimeoutRef.current = setTimeout(() => {
      performSave();
    }, AUTOSAVE_DELAY);

    return () => {
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, [cells, fileId, enabled, serializeCells, performSave]);

  // Save immediately (for manual save)
  const saveNow = useCallback(async () => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    await performSave();
  }, [performSave]);

  // Initialize last saved content when file changes
  useEffect(() => {
    if (fileId) {
      lastSavedContentRef.current = serializeCells(cells);
      setStatus({ status: 'saved', lastSaved: Date.now() });
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
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && hasUnsavedChanges()) {
        performSave();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [hasUnsavedChanges, performSave]);

  return {
    status,
    saveNow,
    hasUnsavedChanges,
    getBackup,
    clearBackup,
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
