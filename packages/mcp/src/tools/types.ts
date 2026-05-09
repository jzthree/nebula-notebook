/**
 * Unified Tool Types
 *
 * Single source of truth for tool definitions.
 * MCP server wraps these with protocol-specific formatting.
 */

import type { NebulaClient } from '../notebook/client.js';

/**
 * Property schema for tool parameters
 */
export interface PropertySchema {
  type: string;
  description?: string;
  enum?: string[];
  default?: unknown;
  items?: { type: string };
}

/**
 * Tool definition schema (MCP-compatible)
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
  annotations?: {
    /** Tool only reads data, doesn't modify */
    readOnlyHint?: boolean;
    /** Tool modifies or deletes data */
    destructiveHint?: boolean;
  };
}

/**
 * Tool execution result
 */
export interface ToolResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
}

/**
 * MCP-formatted content for display
 */
export type MCPContent = Array<
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
>;

/**
 * Tool with definition and executor
 */
export interface Tool<TParams = Record<string, unknown>, TResult = unknown> {
  definition: ToolDefinition;
  execute: (params: TParams, client: NebulaClient) => Promise<ToolResult<TResult>>;
  /**
   * Optional: Format result for MCP display.
   * If not provided, default JSON formatting is used.
   * Can be async for image resizing operations.
   */
  formatForMCP?: (result: ToolResult<TResult>) => MCPContent | Promise<MCPContent>;
}

/**
 * Type helper to extract params type from a Tool
 */
export type ToolParams<T> = T extends Tool<infer P, unknown> ? P : never;

/**
 * Type helper to extract result type from a Tool
 */
export type ToolResultType<T> = T extends Tool<unknown, infer R> ? R : never;
