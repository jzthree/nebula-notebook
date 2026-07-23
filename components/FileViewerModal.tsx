import React, { useEffect } from 'react';
import { ExternalLink, Download, X } from 'lucide-react';
import { classifyFileView, inlineViewUrl, fileExtension } from '../lib/fileViewer';

interface FileViewerModalProps {
  path: string;
  name: string;
  token?: string | null;
  onClose: () => void;
}

/**
 * In-tab viewer for browser-native file types (PDF, video, audio). The body
 * is just a native element pointed at the inline-serve URL — the browser's
 * OWN renderer handles it (PDF runs out-of-process, not in the SPA heap), so
 * there's no bundled library and the memory is reclaimed when this unmounts
 * and the element leaves the DOM. Consistent chrome across types; the "Open in
 * new tab" button pops the same URL out to a full browser tab on demand.
 *
 * Non-native formats (npy/parquet/h5/…) would register a lazy-imported body
 * renderer here — see the file-viewer design notes — so their cost is only
 * paid when someone actually opens one.
 */
export const FileViewerModal: React.FC<FileViewerModalProps> = ({ path, name, token, onClose }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const url = inlineViewUrl(path, token);
  const ext = fileExtension(name || path);
  const isVideo = ['.mp4', '.webm', '.mov', '.m4v', '.ogv'].includes(ext);
  const isAudio = ['.mp3', '.wav', '.ogg', '.oga', '.flac', '.m4a', '.aac'].includes(ext);
  const isPdf = ext === '.pdf';

  return (
    <div
      className="fixed inset-0 z-[70] bg-black/60 flex flex-col"
      onClick={onClose}
    >
      <div className="flex items-center gap-2 px-3 py-2 bg-slate-900 text-slate-100 text-sm flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        <span className="font-medium truncate flex-1" title={path}>{name}</span>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700 text-slate-200"
          title="Open in a new browser tab"
        >
          <ExternalLink className="w-3.5 h-3.5" /> New tab
        </a>
        <a
          href={`/api/fs/download?path=${encodeURIComponent(path)}${token ? `&token=${encodeURIComponent(token)}` : ''}`}
          className="flex items-center gap-1 px-2 py-1 rounded hover:bg-slate-700 text-slate-200"
          title="Download"
        >
          <Download className="w-3.5 h-3.5" /> Download
        </a>
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-slate-700 text-slate-300"
          title="Close (Esc)"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 bg-slate-800 flex items-center justify-center" onClick={(e) => e.stopPropagation()}>
        {isPdf ? (
          <iframe title={name} src={url} className="w-full h-full border-0 bg-white" />
        ) : isVideo ? (
          <video controls autoPlay src={url} className="max-w-full max-h-full" />
        ) : isAudio ? (
          <audio controls autoPlay src={url} className="w-2/3" />
        ) : (
          <div className="text-center text-slate-300">
            <p className="text-sm mb-3">No in-app preview for this file type.</p>
            <a href={url} target="_blank" rel="noopener noreferrer" className="underline">Try opening in a new tab</a>
          </div>
        )}
      </div>
    </div>
  );
};

/** Types the FileViewerModal renders in-app (as opposed to images → the rich
 *  ImageModalViewer, text → the editor, html → the trust-gated page). */
export function opensInFileViewerModal(pathOrName: string): boolean {
  return classifyFileView(pathOrName) === 'newtab'
    && !['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif'].includes(fileExtension(pathOrName));
}
