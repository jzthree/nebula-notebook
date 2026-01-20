/**
 * Cell Metadata Schema
 *
 * Defines which cell fields agents can modify and their types.
 * Must match lib/cellMetadata.ts on the frontend.
 *
 * Shared between:
 * - UI handler (useOperationHandler.ts)
 * - Headless handler (headless-handler.ts)
 * - Operation router validation
 */

export interface MetadataFieldSchema {
  type: 'string' | 'number' | 'boolean' | 'enum';
  values?: string[];
  agentMutable: boolean;
  default?: unknown;
  description?: string;
}

// Cell metadata schema - must match lib/cellMetadata.ts
export const CELL_METADATA_SCHEMA: Record<string, MetadataFieldSchema> = {
  id: {
    type: 'string',
    agentMutable: true,
    description: 'Unique cell identifier',
  },
  type: {
    type: 'enum',
    values: ['code', 'markdown'],
    agentMutable: true,
    description: 'Cell type: code for executable cells, markdown for documentation',
  },
  scrolled: {
    type: 'boolean',
    agentMutable: true,
    default: false,
    description: 'Whether cell output is collapsed (Jupyter standard)',
  },
  scrolledHeight: {
    type: 'number',
    agentMutable: true,
    description: 'Height in pixels when output is collapsed',
  },
};

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Validate a metadata value against the schema.
 */
export function validateMetadataValue(key: string, value: unknown): ValidationResult {
  const schema = CELL_METADATA_SCHEMA[key];

  if (!schema) {
    const allowed = Object.keys(CELL_METADATA_SCHEMA).join(', ');
    return { valid: false, error: `Unknown field "${key}". Allowed: ${allowed}` };
  }

  if (!schema.agentMutable) {
    return { valid: false, error: `Field "${key}" is not modifiable` };
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return { valid: false, error: `Field "${key}" must be a string` };
      }
      break;
    case 'number':
      if (typeof value !== 'number') {
        return { valid: false, error: `Field "${key}" must be a number` };
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean') {
        return { valid: false, error: `Field "${key}" must be a boolean` };
      }
      break;
    case 'enum':
      if (!schema.values?.includes(value as string)) {
        return { valid: false, error: `Field "${key}" must be one of: ${schema.values?.join(', ')}` };
      }
      break;
  }

  return { valid: true };
}
