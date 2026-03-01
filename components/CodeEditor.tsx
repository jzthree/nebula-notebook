import React, { useCallback, useMemo, useRef, useEffect } from 'react';
import CodeMirror, { ReactCodeMirrorRef } from '@uiw/react-codemirror';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { EditorView, Decoration, DecorationSet, ViewPlugin, ViewUpdate, lineNumbers, highlightSpecialChars, drawSelection } from '@codemirror/view';
import { Prec, EditorState, StateEffect, StateField } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { indentUnit, syntaxHighlighting, defaultHighlightStyle, bracketMatching, indentOnInput } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, CompletionContext, CompletionResult, Completion } from '@codemirror/autocomplete';
import { history, defaultKeymap, historyKeymap } from '@codemirror/commands';
import { highlightSelectionMatches } from '@codemirror/search';
import { IndentationConfig, DEFAULT_INDENTATION } from '../utils/indentationDetector';
import { kernelService, CompletionResult as KernelCompletionResult } from '../services/kernelService';

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
  enableInteractiveFeatures?: boolean; // Enable expensive editor features only when focused
  // Direct callbacks for keyboard shortcuts (simpler than synthetic events)
  onShiftEnter?: () => void;  // Run and advance
  onModEnter?: () => void;    // Run current cell (Cmd/Ctrl+Enter)
  onEscape?: () => boolean | void; // Return true to keep focus, false/void to blur
  onSave?: () => void;        // Save notebook (Cmd/Ctrl+S)
  onFocus?: () => void;
  onBlur?: () => void;
  placeholder?: string;
  readOnly?: boolean;
  searchHighlight?: SearchHighlight | null;
  cellId?: string;
  shouldFocus?: boolean; // When true, focus the editor
  onCursorActivity?: (pos: number) => void; // Updates last-known cursor for search navigation
  indentConfig?: IndentationConfig; // Detected indentation configuration
  allCellsRef?: React.RefObject<Array<{ type: string; content: string }>>; // Ref to all cells for lazy autocomplete
  showLineNumbers?: boolean; // Show line numbers in gutter
  kernelSessionId?: string; // Kernel session for live completions (file paths, attributes)
}

// Light theme that matches our existing style
const lightTheme = EditorView.theme({
  '&': {
    fontSize: '0.875rem',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    padding: '0.5rem 0.75rem',
    minHeight: '1.5rem', // Single line minimum
  },
  '.cm-line': {
    padding: '0',
    whiteSpace: 'pre-wrap',  // Preserve leading whitespace, allow wrapping
    wordBreak: 'break-all',  // Break long tokens at any character
  },
  '.cm-gutters': {
    backgroundColor: '#f8fafc', // slate-50
    borderRight: '1px solid #e2e8f0', // slate-200
    color: '#94a3b8', // slate-400
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 0.5rem 0 0.25rem',
    minWidth: '2rem',
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
  '&.cm-focused .cm-selectionBackground': {
    backgroundColor: '#dbeafe', // blue-100
  },
  '&:not(.cm-focused) .cm-selectionBackground': {
    backgroundColor: 'transparent',
  },
  '.cm-cursor': {
    borderLeftColor: '#1e293b',
  },
  // Search match highlighting
  '.cm-searchMatch': {
    // Orange background, keep text color unchanged for readability.
    backgroundColor: 'rgba(251, 146, 60, 0.35)', // orange-400 @ 35%
    borderRadius: '0.125rem',
    boxShadow: 'inset 0 0 0 1px rgba(0, 0, 0, 0.10)',
  },
  // Current search match (highlighted differently)
  '.cm-searchMatch-current': {
    backgroundColor: 'rgba(251, 146, 60, 0.70)', // orange-400 @ 70%
    borderRadius: '0.125rem',
    boxShadow: 'inset 0 0 0 2px rgba(0, 0, 0, 0.18)',
  },
  // Autocomplete tooltip styling
  '.cm-tooltip.cm-tooltip-autocomplete': {
    backgroundColor: 'white',
    border: '1px solid #e2e8f0',
    borderRadius: '0.375rem',
    boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    fontSize: '0.8125rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    padding: '0.25rem 0.5rem',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]': {
    backgroundColor: '#dbeafe',
    color: '#1e293b',
  },
  '.cm-completionIcon': {
    width: '1em',
    marginRight: '0.25rem',
  },
  '.cm-completionLabel': {
    color: '#1e293b',
  },
  '.cm-completionDetail': {
    color: '#64748b',
    marginLeft: '0.5rem',
    fontStyle: 'italic',
  },
});

// Create search highlight decorations
const searchHighlightMark = Decoration.mark({ class: 'cm-searchMatch' });
const currentMatchMark = Decoration.mark({ class: 'cm-searchMatch-current' });

// StateEffect to update the current match position without rebuilding extensions
const setCurrentMatch = StateEffect.define<{ start: number; end: number } | null>();

// StateField that tracks the current match position
const currentMatchField = StateField.define<{ start: number; end: number } | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setCurrentMatch)) {
        return effect.value;
      }
    }
    return value;
  },
});

