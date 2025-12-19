/**
 * Indentation detection utility
 * Analyzes code content to detect indentation style (tabs vs spaces, indent size)
 */

export interface IndentationConfig {
  useTabs: boolean;
  tabSize: number;  // Visual width of a tab
  indentSize: number;  // Number of spaces (or 1 for tabs) per indent level
}

// Default to 4-space indentation (Python standard)
export const DEFAULT_INDENTATION: IndentationConfig = {
  useTabs: false,
  tabSize: 4,
  indentSize: 4,
};

/**
 * Detect indentation style from code content
 * Returns the most commonly used indentation pattern
 */
export function detectIndentationFromContent(content: string): IndentationConfig | null {
  const lines = content.split('\n');

  // Count leading whitespace patterns
  const indentCounts = {
    tabs: 0,
    spaces2: 0,
    spaces4: 0,
    spaces8: 0,
  };

  let linesWithIndent = 0;

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Get leading whitespace
    const match = line.match(/^(\s+)/);
    if (!match) continue;

    const whitespace = match[1];
    linesWithIndent++;

    // Check if it's tabs
    if (whitespace.includes('\t')) {
      indentCounts.tabs++;
      continue;
    }

    // Count spaces
    const spaceCount = whitespace.length;

    // Detect indent size by finding what divides evenly
    if (spaceCount % 2 === 0 && spaceCount % 4 !== 0) {
      indentCounts.spaces2++;
    } else if (spaceCount % 4 === 0) {
      // Could be 4-space or 8-space, need more context
      if (spaceCount === 4 || spaceCount === 12 || spaceCount === 20) {
        indentCounts.spaces4++;
      } else if (spaceCount % 8 === 0) {
        indentCounts.spaces8++;
      } else {
        indentCounts.spaces4++;
      }
    }
  }

  // Need at least some indented lines to make a decision
  if (linesWithIndent < 2) {
    return null;
  }

  // Determine winner
  const maxCount = Math.max(
    indentCounts.tabs,
    indentCounts.spaces2,
    indentCounts.spaces4,
    indentCounts.spaces8
  );

  if (maxCount === 0) {
    return null;
  }

  if (indentCounts.tabs === maxCount) {
    return { useTabs: true, tabSize: 4, indentSize: 1 };
  }
  if (indentCounts.spaces2 === maxCount) {
    return { useTabs: false, tabSize: 2, indentSize: 2 };
  }
  if (indentCounts.spaces8 === maxCount) {
    return { useTabs: false, tabSize: 8, indentSize: 8 };
  }
  // Default to 4 spaces
  return { useTabs: false, tabSize: 4, indentSize: 4 };
}

/**
 * Detect indentation from multiple code cells
 * Aggregates detection across all cells and returns the most common style
 */
export function detectIndentationFromCells(cells: Array<{ type: string; content: string }>): IndentationConfig {
  // Aggregate all code content
  const codeContent = cells
    .filter(cell => cell.type === 'code' && cell.content.trim())
    .map(cell => cell.content)
    .join('\n');

  if (!codeContent) {
    return DEFAULT_INDENTATION;
  }

  const detected = detectIndentationFromContent(codeContent);
  return detected || DEFAULT_INDENTATION;
}

/**
 * Generate the indent string based on config
 */
export function getIndentString(config: IndentationConfig): string {
  if (config.useTabs) {
    return '\t';
  }
  return ' '.repeat(config.indentSize);
}
