import React, { useCallback, useMemo } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';

interface SearchHighlight {
  query: string;
  caseSensitive: boolean;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  language: 'python' | 'markdown';
  onKeyDown?: (event: KeyboardEvent) => boolean; // Return true to prevent default
  placeholder?: string;
  readOnly?: boolean;
  searchHighlight?: SearchHighlight | null;
}

// Light theme that matches our existing style
const lightTheme = EditorView.theme({
  '&': {
    fontSize: '14px',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    padding: '16px',
    minHeight: '4rem',
  },
  '.cm-line': {
    padding: '0',
  },
  '.cm-gutters': {
    display: 'none', // Hide line numbers (we show cell numbers in sidebar)
  },
  '.cm-focused': {
    outline: 'none',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-placeholder': {
    color: '#94a3b8',
    fontStyle: 'italic',
  },
  // Syntax highlighting colors (matching PythonHighlighter)
  '.cm-keyword': { color: '#9333ea' },           // purple-600
  '.cm-atom': { color: '#9333ea' },              // True, False, None
  '.cm-number': { color: '#f97316' },            // orange-500
  '.cm-string': { color: '#16a34a' },            // green-600
  '.cm-string-2': { color: '#16a34a' },          // f-strings, etc
  '.cm-comment': { color: '#94a3b8', fontStyle: 'italic' }, // slate-400
  '.cm-variableName': { color: '#1e293b' },      // slate-800
  '.cm-typeName': { color: '#2563eb' },          // blue-600
  '.cm-propertyName': { color: '#1e293b' },      // slate-800
  '.cm-operator': { color: '#475569' },          // slate-600
  '.cm-bracket': { color: '#475569' },           // slate-600
  '.cm-meta': { color: '#d97706' },              // amber-600 (decorators)
  '.cm-builtin': { color: '#2563eb' },           // blue-600
  // Selection
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    backgroundColor: '#dbeafe', // blue-100
  },
  '.cm-cursor': {
    borderLeftColor: '#1e293b',
  },
  // Search match highlighting
  '.cm-searchMatch': {
    backgroundColor: '#fef08a', // yellow-200
    borderRadius: '2px',
  },
});

// Create search highlight decoration
const searchHighlightMark = Decoration.mark({ class: 'cm-searchMatch' });

// Create extension for search highlighting
function createSearchHighlightExtension(query: string, caseSensitive: boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = this.buildDecorations(view);
      }

      update(update: ViewUpdate) {
        if (update.docChanged || update.viewportChanged) {
          this.decorations = this.buildDecorations(update.view);
        }
      }

      buildDecorations(view: EditorView): DecorationSet {
        const builder = new RangeSetBuilder<Decoration>();

        if (!query) return builder.finish();

        const doc = view.state.doc.toString();
        const searchStr = caseSensitive ? query : query.toLowerCase();
        const searchIn = caseSensitive ? doc : doc.toLowerCase();

        let pos = 0;
        while (pos < searchIn.length) {
          const idx = searchIn.indexOf(searchStr, pos);
          if (idx === -1) break;

          builder.add(idx, idx + query.length, searchHighlightMark);
          pos = idx + 1;
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export const CodeEditor: React.FC<Props> = ({
  value,
  onChange,
  language,
  onKeyDown,
  placeholder,
  readOnly = false,
  searchHighlight,
}) => {
  const extensions = useMemo(() => {
    const exts = [
      lightTheme,
      EditorView.lineWrapping,
      language === 'python' ? python() : markdown(),
    ];

    // Add keyboard handler if provided
    if (onKeyDown) {
      exts.push(
        EditorView.domEventHandlers({
          keydown: (event) => {
            return onKeyDown(event);
          },
        })
      );
    }

    // Add search highlighting if active
    if (searchHighlight?.query) {
      exts.push(createSearchHighlightExtension(searchHighlight.query, searchHighlight.caseSensitive));
    }

    return exts;
  }, [language, onKeyDown, searchHighlight]);

  const handleChange = useCallback(
    (val: string) => {
      onChange(val);
    },
    [onChange]
  );

  return (
    <CodeMirror
      value={value}
      onChange={handleChange}
      extensions={extensions}
      placeholder={placeholder}
      readOnly={readOnly}
      basicSetup={{
        lineNumbers: false,
        foldGutter: false,
        highlightActiveLine: false,
        highlightSelectionMatches: true,
        bracketMatching: true,
        closeBrackets: true,
        autocompletion: false, // Keep it simple for now
        indentOnInput: true,
        syntaxHighlighting: true,
        defaultKeymap: true,
        historyKeymap: true,
      }}
    />
  );
};
