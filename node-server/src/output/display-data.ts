import { JsonValue, MimeBundle, OutputType } from '../fs/types';

export interface NormalizedDisplayOutput {
  type: OutputType;
  content: string;
  mimeBundle: MimeBundle;
  metadata?: Record<string, JsonValue>;
  preferredMimeType: string;
}

const PREFERRED_MIME_TYPES = [
  'application/vnd.nebula.web+json',
  // Widget views must win over plotly/html when both are present
  'application/vnd.jupyter.widget-view+json',
  'application/vnd.plotly.v1+json',
  'text/html',
  'image/png',
  'text/plain',
] as const;

export function stripAutoplayFromHtml(html: string): string {
  if (!html.includes('autoplay')) return html;
  return html.replace(/(<(?:audio|video)\b[^>]*?)\s+autoplay(?:=["'][^"']*["'])?/gi, '$1');
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  // Assume deeply-nested structures are valid rather than risk a stack overflow.
  // Plotly figures can nest 10+ levels deep in their default templates.
  if (depth > 64) {
    return typeof value === 'object';
  }

  if (Array.isArray(value)) {
    return value.every((v) => isJsonValue(v, depth + 1));
  }

  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every((v) => isJsonValue(v, depth + 1));
  }

  return false;
}

export function normalizeMimeValue(mimeType: string, value: unknown): JsonValue | null {
  let normalized: unknown = value;

  if (Array.isArray(normalized) && normalized.every((item) => typeof item === 'string')) {
    normalized = normalized.join('');
  }

  if (mimeType === 'text/html' && typeof normalized === 'string') {
    normalized = stripAutoplayFromHtml(normalized);
  }

  // JSON-based MIME types (plotly, nebula-web, etc.) arrive from JSON.parse
  // and are inherently valid JSON values. Skip the expensive recursive check
  // which can stack-overflow on deeply-nested Plotly templates.
  if (mimeType.endsWith('+json') && typeof normalized === 'object' && normalized !== null) {
    return normalized as JsonValue;
  }

  return isJsonValue(normalized) ? normalized : null;
}

export function normalizeMimeBundle(data: Record<string, unknown>): MimeBundle {
  const bundle: MimeBundle = {};

  for (const [mimeType, value] of Object.entries(data)) {
    const normalized = normalizeMimeValue(mimeType, value);
    if (normalized !== null) {
      bundle[mimeType] = normalized;
    } else if (value !== undefined) {
      console.warn(
        `[display-data] Dropped MIME type "${mimeType}": normalizeMimeValue returned null (value type: ${typeof value}, isArray: ${Array.isArray(value)})`,
      );
    }
  }

  return bundle;
}

export function pickPreferredMimeType(bundle: MimeBundle): string | null {
  for (const mimeType of PREFERRED_MIME_TYPES) {
    if (mimeType in bundle) return mimeType;
  }

  const [firstMimeType] = Object.keys(bundle);
  return firstMimeType ?? null;
}

function stringifyMimeValue(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

function classifyOutputType(bundle: MimeBundle, preferredMimeType: string): OutputType {
  const mimeTypes = Object.keys(bundle);

  if (
    preferredMimeType === 'image/png' &&
    mimeTypes.every((mimeType) => mimeType === 'image/png' || mimeType === 'text/plain')
  ) {
    return 'image';
  }

  if (
    preferredMimeType === 'text/html' &&
    mimeTypes.every((mimeType) => mimeType === 'text/html' || mimeType === 'text/plain')
  ) {
    return 'html';
  }

  if (preferredMimeType === 'text/plain' && mimeTypes.length === 1) {
    return 'stdout';
  }

  return 'display_data';
}

function getDisplayContent(bundle: MimeBundle, preferredMimeType: string, outputType: OutputType): string {
  // For image and html types the content field IS the rendered data (base64 / markup),
  // so we must return the preferred MIME value, not the text/plain fallback.
  // For display_data / stdout the text/plain fallback is more useful (shown as error
  // fallback text in plotly/nebula-web renderers).
  if (outputType === 'image' || outputType === 'html') {
    const preferredValue = bundle[preferredMimeType];
    return preferredValue === undefined ? '' : stringifyMimeValue(preferredValue);
  }

  const fallbackText = bundle['text/plain'];
  if (preferredMimeType !== 'text/plain' && fallbackText !== undefined) {
    return stringifyMimeValue(fallbackText);
  }

  const preferredValue = bundle[preferredMimeType];
  return preferredValue === undefined ? '' : stringifyMimeValue(preferredValue);
}

export function buildDisplayOutput(
  data: Record<string, unknown>,
  metadata?: Record<string, unknown>,
): NormalizedDisplayOutput | null {
  const mimeBundle = normalizeMimeBundle(data);
  const preferredMimeType = pickPreferredMimeType(mimeBundle);

  if (!preferredMimeType) {
    return null;
  }

  const normalizedMetadata = metadata && isJsonValue(metadata)
    ? (metadata as Record<string, JsonValue>)
    : undefined;

  const type = classifyOutputType(mimeBundle, preferredMimeType);

  return {
    type,
    content: getDisplayContent(mimeBundle, preferredMimeType, type),
    mimeBundle,
    metadata: normalizedMetadata,
    preferredMimeType,
  };
}

export function convertMimeBundleToJupyter(bundle: MimeBundle): Record<string, JsonValue> {
  return { ...bundle };
}
