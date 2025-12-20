import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate } from '@codemirror/view';
import { Prec, EditorState } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { indentUnit } from '@codemirror/language';
import { autocompletion, CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';

interface CurrentMatch {
  cellId: string;
  startIndex: number;
  endIndex: number;
}

interface SearchHighlight {
  query: string;
  caseSensitive: boolean;
  useRegex: boolean;
  currentMatch?: CurrentMatch | null;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  language: 'python' | 'markdown';
  onKeyDown?: (event: KeyboardEvent) => boolean; // Return true to prevent default
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  searchHighlight?: SearchHighlight | null;
  cellId?: string;
  shouldFocus?: boolean; // When true, focus the editor
  indentConfig?: IndentationConfig; // Detected indentation configuration
  allCellsContent?: string[]; // Content of all cells for variable extraction
}

// Light theme that matches our existing style
const lightTheme = EditorView.theme({
  '&': {
    fontSize: '14px',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    padding: '8px 12px',
    minHeight: '1.5rem', // Single line minimum
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
  // Current search match (highlighted differently)
  '.cm-searchMatch-current': {
    backgroundColor: '#fb923c', // orange-400
    borderRadius: '2px',
    color: 'white',
  },
  // Autocomplete tooltip styling
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: '6px',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: '13px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '4px 8px',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: '#dbeafe',
    color: '#1e293b',
  },
  '.cm-completionIcon': {
    width: '1em',
    marginRight: '4px',
  },
  '.cm-completionLabel': {
    color: '#1e293b',
  },
  '.cm-completionDetail': {
    color: '#64748b',
    marginLeft: '8px',
    fontStyle: 'italic',
  },
});

// Create search highlight decorations
const searchHighlightMark = Decoration.mark({ class: 'cm-searchMatch' });
const currentMatchMark = Decoration.mark({ class: 'cm-searchMatch-current' });

// Create extension for search highlighting
function createSearchHighlightExtension(
  query: string,
  caseSensitive: boolean,
  useRegex: boolean,
  currentMatchStart?: number,
  currentMatchEnd?: number
) {
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

        if (useRegex) {
          // Regex search
          try {
            const regex = new RegExp(query, caseSensitive ? 'g' : 'gi');
            let match;
            while ((match = regex.exec(doc)) !== null) {
              const idx = match.index;
              const matchLen = match[0].length;
              if (matchLen === 0) {
                regex.lastIndex++; // Prevent infinite loop on zero-length matches
                continue;
              }

              const isCurrentMatch = currentMatchStart !== undefined &&
                idx === currentMatchStart &&
                idx + matchLen === currentMatchEnd;

              builder.add(idx, idx + matchLen, isCurrentMatch ? currentMatchMark : searchHighlightMark);
            }
          } catch {
            // Invalid regex, return empty decorations
            return builder.finish();
          }
        } else {
          // String search
          const searchStr = caseSensitive ? query : query.toLowerCase();
          const searchIn = caseSensitive ? doc : doc.toLowerCase();

          let pos = 0;
          while (pos < searchIn.length) {
            const idx = searchIn.indexOf(searchStr, pos);
            if (idx === -1) break;

            // Check if this is the current match
            const isCurrentMatch = currentMatchStart !== undefined &&
              idx === currentMatchStart &&
              idx + query.length === currentMatchEnd;

            builder.add(idx, idx + query.length, isCurrentMatch ? currentMatchMark : searchHighlightMark);
            pos = idx + 1;
          }
        }

        return builder.finish();
      }
    },
    { decorations: (v) => v.decorations }
  );
}

// Extract Python identifiers from code
function extractPythonIdentifiers(code: string): Set<string> {
  const identifiers = new Set<string>();

  // Match variable assignments: name = ...
  const assignmentPattern = /^[ \t]*([a-zA-Z_][a-zA-Z0-9_]*)\s*=/gm;

  // Match function definitions: def name(...
  const functionPattern = /\bdef\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/g;

  // Match class definitions: class Name...
  const classPattern = /\bclass\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;

  // Match for loop variables: for name in ...
  const forPattern = /\bfor\s+([a-zA-Z_][a-zA-Z0-9_]*)\s+in\b/g;

  // Match import statements: import name, from x import name
  const importPattern = /\bimport\s+([a-zA-Z_][a-zA-Z0-9_]*)/g;
  const fromImportPattern = /\bfrom\s+\S+\s+import\s+([a-zA-Z_][a-zA-Z0-9_,\s]+)/g;

  // Match function parameters: def func(param1, param2):
  const paramPattern = /\bdef\s+\w+\s*\(([^)]*)\)/g;

  let match;

  while ((match = assignmentPattern.exec(code)) !== null) {
    identifiers.add(match[1]);
  }

  while ((match = functionPattern.exec(code)) !== null) {
    identifiers.add(match[1]);
  }

  while ((match = classPattern.exec(code)) !== null) {
    identifiers.add(match[1]);
  }

  while ((match = forPattern.exec(code)) !== null) {
    identifiers.add(match[1]);
  }

  while ((match = importPattern.exec(code)) !== null) {
    identifiers.add(match[1]);
  }

  while ((match = fromImportPattern.exec(code)) !== null) {
    // Split by comma and extract each imported name
    const imports = match[1].split(',');
    for (const imp of imports) {
      const name = imp.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) {
        identifiers.add(name);
      }
    }
  }

  while ((match = paramPattern.exec(code)) !== null) {
    const params = match[1].split(',');
    for (const param of params) {
      // Extract parameter name (handle type hints and defaults)
      const paramName = param.split(':')[0].split('=')[0].trim();
      if (paramName && /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(paramName) && paramName !== '*' && paramName !== '**') {
        identifiers.add(paramName);
      }
    }
  }

  return identifiers;
}

