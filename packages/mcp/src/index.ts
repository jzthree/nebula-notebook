/**
 * Nebula MCP tools and client library.
 *
 * This package is installable on the agent/client machine and talks to a
 * running Nebula Notebook server over HTTP/WebSocket.
 */

// =============================================================================
// Core Types
// =============================================================================
export * from './types.js';

// =============================================================================
// Error Handling
// =============================================================================
export {
  classifyError,
  getErrorMessage,
  formatErrorMessage,
  shouldRetry,
  calculateRetryDelay,
  ErrorCategory,
  type ClassifiedError,
  type RecoverabilityStatus,
} from './errors.js';

// =============================================================================
// Circuit Breaker
// =============================================================================
export {
  CircuitBreaker,
  createCircuitBreaker,
  CircuitState,
  type CircuitBreakerOptions,
  type CircuitBreakerEvent,
  type CircuitBreakerListener,
  type CircuitBreakerResult,
} from './circuit-breaker.js';

// =============================================================================
// Nebula Client
// =============================================================================
export {
  NebulaClient,
  createNebulaClient,
  type NebulaClientConfig,
  type KernelSession,
  type ExecutionResult,
  type WriteCellResult,
} from './notebook/client.js';

// =============================================================================
// Unified Tools (single source of truth)
// =============================================================================
export {
  // Tool types
  type Tool,
  type ToolDefinition,
  type ToolResult,
  type MCPContent,

  // Tool collections
  allTools,
  toolsByName,
  toolCategories,
  notebookTools,
  kernelTools,
  executionTools,

  // Tool utilities
  getToolDefinitions,
  executeToolByName,
  executeToolForMCP,
  getTool,
  hasTool,
  getToolNamesByCategory,

  // Individual notebook tools
  readNotebookTool,
  readCellTool,
  readOutputTool,
  insertCellTool,
  updateCellTool,
  deleteCellTool,
  createNotebookTool,
  moveCellTool,
  duplicateCellTool,
  searchCellsTool,
  updateMetadataTool,

  // Individual kernel tools
  listKernelsTool,
  kernelStartTool,
  kernelStopTool,
  kernelRestartTool,
  kernelInterruptTool,

  // Individual execution tools
  executeCellTool,
} from './tools/index.js';

// =============================================================================
// Legacy exports (for backwards compatibility)
// =============================================================================
export {
  readNotebookCells,
  writeNotebookCell,
  executeCell,
  searchNotebookCells,
  readCellsToolDefinition,
  writeCellToolDefinition,
  executeCellToolDefinition,
  searchCellsToolDefinition,
  type ReadCellsParams,
  type ReadCellsResult,
  type WriteCellParams,
  type ExecuteCellParams,
  type ExecuteCellResult,
  type SearchCellsParams,
  type SearchCellsResult,
} from './notebook/tools.js';
