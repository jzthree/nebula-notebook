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
 * Generate a deterministic SVG avatar for a notebook
 * Simple geometric design with large letters for small icon visibility
 */
export function generateDeterministicAvatar(notebookName: string): string {
  const cacheKey = `det-${notebookName}`;

  // Check memory cache
  if (avatarCache.has(cacheKey)) {
    return avatarCache.get(cacheKey)!;
  }

  const hash = hashString(notebookName);
  const primaryColor = hashToColor(hash, 65, 50); // Slightly more saturated, darker for contrast
  const initials = getInitials(notebookName);

  // Simple solid background with maximum size letters
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
      <rect width="32" height="32" rx="6" fill="${primaryColor}"/>
      <text x="16" y="22" text-anchor="middle" fill="white" font-family="system-ui, -apple-system, sans-serif" font-size="15" font-weight="700" letter-spacing="-0.5">
        ${initials}
      </text>
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