// Create extension for search highlighting
// ⚠️ PERFORMANCE: We avoid full document rescans during match navigation.
// - All-matches decorations rebuild on doc changes (or when query/options change
//   and the extension is recreated).
// - Current match is a tiny decoration updated via StateEffect (O(1)).
function createSearchHighlightExtension(
  query: string,
  caseSensitive: boolean,
  useRegex: boolean
) {
  const allMatchesPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      // Key idea: don't rebuild on viewport changes, since navigating/scrolling
      // should be cheap even for long documents.
      if (update.docChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      if (!query) return builder.finish();

      const doc = view.state.doc.toString();

      if (useRegex) {
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
            builder.add(idx, idx + matchLen, searchHighlightMark);
          }
        } catch {
          // Invalid regex: show no highlights.
          return builder.finish();
        }
      } else {
        const searchStr = caseSensitive ? query : query.toLowerCase();
        const searchIn = caseSensitive ? doc : doc.toLowerCase();

        let pos = 0;
        while (pos < searchIn.length) {
          const idx = searchIn.indexOf(searchStr, pos);
          if (idx === -1) break;
          builder.add(idx, idx + query.length, searchHighlightMark);
          pos = idx + 1;
        }
      }

      return builder.finish();
    }
  }, { decorations: v => v.decorations });

  const currentMatchPlugin = ViewPlugin.fromClass(class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = this.buildDecorations(view);
    }

    update(update: ViewUpdate) {
      const currentMatchChanged = update.transactions.some(tr =>
        tr.effects.some(e => e.is(setCurrentMatch))
      );
      if (update.docChanged || currentMatchChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view: EditorView): DecorationSet {
      const builder = new RangeSetBuilder<Decoration>();
      const currentMatch = view.state.field(currentMatchField);
      if (!currentMatch) return builder.finish();

      const docLen = view.state.doc.length;
      const start = Math.max(0, Math.min(currentMatch.start, docLen));
      const end = Math.max(0, Math.min(currentMatch.end, docLen));
      if (start >= end) return builder.finish();

      builder.add(start, end, currentMatchMark);
      return builder.finish();
    }
  }, { decorations: v => v.decorations });

  return [currentMatchField, allMatchesPlugin, currentMatchPlugin];
}

