import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { ChevronRight, ChevronDown } from 'lucide-react';
import { Cell } from '../types';

interface HeaderInfo {
  cellId: string;
  cellIndex: number;
  level: number; // 1 for #, 2 for ##, 3 for ###
  text: string;
  key: string;
}

interface Props {
  cells: Cell[];
  activeCellId: string | null;
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

// Find current section based on active cell
function findCurrentSection(headers: HeaderInfo[], activeCellIndex: number): HeaderInfo | null {
  if (headers.length === 0) return null;

  let current: HeaderInfo | null = null;
  for (const header of headers) {
    if (header.cellIndex <= activeCellIndex) {
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

  for (let i = currentIdx; i >= 0; i--) {
    const header = headers[i];
    if (path.length === 0 || header.level < path[0].level) {
      path.unshift(header);
    }
  }

  return path;
}

// Get siblings for a header (same level, within same parent scope)
function getSiblings(headers: HeaderInfo[], header: HeaderInfo, breadcrumbPath: HeaderInfo[]): HeaderInfo[] {
  const headerIdx = headers.findIndex(h => h.key === header.key);
  const level = header.level;

  // Find the parent header (if any) - it's the previous item in breadcrumb path
  const pathIdx = breadcrumbPath.findIndex(h => h.key === header.key);
  const parent = pathIdx > 0 ? breadcrumbPath[pathIdx - 1] : null;

  // Find the range of headers under this parent
  let startIdx = 0;
  let endIdx = headers.length;

  if (parent) {
    const parentIdx = headers.findIndex(h => h.key === parent.key);
    startIdx = parentIdx + 1;

    // Find where parent's scope ends (next header at parent's level or higher)
    for (let i = parentIdx + 1; i < headers.length; i++) {
      if (headers[i].level <= parent.level) {
        endIdx = i;
        break;
      }
    }
  }

  // Get all headers at the same level within the parent's scope
  return headers.slice(startIdx, endIdx).filter(h => h.level === level);
}

interface BreadcrumbSegmentProps {
  header: HeaderInfo;
  siblings: HeaderInfo[];
  currentKey: string;
  onNavigate: (header: HeaderInfo) => void;
}

const BreadcrumbSegment: React.FC<BreadcrumbSegmentProps> = ({
  header,
  siblings,
  currentKey,
  onNavigate
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  const handleSelect = (h: HeaderInfo) => {
    onNavigate(h);
    setIsOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className="truncate text-gray-600 hover:text-gray-900 transition-colors"
        title={header.text}
      >
        {header.text}
      </button>

      {isOpen && siblings.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute left-0 top-full mt-1 min-w-48 max-w-72 max-h-64 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50"
        >
          {siblings.map((h) => (
            <button
              key={h.key}
              onClick={() => handleSelect(h)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 transition-colors truncate ${
                h.key === currentKey ? 'bg-blue-50 text-blue-700' : 'text-gray-600'
              }`}
            >
              {h.text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const NotebookBreadcrumb: React.FC<Props> = ({ cells, activeCellId, onNavigate }) => {
  const [isAllOpen, setIsAllOpen] = useState(false);
  const allDropdownRef = useRef<HTMLDivElement>(null);
  const allButtonRef = useRef<HTMLButtonElement>(null);

  const headers = useMemo(() => parseHeaders(cells), [cells]);

  const activeCellIndex = useMemo(() => {
    if (!activeCellId) return 0;
    const idx = cells.findIndex(c => c.id === activeCellId);
    return idx >= 0 ? idx : 0;
  }, [cells, activeCellId]);

  const currentSection = useMemo(
    () => findCurrentSection(headers, activeCellIndex),
    [headers, activeCellIndex]
  );

  const breadcrumbPath = useMemo(
    () => buildBreadcrumbPath(headers, currentSection),
    [headers, currentSection]
  );

  // Close "all sections" dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        allDropdownRef.current &&
        !allDropdownRef.current.contains(e.target as Node) &&
        allButtonRef.current &&
        !allButtonRef.current.contains(e.target as Node)
      ) {
        setIsAllOpen(false);
      }
    };

    if (isAllOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isAllOpen]);

  const handleNavigate = useCallback((header: HeaderInfo) => {
    onNavigate(header.cellIndex, header.cellId);
    setIsAllOpen(false);
  }, [onNavigate]);

  if (headers.length === 0) {
    return null;
  }

  return (
    <div className="border-b border-gray-100">
      <div className="max-w-5xl mx-auto px-4">
        <div className="flex items-center py-1 text-xs text-gray-500">
          <div className="flex items-center gap-1 min-w-0 flex-1">
            {breadcrumbPath.map((header, idx) => (
              <React.Fragment key={header.key}>
                {idx > 0 && (
                  <ChevronRight className="w-3 h-3 text-gray-300 flex-shrink-0" />
                )}
                <BreadcrumbSegment
                  header={header}
                  siblings={getSiblings(headers, header, breadcrumbPath)}
                  currentKey={header.key}
                  onNavigate={handleNavigate}
                />
              </React.Fragment>
            ))}
          </div>

          {/* All sections dropdown */}
          <div className="relative ml-2">
            <button
              ref={allButtonRef}
              onClick={() => setIsAllOpen(!isAllOpen)}
              className="flex items-center gap-0.5 text-gray-400 hover:text-gray-600 transition-colors"
              title="All sections"
            >
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isAllOpen ? 'rotate-180' : ''}`} />
            </button>

            {isAllOpen && (
              <div
                ref={allDropdownRef}
                className="absolute right-0 top-full mt-1 w-72 max-h-80 overflow-auto bg-white border border-gray-200 rounded-lg shadow-lg z-50"
              >
                {headers.map((header) => (
                  <button
                    key={header.key}
                    onClick={() => handleNavigate(header)}
                    className={`w-full text-left px-3 py-1.5 text-sm hover:bg-gray-50 transition-colors truncate ${
                      currentSection?.key === header.key ? 'bg-blue-50 text-blue-700' : 'text-gray-600'
                    }`}
                    style={{ paddingLeft: `${(header.level - 1) * 16 + 12}px` }}
                  >
                    {header.text}
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
