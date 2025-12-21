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
 * Find the greatest common divisor of two numbers
 */
function gcd(a: number, b: number): number {
  while (b !== 0) {
    const t = b;
    b = a % b;
    a = t;
  }
  return a;
}

/**
 * Detect indentation style from code content
 * Uses the GCD of all indentation levels to find the base indent size
 */
export function detectIndentationFromContent(content: string): IndentationConfig | null {
  const lines = content.split('\n');

  let hasTabs = false;
  let hasSpaces = false;
  const indentLevels: number[] = [];

  for (const line of lines) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Get leading whitespace
    const match = line.match(/^(\s+)/);
    if (!match) continue;

    const whitespace = match[1];

    // Check if it's tabs
    if (whitespace.includes('\t')) {
      hasTabs = true;
      continue;
    }

    hasSpaces = true;
    const spaceCount = whitespace.length;
    if (spaceCount > 0) {
      indentLevels.push(spaceCount);
    }
  }

  // If we have tabs, use tabs
  if (hasTabs && !hasSpaces) {
    return { useTabs: true, tabSize: 4, indentSize: 1 };
  }

  // Need at least some indented lines to detect space-based indentation
  if (indentLevels.length < 2) {
    return null;
  }

  // Find GCD of all indentation levels
  let indentGcd = indentLevels[0];
  for (let i = 1; i < indentLevels.length; i++) {
    indentGcd = gcd(indentGcd, indentLevels[i]);
    if (indentGcd === 1) break; // Can't get smaller
  }

  // Validate the detected indent size
  // Only accept 2, 4, or 8 as valid indent sizes
  // Default to 4 if we get something unusual
  if (indentGcd === 2) {
    return { useTabs: false, tabSize: 2, indentSize: 2 };
  }
  if (indentGcd === 4) {
    return { useTabs: false, tabSize: 4, indentSize: 4 };
  }
  if (indentGcd === 8) {
    // 8-space indent is unusual - only accept if we have strong evidence
    // (i.e., we see indentation at exactly 8, not 4)
    const hasSmallIndent = indentLevels.some(level => level < 8 && level > 0);
    if (hasSmallIndent) {
      // If there's any indent smaller than 8, use that as the base
      const smallIndents = indentLevels.filter(level => level < 8 && level > 0);
      const smallGcd = smallIndents.reduce((a, b) => gcd(a, b), smallIndents[0] || 4);
      if (smallGcd === 2) {
        return { useTabs: false, tabSize: 2, indentSize: 2 };
      }
      return { useTabs: false, tabSize: 4, indentSize: 4 };
    }
    return { useTabs: false, tabSize: 8, indentSize: 8 };
  }

  // Default to 4 spaces for any other case
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