function createCursorActivityExtension(
  onCursorActivityRef: React.MutableRefObject<((pos: number) => void) | undefined>
) {
  return ViewPlugin.fromClass(class {
    lastPos: number;

    constructor(view: EditorView) {
      this.lastPos = view.state.selection.main.head;
    }

    update(update: ViewUpdate) {
      if (!update.selectionSet) return;
      const pos = update.state.selection.main.head;
      if (pos === this.lastPos) return;
      this.lastPos = pos;
      onCursorActivityRef.current?.(pos);
    }
  });
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

// Create completion source for Python - uses ref to compute content lazily (only when autocomplete triggers)
function createPythonCompletionSource(allCellsRef: React.RefObject<Array<{ type: string; content: string }> | null>) {
  return (context: CompletionContext): CompletionResult | null => {
    // Get the word before cursor
    const word = context.matchBefore(/[a-zA-Z_][a-zA-Z0-9_]*/);

    // Don't show completions if we're not typing a word and not explicitly requested
    if (!word && !context.explicit) return null;

    // Compute content lazily from ref - only runs when autocomplete triggers, not on every keystroke
    const allCells = allCellsRef.current || [];
    const allCellsContent = allCells
      .filter(c => c.type === 'code')
      .map(c => c.content);

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

// Check if cursor is inside a string literal
function isInsideString(textBefore: string): boolean {
  // Count quotes to determine if we're inside a string
  // This is a simplified check - doesn't handle escaped quotes perfectly
  let inSingle = false;
  let inDouble = false;
  let inTripleSingle = false;
  let inTripleDouble = false;

  for (let i = 0; i < textBefore.length; i++) {
    const char = textBefore[i];
    const next2 = textBefore.slice(i, i + 3);

    if (next2 === '"""' && !inSingle && !inTripleSingle) {
      inTripleDouble = !inTripleDouble;
      i += 2;
    } else if (next2 === "'''" && !inDouble && !inTripleDouble) {
      inTripleSingle = !inTripleSingle;
      i += 2;
    } else if (char === '"' && !inSingle && !inTripleSingle && !inTripleDouble) {
      inDouble = !inDouble;
    } else if (char === "'" && !inDouble && !inTripleSingle && !inTripleDouble) {
      inSingle = !inSingle;
    }
  }

  return inSingle || inDouble || inTripleSingle || inTripleDouble;
}

// Create kernel completion source for file paths and attributes
function createKernelCompletionSource(kernelSessionIdRef: React.RefObject<string | undefined>) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const sessionId = kernelSessionIdRef.current;
    if (!sessionId) return null;

    try {
      // Get all text up to cursor
      const doc = context.state.doc;
      const pos = context.pos;

      // For kernel completions, send the full line context
      const line = doc.lineAt(pos);
      const lineText = line.text;
      const cursorInLine = pos - line.from;

      // Request completion from kernel
      console.log('[Completion] Requesting from kernel:', { sessionId, lineText, cursorInLine });
      const result = await kernelService.complete(sessionId, lineText, cursorInLine);
      console.log('[Completion] Kernel service returned:', result);

      if (result.status !== 'ok' || result.matches.length === 0) {
        console.log('[Completion] No matches or error status');
        return null;
      }

      // Convert kernel matches to CodeMirror format
      const options: Completion[] = result.matches.map((match, idx) => ({
        label: match,
        type: match.endsWith('/') ? 'folder' : 'file',
        boost: result.matches.length - idx, // Preserve kernel's ordering
      }));

      // Adjust cursor positions relative to document
      const from = line.from + result.cursor_start;

      return {
        from,
        options,
        validFor: /^[\w./~-]*$/,
      };
    } catch (e) {
      console.error('Kernel completion error:', e);
      return null;
    }
  };
}

// Create combined completion source with context-based routing
function createCombinedCompletionSource(
  allCellsRef: React.RefObject<Array<{ type: string; content: string }> | null>,
  kernelSessionIdRef: React.RefObject<string | undefined>
) {
  const staticSource = createPythonCompletionSource(allCellsRef);
  const kernelSource = createKernelCompletionSource(kernelSessionIdRef);

  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const textBefore = line.text.slice(0, context.pos - line.from);
    const sessionId = kernelSessionIdRef.current;

    // Inside string → kernel (file paths)
    if (isInsideString(textBefore)) {
      console.log('[Completion] Inside string, using kernel. SessionId:', sessionId);
      const result = await kernelSource(context);
      console.log('[Completion] Kernel result:', result);
      if (result && result.options.length > 0) return result;
      // Fall through to static if kernel returns nothing
    }

    // After dot → kernel (object attributes)
    if (textBefore.match(/\.\w*$/)) {
      console.log('[Completion] After dot, using kernel. SessionId:', sessionId, 'textBefore:', textBefore);
      const result = await kernelSource(context);
      console.log('[Completion] Kernel result:', result);
      if (result && result.options.length > 0) return result;
    }

    // After import/from → kernel (module names)
    if (textBefore.match(/^\s*(from|import)\s+[\w.]*$/)) {
      console.log('[Completion] After import, using kernel. SessionId:', sessionId);
      const result = await kernelSource(context);
      console.log('[Completion] Kernel result:', result);
      if (result && result.options.length > 0) return result;
    }

    // Default → static completions (instant, no latency)
    return staticSource(context);
  };
}

