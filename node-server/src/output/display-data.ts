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
  'application/vnd.plotly.v1+json',
  'text/html',
  'image/png',
  'text/plain',
] as const;

export function stripAutoplayFromHtml(html: string): string {
  if (!html.includes('autoplay')) return html;
  return html.replace(/(<(?:audio|video)\b[^>]*?)\s+autoplay(?:=["'][^"']*["'])?/gi, '$1');
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return true;
  }

  if (Array.isArray(value)) {
    return value.every(isJsonValue);
  }

  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).every(isJsonValue);
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

  return isJsonValue(normalized) ? normalized : null;
}

export function normalizeMimeBundle(data: Record<string, unknown>): MimeBundle {
  const bundle: MimeBundle = {};

  for (const [mimeType, value] of Object.entries(data)) {
    const normalized = normalizeMimeValue(mimeType, value);
    if (normalized !== null) {
      bundle[mimeType] = normalized;
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

function getDisplayContent(bundle: MimeBundle, preferredMimeType: string): string {
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

  return {
    type: classifyOutputType(mimeBundle, preferredMimeType),
    content: getDisplayContent(mimeBundle, preferredMimeType),
    mimeBundle,
    metadata: normalizedMetadata,
    preferredMimeType,
  };
}

export function convertMimeBundleToJupyter(bundle: MimeBundle): Record<string, JsonValue> {
  return { ...bundle };
}
