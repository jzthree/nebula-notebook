/**
 * FileListItem - Shared file/folder row component with hover actions
 *
 * Used by both FileBrowser and Dashboard for consistent UX.
 */

import React from 'react';
import {
  Folder,
  Book,
  FileCode,
  FileText,
  File,
  Copy,
  Trash2,
  Download,
  ExternalLink,
} from 'lucide-react';
import { FileItem } from '../services/fileService';

interface FileListItemProps {
  item: FileItem;
  isCurrentFile?: boolean;
  onNavigate?: (path: string) => void;
  onSelect?: (path: string) => void;
  onOpenNewTab?: (path: string) => void;
  onDuplicate?: (item: FileItem) => void;
  onDownload?: (item: FileItem) => void;
  onDelete?: (item: FileItem) => void;
  compact?: boolean;
}

// Format relative time
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;

  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(timestamp * 1000).toLocaleDateString();
}

// Get file icon
function getFileIcon(item: FileItem) {
  if (item.isDirectory) return <Folder className="w-4 h-4 text-blue-500" />;
  if (item.extension === '.ipynb') return <Book className="w-4 h-4 text-orange-500" />;
  if (item.extension === '.py') return <FileCode className="w-4 h-4 text-blue-500" />;
  if (item.extension === '.csv') return <FileText className="w-4 h-4 text-green-500" />;
  if (item.extension === '.json') return <FileCode className="w-4 h-4 text-yellow-500" />;
  return <File className="w-4 h-4 text-slate-400" />;
}

export const FileListItem: React.FC<FileListItemProps> = ({
  item,
  isCurrentFile = false,
  onNavigate,
  onSelect,
  onOpenNewTab,
  onDuplicate,
  onDownload,
  onDelete,
  compact = false,
}) => {
  const isNotebook = item.extension === '.ipynb';
  const isClickable = item.isDirectory || isNotebook;

  const handleClick = () => {
    if (item.isDirectory && onNavigate) {
      onNavigate(item.path);
    } else if (isNotebook && onSelect) {
      onSelect(item.path);
    }
  };

  const handleAction = (e: React.MouseEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };

  return (
    <div
      onClick={isClickable ? handleClick : undefined}
      className={`
        group relative flex items-center px-3 py-2 rounded-md transition-all
        ${compact ? 'py-2' : 'py-3 px-4'}
        ${isClickable ? 'cursor-pointer' : 'cursor-default'}
        ${isCurrentFile
          ? 'bg-blue-100/50 text-blue-900 font-medium'
          : isNotebook
            ? 'hover:bg-orange-50 text-slate-700'
            : item.isDirectory
              ? 'hover:bg-slate-100 text-slate-700'
              : 'text-slate-500 opacity-60'
        }
      `}
    >
      {/* File icon and name */}
      <div className="flex items-center gap-2 overflow-hidden flex-1 min-w-0">
        {getFileIcon(item)}
        <div className="flex flex-col min-w-0 flex-1">
          <span
            className={`text-xs truncate ${isNotebook ? 'group-hover:text-orange-600' : ''}`}
            title={item.name}
          >
            {item.name}
          </span>
          {!item.isDirectory && !compact && (
            <span className="text-[9px] text-slate-400 flex gap-2">
              {formatRelativeTime(item.modified)}
              <span>•</span>
              {item.size}
            </span>
          )}
        </div>
      </div>

      {/* Hover Actions */}
      {!item.isDirectory && (onOpenNewTab || onDuplicate || onDownload || onDelete) && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none group-hover:pointer-events-auto">
          <div className="flex bg-white shadow-sm rounded border border-slate-200">
            {isNotebook && onOpenNewTab && (
              <>
                <button
                  onClick={(e) => handleAction(e, () => onOpenNewTab(item.path))}
                  className="p-1 text-slate-400 hover:text-green-600 hover:bg-green-50"
                  title="Open in new tab"
                >
                  <ExternalLink className="w-3 h-3" />
                </button>
                {(onDuplicate || onDownload || onDelete) && (
                  <div className="w-[1px] bg-slate-200" />
                )}
              </>
            )}
            {onDuplicate && (
              <>
                <button
                  onClick={(e) => handleAction(e, () => onDuplicate(item))}
                  className="p-1 text-slate-400 hover:text-blue-600 hover:bg-blue-50"
                  title="Duplicate"
                >
                  <Copy className="w-3 h-3" />
                </button>
                {(onDownload || onDelete) && <div className="w-[1px] bg-slate-200" />}
              </>
            )}
            {onDownload && (
              <>
                <button
                  onClick={(e) => handleAction(e, () => onDownload(item))}
                  className="p-1 text-slate-400 hover:text-purple-600 hover:bg-purple-50"
                  title="Download"
                >
                  <Download className="w-3 h-3" />
                </button>
                {onDelete && <div className="w-[1px] bg-slate-200" />}
              </>
            )}
            {onDelete && (
              <button
                onClick={(e) => handleAction(e, () => onDelete(item))}
                className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
