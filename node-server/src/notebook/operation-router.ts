/**
 * Notebook Operation Router
 *
 * Routes notebook operations to either:
 * 1. Connected UI via WebSocket (real-time collaboration)
 * 2. Headless notebook manager (file-based when no UI)
 *
 * From the agent's (MCP) perspective, operations look identical regardless of mode.
 */

import * as path from 'path';
import { WebSocket } from 'ws';
import { HeadlessOperationHandler } from './headless-handler';

interface PendingRequest {
  resolve: (value: OperationResult) => void;
  reject: (error: Error) => void;
  timeoutId: NodeJS.Timeout;
}

interface UIConnection {
  websocket: WebSocket;
  notebookPath: string;
  pendingRequests: Map<string, PendingRequest>;
}

interface OperationResult {
  success: boolean;
  error?: string;
  [key: string]: unknown;
}

interface AgentLock {
  agentId: string;        // Unique identifier for locking (sessionId)
  clientName?: string;    // Display name (e.g., "claude-code", "cursor")
  clientVersion?: string; // Client version
  expiresAt: number;
  notebookPath: string;
  lockedAt: number;       // When lock was first acquired
}

const AGENT_LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class OperationRouter {
  private uiConnections: Map<string, UIConnection> = new Map();
  private headlessHandler: HeadlessOperationHandler | null = null;
  private operationTimeout = 30000; // 30 seconds
  private agentLocks: Map<string, AgentLock> = new Map(); // path -> lock

  setHeadlessHandler(handler: HeadlessOperationHandler): void {
    this.headlessHandler = handler;
  }

  /**
   * Register a UI connection for a notebook path.
   */
  async registerUI(websocket: WebSocket, notebookPath: string): Promise<void> {
    const normalizedPath = path.resolve(notebookPath);

    // Close existing connection if any
    if (this.uiConnections.has(normalizedPath)) {
      const oldConn = this.uiConnections.get(normalizedPath)!;
      for (const [, request] of oldConn.pendingRequests) {
        clearTimeout(request.timeoutId);
        request.reject(new Error('Connection replaced'));
      }
    }

    this.uiConnections.set(normalizedPath, {
      websocket,
      notebookPath: normalizedPath,
      pendingRequests: new Map(),
    });

    console.log(`[OperationRouter] UI registered for: ${normalizedPath}`);
  }

  /**
   * Unregister a UI connection.
   */
  unregisterUI(notebookPath: string): void {
    const normalizedPath = path.resolve(notebookPath);

    if (this.uiConnections.has(normalizedPath)) {
      const conn = this.uiConnections.get(normalizedPath)!;
      for (const [, request] of conn.pendingRequests) {
        clearTimeout(request.timeoutId);
        request.reject(new Error('UI disconnected'));
      }
      this.uiConnections.delete(normalizedPath);
      console.log(`[OperationRouter] UI unregistered for: ${normalizedPath}`);
    }
  }

  /**
   * Check if a UI is connected for the notebook.
   */
  hasUI(notebookPath: string): boolean {
    const normalizedPath = path.resolve(notebookPath);
    return this.uiConnections.has(normalizedPath);
  }

  /**
   * Start an agent session with locking.
   * Returns success if lock acquired, error if already locked by another agent.
   */
  startAgentSession(
    notebookPath: string,
    agentId: string,
    metadata?: { clientName?: string; clientVersion?: string }
  ): { success: boolean; error?: string; lock?: AgentLock } {
    const normalizedPath = path.resolve(notebookPath);

    // Clean up expired locks first
    this.cleanupExpiredLocks();

    const existingLock = this.agentLocks.get(normalizedPath);
    if (existingLock) {
      if (existingLock.agentId === agentId) {
        // Same agent re-acquiring lock - refresh timeout
        existingLock.expiresAt = Date.now() + AGENT_LOCK_TIMEOUT_MS;
        console.log(`[OperationRouter] Agent session refreshed for: ${normalizedPath} (agent: ${agentId})`);
        return { success: true, lock: existingLock };
      } else {
        // Different agent has the lock
        const lockedBy = existingLock.clientName || existingLock.agentId;
        console.log(`[OperationRouter] Agent session BLOCKED for: ${normalizedPath} (requested by: ${agentId}, held by: ${lockedBy})`);
        return {
          success: false,
          error: `Notebook is locked by ${lockedBy}. Lock expires in ${Math.ceil((existingLock.expiresAt - Date.now()) / 1000)}s.`,
          lock: existingLock,
        };
      }
    }

    // Acquire new lock
    const now = Date.now();
    const newLock: AgentLock = {
      agentId,
      clientName: metadata?.clientName,
      clientVersion: metadata?.clientVersion,
      expiresAt: now + AGENT_LOCK_TIMEOUT_MS,
      notebookPath: normalizedPath,
      lockedAt: now,
    };
    this.agentLocks.set(normalizedPath, newLock);
    console.log(`[OperationRouter] Agent session started for: ${normalizedPath} (agent: ${agentId}, client: ${metadata?.clientName || 'unknown'})`);
    return { success: true, lock: newLock };
  }

  /**
   * End an agent session and release the lock.
   * Only the lock holder can release the lock.
   */
  endAgentSession(notebookPath: string, agentId: string): { success: boolean; error?: string } {
    const normalizedPath = path.resolve(notebookPath);

    const existingLock = this.agentLocks.get(normalizedPath);
    if (!existingLock) {
      // No lock exists - that's fine
      return { success: true };
    }

    if (existingLock.agentId !== agentId) {
      console.log(`[OperationRouter] Agent session end REJECTED for: ${normalizedPath} (requested by: ${agentId}, held by: ${existingLock.agentId})`);
      return {
        success: false,
        error: 'Cannot release lock held by another agent'
      };
    }

    this.agentLocks.delete(normalizedPath);
    console.log(`[OperationRouter] Agent session ended for: ${normalizedPath} (agent: ${agentId})`);
    return { success: true };
  }

  /**
   * Check if a notebook is in an agent session.
   */
  isAgentSession(notebookPath: string): boolean {
    const normalizedPath = path.resolve(notebookPath);
    const lock = this.agentLocks.get(normalizedPath);
    return lock !== undefined && lock.expiresAt > Date.now();
  }

  /**
   * Get the agent ID holding the lock, if any.
   */
  getAgentLock(notebookPath: string): AgentLock | null {
    const normalizedPath = path.resolve(notebookPath);
    const lock = this.agentLocks.get(normalizedPath);
    if (lock && lock.expiresAt > Date.now()) {
      return lock;
    }
    return null;
  }

  /**
   * Refresh lock timeout for an agent operation.
   */
  refreshAgentLock(notebookPath: string, agentId: string): boolean {
    const normalizedPath = path.resolve(notebookPath);
    const lock = this.agentLocks.get(normalizedPath);
    if (lock && lock.agentId === agentId) {
      lock.expiresAt = Date.now() + AGENT_LOCK_TIMEOUT_MS;
      return true;
    }
    return false;
  }

  /**
   * Clean up expired locks.
   */
  private cleanupExpiredLocks(): void {
    const now = Date.now();
    for (const [path, lock] of this.agentLocks) {
      if (lock.expiresAt <= now) {
        console.log(`[OperationRouter] Agent lock expired for: ${path} (agent: ${lock.agentId})`);
        this.agentLocks.delete(path);
      }
    }
  }

  /**
   * Apply a notebook operation.
   */
  async applyOperation(operation: Record<string, unknown>): Promise<OperationResult> {
    const notebookPath = (operation.notebookPath as string) || '';
    const normalizedPath = path.resolve(notebookPath);
    const opType = operation.type as string;
    const agentId = operation.agentId as string | undefined;

    // Clean up expired locks
    this.cleanupExpiredLocks();

    const lock = this.agentLocks.get(normalizedPath);
    const isLocked = lock !== undefined && lock.expiresAt > Date.now();

    console.log(`[OperationRouter] applyOperation:`);
    console.log(`  op_type: ${opType}`);
    console.log(`  notebook_path: ${notebookPath}`);
    console.log(`  normalized_path: ${normalizedPath}`);
    console.log(`  registered_uis: ${Array.from(this.uiConnections.keys())}`);
    console.log(`  has_ui: ${this.uiConnections.has(normalizedPath)}`);
    console.log(`  is_locked: ${isLocked}${lock ? ` (by: ${lock.agentId})` : ''}`);
    console.log(`  request_agent_id: ${agentId || '(none)'}`);

    // Check if another agent holds the lock (for write operations)
    const readOnlyOps = new Set(['readCell', 'readCellOutput', 'searchCells', 'readNotebook']);
    if (isLocked && lock && lock.agentId !== agentId && !readOnlyOps.has(opType)) {
      console.log(`  -> BLOCKED: Operation blocked by agent lock`);
      return {
        success: false,
        error: `Notebook is locked by another agent (${lock.agentId}). Lock expires in ${Math.ceil((lock.expiresAt - Date.now()) / 1000)}s.`,
      };
    }

    // Refresh lock timeout if this agent holds it
    if (lock && agentId && lock.agentId === agentId) {
      lock.expiresAt = Date.now() + AGENT_LOCK_TIMEOUT_MS;
    }

    if (this.uiConnections.has(normalizedPath)) {
      console.log(`  -> Routing to UI`);
      return await this.forwardToUI(normalizedPath, operation);
    } else {
      // Check if this is an agent session (locked but UI disconnected)
      if (isLocked) {
        console.log(`  -> FAILING: Agent session but UI disconnected`);
        return {
          success: false,
          error: 'Agent session active but UI disconnected. Cannot fall back to headless mode during agent session.',
        };
      }
      console.log(`  -> Routing to HEADLESS`);
      return await this.applyHeadless(operation);
    }
  }

  private async forwardToUI(notebookPath: string, operation: Record<string, unknown>): Promise<OperationResult> {
    const conn = this.uiConnections.get(notebookPath)!;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    // Calculate timeout based on operation type
    const opType = operation.type as string;
    let timeout = this.operationTimeout;

    if (opType === 'executeCell') {
      const maxWait = (operation.maxWait as number) || 10;
      timeout = (maxWait + 5) * 1000;
    } else if (opType === 'readCellOutput') {
      const maxWait = (operation.maxWait as number) || 0;
      timeout = Math.max(this.operationTimeout, (maxWait + 5) * 1000);
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        // For executeCell, timeout means the cell is still running - return busy status, not error
        if (opType === 'executeCell') {
          resolve({
            success: true,
            executionStatus: 'busy',
            // Pass through the original cellId/cellIndex from the operation for polling
            cellId: operation.cellId,
            cellIndex: operation.cellIndex,
            outputs: [],
            message: `Cell still executing after ${timeout / 1000}s. Use read_output with max_wait to poll for results.`,
          });
        } else {
          resolve({
            success: false,
            error: `Operation timed out after ${timeout / 1000}s`,
          });
        }
      }, timeout);

      conn.pendingRequests.set(requestId, { resolve, reject, timeoutId });

      // Send operation to UI
      const message = {
        type: 'operation',
        operation,
        requestId,
      };

      try {
        conn.websocket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timeoutId);
        conn.pendingRequests.delete(requestId);
        resolve({
          success: false,
          error: `Failed to forward operation to UI: ${err}`,
        });
      }
    });
  }

  /**
   * Handle operation response from UI.
   */
  handleUIResponse(notebookPath: string, response: Record<string, unknown>): void {
    const normalizedPath = path.resolve(notebookPath);

    if (!this.uiConnections.has(normalizedPath)) {
      console.log(`[OperationRouter] Received response for unknown notebook: ${notebookPath}`);
      return;
    }

    const conn = this.uiConnections.get(normalizedPath)!;
    const requestId = response.requestId as string;

    if (requestId && conn.pendingRequests.has(requestId)) {
      const request = conn.pendingRequests.get(requestId)!;
      clearTimeout(request.timeoutId);
      conn.pendingRequests.delete(requestId);

      const result = (response.result as OperationResult) || { success: false, error: 'No result in response' };
      request.resolve(result);
    }
  }

  private async applyHeadless(operation: Record<string, unknown>): Promise<OperationResult> {
    if (!this.headlessHandler) {
      return {
        success: false,
        error: 'Headless manager not configured',
      };
    }

    return await this.headlessHandler.applyOperation(operation);
  }

  /**
   * Read notebook state.
   */
  async readNotebook(
    notebookPath: string,
    includeOutputs = true,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): Promise<OperationResult> {
    const normalizedPath = path.resolve(notebookPath);

    if (this.uiConnections.has(normalizedPath)) {
      const result = await this.readFromUI(normalizedPath);
      if (result.success) {
        return this.applyOutputTruncation(result, includeOutputs, maxLines, maxChars, maxLinesError, maxCharsError);
      }
      return result;
    } else {
      return await this.readFromFile(notebookPath, includeOutputs, maxLines, maxChars, maxLinesError, maxCharsError);
    }
  }

  private async readFromUI(notebookPath: string): Promise<OperationResult> {
    const conn = this.uiConnections.get(notebookPath)!;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        conn.pendingRequests.delete(requestId);
        console.log(`[OperationRouter] UI read timeout, falling back to file`);
        this.readFromFile(notebookPath).then(resolve);
      }, this.operationTimeout);

      conn.pendingRequests.set(requestId, {
        resolve,
        reject: (err) => resolve({ success: false, error: String(err) }),
        timeoutId,
      });

      const message = {
        type: 'readNotebook',
        requestId,
      };

      try {
        conn.websocket.send(JSON.stringify(message));
      } catch (err) {
        clearTimeout(timeoutId);
        conn.pendingRequests.delete(requestId);
        resolve({
          success: false,
          error: `Failed to read from UI: ${err}`,
        });
      }
    });
  }

  private async readFromFile(
    notebookPath: string,
    includeOutputs = true,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): Promise<OperationResult> {
    if (!this.headlessHandler) {
      return {
        success: false,
        error: 'Headless manager not configured',
      };
    }

    return await this.headlessHandler.readNotebook(
      notebookPath,
      includeOutputs,
      maxLines,
      maxChars,
      maxLinesError,
      maxCharsError
    );
  }

  private applyOutputTruncation(
    result: OperationResult,
    includeOutputs: boolean,
    maxLines?: number,
    maxChars?: number,
    maxLinesError?: number,
    maxCharsError?: number
  ): OperationResult {
    if (!result.success || !result.data) {
      return result;
    }

    const data = result.data as { cells?: unknown[] };
    const cells = data.cells || [];

    if (!includeOutputs) {
      data.cells = cells.map((cell: unknown) => ({ ...(cell as Record<string, unknown>), outputs: [] }));
      return result;
    }

    // Apply truncation defaults
    const effectiveMaxLines = maxLines ?? 100;
    const effectiveMaxChars = maxChars ?? 10000;
    const effectiveMaxLinesError = maxLinesError ?? 200;
    const effectiveMaxCharsError = maxCharsError ?? 20000;

    data.cells = cells.map((cell: unknown) => {
      const c = cell as Record<string, unknown>;
      const outputs = (c.outputs as unknown[]) || [];

      return {
        ...c,
        outputs: outputs.map((output: unknown) => {
          const o = output as Record<string, unknown>;
          const outputType = (o.type as string) || 'stdout';
          const content = (o.content as string) || '';

          if (outputType === 'image' || outputType === 'html') {
            return { ...o, is_binary: outputType === 'image' };
          }

          const linesLimit = outputType === 'error' ? effectiveMaxLinesError : effectiveMaxLines;
          const charsLimit = outputType === 'error' ? effectiveMaxCharsError : effectiveMaxChars;

          const lines = content.split('\n');
          const totalLines = lines.length;
          const totalChars = content.length;

          // Match Python's truncation logic exactly
          let truncated = false;
          let truncationReason: string | null = null;
          const resultLines: string[] = [];
          let charCount = 0;
          const startLine = 0;
          let endLine = 0;

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const newCharCount = charCount + line.length + (i > 0 ? 1 : 0); // +1 for newline

            if (i >= linesLimit) {
              truncated = true;
              truncationReason = 'lines';
              break;
            }

            if (newCharCount > charsLimit && i > 0) { // Always include at least 1 line
              truncated = true;
              truncationReason = 'chars';
              break;
            }

            resultLines.push(line);
            charCount = newCharCount;
            endLine = startLine + i + 1;
          }

          const truncatedContent = resultLines.join('\n');

          return {
            type: outputType,
            content: truncatedContent,
            truncated,
            truncation_reason: truncationReason,
            total_lines: totalLines,
            total_chars: totalChars,
            returned_range: {
              start_line: startLine,
              end_line: endLine,
              char_count: truncatedContent.length,
            },
          };
        }),
      };
    });

    return result;
  }
}

// Global router instance
export const operationRouter = new OperationRouter();
