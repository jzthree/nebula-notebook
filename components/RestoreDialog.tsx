/**
 * RestoreDialog - Confirmation dialog for restoring notebook to a previous state
 *
 * Offers two restore strategies:
 * 1. "Restore Here" - Generates new operations (reversible, history grows)
 * 2. "Save as New File" - Creates new file with truncated history (branch point)
 */

import React, { useState, useMemo } from 'react';
import { X, RotateCcw, GitBranch, AlertTriangle, Clock, FileText } from 'lucide-react';
import { Cell } from '../types';

interface RestoreDialogProps {
  isOpen: boolean;
  onClose: () => void;
  targetTimestamp: number;
  // Current state vs preview state for showing diff summary
  currentCells: Cell[];
  previewCells: Cell[];
  // Callbacks
  onRestoreHere: () => void;
  onSaveAsNew: () => void;
  // Optional: suggested filename for new file
  suggestedFilename?: string;
}

// Format timestamp for display
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  return date.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)} minutes ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} hours ago`;
  return `${Math.floor(diff / 86400000)} days ago`;
}

interface DiffSummary {
  added: number;      // Cells in preview but not in current
  removed: number;    // Cells in current but not in preview
  modified: number;   // Cells in both but with different content
  unchanged: number;  // Cells in both with same content
}

function computeDiffSummary(currentCells: Cell[], previewCells: Cell[]): DiffSummary {
  const currentMap = new Map(currentCells.map(c => [c.id, c]));
  const previewMap = new Map(previewCells.map(c => [c.id, c]));

  let added = 0;
  let removed = 0;
  let modified = 0;
  let unchanged = 0;

  // Check preview cells against current
  for (const [id, previewCell] of previewMap) {
    const currentCell = currentMap.get(id);
    if (!currentCell) {
      // Cell exists in preview but not current = will be "added" when restoring
      added++;
    } else if (currentCell.content !== previewCell.content || currentCell.type !== previewCell.type) {
      modified++;
    } else {
      unchanged++;
    }
  }

  // Check for cells in current but not in preview = will be "removed" when restoring
  for (const id of currentMap.keys()) {
    if (!previewMap.has(id)) {
      removed++;
    }
  }

  return { added, removed, modified, unchanged };
}

export const RestoreDialog: React.FC<RestoreDialogProps> = ({
  isOpen,
  onClose,
  targetTimestamp,
  currentCells,
  previewCells,
  onRestoreHere,
  onSaveAsNew,
  suggestedFilename,
}) => {
  const [isRestoring, setIsRestoring] = useState(false);

  const diffSummary = useMemo(
    () => computeDiffSummary(currentCells, previewCells),
    [currentCells, previewCells]
  );

  const handleRestoreHere = async () => {
    setIsRestoring(true);
    try {
      await onRestoreHere();
      onClose();
    } finally {
      setIsRestoring(false);
    }
  };

  const handleSaveAsNew = async () => {
    setIsRestoring(true);
    try {
      await onSaveAsNew();
      onClose();
    } finally {
      setIsRestoring(false);
    }
  };

  if (!isOpen) return null;

  const hasChanges = diffSummary.added > 0 || diffSummary.removed > 0 || diffSummary.modified > 0;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
      />

      {/* Dialog */}
      <div className="relative bg-white rounded-lg shadow-xl max-w-lg w-full mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-2">
            <RotateCcw className="w-5 h-5 text-blue-600" />
            <h2 className="text-lg font-semibold text-slate-800">Restore Notebook</h2>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-4">
          {/* Target timestamp */}
          <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg">
            <Clock className="w-5 h-5 text-blue-600 flex-shrink-0" />
            <div>
              <div className="text-sm font-medium text-blue-900">
                Restore to: {formatTime(targetTimestamp)}
              </div>
              <div className="text-xs text-blue-600">
                {formatRelativeTime(targetTimestamp)}
              </div>
            </div>
          </div>

          {/* Diff summary */}
          {hasChanges ? (
            <div className="p-3 bg-amber-50 rounded-lg border border-amber-200">
              <div className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="text-sm font-medium text-amber-800">
                    This will change your notebook:
                  </div>
                  <ul className="mt-1 text-xs text-amber-700 space-y-0.5">
                    {diffSummary.modified > 0 && (
                      <li>• {diffSummary.modified} cell{diffSummary.modified !== 1 ? 's' : ''} will be modified</li>
                    )}
                    {diffSummary.added > 0 && (
                      <li>• {diffSummary.added} cell{diffSummary.added !== 1 ? 's' : ''} will be restored</li>
                    )}
                    {diffSummary.removed > 0 && (
                      <li>• {diffSummary.removed} cell{diffSummary.removed !== 1 ? 's' : ''} will be removed</li>
                    )}
                  </ul>
                  <div className="mt-2 text-xs text-amber-600">
                    Note: Cell outputs are not restored (only code/markdown content)
                  </div>
                </div>
              </div>
            </div>
          ) : (
            <div className="p-3 bg-green-50 rounded-lg border border-green-200">
              <div className="text-sm text-green-700">
                No changes needed - notebook is already at this state.
              </div>
            </div>
          )}

          {/* Options */}
          <div className="space-y-3">
            {/* Option 1: Restore Here */}
            <button
              onClick={handleRestoreHere}
              disabled={isRestoring || !hasChanges}
              className="w-full p-4 text-left border-2 border-slate-200 rounded-lg hover:border-blue-400 hover:bg-blue-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 bg-blue-100 rounded-lg group-hover:bg-blue-200 transition-colors">
                  <RotateCcw className="w-5 h-5 text-blue-600" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-slate-800">Restore Here</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Transform current notebook to the target state. This is undoable - you can undo the restore itself.
                  </div>
                  <div className="text-[0.625rem] text-slate-400 mt-2">
                    Strategy: Generates reverse operations (history grows)
                  </div>
                </div>
              </div>
            </button>

            {/* Option 2: Save as New File */}
            <button
              onClick={handleSaveAsNew}
              disabled={isRestoring}
              className="w-full p-4 text-left border-2 border-slate-200 rounded-lg hover:border-green-400 hover:bg-green-50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed group"
            >
              <div className="flex items-start gap-3">
                <div className="p-2 bg-green-100 rounded-lg group-hover:bg-green-200 transition-colors">
                  <GitBranch className="w-5 h-5 text-green-600" />
                </div>
                <div className="flex-1">
                  <div className="font-medium text-slate-800">Save as New File</div>
                  <div className="text-xs text-slate-500 mt-1">
                    Create a new notebook file from this point. Original file stays untouched.
                  </div>
                  {suggestedFilename && (
                    <div className="flex items-center gap-1 text-[0.625rem] text-slate-400 mt-2">
                      <FileText className="w-3 h-3" />
                      {suggestedFilename}
                    </div>
                  )}
                  <div className="text-[0.625rem] text-slate-400 mt-1">
                    Strategy: History truncated at restore point (branch)
                  </div>
                </div>
              </div>
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="px-4 py-3 border-t border-slate-200 bg-slate-50 flex justify-end">
          <button
            onClick={onClose}
            disabled={isRestoring}
            className="px-4 py-2 text-sm text-slate-600 hover:text-slate-800 hover:bg-slate-200 rounded transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
