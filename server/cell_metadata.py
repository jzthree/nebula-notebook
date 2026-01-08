"""
Cell Metadata Schema

Defines which cell fields agents can modify and their types.
Must match lib/cellMetadata.ts on the frontend.

Shared between:
- UI handler (useOperationHandler.ts)
- Headless handler (headless_handler.py)
- Operation router validation
"""

from typing import Dict, Any


# Cell metadata schema - must match lib/cellMetadata.ts
CELL_METADATA_SCHEMA = {
    'id': {'type': 'string', 'agent_mutable': True},
    'type': {'type': 'enum', 'values': ['code', 'markdown'], 'agent_mutable': True},
    'scrolled': {'type': 'boolean', 'agent_mutable': True, 'default': False},
    'scrolledHeight': {'type': 'number', 'agent_mutable': True},
}


def validate_metadata_value(key: str, value: Any) -> Dict[str, Any]:
    """Validate a metadata value against the schema. Returns {valid: bool, error?: str}"""
    schema = CELL_METADATA_SCHEMA.get(key)

    if schema is None:
        allowed = ', '.join(CELL_METADATA_SCHEMA.keys())
        return {'valid': False, 'error': f'Unknown field "{key}". Allowed: {allowed}'}

    if not schema.get('agent_mutable', False):
        return {'valid': False, 'error': f'Field "{key}" is not modifiable'}

    field_type = schema.get('type')
    if field_type == 'string':
        if not isinstance(value, str):
            return {'valid': False, 'error': f'Field "{key}" must be a string'}
    elif field_type == 'number':
        if not isinstance(value, (int, float)):
            return {'valid': False, 'error': f'Field "{key}" must be a number'}
    elif field_type == 'boolean':
        if not isinstance(value, bool):
            return {'valid': False, 'error': f'Field "{key}" must be a boolean'}
    elif field_type == 'enum':
        if value not in schema.get('values', []):
            return {'valid': False, 'error': f'Field "{key}" must be one of: {", ".join(schema["values"])}'}

    return {'valid': True}
