import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown, FileText } from 'lucide-react';
import { Cell } from '../types';

interface HeaderInfo {
  cellId: string;
  cellIndex: number;
  level: number; // 1 for #, 2 for ##, 3 for ###
  text: string;
}

interface Props {
  cells: Cell[];
  visibleRange: { startIndex: number; endIndex: number };
  onNavigate: (cellIndex: number, cellId: string) => void;
}

// Parse markdown cell content for headers
function parseHeaders(cells: Cell[]): HeaderInfo[] {
  const headers: HeaderInfo[] = [];

  cells.forEach((cell, index) => {
    if (cell.type !== 'markdown') return;

    // Match headers at the start of lines
    const lines = cell.content.split('\n');
    for (const line of lines) {
      const match = line.match(/^(#{1,3})\s+(.+)/);
      if (match) {
        headers.push({
          cellId: cell.id,
          cellIndex: index,
          level: match[1].length,
          text: match[2].trim()
        });
        break; // Only take first header from each cell
      }
    }
  });

  return headers;
}

// Find current section based on visible cells
function findCurrentSection(headers: HeaderInfo[], visibleStartIndex: number): HeaderInfo | null {
  if (headers.length === 0) return null;

  // Find the last header that's at or before the visible start
  let current: HeaderInfo | null = null;
  for (const header of headers) {
    if (header.cellIndex <= visibleStartIndex) {
      current = header;
    } else {
      break;
    }
  }

  return current || headers[0];
}

// Build breadcrumb path from current section
function buildBreadcrumbPath(headers: HeaderInfo[], current: HeaderInfo | null): HeaderInfo[] {
  if (!current) return [];

  const path: HeaderInfo[] = [];
  const currentIdx = headers.findIndex(h => h.cellId === current.cellId);

  // Walk backwards to find parent headers
  for (let i = currentIdx; i >= 0; i--) {
    const header = headers[i];
    // Include if it's a higher level (smaller number) than any header in path
    if (path.length === 0 || header.level < path[0].level) {
      path.unshift(header);
    }
  }

  return path;
}

export const NotebookBreadcrumb: React.FC<Props> = ({ cells, visibleRange, onNavigate }) => {
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // Parse headers from cells
  const headers = useMemo(() => parseHeaders(cells), [cells]);

  // Find current section based on scroll
  const currentSection = useMemo(
    () => findCurrentSection(headers, visibleRange.startIndex),
    [headers, visibleRange.startIndex]
  );

  // Build breadcrumb path
  const breadcrumbPath = useMemo(
    () => buildBreadcrumbPath(headers, currentSection),
    [headers, currentSection]
  );

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleNavigate = useCallback((header: HeaderInfo) => {
    onNavigate(header.cellIndex, header.cellId);
    setIsDropdownOpen(false);
  }, [onNavigate]);

  // Don't render if no headers
  if (headers.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center px-4 py-1.5 bg-gray-50 border-b border-gray-200 text-sm">
      <FileText className="w-3.5 h-3.5 text-gray-400 mr-2 flex-shrink-0" />

      {/* Breadcrumb path */}
      <div className="flex items-center gap-1 min-w-0 flex-1">
        {breadcrumbPath.map((header, idx) => (
          <React.Fragment key={header.cellId}>
            {idx > 0 && (
              <ChevronRight className="w-3 h-3 text-gray-300 flex-shrink-0" />
            )}
            <button
              onClick={() => handleNavigate(header)}
              className={`truncate hover:text-blue-600 hover:underline transition-colors ${
                idx === breadcrumbPath.length - 1
                  ? 'text-gray-700 font-medium'
                  : 'text-gray-500'
              }`}
              title={header.text}
            >
              {header.text}
            </button>
          </React.Fragment>
        ))}
      </div>

      {/* Dropdown toggle */}
      <div className="relative ml-2">
        <button
          ref={buttonRef}
          onClick={() => setIsDropdownOpen(!isDropdownOpen)}
          className="flex items-center gap-1 px-2 py-0.5 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded transition-colors"
          title="Jump to section"
        >
          <span className="text-xs">{headers.length} sections</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
        </button>

        {/* Dropdown menu */}
        {isDropdownOpen && (
          <div
            ref={dropdownRef}
            className="absolute right-0 top-full mt-1 w-64 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50"
          >
            {headers.map((header) => (
              <button
                key={`${header.cellId}-${header.text}`}
                onClick={() => handleNavigate(header)}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-gray-50 transition-colors flex items-center gap-2 ${
                  currentSection?.cellId === header.cellId ? 'bg-blue-50 text-blue-700' : 'text-gray-700'
                }`}
                style={{ paddingLeft: `${(header.level - 1) * 12 + 12}px` }}
              >
                <span className="text-gray-400 text-xs w-4">{'#'.repeat(header.level)}</span>
                <span className="truncate">{header.text}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
