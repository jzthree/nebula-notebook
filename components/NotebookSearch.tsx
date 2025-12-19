import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, ChevronUp, ChevronDown, Replace, ReplaceAll } from 'lucide-react';
import { Cell } from '../types';

interface SearchMatch {
  cellIndex: number;
  cellId: string;
  startIndex: number;
  endIndex: number;
}

export interface CurrentMatch {
  cellId: string;
  startIndex: number;
  endIndex: number;
}

interface Props {
  cells: Cell[];
  isOpen: boolean;
  onClose: () => void;
  onNavigateToCell: (cellIndex: number, cellId: string) => void;
  onSearchChange?: (query: string, caseSensitive: boolean, useRegex: boolean, currentMatch: CurrentMatch | null) => void;
  onReplace?: (cellId: string, startIndex: number, endIndex: number, replacement: string) => void;
  onReplaceAllInCell?: (cellId: string, query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => void;
  onReplaceAllInNotebook?: (query: string, replacement: string, caseSensitive: boolean, useRegex: boolean) => void;
  activeCellId?: string | null; // Start search from this cell
}

export const NotebookSearch: React.FC<Props> = ({
  cells,
  isOpen,
  onClose,
  onNavigateToCell,
  onSearchChange,
  onReplace,
  onReplaceAllInCell,
  onReplaceAllInNotebook,
  activeCellId,
}) => {
  const [query, setQuery] = useState('');
  const [replaceText, setReplaceText] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [regexError, setRegexError] = useState<string | null>(null);
  const [showReplace, setShowReplace] = useState(false);
  const [showReplaceAllMenu, setShowReplaceAllMenu] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const replaceAllMenuRef = useRef<HTMLDivElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && searchInputRef.current) {
      searchInputRef.current.focus();
      searchInputRef.current.select();
    }
  }, [isOpen]);

  // Close replace all menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (replaceAllMenuRef.current && !replaceAllMenuRef.current.contains(e.target as Node)) {
        setShowReplaceAllMenu(false);
      }
    };
    if (showReplaceAllMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showReplaceAllMenu]);

  // Notify parent of search query changes for highlighting
  useEffect(() => {
    // Only notify when search is open
    if (!isOpen) return;

    const currentMatch = matches.length > 0 ? {
      cellId: matches[currentMatchIndex]?.cellId,
      startIndex: matches[currentMatchIndex]?.startIndex,
      endIndex: matches[currentMatchIndex]?.endIndex,
    } : null;
    onSearchChange?.(query, caseSensitive, useRegex, currentMatch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, query, caseSensitive, useRegex, currentMatchIndex, matches]); // Intentionally exclude onSearchChange to prevent infinite loops

  // Track previous query to detect query changes vs cell content changes
  const prevQueryRef = useRef(query);
  const prevCaseSensitiveRef = useRef(caseSensitive);
  const prevUseRegexRef = useRef(useRegex);

  // Search through cells
  useEffect(() => {
    // Don't search when closed
    if (!isOpen) return;

    if (!query.trim()) {
      setMatches([]);
      setCurrentMatchIndex(0);
      setRegexError(null);
      prevQueryRef.current = query;
      return;
    }

    const newMatches: SearchMatch[] = [];

    // Build regex or use string search
    let regex: RegExp | null = null;
    if (useRegex) {
      try {
        regex = new RegExp(query, caseSensitive ? 'g' : 'gi');
        setRegexError(null);
      } catch (e) {
        setRegexError((e as Error).message);
        setMatches([]);
        return;
      }
    }

    cells.forEach((cell, cellIndex) => {
      if (useRegex && regex) {
        // Regex search
        regex.lastIndex = 0; // Reset regex state
        let match;
        while ((match = regex.exec(cell.content)) !== null) {
          newMatches.push({
            cellIndex,
            cellId: cell.id,
            startIndex: match.index,
            endIndex: match.index + match[0].length,
          });
          // Prevent infinite loop on zero-length matches
          if (match[0].length === 0) regex.lastIndex++;
        }
      } else {
        // String search
        const searchQuery = caseSensitive ? query : query.toLowerCase();
        const content = caseSensitive ? cell.content : cell.content.toLowerCase();
        let startIndex = 0;

        while (true) {
          const foundIndex = content.indexOf(searchQuery, startIndex);
          if (foundIndex === -1) break;

          newMatches.push({
            cellIndex,
            cellId: cell.id,
            startIndex: foundIndex,
            endIndex: foundIndex + query.length,
          });

          startIndex = foundIndex + 1;
        }
      }
    });

    setMatches(newMatches);

    // Only navigate to first match when query changes, not when cell content changes
    const queryChanged = query !== prevQueryRef.current ||
                         caseSensitive !== prevCaseSensitiveRef.current ||
                         useRegex !== prevUseRegexRef.current;
    if (queryChanged && newMatches.length > 0) {
      // Find first match at or after the active cell
      const activeCellIndex = activeCellId
        ? cells.findIndex(c => c.id === activeCellId)
        : 0;

      // Find the first match in active cell or later
      let startIndex = newMatches.findIndex(m => m.cellIndex >= activeCellIndex);

      // If no match found at or after active cell, wrap to beginning
      if (startIndex === -1) {
        startIndex = 0;
      }

      setCurrentMatchIndex(startIndex);
      onNavigateToCell(newMatches[startIndex].cellIndex, newMatches[startIndex].cellId);
      // Re-focus search input after navigation to prevent cell from stealing focus
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    } else if (queryChanged) {
      setCurrentMatchIndex(0);
    }

    prevQueryRef.current = query;
    prevCaseSensitiveRef.current = caseSensitive;
    prevUseRegexRef.current = useRegex;
  }, [isOpen, query, cells, caseSensitive, useRegex, onNavigateToCell, activeCellId]);

  const goToMatch = useCallback((index: number) => {
    if (matches.length === 0) return;

    const wrappedIndex = ((index % matches.length) + matches.length) % matches.length;
    setCurrentMatchIndex(wrappedIndex);

    const match = matches[wrappedIndex];
    onNavigateToCell(match.cellIndex, match.cellId);

    // Re-focus search input after navigation
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [matches, onNavigateToCell]);

  const goToNextMatch = useCallback(() => {
    goToMatch(currentMatchIndex + 1);
  }, [currentMatchIndex, goToMatch]);

  const goToPrevMatch = useCallback(() => {
    goToMatch(currentMatchIndex - 1);
  }, [currentMatchIndex, goToMatch]);

  // Replace current match
  const handleReplace = useCallback(() => {
    if (matches.length === 0 || !onReplace) return;

    const match = matches[currentMatchIndex];
    onReplace(match.cellId, match.startIndex, match.endIndex, replaceText);

    // Re-focus search input after replace
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [matches, currentMatchIndex, replaceText, onReplace]);

  // Replace all in current cell
  const handleReplaceAllInCell = useCallback(() => {
    if (matches.length === 0 || !onReplaceAllInCell) return;

    const currentCellId = matches[currentMatchIndex]?.cellId;
    if (currentCellId) {
      onReplaceAllInCell(currentCellId, query, replaceText, caseSensitive, useRegex);
    }
    setShowReplaceAllMenu(false);

    // Re-focus search input
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [matches, currentMatchIndex, query, replaceText, caseSensitive, useRegex, onReplaceAllInCell]);

  // Replace all in notebook
  const handleReplaceAllInNotebook = useCallback(() => {
    if (!query || !onReplaceAllInNotebook) return;

    onReplaceAllInNotebook(query, replaceText, caseSensitive, useRegex);
    setShowReplaceAllMenu(false);

    // Re-focus search input
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
  }, [query, replaceText, caseSensitive, useRegex, onReplaceAllInNotebook]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      // Ctrl/Cmd+Enter to replace
      e.preventDefault();
      handleReplace();
    }
  };

  // Get count of matches in current cell
  const currentCellMatchCount = matches.filter(m => m.cellId === matches[currentMatchIndex]?.cellId).length;

  if (!isOpen) return null;

  return (
    <div className="fixed top-16 right-4 z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-2 flex flex-col gap-2">
      {/* Search row */}
      <div className="flex items-center gap-2">
        <Search className="w-4 h-4 text-slate-400 flex-shrink-0" />
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search in notebook..."
          className="w-48 px-2 py-1 text-sm border-none outline-none bg-transparent"
          autoFocus
        />

        {query && (
          <span className={`text-xs min-w-[60px] ${regexError ? 'text-red-500' : 'text-slate-500'}`}>
            {regexError
              ? 'Invalid regex'
              : matches.length > 0
                ? `${currentMatchIndex + 1} of ${matches.length}`
                : 'No matches'}
          </span>
        )}

        <div className="flex items-center border-l border-slate-200 pl-2 gap-1">
          <button
            onClick={goToPrevMatch}
            disabled={matches.length === 0}
            className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
            title="Previous (Shift+Enter)"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            onClick={goToNextMatch}
            disabled={matches.length === 0}
            className="p-1 hover:bg-slate-100 rounded disabled:opacity-30"
            title="Next (Enter)"
          >
            <ChevronDown className="w-4 h-4" />
          </button>
        </div>

        <button
          onClick={() => setCaseSensitive(!caseSensitive)}
          className={`px-1.5 py-0.5 text-xs font-mono rounded ${
            caseSensitive ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-100'
          }`}
          title="Case sensitive"
        >
          Aa
        </button>

        <button
          onClick={() => setUseRegex(!useRegex)}
          className={`px-1.5 py-0.5 text-xs font-mono rounded ${
            useRegex ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-100'
          }`}
          title="Use regular expression"
        >
          .*
        </button>

        <button
          onClick={() => setShowReplace(!showReplace)}
          className={`p-1 rounded ${showReplace ? 'bg-blue-100 text-blue-700' : 'text-slate-400 hover:bg-slate-100'}`}
          title="Toggle replace"
        >
          <Replace className="w-4 h-4" />
        </button>

        <button
          onClick={onClose}
          className="p-1 hover:bg-slate-100 rounded"
          title="Close (Esc)"
        >
          <X className="w-4 h-4 text-slate-400" />
        </button>
      </div>

      {/* Replace row */}
      {showReplace && (
        <div className="flex items-center gap-2 pl-6">
          <input
            ref={replaceInputRef}
            type="text"
            value={replaceText}
            onChange={(e) => setReplaceText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Replace with..."
            className="w-48 px-2 py-1 text-sm border border-slate-200 rounded outline-none focus:border-blue-400"
          />

          <button
            onClick={handleReplace}
            disabled={matches.length === 0}
            className="px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-30"
            title="Replace (Ctrl+Enter)"
          >
            Replace
          </button>

          <div className="relative" ref={replaceAllMenuRef}>
            <button
              onClick={() => setShowReplaceAllMenu(!showReplaceAllMenu)}
              disabled={matches.length === 0}
              className="px-2 py-1 text-xs bg-slate-100 hover:bg-slate-200 rounded disabled:opacity-30 flex items-center gap-1"
              title="Replace all options"
            >
              <ReplaceAll className="w-3 h-3" />
              Replace All
              <ChevronDown className="w-3 h-3" />
            </button>

            {showReplaceAllMenu && (
              <div className="absolute top-full left-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[160px] z-10">
                <button
                  onClick={handleReplaceAllInCell}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-slate-100 flex items-center justify-between"
                >
                  <span>In this cell</span>
                  <span className="text-slate-400">({currentCellMatchCount})</span>
                </button>
                <button
                  onClick={handleReplaceAllInNotebook}
                  className="w-full px-3 py-1.5 text-xs text-left hover:bg-slate-100 flex items-center justify-between"
                >
                  <span>In all cells</span>
                  <span className="text-slate-400">({matches.length})</span>
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

// Hook to get the current search query for highlighting in cells
export function useSearchHighlight() {
  const [searchState, setSearchState] = useState<{
    query: string;
    caseSensitive: boolean;
  } | null>(null);

  return { searchState, setSearchState };
}