// Common Python builtins for completion
const pythonBuiltins = [
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set', 'tuple',
  'bool', 'type', 'isinstance', 'issubclass', 'hasattr', 'getattr', 'setattr',
  'open', 'input', 'abs', 'max', 'min', 'sum', 'sorted', 'reversed', 'enumerate',
  'zip', 'map', 'filter', 'any', 'all', 'round', 'pow', 'divmod', 'hex', 'oct', 'bin',
  'ord', 'chr', 'format', 'repr', 'hash', 'id', 'dir', 'vars', 'globals', 'locals',
  'callable', 'iter', 'next', 'slice', 'super', 'object', 'property', 'classmethod',
  'staticmethod', 'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'AttributeError', 'ImportError', 'RuntimeError', 'StopIteration', 'True', 'False', 'None',
];

// Common data science imports
const dataScienceCompletions = [
  { label: 'numpy', detail: 'as np' },
  { label: 'pandas', detail: 'as pd' },
  { label: 'matplotlib', detail: '.pyplot as plt' },
  { label: 'sklearn', detail: 'scikit-learn' },
  { label: 'torch', detail: 'PyTorch' },
  { label: 'tensorflow', detail: 'as tf' },
  { label: 'scipy', detail: 'scientific computing' },
  { label: 'seaborn', detail: 'as sns' },
];

// Create completion source for Python - uses ref to avoid extension rebuilds
function createPythonCompletionSource(allCellsContentRef: React.RefObject<string[]>) {
  return (context: CompletionContext): CompletionResult | null => {
    // Get the word before cursor
    const word = context.matchBefore(/[a-zA-Z_][a-zA-Z0-9_]*/);

    // Don't show completions if we're not typing a word and not explicitly requested
    if (!word && !context.explicit) return null;

    // Read current content from ref (fresh on each completion request)
    const allCellsContent = allCellsContentRef.current || [];

    // Extract identifiers from all cells
    const identifiers = new Set<string>();
    for (const content of allCellsContent) {
      const cellIdentifiers = extractPythonIdentifiers(content);
      for (const id of cellIdentifiers) {
        identifiers.add(id);
      }
    }

    // Build completion options
    const options: { label: string; type: string; detail?: string; boost?: number }[] = [];

    // Add user-defined identifiers (higher priority)
    for (const id of identifiers) {
      options.push({ label: id, type: 'variable', boost: 2 });
    }

    // Add Python builtins
    for (const builtin of pythonBuiltins) {
      if (!identifiers.has(builtin)) {
        options.push({ label: builtin, type: 'function', boost: 1 });
      }
    }

    // Add common data science modules
    for (const mod of dataScienceCompletions) {
      if (!identifiers.has(mod.label)) {
        options.push({ label: mod.label, type: 'namespace', detail: mod.detail, boost: 0 });
      }
    }

    return {
      from: word ? word.from : context.pos,
      options,
      validFor: /^[a-zA-Z_][a-zA-Z0-9_]*$/,
    };
  };
}

// Typing lag measurement extension
const MEASURE_TYPING_LAG = true; // Set to false to disable logging
let lastKeydownTime = 0;

function createTypingLagExtension() {
  return EditorView.domEventHandlers({
    keydown: () => {
      lastKeydownTime = performance.now();
      return false; // Don't prevent default
    },
  });
}

function createTypingLagUpdateListener() {
  return EditorView.updateListener.of((update) => {
    if (MEASURE_TYPING_LAG && update.docChanged && lastKeydownTime > 0) {
      const lag = performance.now() - lastKeydownTime;
      if (lag < 1000) { // Only log reasonable values
        if (lag > 50) {
          // Warn when lag exceeds 50ms - likely an extension rebuild issue
          console.warn(`⚠️ Typing lag: ${lag.toFixed(1)}ms - check if callbacks are stable`);
        } else {
          console.log(`⌨️ Typing lag: ${lag.toFixed(1)}ms`);
        }
      }
      lastKeydownTime = 0;
    }
  });
}

