import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Search, X, ChevronUp, ChevronDown } from 'lucide-react';
import { Cell } from '../types';

interface SearchMatch {
  cellIndex: number;
  cellId: string;
  startIndex: number;
  endIndex: number;
}

interface Props {
  cells: Cell[];
  isOpen: boolean;
  onClose: () => void;
  onNavigateToCell: (cellIndex: number, cellId: string) => void;
  onSearchChange?: (query: string, caseSensitive: boolean) => void;
}

export const NotebookSearch: React.FC<Props> = ({
  cells,
  isOpen,
  onClose,
  onNavigateToCell,
  onSearchChange,
}) => {
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [currentMatchIndex, setCurrentMatchIndex] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus input when opened
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isOpen]);

  // Notify parent of search query changes for highlighting
  useEffect(() => {
    onSearchChange?.(query, caseSensitive);
  }, [query, caseSensitive, onSearchChange]);

  // Search through cells
  useEffect(() => {
    if (!query.trim()) {
      setMatches([]);
      setCurrentMatchIndex(0);
      return;
    }

    const searchQuery = caseSensitive ? query : query.toLowerCase();
    const newMatches: SearchMatch[] = [];

    cells.forEach((cell, cellIndex) => {
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
    });

    setMatches(newMatches);
    setCurrentMatchIndex(0);

    // Navigate to first match
    if (newMatches.length > 0) {
      onNavigateToCell(newMatches[0].cellIndex, newMatches[0].cellId);
    }
  }, [query, cells, caseSensitive, onNavigateToCell]);

  const goToMatch = useCallback((index: number) => {
    if (matches.length === 0) return;

    const wrappedIndex = ((index % matches.length) + matches.length) % matches.length;
    setCurrentMatchIndex(wrappedIndex);

    const match = matches[wrappedIndex];
    onNavigateToCell(match.cellIndex, match.cellId);
  }, [matches, onNavigateToCell]);

  const goToNextMatch = useCallback(() => {
    goToMatch(currentMatchIndex + 1);
  }, [currentMatchIndex, goToMatch]);

  const goToPrevMatch = useCallback(() => {
    goToMatch(currentMatchIndex - 1);
  }, [currentMatchIndex, goToMatch]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      onClose();
    } else if (e.key === 'Enter') {
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed top-16 right-4 z-50 bg-white rounded-lg shadow-xl border border-slate-200 p-2 flex items-center gap-2">
      <Search className="w-4 h-4 text-slate-400" />
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search in notebook..."
        className="w-48 px-2 py-1 text-sm border-none outline-none bg-transparent"
        autoFocus
      />

      {query && (
        <span className="text-xs text-slate-500 min-w-[60px]">
          {matches.length > 0
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
        onClick={onClose}
        className="p-1 hover:bg-slate-100 rounded"
        title="Close (Esc)"
      >
        <X className="w-4 h-4 text-slate-400" />
      </button>
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