export const CodeEditor: React.FC<Props> = ({
  value,
  onChange,
  language,
  enableInteractiveFeatures = true,
  onShiftEnter,
  onModEnter,
  onEscape,
  onSave,
  onFocus,
  onBlur,
  placeholder,
  readOnly = false,
  searchHighlight,
  cellId,
  shouldFocus = false,
  onCursorActivity,
  indentConfig = DEFAULT_INDENTATION,
  allCellsRef,
  showLineNumbers = false,
  kernelSessionId,
}) => {
  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const onCursorActivityRef = useRef<((pos: number) => void) | undefined>(onCursorActivity);
  onCursorActivityRef.current = onCursorActivity;

  // Fallback ref if none provided (for standalone usage)
  const fallbackRef = useRef<Array<{ type: string; content: string }>>([]);
  const effectiveAllCellsRef = allCellsRef || fallbackRef;

  // Ref for kernel session ID (for stable closure in completion source)
  const kernelSessionIdRef = useRef<string | undefined>(kernelSessionId);
  kernelSessionIdRef.current = kernelSessionId;

  // Focus editor when shouldFocus becomes true
  useEffect(() => {
    if (shouldFocus) {
      // Don't steal focus from non-CodeMirror inputs (e.g., search bar, dialogs)
      const activeElement = document.activeElement;
      const isCodeMirrorEditor = activeElement?.closest('.cm-editor') !== null;
      const isOtherInputFocused = (
        activeElement instanceof HTMLInputElement ||
        activeElement instanceof HTMLTextAreaElement ||
        activeElement?.getAttribute('role') === 'textbox'
      ) && !isCodeMirrorEditor;

      if (isOtherInputFocused) {
        return; // Don't steal focus from other inputs
      }

      // Use requestAnimationFrame to ensure the editor is fully rendered
      const focusEditor = () => {
        if (editorRef.current?.view) {
          // Use DOM focus with preventScroll to avoid unwanted scroll jumps
          // CodeMirror's view.focus() doesn't have this option
          const contentElement = editorRef.current.view.contentDOM;
          contentElement.focus({ preventScroll: true });
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

  // ⚠️ PERFORMANCE CRITICAL: Update current match via StateEffect, NOT by rebuilding extensions.
  // This allows navigating through search results without recreating all CodeMirror extensions.
  useEffect(() => {
    const matchValue = (currentMatchStart !== undefined && currentMatchEnd !== undefined)
      ? { start: currentMatchStart, end: currentMatchEnd }
      : null;

    let cancelled = false;
    let rafId: number | null = null;

    const dispatchWhenReady = (attempt: number) => {
      if (cancelled) return;

      const view = editorRef.current?.view;
      if (!view) {
        if (attempt < 60) {
          rafId = requestAnimationFrame(() => dispatchWhenReady(attempt + 1));
        }
        return;
      }

      view.dispatch({ effects: setCurrentMatch.of(matchValue) });
    };

    dispatchWhenReady(0);
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [searchQuery, currentMatchStart, currentMatchEnd]);

  // Scroll current search match into view (without changing selection)
  useEffect(() => {
    if (currentMatchStart === undefined || currentMatchEnd === undefined) return;

    let cancelled = false;
    let rafId: number | null = null;

    const scrollWhenReady = (attempt: number) => {
      if (cancelled) return;

      const view = editorRef.current?.view;
      if (!view) {
        if (attempt < 60) {
          rafId = requestAnimationFrame(() => scrollWhenReady(attempt + 1));
        }
        return;
      }

      const docLen = view.state.doc.length;
      const pos = Math.max(0, Math.min(currentMatchStart, docLen));

      // Ensure the current match decoration is applied even if the view mounted late.
      view.dispatch({
        effects: [
          setCurrentMatch.of({ start: currentMatchStart, end: currentMatchEnd }),
          EditorView.scrollIntoView(pos, { y: 'nearest' }),
        ],
      });
    };

    scrollWhenReady(0);
    return () => {
      cancelled = true;
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [currentMatchStart, currentMatchEnd]);

  // ⚠️ PERFORMANCE CRITICAL: Extensions rebuild when dependencies change.
  // All callbacks (onKeyDown, onFocus, onBlur) MUST be stable - use refs in Cell.tsx
  // to avoid recreating them on every keystroke. If you see typing lag, check if
  // any callback dependency is changing on each render (e.g., cell.content).
  const extensions = useMemo(() => {
    // Create indent string based on config
    const indentStr = indentConfig.useTabs ? '\t' : ' '.repeat(indentConfig.indentSize);

    // Minimal CodeMirror setup - only essential extensions
    // This reduces bundle size by ~50-80KB compared to full basicSetup
    const exts = [
      lightTheme,
      EditorView.lineWrapping,
      language === 'python' ? python() : markdown(),
      // Configure indentation based on detected style
      indentUnit.of(indentStr),
      EditorState.tabSize.of(indentConfig.tabSize),
      // Core editing features (minimal setup)
      highlightSpecialChars(),
      // ⚠️ PERFORMANCE: Limit CodeMirror's internal history to prevent unbounded growth.
      // The notebook has its own undo system for structural changes, so we only need
      // per-cell text undo. Default (100) can cause lag after extended use.
      history({ minDepth: 50, newGroupDelay: 300 }),
      drawSelection(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      bracketMatching(),
      closeBrackets(),
      // Keymaps
      keymap.of([
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...historyKeymap,
      ]),
    ];

    // Expensive interaction-only features should only run for focused editors.
    if (enableInteractiveFeatures) {
      exts.push(highlightSelectionMatches());
    }

    // Optional line numbers
    if (showLineNumbers) {
      exts.push(lineNumbers());
    }

    // Add autocompletion for Python - uses refs so no rebuild on content changes
    // Combined source: static for variables, kernel for paths/attributes/imports
    if (language === 'python' && enableInteractiveFeatures) {
      exts.push(
        autocompletion({
          override: [createCombinedCompletionSource(effectiveAllCellsRef, kernelSessionIdRef)],
          activateOnTyping: true,
          defaultKeymap: true,
        })
      );
    }

    // Add keymap for cell shortcuts - direct callbacks (no synthetic events)
    const keymapEntries: { key: string; run: (view: EditorView) => boolean }[] = [];

    if (onShiftEnter) {
      keymapEntries.push({
        key: 'Shift-Enter',
        run: () => { onShiftEnter(); return true; },
      });
    }

    if (onModEnter) {
      // Mod-Enter = Cmd on Mac, Ctrl on Windows/Linux
      keymapEntries.push({
        key: 'Mod-Enter',
        run: () => { onModEnter(); return true; },
      });
      // Also handle explicit Ctrl-Enter on Mac for users who prefer it
      keymapEntries.push({
        key: 'Ctrl-Enter',
        run: () => { onModEnter(); return true; },
      });
    }

    if (onSave) {
      keymapEntries.push({
        key: 'Mod-s',
        run: () => { onSave(); return true; },
      });
    }

    // Escape handling: callback decides whether focus should remain in editor.
    if (onEscape) {
      keymapEntries.push({
        key: 'Escape',
        run: (view) => {
          const keepFocus = onEscape();
          if (!keepFocus) {
            view.contentDOM.blur();
          }
          return true;
        },
      });
    }

    if (keymapEntries.length > 0) {
      exts.push(Prec.highest(keymap.of(keymapEntries)));
    }

    // Add focus/blur handlers and clipboard fix
    exts.push(
      Prec.highest(
        EditorView.domEventHandlers({
          focus: onFocus ? () => { onFocus(); return false; } : undefined,
          blur: onBlur ? () => { onBlur(); return false; } : undefined,
          // Ensure copy writes to system clipboard on HTTP localhost
          copy: (event, view) => {
            const selection = view.state.sliceDoc(
              view.state.selection.main.from,
              view.state.selection.main.to
            );
            if (selection && event.clipboardData) {
              event.clipboardData.setData('text/plain', selection);
              event.preventDefault();
            }
            return false;
          },
        })
      )
    );

    // Add search highlighting if active
    // ⚠️ PERFORMANCE: Current match position is updated via StateEffect in useEffect below,
    // NOT via dependency array. This prevents full extension rebuild on match navigation.
    if (searchQuery) {
      exts.push(createSearchHighlightExtension(
        searchQuery,
        searchCaseSensitive ?? false,
        searchUseRegex ?? false
      ));
    }

    // Track cursor position for search navigation (use refs to avoid rebuilds)
    if (onCursorActivityRef.current) {
      exts.push(createCursorActivityExtension(onCursorActivityRef));
    }

    return exts;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, enableInteractiveFeatures, onShiftEnter, onModEnter, onEscape, onSave, onFocus, onBlur, searchQuery, searchCaseSensitive, searchUseRegex, indentConfig, showLineNumbers]);

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
      onChange={onChange}
      extensions={extensions}
      placeholder={placeholder}
      readOnly={readOnly}
      basicSetup={false}
    />
  );
};
