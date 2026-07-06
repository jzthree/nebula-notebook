/**
 * Image Resize Utility
 *
 * Resizes base64 PNG images to fit within Claude API limits.
 * Claude's multi-image requests require each image to be ≤2000 pixels in any dimension.
 */

// sharp is a native module and OPTIONAL: it is only needed to downscale
// oversized image outputs. Loading it lazily keeps the `nebula` CLI (which
// shares this code) runnable from a bare checkout with no node_modules —
// images are then passed through at original size instead of failing.
type SharpModule = typeof import('sharp');
let sharpPromise: Promise<SharpModule | null> | null = null;

function loadSharp(): Promise<SharpModule | null> {
  if (!sharpPromise) {
    sharpPromise = import('sharp')
      .then((mod) => (mod.default ?? mod) as unknown as SharpModule)
      .catch(() => {
        console.error('[ImageResize] sharp not available — images passed through without resizing');
        return null;
      });
  }
  return sharpPromise;
}

const DEFAULT_MAX_DIMENSION = 2000;

/**
 * Resize a base64 PNG image if it exceeds the maximum dimension.
 * Returns the original if already within limits or if resizing fails.
 *
 * @param base64Data - Base64 encoded PNG data (without data URL prefix)
 * @param maxDimension - Maximum allowed dimension (default: 2000)
 * @returns Resized base64 PNG data
 */
export async function resizeImageIfNeeded(
  base64Data: string,
  maxDimension: number = DEFAULT_MAX_DIMENSION
): Promise<string> {
  try {
    const sharp = await loadSharp();
    if (!sharp) return base64Data.trim();
    const buffer = Buffer.from(base64Data, 'base64');
    const image = sharp(buffer);
    const metadata = await image.metadata();

    const { width, height } = metadata;
    if (!width || !height) {
      return base64Data; // Can't determine size, return original
    }

    // Check if resize is needed
    if (width <= maxDimension && height <= maxDimension) {
      return base64Data.trim(); // Already within limits, but trim any whitespace
    }

    // Calculate new dimensions maintaining aspect ratio
    const scale = Math.min(maxDimension / width, maxDimension / height);
    const newWidth = Math.round(width * scale);
    const newHeight = Math.round(height * scale);

    // Resize and convert back to base64
    const resizedBuffer = await image
      .resize(newWidth, newHeight, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();

    return resizedBuffer.toString('base64').trim();
  } catch (error) {
    // If resizing fails, return original (trimmed)
    console.error('[ImageResize] Failed to resize image:', error);
    return base64Data.trim();
  }
}

/**
 * Check image dimensions without resizing.
 * Returns null if dimensions can't be determined.
 */
export async function getImageDimensions(
  base64Data: string
): Promise<{ width: number; height: number } | null> {
  try {
    const sharp = await loadSharp();
    if (!sharp) return null;
    const buffer = Buffer.from(base64Data, 'base64');
    const metadata = await sharp(buffer).metadata();
    if (metadata.width && metadata.height) {
      return { width: metadata.width, height: metadata.height };
    }
    return null;
  } catch {
    return null;
  }
}
