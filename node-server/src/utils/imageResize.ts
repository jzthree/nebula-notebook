/**
 * Image Resize Utility
 *
 * Resizes base64 PNG images to fit within Claude API limits.
 * Claude's multi-image requests require each image to be ≤2000 pixels in any dimension.
 */

import sharp from 'sharp';

const MAX_DIMENSION = 2000;

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
  maxDimension: number = MAX_DIMENSION
): Promise<string> {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const image = sharp(buffer);
    const metadata = await image.metadata();

    const { width, height } = metadata;
    if (!width || !height) {
      return base64Data; // Can't determine size, return original
    }

    // Check if resize is needed
    if (width <= maxDimension && height <= maxDimension) {
      return base64Data; // Already within limits
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

    return resizedBuffer.toString('base64');
  } catch (error) {
    // If resizing fails, return original
    console.warn('[ImageResize] Failed to resize image:', error);
    return base64Data;
  }
}

/**
 * Check if an image needs resizing without actually resizing it.
 */
export async function needsResize(
  base64Data: string,
  maxDimension: number = MAX_DIMENSION
): Promise<boolean> {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const metadata = await sharp(buffer).metadata();

    const { width, height } = metadata;
    if (!width || !height) {
      return false;
    }

    return width > maxDimension || height > maxDimension;
  } catch {
    return false;
  }
}
