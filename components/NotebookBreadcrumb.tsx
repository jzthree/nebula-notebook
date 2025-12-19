import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Cell } from '../types';

interface HeaderInfo {
  cellId: string;
  cellIndex: number;
  level: number; // 1 for #, 2 for ##, 3 for ###
  text: string;
  key: string; // Unique key for React
}

interface Props {
  cells: Cell[];
  visibleRange: { startIndex: number; endIndex: number };
  onNavigate: (cellIndex: number, cellId: string) => void;
}

// Parse markdown cell content for headers (allows multiple per cell)
function parseHeaders(cells: Cell[]): HeaderInfo[] {
  const headers: HeaderInfo[] = [];

  cells.forEach((cell, index) => {
    if (cell.type !== 'markdown') return;

    const lines = cell.content.split('\n');
    let headerCount = 0;
    for (const line of lines) {
      const match = line.match(/^(#{1,3})\s+(.+)/);
      if (match) {
        headers.push({
          cellId: cell.id,
          cellIndex: index,
          level: match[1].length,
          text: match[2].trim(),
          key: `${cell.id}-${headerCount++}`
        });
      }
    }
  });

  return headers;
}

// Find current section based on visible cells
function findCurrentSection(headers: HeaderInfo[], visibleStartIndex: number): HeaderInfo | null {
  if (headers.length === 0) return null;

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

// Build breadcrumb path from current section (includes parent headers)
function buildBreadcrumbPath(headers: HeaderInfo[], current: HeaderInfo | null): HeaderInfo[] {
  if (!current) return [];

  const path: HeaderInfo[] = [];
  const currentIdx = headers.findIndex(h => h.key === current.key);

  // Walk backwards to find parent headers (lower level numbers = higher in hierarchy)
  for (let i = currentIdx; i >= 0; i--) {
    const header = headers[i];
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

  const headers = useMemo(() => parseHeaders(cells), [cells]);

  const currentSection = useMemo(
    () => findCurrentSection(headers, visibleRange.startIndex),
    [headers, visibleRange.startIndex]
  );

  const breadcrumbPath = useMemo(
    () => buildBreadcrumbPath(headers, currentSection),
    [headers, currentSection]
  );

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

  if (headers.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4">
        <div className="flex items-center py-1 text-xs text-gray-500">
          {/* Breadcrumb path */}
          <div className="flex items-center gap-1 min-w-0 flex-1">
            {breadcrumbPath.map((header, idx) => (
              <React.Fragment key={header.key}>
                {idx > 0 && (
                  <ChevronRight className="w-3 h-3 text-gray-300 flex-shrink-0" />
                )}
                <button
                  onClick={() => handleNavigate(header)}
                  className={`truncate hover:text-gray-900 transition-colors ${
                    idx === breadcrumbPath.length - 1
                      ? 'text-gray-600'
                      : 'text-gray-400'
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
              className="flex items-center gap-0.5 text-gray-400 hover:text-gray-600 transition-colors"
              title="Jump to section"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`} />
            </button>

            {isDropdownOpen && (
              <div
                ref={dropdownRef}
                className="absolute right-0 top-full mt-1 w-72 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50"
              >
                {headers.map((header) => (
                  <button
                    key={header.key}
                    onClick={() => handleNavigate(header)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 transition-colors ${
                      currentSection?.key === header.key ? 'bg-blue-50 text-blue-700' : 'text-gray-600'
                    }`}
                    style={{ paddingLeft: `${(header.level - 1) * 16 + 12}px` }}
                  >
                    <span className="truncate">{header.text}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