export const CodeEditor: React.FC<Props> = ({
  value,
  onChange,
  language,
  onKeyDown,
  onFocus,
  onBlur,
  placeholder,
  readOnly = false,
  searchHighlight,
  cellId,
  shouldFocus = false,
  indentConfig = DEFAULT_INDENTATION,
  allCellsContent = [],
}) => {
  const editorRef = useRef<ReactCodeMirrorRef>(null);

  // Use ref for allCellsContent to avoid extension rebuilds on every keystroke
  const allCellsContentRef = useRef<string[]>(allCellsContent);
  allCellsContentRef.current = allCellsContent; // Update ref on each render

  // Focus editor when shouldFocus becomes true
  useEffect(() => {
    if (shouldFocus) {
      // Don't steal focus from other inputs (e.g., search bar, dialogs)
      const activeElement = document.activeElement;
      const isOtherInputFocused = activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.getAttribute('role') === 'textbox';

      if (isOtherInputFocused) {
        return; // Don't steal focus from other inputs
      }

      // Use requestAnimationFrame to ensure the editor is fully rendered
      const focusEditor = () => {
        if (editorRef.current?.view) {
          editorRef.current.view.focus();
        } else {
          // Editor not ready yet, try again next frame
          requestAnimationFrame(focusEditor);
        }
      };
      requestAnimationFrame(focusEditor);
    }
  }, [shouldFocus]);

  // Extract stable values from searchHighlight to avoid recreating extensions
  // when currentMatch changes for a DIFFERENT cell
  const searchQuery = searchHighlight?.query;
  const searchCaseSensitive = searchHighlight?.caseSensitive;
  const searchUseRegex = searchHighlight?.useRegex;
  const isCurrentMatchInThisCell = searchHighlight?.currentMatch?.cellId === cellId;
  const currentMatchStart = isCurrentMatchInThisCell ? searchHighlight?.currentMatch?.startIndex : undefined;
  const currentMatchEnd = isCurrentMatchInThisCell ? searchHighlight?.currentMatch?.endIndex : undefined;

  // ⚠️ PERFORMANCE CRITICAL: Extensions rebuild when dependencies change.
  // All callbacks (onKeyDown, onFocus, onBlur) MUST be stable - use refs in Cell.tsx
  // to avoid recreating them on every keystroke. If you see typing lag, check if
  // any callback dependency is changing on each render (e.g., cell.content).
  const extensions = useMemo(() => {
    // Create indent string based on config
    const indentStr = indentConfig.useTabs ? '\t' : ' '.repeat(indentConfig.indentSize);

    const exts = [
      lightTheme,
      EditorView.lineWrapping,
      language === 'python' ? python() : markdown(),
      // Configure indentation based on detected style
      indentUnit.of(indentStr),
      EditorState.tabSize.of(indentConfig.tabSize),
      // Typing lag measurement
      createTypingLagExtension(),
      createTypingLagUpdateListener(),
    ];

    // Add autocompletion for Python - uses ref so no rebuild on content changes
    if (language === 'python') {
      exts.push(
        autocompletion({
          override: [createPythonCompletionSource(allCellsContentRef)],
          activateOnTyping: true,
          defaultKeymap: true,
        })
      );
    }

    // Add keymap to intercept Shift+Enter and Ctrl/Cmd+Enter BEFORE CodeMirror's default newline handling
    if (onKeyDown) {
      exts.push(
        Prec.highest(
          keymap.of([
            {
              key: 'Shift-Enter',
              run: (view) => {
                // Create a synthetic keyboard event to pass to our handler
                const event = new KeyboardEvent('keydown', {
                  key: 'Enter',
                  shiftKey: true,
                  ctrlKey: false,
                  metaKey: false,
                  bubbles: true,
                  cancelable: true,
                });
                return onKeyDown(event);
              },
            },
            {
              key: 'Mod-Enter',
              run: (view) => {
                const isMac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
                const event = new KeyboardEvent('keydown', {
                  key: 'Enter',
                  shiftKey: false,
                  ctrlKey: !isMac,
                  metaKey: isMac,
                  bubbles: true,
                  cancelable: true,
                });
                return onKeyDown(event);
              },
            },
          ])
        )
      );
    }

    // Add focus/blur handlers
    if (onFocus || onBlur) {
      exts.push(
        Prec.highest(
          EditorView.domEventHandlers({
            focus: onFocus ? () => { onFocus(); return false; } : undefined,
            blur: onBlur ? () => { onBlur(); return false; } : undefined,
          })
        )
      );
    }

    // Add search highlighting if active
    if (searchQuery) {
      exts.push(createSearchHighlightExtension(
        searchQuery,
        searchCaseSensitive ?? false,
        searchUseRegex ?? false,
        currentMatchStart,
        currentMatchEnd
      ));
    }

    return exts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, onKeyDown, onFocus, onBlur, searchQuery, searchCaseSensitive, searchUseRegex, currentMatchStart, currentMatchEnd, indentConfig]);

  const handleChange = useCallback(
    (val: string) => {
      onChange(val);
    },
    [onChange]
  );

  return (
    <CodeMirror
      ref={editorRef}
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
        autocompletion: false, // We handle this ourselves
        indentOnInput: true,
        syntaxHighlighting: true,
        defaultKeymap: true,
        historyKeymap: true,
        searchKeymap: false, // Disable per-cell search, we have notebook-wide search
      }}
    />
  );
};
