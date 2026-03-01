import { Cell } from '../types';

// Estimate cell height based on content (for cells not yet measured)
// This prevents scroll jumps when scrolling up to tall cells
export function estimateCellHeight(cell: Cell): number {
  // Base height: toolbar (40px) + padding (24px) + minimum content (40px)
  let height = 104;

  // Estimate code editor height: ~20px per line, min 40px
  const lines = cell.content.split('\n').length;
  height += Math.max(40, lines * 20);

  // Estimate output height if present
  if (cell.outputs && cell.outputs.length > 0) {
    for (const output of cell.outputs) {
      if (output.type === 'image') {
        // Images are typically ~300px
        height += 300;
      } else if (output.type === 'html') {
        // Embedded HTML outputs tend to be medium/tall even with little source text.
        height += 240;
      } else if (output.content) {
        // Text output: ~16px per line
        const outputLines = output.content.split('\n').length;
        // If cell is in scroll mode, cap at the scrolled height
        if (cell.scrolled) {
          height += Math.min(outputLines * 20, cell.scrolledHeight || 200);
        } else {
          // Long tracebacks are much taller than regular stdout/stderr.
          // A higher cap reduces underestimation-driven jumps while keeping
          // defaults bounded for extremely large outputs.
          const maxTextHeight =
            output.type === 'error' ? 2400 :
            output.type === 'stderr' ? 1800 :
            1200;
          height += Math.min(outputLines * 20, maxTextHeight);
        }
      }
    }
  }

  return height;
}

export function computeDefaultCellHeight(cells: Cell[], cache: Map<string, number>): number {
  if (cells.length === 0) return 150;

  let totalHeight = 0;
  let count = 0;

  for (const cell of cells) {
    const cached = cache.get(cell.id);
    if (cached) {
      totalHeight += cached;
    } else {
      totalHeight += estimateCellHeight(cell);
    }
    count++;
  }

  // Return average, with a minimum of 200 to avoid underestimating
  return Math.max(200, Math.round(totalHeight / count));
}
