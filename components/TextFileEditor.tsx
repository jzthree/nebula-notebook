import React, { useCallback, useEffect, useMemo, useState } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { EditorView } from '@codemirror/view';
import { lineNumbers } from '@codemirror/view';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { readFile, writeFile } from '../services/fileService';

interface TextFileEditorProps {
  filePath: string;
  variant?: 'full' | 'modal';
  onClose?: () => void;
}

const editorTheme = EditorView.theme({
  '&': {
    fontSize: '0.875rem',
    backgroundColor: '#ffffff',
  },
  '&.cm-editor': {
    height: '100%',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    padding: '1rem',
    minHeight: '100%',
  },
  '.cm-line': {
    padding: '0',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
  },
  '.cm-scroller': {
    overflow: 'auto',
    height: '100%',
  },
  '.cm-gutters': {
    backgroundColor: '#f8fafc',
    borderRight: '1px solid #e2e8f0',
    color: '#94a3b8',
  },
  '.cm-focused': {
    outline: 'none',
  },
});

const getLanguageExtensions = (path: string) => {
  const lower = path.toLowerCase();
  if (lower.endsWith('.py')) return [python()];
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return [markdown()];
  return [];
};

export const TextFileEditor: React.FC<TextFileEditorProps> = ({ filePath, variant = 'full', onClose }) => {
  const [content, setContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);

  const filename = useMemo(() => filePath.split('/').pop() || filePath, [filePath]);
  const extensions = useMemo(() => {
    const language = getLanguageExtensions(filePath);
    return [editorTheme, lineNumbers(), ...language];
  }, [filePath]);

  const loadFile = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await readFile(filePath);
      if (result.type !== 'text' || typeof result.content !== 'string') {
        setError('This file cannot be opened as text.');
        return;
      }
      setContent(result.content);
      setIsDirty(false);
      setLastSavedAt(Date.now());
    } catch (err: any) {
      setError(err.message || 'Failed to load file');
    } finally {
      setIsLoading(false);
    }
  }, [filePath]);

  useEffect(() => {
    document.title = `${filename} - Nebula Editor`;
    loadFile();
  }, [filename, loadFile]);

  const handleSave = useCallback(async () => {
    if (!isDirty || isSaving) return;
    setIsSaving(true);
    try {
      await writeFile(filePath, content, 'text');
      setIsDirty(false);
      setLastSavedAt(Date.now());
    } catch (err: any) {
      setError(err.message || 'Failed to save file');
    } finally {
      setIsSaving(false);
    }
  }, [content, filePath, isDirty, isSaving]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSave]);

  if (isLoading) {
    return (
      <div className={`${variant === 'modal' ? 'h-full' : 'min-h-screen'} bg-slate-50 flex items-center justify-center text-slate-500 text-sm`}>
        Loading file…
      </div>
    );
  }

  if (error) {
    return (
      <div className={`${variant === 'modal' ? 'h-full' : 'min-h-screen'} bg-slate-50 text-slate-900 flex items-center justify-center p-6`}>
        <div className="max-w-lg rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold mb-2">Unable to open file</h1>
          <p className="text-sm text-slate-600">{error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`${variant === 'modal' ? 'h-full' : 'min-h-screen'} flex flex-col bg-slate-50 text-slate-900`}>
      <header className="flex items-center justify-between gap-4 px-4 py-3 border-b border-slate-200 bg-white">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900 truncate">{filename}</div>
          <div className="text-[0.625rem] text-slate-500 truncate">{filePath}</div>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-500">
          {isDirty ? <span className="text-amber-600">Unsaved</span> : <span>Saved</span>}
          {lastSavedAt && !isDirty && (
            <span className="text-slate-400">· {new Date(lastSavedAt).toLocaleTimeString()}</span>
          )}
          <button
            onClick={handleSave}
            disabled={!isDirty || isSaving}
            className="px-3 py-1.5 text-xs font-medium rounded border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100 disabled:opacity-50"
          >
            {isSaving ? 'Saving…' : 'Save'}
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="px-2 py-1.5 text-xs font-medium rounded border border-slate-200 text-slate-500 hover:bg-slate-100"
            >
              Close
            </button>
          )}
        </div>
      </header>
      <div className="flex-1 overflow-hidden">
        <CodeMirror
          value={content}
          height={variant === 'modal' ? '100%' : 'calc(100vh - 56px)'}
          className="h-full"
          extensions={extensions}
          onChange={(value) => {
            setContent(value);
            setIsDirty(true);
          }}
        />
      </div>
    </div>
  );
};
