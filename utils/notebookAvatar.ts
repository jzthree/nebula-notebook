/**
 * Notebook Avatar Generator
 * Creates unique, deterministic avatars for notebooks based on their names.
 */

// Cache for generated avatars (in-memory)
const avatarCache = new Map<string, string>();

/**
 * Simple hash function for strings
 */
function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

/**
 * Generate gradient colors based on hash - wide color variations
 * Returns [startColor, midColor, endColor]
 */
function hashToGradient(hash: number): [string, string, string] {
  // Wide hue shift for more dramatic color variety
  // Range: ±90 degrees allows gradients from warm (reds/oranges) to cool (teals/greens)
  const hueShift = (hash % 180) - 90; // -90 to +90 degree shift

  const baseHues = [270, 240, 210]; // purple, indigo, blue
  const hues = baseHues.map(h => (h + hueShift + 360) % 360);

  return [
    `hsl(${hues[0]}, 70%, 55%)`,
    `hsl(${hues[1]}, 65%, 55%)`,
    `hsl(${hues[2]}, 60%, 55%)`
  ];
}

/**
 * Generate star/accent color and position based on hash
 */
function hashToAccent(hash: number): { color: string; cx: number; cy: number } {
  // Accent colors: yellow, orange, pink, cyan
  const accentColors = ['#fbbf24', '#f97316', '#ec4899', '#06b6d4', '#10b981'];
  const color = accentColors[hash % accentColors.length];

  // Position in bottom-right quadrant area
  const positions = [
    { cx: 24, cy: 22 },
    { cx: 22, cy: 24 },
    { cx: 26, cy: 20 },
    { cx: 24, cy: 8 },
    { cx: 8, cy: 24 },
  ];
  const pos = positions[(hash >> 4) % positions.length];

  return { color, ...pos };
}

/**
 * Generate line pattern variation based on hash
 */
function hashToLines(hash: number): string[] {
  const patterns = [
    // Standard notebook lines (like favicon)
    ['M8 10h16', 'M8 16h12', 'M8 22h14'],
    // Shorter lines
    ['M8 10h14', 'M8 16h10', 'M8 22h12'],
    // Code-style indented
    ['M8 10h16', 'M10 16h12', 'M10 22h10'],
    // Two lines
    ['M8 12h14', 'M8 20h12'],
    // Centered
    ['M6 10h20', 'M8 16h16', 'M10 22h12'],
  ];
  return patterns[hash % patterns.length];
}

/**
 * Generate a deterministic SVG avatar for a notebook
 * Nebula-themed design with gradient, notebook lines, and accent star
 */
export function generateDeterministicAvatar(notebookName: string): string {
  const cacheKey = `det-${notebookName}`;

  // Check memory cache
  if (avatarCache.has(cacheKey)) {
    return avatarCache.get(cacheKey)!;
  }

  const hash = hashString(notebookName);
  const [color1, color2, color3] = hashToGradient(hash);
  const accent = hashToAccent(hash >> 8);
  const lines = hashToLines(hash >> 16);
  const gradientId = `nebula-${hash}`;

  // Build lines path
  const linesPath = lines.join(' ');

  // Nebula-style avatar with variations
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" style="stop-color:${color1}"/>
          <stop offset="50%" style="stop-color:${color2}"/>
          <stop offset="100%" style="stop-color:${color3}"/>
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="6" fill="url(#${gradientId})"/>
      <path d="${linesPath}" stroke="white" stroke-width="2.5" stroke-linecap="round" opacity="0.9"/>
      <circle cx="${accent.cx}" cy="${accent.cy}" r="3" fill="${accent.color}"/>
    </svg>
  `.trim();

  // Cache the result
  avatarCache.set(cacheKey, svg);

  return svg;
}

/**
 * Convert SVG string to data URL
 */
export function svgToDataUrl(svg: string): string {
  const encoded = encodeURIComponent(svg);
  return `data:image/svg+xml,${encoded}`;
}

/**
 * Update the page favicon
 */
export function updateFavicon(svgOrUrl: string): void {
  const favicon = document.getElementById('favicon') as HTMLLinkElement;
  if (favicon) {
    // Check if it's already a data URL or URL
    if (svgOrUrl.startsWith('data:') || svgOrUrl.startsWith('http') || svgOrUrl.startsWith('/')) {
      favicon.href = svgOrUrl;
    } else {
      // It's raw SVG, convert to data URL
      favicon.href = svgToDataUrl(svgOrUrl);
    }
  }
}

/**
 * Reset favicon to default
 */
export function resetFavicon(): void {
  updateFavicon('/favicon.svg');
}

/**
 * Get avatar for a notebook (deterministic generation)
 */
export function getNotebookAvatar(notebookName: string): string {
  const svg = generateDeterministicAvatar(notebookName);
  return svgToDataUrl(svg);
}

/**
 * Clear avatar cache
 */
export function clearAvatarCache(): void {
  avatarCache.clear();
}
