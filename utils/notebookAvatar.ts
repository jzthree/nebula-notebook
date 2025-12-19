/**
 * Notebook Avatar Generator
 * Creates unique, deterministic avatars for notebooks based on their names.
 * Optionally supports AI-generated icons (with caching to minimize API usage).
 */

// Cache for generated avatars (in-memory and localStorage)
const avatarCache = new Map<string, string>();
const CACHE_KEY_PREFIX = 'nebula-avatar-';
const AI_CACHE_KEY_PREFIX = 'nebula-ai-avatar-';

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
 * Generate HSL color from hash
 */
function hashToColor(hash: number, saturation = 70, lightness = 60): string {
  const hue = hash % 360;
  return `hsl(${hue}, ${saturation}%, ${lightness}%)`;
}

/**
 * Get initials from notebook name
 */
function getInitials(name: string): string {
  // Remove extension and path
  const baseName = name.replace(/\.ipynb$/, '').split('/').pop() || 'N';

  // Get initials from words (max 2)
  const words = baseName.split(/[-_\s]+/).filter(w => w.length > 0);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  // Use first 2 chars if single word
  return baseName.substring(0, 2).toUpperCase();
}


/**
 * Generate gradient colors based on hash - variations on the nebula theme
 * Returns [startColor, midColor, endColor]
 */
function hashToGradient(hash: number): [string, string, string] {
  // Base hues in the purple-blue spectrum (240-280 range)
  // Shift based on hash to create variation while staying in nebula palette
  const hueShift = (hash % 60) - 30; // -30 to +30 degree shift

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
 * Get cached AI-generated avatar if exists
 */
export function getCachedAIAvatar(notebookName: string): string | null {
  const cacheKey = AI_CACHE_KEY_PREFIX + hashString(notebookName);
  try {
    return localStorage.getItem(cacheKey);
  } catch {
    return null;
  }
}

/**
 * Save AI-generated avatar to cache
 */
export function cacheAIAvatar(notebookName: string, dataUrl: string): void {
  const cacheKey = AI_CACHE_KEY_PREFIX + hashString(notebookName);
  try {
    localStorage.setItem(cacheKey, dataUrl);
  } catch {
    // localStorage might be full, ignore
  }
}

/**
 * Generate AI avatar using the configured LLM provider (if supported)
 * Returns null if AI generation is not available or fails
 */
export async function generateAIAvatar(
  notebookName: string,
  generateFn: (prompt: string) => Promise<string | null>
): Promise<string | null> {
  // Check cache first
  const cached = getCachedAIAvatar(notebookName);
  if (cached) {
    return cached;
  }

  // Extract meaningful name from path
  const baseName = notebookName.replace(/\.ipynb$/, '').split('/').pop() || 'notebook';

  // Create a prompt for icon description (not actual image generation)
  // This is a placeholder - actual implementation would depend on having
  // an image generation API (like DALL-E via OpenAI)
  const prompt = `Create a simple, minimalist 32x32 pixel icon for a notebook called "${baseName}".
  The icon should be abstract, colorful, and distinctive. Return only valid SVG code.`;

  try {
    const result = await generateFn(prompt);
    if (result && result.includes('<svg')) {
      // Extract SVG from response
      const svgMatch = result.match(/<svg[^>]*>[\s\S]*<\/svg>/i);
      if (svgMatch) {
        const dataUrl = svgToDataUrl(svgMatch[0]);
        cacheAIAvatar(notebookName, dataUrl);
        return dataUrl;
      }
    }
  } catch (error) {
    console.warn('AI avatar generation failed:', error);
  }

  return null;
}

/**
 * Main function to get avatar for a notebook
 * Uses AI if enabled and available, otherwise falls back to deterministic generation
 */
export async function getNotebookAvatar(
  notebookName: string,
  options: {
    useAI?: boolean;
    aiGenerateFn?: (prompt: string) => Promise<string | null>;
  } = {}
): Promise<string> {
  const { useAI = false, aiGenerateFn } = options;

  // Try AI generation if enabled and function provided
  if (useAI && aiGenerateFn) {
    // Check cache first to avoid API calls
    const cached = getCachedAIAvatar(notebookName);
    if (cached) {
      return cached;
    }

    // Try AI generation (non-blocking, will fall back to deterministic)
    const aiAvatar = await generateAIAvatar(notebookName, aiGenerateFn);
    if (aiAvatar) {
      return aiAvatar;
    }
  }

  // Fall back to deterministic generation
  const svg = generateDeterministicAvatar(notebookName);
  return svgToDataUrl(svg);
}

/**
 * Clear all cached avatars
 */
export function clearAvatarCache(): void {
  avatarCache.clear();

  // Clear localStorage cache
  try {
    const keys = Object.keys(localStorage);
    keys.forEach(key => {
      if (key.startsWith(AI_CACHE_KEY_PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  } catch {
    // Ignore errors
  }
}
