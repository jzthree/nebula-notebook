import React, { useMemo } from 'react';

/**
 * Lightweight Python syntax highlighter
 * Uses regex tokenization - fast and virtualization-friendly
 */

interface Token {
  type: 'keyword' | 'builtin' | 'string' | 'comment' | 'number' | 'operator' | 'decorator' | 'text';
  value: string;
}

const KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue',
  'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from',
  'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not',
  'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
  'True', 'False', 'None'
]);

const BUILTINS = new Set([
  'print', 'len', 'range', 'str', 'int', 'float', 'list', 'dict', 'set',
  'tuple', 'bool', 'type', 'isinstance', 'hasattr', 'getattr', 'setattr',
  'open', 'input', 'abs', 'all', 'any', 'bin', 'chr', 'dir', 'divmod',
  'enumerate', 'eval', 'exec', 'filter', 'format', 'frozenset', 'globals',
  'hash', 'help', 'hex', 'id', 'iter', 'locals', 'map', 'max', 'min',
  'next', 'object', 'oct', 'ord', 'pow', 'repr', 'reversed', 'round',
  'slice', 'sorted', 'sum', 'super', 'vars', 'zip', '__import__',
  'Exception', 'ValueError', 'TypeError', 'KeyError', 'IndexError',
  'AttributeError', 'ImportError', 'RuntimeError', 'StopIteration'
]);

// Tokenize Python code - simple regex-based approach
function tokenize(code: string): Token[] {
  const tokens: Token[] = [];
  let remaining = code;

  while (remaining.length > 0) {
    let matched = false;

    // Triple-quoted strings (must come before single quotes)
    const tripleMatch = remaining.match(/^('''[\s\S]*?'''|"""[\s\S]*?""")/);
    if (tripleMatch) {
      tokens.push({ type: 'string', value: tripleMatch[0] });
      remaining = remaining.slice(tripleMatch[0].length);
      matched = true;
      continue;
    }

    // Single/double quoted strings
    const stringMatch = remaining.match(/^('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/);
    if (stringMatch) {
      tokens.push({ type: 'string', value: stringMatch[0] });
      remaining = remaining.slice(stringMatch[0].length);
      matched = true;
      continue;
    }

    // Comments
    const commentMatch = remaining.match(/^#.*/);
    if (commentMatch) {
      tokens.push({ type: 'comment', value: commentMatch[0] });
      remaining = remaining.slice(commentMatch[0].length);
      matched = true;
      continue;
    }

    // Decorators
    const decoratorMatch = remaining.match(/^@\w+/);
    if (decoratorMatch) {
      tokens.push({ type: 'decorator', value: decoratorMatch[0] });
      remaining = remaining.slice(decoratorMatch[0].length);
      matched = true;
      continue;
    }

    // Numbers (including floats and scientific notation)
    const numberMatch = remaining.match(/^-?\d+\.?\d*(?:[eE][+-]?\d+)?/);
    if (numberMatch) {
      tokens.push({ type: 'number', value: numberMatch[0] });
      remaining = remaining.slice(numberMatch[0].length);
      matched = true;
      continue;
    }

    // Words (identifiers, keywords, builtins)
    const wordMatch = remaining.match(/^[a-zA-Z_]\w*/);
    if (wordMatch) {
      const word = wordMatch[0];
      let type: Token['type'] = 'text';
      if (KEYWORDS.has(word)) {
        type = 'keyword';
      } else if (BUILTINS.has(word)) {
        type = 'builtin';
      }
      tokens.push({ type, value: word });
      remaining = remaining.slice(word.length);
      matched = true;
      continue;
    }

    // Operators
    const operatorMatch = remaining.match(/^[+\-*/%=<>!&|^~:]+/);
    if (operatorMatch) {
      tokens.push({ type: 'operator', value: operatorMatch[0] });
      remaining = remaining.slice(operatorMatch[0].length);
      matched = true;
      continue;
    }

    // Any other character (whitespace, punctuation, etc.)
    if (!matched) {
      tokens.push({ type: 'text', value: remaining[0] });
      remaining = remaining.slice(1);
    }
  }

  return tokens;
}

const TOKEN_STYLES: Record<Token['type'], string> = {
  keyword: 'text-purple-600 font-medium',
  builtin: 'text-blue-600',
  string: 'text-green-600',
  comment: 'text-slate-400 italic',
  number: 'text-orange-500',
  operator: 'text-slate-600',
  decorator: 'text-amber-600',
  text: 'text-slate-800'
};

interface Props {
  code: string;
  className?: string;
}

export const PythonHighlighter: React.FC<Props> = ({ code, className = '' }) => {
  const tokens = useMemo(() => tokenize(code), [code]);

  return (
    <pre className={`font-mono text-sm leading-6 whitespace-pre-wrap break-words ${className}`}>
      {tokens.map((token, i) => (
        <span key={i} className={TOKEN_STYLES[token.type]}>
          {token.value}
        </span>
      ))}
    </pre>
  );
};
