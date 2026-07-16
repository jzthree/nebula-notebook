/**
 * Kernel Service - Frontend client for Jupyter kernel management
 * Supports multiple concurrent kernel sessions
 */
import { CellOutput } from '../types';
import { authService } from './authService';

export const API_BASE = '/api';

/**
 * Thrown when a kernel's server/allocation is gone (HTTP 410). Unlike a transient
 * connection error, this is terminal: the reconnect loop should stop and mark the
 * kernel dead rather than retrying forever.
 */
export class KernelServerGoneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KernelServerGoneError';
  }
}

export interface KernelSpec {
  name: string;
  display_name: string;
  language: string;
  path: string;
  python_path?: string | null; // The actual Python executable from kernel.json argv[0]
}

export interface KernelSession {
  id: string;
  kernel_name: string;
  status: 'idle' | 'busy' | 'starting';
  execution_count: number;
}

/** Result of an execute round-trip. executionCount is the KERNEL's own
 * counter (from execute_input) — the authoritative Jupyter [n]. */
export interface ExecuteCodeResult {
  status?: string;
  executionCount?: number | null;
  error?: string;
  queuePosition?: number;
  queueLength?: number;
}

export interface PythonEnvironment {
  path: string;
  version: string;
  display_name: string;
  env_type: 'system' | 'conda' | 'pyenv' | 'venv' | 'homebrew' | 'uv' | 'pixi';
  env_name: string | null;
  has_ipykernel: boolean;
  // PEP 668: interpreter forbids in-place pip installs → guide to an isolated env.
  externally_managed: boolean;
  // Copy-pasteable command to make ipykernel available; null when already present.
  install_hint: string | null;
  kernel_name: string | null;
}

/** Stable error codes returned by the kernel-provisioning API. */
export type KernelProvisionErrorCode =
  | 'python_not_found'
  | 'externally_managed'
  | 'needs_ipykernel'
  | 'install_failed'
  | 'register_failed';

/** Error thrown by installKernel carrying a machine-readable code + guidance. */
export class KernelProvisionError extends Error {
  code?: KernelProvisionErrorCode;
  installHint?: string;
  constructor(message: string, code?: KernelProvisionErrorCode, installHint?: string) {
    super(message);
    this.name = 'KernelProvisionError';
    this.code = code;
    this.installHint = installHint;
  }
}

/**
 * Env kernels (raw launch): a Python environment used as a kernel directly,
 * no kernelspec registration. The name encodes the interpreter path and is
 * understood by the backend's kernel start endpoints.
 */
export const ENV_KERNEL_PREFIX = 'env:';

export function envKernelName(pythonPath: string): string {
  return ENV_KERNEL_PREFIX + pythonPath;
}

export function isEnvKernelName(name: string | null | undefined): boolean {
  return !!name && name.startsWith(ENV_KERNEL_PREFIX);
}

/** Parse a failed kernel-API response into the richest error we can throw. */
function provisionErrorFrom(error: { detail?: string; code?: string; install_hint?: string }, fallback: string): Error {
  if (error.code) {
    return new KernelProvisionError(
      error.detail || fallback,
      error.code as KernelProvisionErrorCode,
      error.install_hint
    );
  }
  return new Error(error.detail || fallback);
}

export interface PythonEnvironmentsResponse {
  kernelspecs: KernelSpec[];
  environments: PythonEnvironment[];
  cache_info: {
    cached_count: number;
    cache_age_hours: number | null;
    cache_valid: boolean;
    cache_file: string;
  };
}

export interface KernelPreference {
  kernel_name: string | null;
  server_id: string | null;
  updated_at?: number;
}

/**
 * Jupyter comm message relayed over the kernel WebSocket (ipywidgets support).
 * Mirrors the fixed backend contract: `{ type: 'comm', comm: CommMessage }`.
 */
export interface CommMessage {
  msg_type: 'comm_open' | 'comm_msg' | 'comm_close';
  comm_id: string;
  target_name?: string;
  data: Record<string, unknown>;
  /** Binary buffers, base64-encoded for JSON transport. */
  buffers?: string[];
}

/** Reply payload for `{ type: 'comm_info' }`: comm_id -> { target_name }. */
export type CommInfoReply = Record<string, { target_name: string }>;

// Completion result from kernel
export interface CompletionResult {
  status: string;
  matches: string[];
  cursor_start: number;
  cursor_end: number;
  metadata?: Record<string, any>;
}

// Internal session state for each kernel session
interface SessionState {
  sessionId: string;
  ws: WebSocket | null;
  messageQueue: Array<{
    resolve: (value: any) => void;
    reject: (error: any) => void;
    onOutput: (output: CellOutput) => void;
    cellId?: string | null;
  }>;
  // WebSocket output sync handshake. We require an initial `sync_outputs` round-trip
  // before sending execute/complete requests so the client has current cell outputs.
  initialSyncDone?: boolean;
  initialSyncPromise?: Promise<void>;
  initialSyncResolve?: (() => void) | null;
  initialSyncTimeout?: ReturnType<typeof setTimeout> | null;
  initialSyncTimedOut?: boolean;
  pendingCompletion?: {
    resolve: (result: CompletionResult) => void;
    reject: (error: any) => void;
  };
  // Pending `comm_info` requests. The next `comm_info_reply` resolves all of them
  // (the reply carries the full comm map, so correlation is unnecessary).
  pendingCommInfo?: Array<{
    resolve: (comms: CommInfoReply) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>;
  filePath?: string; // Associated notebook file path
  kernelName?: string; // Kernel name for reconnection
  serverId?: string | null; // Server ID for reconnection
}

// Reconnection callback type
type ReconnectCallback = (sessionId: string, filePath?: string) => void;
type StatusCallback = (sessionId: string, status: 'idle' | 'busy' | 'starting' | 'dead', cellId?: string | null) => void;

class KernelService {
  // Multi-session state: sessionId -> SessionState
  private sessions: Map<string, SessionState> = new Map();

  // Reconnection state
  private reconnectInterval: NodeJS.Timeout | null = null;
  private disconnectedSessions: Set<string> = new Set();
  // Consecutive "server/allocation gone" (410) reports per session — a kernel
  // is only marked terminally dead after the signal persists (see reconnect loop).
  private serverGoneCounts: Map<string, number> = new Map();
  private onReconnectCallbacks: ReconnectCallback[] = [];
  private onDisconnectCallbacks: ((sessionId: string) => void)[] = [];
  private onStatusCallbacks: StatusCallback[] = [];
  private onBufferedOutputCallbacks: Array<(sessionId: string, output: CellOutput, cellId?: string | null) => void> = [];
  private onCommCallbacks: Array<(sessionId: string, comm: CommMessage) => void> = [];
  private onSyncReplaceCallbacks: Array<(sessionId: string, cellOutputs: Map<string, CellOutput[]>, executingCellId?: string | null) => void> = [];

  /**
   * Get list of available kernels on the system
   */
  async getAvailableKernels(serverId?: string | null): Promise<KernelSpec[]> {
    const params = new URLSearchParams();
    if (serverId) {
      params.set('server_id', serverId);
    }
    const url = params.toString() ? `${API_BASE}/kernels?${params.toString()}` : `${API_BASE}/kernels`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch kernels');
    }
    const data = await response.json();
    return data.kernels;
  }

  /**
   * Start a new kernel session
   * @param kernelName - The kernel to start (e.g., 'python3')
   * @param cwd - Optional working directory for the kernel
   * @param filePath - Optional file path for "one notebook = one kernel"
   * @param serverId - Optional server ID for cluster support (null for local)
   * @returns The session ID
   */
  async startKernel(kernelName: string = 'python3', cwd?: string, filePath?: string, serverId?: string | null): Promise<string> {
    const body: { kernel_name: string; cwd?: string; file_path?: string; server_id?: string; client_origin: 'ui' } = {
      kernel_name: kernelName,
      client_origin: 'ui',
    };
    if (cwd) {
      body.cwd = cwd;
    }
    if (filePath) {
      body.file_path = filePath;
    }
    if (serverId) {
      body.server_id = serverId;
    }

    const response = await fetch(`${API_BASE}/kernels/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Failed to start kernel' }));
      // Structured provisioning errors (needs_ipykernel, …) drive the
      // install-prompt UI — preserve code + hint instead of flattening to text.
      throw provisionErrorFrom(error, 'Failed to start kernel');
    }

    const data = await response.json();
    const sessionId = data.session_id;
    const resolvedServerId = data.server_id ?? serverId ?? null;

    // Initialize session state
    this.sessions.set(sessionId, {
      sessionId,
      ws: null,
      messageQueue: [],
      filePath,
      kernelName: kernelName,
      serverId: resolvedServerId,
    });

    // Connect WebSocket
    await this.connectWebSocket(sessionId);

    return sessionId;
  }

  /**
   * Get or create a kernel for a notebook file
   * Implements "one notebook = one kernel" - multiple tabs share the same kernel
   * @param filePath - The notebook file path
   * @param kernelName - The kernel to start if creating new
   * @param serverId - Optional server ID for cluster support (null for local)
   * @returns Object with session ID, created flag, and created_at timestamp
   */
  async getOrCreateKernelForFile(
    filePath: string,
    kernelName: string = 'python3',
    serverId?: string | null,
  ): Promise<{ sessionId: string; created?: boolean; createdAt?: number; serverId?: string | null; mtime?: number }> {
    const body: { file_path: string; kernel_name: string; server_id?: string; client_origin: 'ui' } = {
      file_path: filePath,
      kernel_name: kernelName,
      client_origin: 'ui',
    };
    if (serverId) {
      body.server_id = serverId;
    }

    const response = await fetch(`${API_BASE}/kernels/for-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Failed to get/create kernel' }));
      throw provisionErrorFrom(error, 'Failed to get/create kernel');
    }

    const data = await response.json();
    const sessionId = data.session_id;
    const created = data.created as boolean | undefined;
    const createdAt = data.created_at as number | undefined;
    const resolvedServerId = data.server_id ?? serverId ?? null;
    const mtime = data.mtime as number | undefined;

    // Initialize session state if not already connected
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        ws: null,
        messageQueue: [],
        filePath,
        kernelName,
        serverId: resolvedServerId,
      });

      // Connect WebSocket
      await this.connectWebSocket(sessionId);
    } else {
      // Update filePath and kernelName in case they changed
      const session = this.sessions.get(sessionId)!;
      session.filePath = filePath;
      session.kernelName = kernelName;
      session.serverId = resolvedServerId;

      if (!this.isConnected(sessionId)) {
        // Reconnect if disconnected
        await this.connectWebSocket(sessionId);
      }
    }

    return { sessionId, created, createdAt, serverId: resolvedServerId, mtime };
  }

  /**
   * Attach the frontend to an existing kernel session by ID.
   * Used when an external client has already chosen the concrete session.
   */
  async attachToSession(
    sessionId: string,
    filePath?: string,
  ): Promise<{ sessionId: string; filePath?: string; kernelName?: string; serverId?: string | null }> {
    const response = await fetch(`${API_BASE}/kernels/${encodeURIComponent(sessionId)}/status`);
    if (response.status === 404) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Failed to attach to kernel session' }));
      throw new Error(error.detail || 'Failed to attach to kernel session');
    }

    const data = await response.json();
    const resolvedFilePath = (data.file_path as string | undefined) ?? filePath;
    const kernelName = data.kernel_name as string | undefined;
    const serverId = (data.server_id as string | null | undefined) ?? null;

    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        ws: null,
        messageQueue: [],
        filePath: resolvedFilePath,
        kernelName,
        serverId,
      });
      await this.connectWebSocket(sessionId);
    } else {
      const session = this.sessions.get(sessionId)!;
      session.filePath = resolvedFilePath;
      session.kernelName = kernelName;
      session.serverId = serverId;

      if (!this.isConnected(sessionId)) {
        await this.connectWebSocket(sessionId);
      }
    }

    return { sessionId, filePath: resolvedFilePath, kernelName, serverId };
  }

  /**
   * Connect WebSocket for a specific session
   */
  private async connectWebSocket(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Reset initial sync state on (re)connect.
    session.initialSyncDone = false;
    session.initialSyncTimedOut = false;
    session.initialSyncPromise = undefined;
    session.initialSyncResolve = null;
    if (session.initialSyncTimeout) {
      clearTimeout(session.initialSyncTimeout);
    }
    session.initialSyncTimeout = null;

    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // Encode session ID to handle proxied sessions with "::" in the ID
      const encodedSessionId = encodeURIComponent(sessionId);
      const baseWsUrl = `${protocol}//${window.location.host}${API_BASE}/kernels/${encodedSessionId}/ws`;
      const wsUrl = authService.getAuthenticatedWebSocketUrl(baseWsUrl);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('Kernel WebSocket connected');
        session.ws = ws;
        // Request replay before we send any execute/complete messages. This prevents
        // a race on refresh where live outputs can arrive before replay and cause
        // the UI to skip buffered outputs.
        this.requestInitialSync(sessionId);
        resolve();
      };

      ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      ws.onclose = () => {
        console.log('Kernel WebSocket closed');
        if (session.ws === ws) {
          session.ws = null;
          // Add to disconnected sessions and start reconnection
          this.disconnectedSessions.add(sessionId);
          this.startReconnectLoop();
          // Notify disconnect callbacks
          for (const callback of this.onDisconnectCallbacks) {
            try {
              callback(sessionId);
            } catch (e) {
              console.error('Disconnect callback error:', e);
            }
          }
        }
      };

      ws.onmessage = async (event) => {
        try {
          let raw = event.data;
          let text: string;
          if (typeof raw === 'string') {
            text = raw;
          } else if (raw instanceof ArrayBuffer) {
            text = new TextDecoder().decode(raw);
          } else if (raw instanceof Blob) {
            text = await raw.text();
          } else {
            text = String(raw);
          }
          const data = JSON.parse(text);
          this.handleMessage(sessionId, data);
        } catch (error) {
          console.error('[Kernel WS] Failed to parse message:', error);
        }
      };
    });
  }

  /**
   * Handle incoming WebSocket messages for a session
   */
  private handleMessage(sessionId: string, data: any) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Handle status updates first - these don't require a pending handler
    // This is important for receiving initial status on WebSocket connect
    if (data.type === 'status') {
      const status = data.status as 'idle' | 'busy' | 'starting' | 'dead';
      const cellId = data.cell_id ?? null;
      for (const callback of this.onStatusCallbacks) {
        try {
          callback(sessionId, status, cellId);
        } catch (e) {
          console.error('Status callback error:', e);
        }
      }
      return;
    }

    if (data.type === 'sync_outputs') {
      // Cell-level replace protocol: server sends complete cell output arrays
      const cellsData = data.cells as Record<string, Array<{
        type: string;
        content: string;
        mimeBundle?: CellOutput['mimeBundle'];
        metadata?: CellOutput['metadata'];
        preferredMimeType?: string;
      }>> | undefined;
      if (cellsData && typeof cellsData === 'object') {
        const cellOutputMap = new Map<string, CellOutput[]>();
        const now = Date.now();
        for (const [cellId, outputs] of Object.entries(cellsData)) {
          if (!Array.isArray(outputs)) continue;
          const cellOutputs: CellOutput[] = outputs.map((o, i) => ({
            id: `sync-${cellId}-${i}`,
            type: o.type as CellOutput['type'],
            content: o.content,
            timestamp: now,
            mimeBundle: o.mimeBundle,
            metadata: o.metadata,
            preferredMimeType: o.preferredMimeType,
          }));
          cellOutputMap.set(cellId, cellOutputs);
        }
        const executingCellId = (data.executing_cell as string | null) ?? null;
        // Fire sync replace callbacks (Notebook.tsx replaces cell outputs + executing state)
        for (const callback of this.onSyncReplaceCallbacks) {
          try {
            callback(sessionId, cellOutputMap, executingCellId);
          } catch (e) {
            console.error('Sync replace callback error:', e);
          }
        }
      }

      // Mark initial sync complete
      if (!session.initialSyncDone) {
        session.initialSyncDone = true;
        if (session.initialSyncTimeout) {
          clearTimeout(session.initialSyncTimeout);
          session.initialSyncTimeout = null;
        }
        if (session.initialSyncResolve) {
          try {
            session.initialSyncResolve();
          } catch {
            // Ignore resolve errors.
          }
        }
      }
      return;
    }

    // Comm messages (ipywidgets) can arrive at any time, independent of execution
    if (data.type === 'comm') {
      const comm = data.comm as CommMessage | undefined;
      if (comm && typeof comm.comm_id === 'string' && comm.msg_type) {
        for (const callback of this.onCommCallbacks) {
          try {
            callback(sessionId, comm);
          } catch (e) {
            console.error('Comm callback error:', e);
          }
        }
      }
      return;
    }

    // Reply to a `comm_info` request — resolve all pending requests with the comm map
    if (data.type === 'comm_info_reply') {
      const comms = (data.comms ?? {}) as CommInfoReply;
      const pending = session.pendingCommInfo;
      session.pendingCommInfo = undefined;
      if (pending) {
        for (const entry of pending) {
          clearTimeout(entry.timeout);
          try {
            entry.resolve(comms);
          } catch (e) {
            console.error('Comm info callback error:', e);
          }
        }
      }
      return;
    }

    // Handle completion replies - also don't require execution handler
    if (data.type === 'complete_reply') {
      if (session.pendingCompletion) {
        session.pendingCompletion.resolve(data.result);
        session.pendingCompletion = undefined;
      }
      return;
    }

    const handler = session.messageQueue[0];

    if (data.type === 'output') {
      const output = data.output;
      const cellId = data.cell_id ?? data.cellId ?? null;
      const cellOutput: CellOutput = {
        id: crypto.randomUUID(),
        type: output.type,
        content: output.content,
        timestamp: Date.now(),
        mimeBundle: output.mimeBundle,
        metadata: output.metadata,
        preferredMimeType: output.preferredMimeType,
      };

      if (handler && handler.cellId && cellId && handler.cellId !== cellId) {
        // Output for a different cell than the active handler. Treat as buffered.
        for (const callback of this.onBufferedOutputCallbacks) {
          try {
            callback(sessionId, cellOutput, cellId);
          } catch (e) {
            console.error('Buffered output callback error:', e);
          }
        }
      } else if (handler) {
        handler.onOutput(cellOutput);
      } else {
        for (const callback of this.onBufferedOutputCallbacks) {
          try {
            callback(sessionId, cellOutput, cellId);
          } catch (e) {
            console.error('Buffered output callback error:', e);
          }
        }
      }

      return;
    }

    // Other message types require an active execution handler
    if (!handler) return;

    switch (data.type) {
      case 'result':
        // Execution complete
        session.messageQueue.shift();
        handler.resolve(data.result);
        break;

      case 'error':
        session.messageQueue.shift();
        handler.reject(new Error(data.error));
        break;
    }
  }

  /**
   * Execute code in a specific kernel session
   * @param sessionId - The session to execute in
   * @param code - The code to execute
   * @param onOutput - Callback for streaming output
   */
  async executeCode(
    sessionId: string,
    code: string,
    onOutput: (output: CellOutput) => void,
    cellId?: string | null
  ): Promise<ExecuteCodeResult | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Kernel not connected');
    }

    await this.waitForInitialSync(sessionId);

    return new Promise((resolve, reject) => {
      session.messageQueue.push({ resolve, reject, onOutput, cellId });

      session.ws!.send(JSON.stringify({
        type: 'execute',
        code: code,
        cell_id: cellId ?? undefined,
      }));
    });
  }

  /**
   * Request code completion from kernel
   * @param sessionId - The session to use
   * @param code - The code context
   * @param cursorPos - Cursor position in the code
   * @returns Completion matches from kernel
   */
  async complete(
    sessionId: string,
    code: string,
    cursorPos: number
  ): Promise<CompletionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    await this.waitForInitialSync(sessionId);

    // Cancel any pending completion
    if (session.pendingCompletion) {
      session.pendingCompletion.reject(new Error('Cancelled'));
    }

    return new Promise((resolve, reject) => {
      // Set timeout for completion
      const timeout = setTimeout(() => {
        if (session.pendingCompletion) {
          session.pendingCompletion = undefined;
          resolve({ status: 'timeout', matches: [], cursor_start: cursorPos, cursor_end: cursorPos });
        }
      }, 3000);

      session.pendingCompletion = {
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };

      session.ws!.send(JSON.stringify({
        type: 'complete',
        code: code,
        cursor_pos: cursorPos
      }));
    });
  }

  /**
   * Stop a specific kernel session
   * @param sessionId - The session to stop
   */
  async stopKernel(sessionId: string): Promise<void> {
    // Clean up local session if we have it
    const session = this.sessions.get(sessionId);
    if (session) {
      if (session.ws) {
        session.ws.close();
      }
      this.sessions.delete(sessionId);
    }

    // Always send DELETE to server (kernel may exist even if not in local sessions)
    await fetch(`${API_BASE}/kernels/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    });
  }

  /**
   * Interrupt kernel execution for a specific session
   */
  async interruptKernel(sessionId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/kernels/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Failed to interrupt kernel' }));
      throw new Error(error.detail || 'Failed to interrupt kernel');
    }
  }

  /**
   * Restart a specific kernel
   */
  async restartKernel(sessionId: string): Promise<void> {
    const response = await fetch(`${API_BASE}/kernels/${encodeURIComponent(sessionId)}/restart`, {
      method: 'POST'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Failed to restart kernel' }));
      throw new Error(error.detail || 'Failed to restart kernel');
    }
  }

  /**
   * Get kernel status for a specific session
   */
  async getStatus(sessionId: string): Promise<KernelSession | null> {
    if (!this.sessions.has(sessionId)) return null;

    const response = await fetch(`${API_BASE}/kernels/${encodeURIComponent(sessionId)}/status`);
    if (response.status === 404) return null;
    if (response.status === 410) {
      // The server/allocation hosting this kernel is gone — terminal, not transient.
      const error = await response.json().catch(() => ({ detail: 'Allocation ended' }));
      throw new KernelServerGoneError(error.detail || 'Allocation ended — kernel stopped');
    }
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: 'Failed to get kernel status' }));
      throw new Error(error.detail || 'Failed to get kernel status');
    }

    return response.json();
  }

  /**
   * Check if a specific session is connected
   */
  isConnected(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    return session.ws !== null && session.ws.readyState === WebSocket.OPEN;
  }

  /**
   * True if the session has an execute (or other request) currently in
   * flight. Used to skip kernel completion requests that would only queue
   * up behind the execute on the serialized shell channel.
   */
  hasPendingRequest(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    return !!session && session.messageQueue.length > 0;
  }

  /**
   * True if ANY kernel WebSocket is currently open. Used as a liveness
   * corroborator by the connection monitor: while a WS is open the server is
   * clearly reachable, so a transient /api/health timeout (e.g. an SSH-tunnel
   * latency spike on a login-node deploy) must not be reported as an outage.
   */
  hasOpenConnection(): boolean {
    for (const session of this.sessions.values()) {
      if (session.ws !== null && session.ws.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  /**
   * Subscribe to sync replace events (cell-level output replacement on reconnect)
   */
  onSyncReplace(callback: (sessionId: string, cellOutputs: Map<string, CellOutput[]>, executingCellId?: string | null) => void): () => void {
    this.onSyncReplaceCallbacks.push(callback);
    return () => {
      this.onSyncReplaceCallbacks = this.onSyncReplaceCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Subscribe to reconnection events
   */
  onReconnect(callback: ReconnectCallback): () => void {
    this.onReconnectCallbacks.push(callback);
    return () => {
      this.onReconnectCallbacks = this.onReconnectCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Subscribe to disconnection events
   */
  onDisconnect(callback: (sessionId: string) => void): () => void {
    this.onDisconnectCallbacks.push(callback);
    return () => {
      this.onDisconnectCallbacks = this.onDisconnectCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Subscribe to status updates
   */
  onStatus(callback: StatusCallback): () => void {
    this.onStatusCallbacks.push(callback);
    return () => {
      this.onStatusCallbacks = this.onStatusCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Subscribe to buffered output replay events (e.g. after reconnect)
   */
  onBufferedOutput(callback: (sessionId: string, output: CellOutput, cellId?: string | null) => void): () => void {
    this.onBufferedOutputCallbacks.push(callback);
    return () => {
      this.onBufferedOutputCallbacks = this.onBufferedOutputCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Send a comm message (ipywidgets traffic) to the kernel over the session WebSocket.
   * Comm messages are fire-and-forget: if the socket is not open they are dropped
   * with a warning (the widget manager re-syncs state via comm_info on reconnect).
   */
  sendComm(sessionId: string, comm: CommMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
      console.warn(`[Kernel WS] Dropping ${comm.msg_type} for comm ${comm.comm_id}: session ${sessionId} not connected`);
      return;
    }
    try {
      session.ws.send(JSON.stringify({ type: 'comm', comm }));
    } catch (err) {
      console.warn('[Kernel WS] Failed to send comm message:', err);
    }
  }

  /**
   * Subscribe to incoming comm messages (ipywidgets traffic) from any session.
   */
  onComm(callback: (sessionId: string, comm: CommMessage) => void): () => void {
    this.onCommCallbacks.push(callback);
    return () => {
      this.onCommCallbacks = this.onCommCallbacks.filter(cb => cb !== callback);
    };
  }

  /**
   * Request the kernel's open comms (`{type:'comm_info'}` -> `comm_info_reply`).
   * Resolves with an empty map on timeout or when the socket is not open, so
   * widget state restoration degrades cleanly instead of throwing.
   */
  requestCommInfo(sessionId: string, timeoutMs: number = 5000): Promise<CommInfoReply> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.ws || session.ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve({});
    }

    return new Promise<CommInfoReply>((resolve) => {
      const entry = {
        resolve,
        timeout: setTimeout(() => {
          if (session.pendingCommInfo) {
            session.pendingCommInfo = session.pendingCommInfo.filter(e => e !== entry);
          }
          resolve({});
        }, timeoutMs),
      };
      session.pendingCommInfo = [...(session.pendingCommInfo ?? []), entry];

      try {
        session.ws!.send(JSON.stringify({ type: 'comm_info' }));
      } catch (err) {
        console.warn('[Kernel WS] Failed to request comm info:', err);
        clearTimeout(entry.timeout);
        session.pendingCommInfo = session.pendingCommInfo?.filter(e => e !== entry);
        resolve({});
      }
    });
  }

  /**
   * Start the reconnection loop (tries every second)
   */
  private startReconnectLoop(): void {
    if (this.reconnectInterval) return; // Already running

    this.reconnectInterval = setInterval(async () => {
      if (this.disconnectedSessions.size === 0) {
        // No disconnected sessions, stop the loop
        this.stopReconnectLoop();
        return;
      }

      // Try to reconnect each disconnected session
      for (const sessionId of Array.from(this.disconnectedSessions)) {
        const session = this.sessions.get(sessionId);
        if (!session) {
          this.disconnectedSessions.delete(sessionId);
          continue;
        }

        try {
          // First check if session exists on server
          let status: KernelSession | null = null;
          try {
            status = await this.getStatus(sessionId);
          } catch (statusError) {
            if (statusError instanceof KernelServerGoneError) {
              // The kernel's server/allocation is reported gone. Require the
              // signal to PERSIST across a few loop iterations before treating
              // it as terminal — a single 410 can race registry/allocation
              // bookkeeping. (The server already vets this against scheduler
              // state, so this is defense in depth.)
              const goneCount = (this.serverGoneCounts.get(sessionId) ?? 0) + 1;
              this.serverGoneCounts.set(sessionId, goneCount);
              if (goneCount < 3) {
                console.log(`Session ${sessionId} server/allocation reported gone (${goneCount}/3): ${statusError.message}`);
                continue;
              }
              // Confirmed terminal — stop reconnecting and mark the kernel
              // dead so the UI drops the "reconnecting" spinner and tells the
              // user, instead of retrying forever.
              console.log(`Session ${sessionId} server/allocation gone: ${statusError.message}`);
              this.serverGoneCounts.delete(sessionId);
              this.disconnectedSessions.delete(sessionId);
              for (const callback of this.onStatusCallbacks) {
                try {
                  callback(sessionId, 'dead', null);
                } catch (e) {
                  console.error('Status callback error:', e);
                }
              }
              continue;
            }
            // If status check fails (e.g. transient 500/503), don't recreate yet
            this.serverGoneCounts.delete(sessionId);
            console.error(`Failed to check session status for ${sessionId}:`, statusError);
            continue;
          }
          this.serverGoneCounts.delete(sessionId);

          if (!status && session.filePath && session.kernelName) {
            // Session no longer exists on server, recreate it
            console.log(`Session ${sessionId} not found on server, recreating for ${session.filePath}`);

            // Remove old session tracking
            this.sessions.delete(sessionId);
            this.disconnectedSessions.delete(sessionId);

            // Create new session - this will call onReconnect with the new session
            try {
              const { sessionId: newSessionId } = await this.getOrCreateKernelForFile(
                session.filePath,
                session.kernelName,
                session.serverId
              );
              console.log(`Recreated session as ${newSessionId}`);

              // Notify callbacks with new session ID
              for (const callback of this.onReconnectCallbacks) {
                try {
                  callback(newSessionId, session.filePath);
                } catch (e) {
                  console.error('Reconnect callback error:', e);
                }
              }
            } catch (e) {
              console.error('Failed to recreate session:', e);
            }
            continue;
          }

          // Session exists, just reconnect WebSocket
          await this.connectWebSocket(sessionId);
          this.disconnectedSessions.delete(sessionId);
          console.log(`Reconnected session ${sessionId}`);

          // Notify callbacks
          for (const callback of this.onReconnectCallbacks) {
            try {
              callback(sessionId, session.filePath);
            } catch (e) {
              console.error('Reconnect callback error:', e);
            }
          }
        } catch (e) {
          // Still disconnected, will retry next interval
          console.log(`Reconnection attempt failed for ${sessionId}:`, e);
        }
      }
    }, 2000); // Try every 2 seconds (reduced frequency)
  }

  /**
   * Stop the reconnection loop
   */
  private stopReconnectLoop(): void {
    if (this.reconnectInterval) {
      clearInterval(this.reconnectInterval);
      this.reconnectInterval = null;
    }
  }

  /**
   * Clear all sessions (for testing)
   * @internal
   */
  _clearAllSessions(): void {
    this.stopReconnectLoop();
    this.disconnectedSessions.clear();
    this.sessions.clear();
  }

  /**
   * Get all active session IDs
   */
  getActiveSessions(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get all Python environments (kernelspecs + discovered)
   */
  async getPythonEnvironments(refresh: boolean = false, serverId?: string | null): Promise<PythonEnvironmentsResponse> {
    const params = new URLSearchParams({ refresh: refresh ? 'true' : 'false' });
    if (serverId) {
      params.set('server_id', serverId);
    }
    const response = await fetch(`${API_BASE}/python/environments?${params.toString()}`);
    if (!response.ok) {
      throw new Error('Failed to fetch Python environments');
    }
    return response.json();
  }

  /**
   * Get stored kernel preference for a notebook file.
   */
  async getKernelPreference(filePath: string): Promise<KernelPreference | null> {
    const params = new URLSearchParams({ file_path: filePath });
    const response = await fetch(`${API_BASE}/kernels/preference?${params.toString()}`);
    if (!response.ok) {
      throw new Error('Failed to fetch kernel preference');
    }
    const data = await response.json();
    if (!data.kernel_name && !data.server_id) {
      return null;
    }
    return data as KernelPreference;
  }

  /**
   * Install ipykernel and register a Python environment as a kernel
   */
  async installKernel(pythonPath: string, kernelName?: string, serverId?: string | null): Promise<{ kernel_name: string; message: string }> {
    const response = await fetch(`${API_BASE}/python/install-kernel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        python_path: pythonPath,
        kernel_name: kernelName,
        server_id: serverId || undefined
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      // Preserve the structured code + guidance so the UI can branch on it
      // (e.g. show install instructions for an externally-managed Python).
      throw new KernelProvisionError(
        error.detail || 'Failed to install kernel',
        error.code,
        error.install_hint
      );
    }

    return response.json();
  }

  /**
   * Force refresh Python environment discovery cache
   */
  async refreshPythonEnvironments(serverId?: string | null): Promise<{ count: number }> {
    const params = new URLSearchParams();
    if (serverId) {
      params.set('server_id', serverId);
    }
    const url = params.toString() ? `${API_BASE}/python/refresh?${params.toString()}` : `${API_BASE}/python/refresh`;
    const response = await fetch(url, {
      method: 'POST'
    });

    if (!response.ok) {
      throw new Error('Failed to refresh Python environments');
    }

    return response.json();
  }

  /**
   * Get all active kernel sessions from server with memory usage
   */
  async getAllSessions(serverId?: string | null): Promise<KernelSessionInfo[]> {
    const params = new URLSearchParams();
    if (serverId) {
      params.set('server_id', serverId);
    }
    const url = params.toString() ? `${API_BASE}/kernels/sessions?${params.toString()}` : `${API_BASE}/kernels/sessions`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error('Failed to fetch kernel sessions');
    }
    const data = await response.json();
    return data.sessions;
  }

  private requestInitialSync(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.initialSyncDone) return;
    if (session.initialSyncPromise) return;
    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) return;

    session.initialSyncPromise = new Promise<void>((resolve) => {
      session.initialSyncResolve = resolve;
    });

    // Request complete cell outputs from server for replace semantics.
    try {
      session.ws.send(JSON.stringify({ type: 'sync_outputs' }));
    } catch (err) {
      console.error('Failed to request output sync:', err);
      // Don't block execution forever if we couldn't send the message.
      session.initialSyncDone = true;
      session.initialSyncResolve?.();
      return;
    }

    // Safety valve: don't block UI actions forever if the server doesn't respond.
    session.initialSyncTimeout = setTimeout(() => {
      if (session.initialSyncDone) return;
      session.initialSyncTimedOut = true;
      console.warn('[Kernel WS] Initial output sync timed out; continuing without sync');
      session.initialSyncResolve?.();
    }, 5000);
  }

  private async waitForInitialSync(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (session.initialSyncDone) return;
    if (session.initialSyncTimedOut) return;
    this.requestInitialSync(sessionId);
    if (!session.initialSyncPromise) return;
    await session.initialSyncPromise;
  }
}

export interface KernelSessionInfo {
  id: string;
  kernel_name: string;
  file_path: string | null;
  status: string;
  execution_count: number;
  memory_mb: number | null;
  pid: number | null;
  created_at: number; // Unix timestamp in seconds
}

// Export singleton instance
export const kernelService = new KernelService();

// Legacy helper functions for backwards compatibility
// These use a "default" session concept - the first/only session

let defaultSessionId: string | null = null;

export const initializeKernel = async (kernelName: string = 'python3'): Promise<void> => {
  defaultSessionId = await kernelService.startKernel(kernelName);
};

export const runPythonCode = async (
  code: string,
  onOutput: (output: CellOutput) => void
): Promise<void> => {
  if (!defaultSessionId) {
    throw new Error('No default kernel session. Call initializeKernel first.');
  }
  await kernelService.executeCode(defaultSessionId, code, onOutput);
};

// Dead session type - orphaned or terminated sessions from previous runs
export interface DeadSession {
  session_id: string;
  kernel_name: string;
  file_path: string | null;
  status: 'orphaned' | 'terminated';
  last_heartbeat: number;
}

/**
 * Get dead kernel sessions (orphaned/terminated) that can be cleaned up
 */
export const getDeadKernelSessions = async (serverId?: string | null): Promise<DeadSession[]> => {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const params = new URLSearchParams();
  if (serverId) {
    params.set('server_id', serverId);
  }
  const url = params.toString() ? `${API_BASE}/kernels/dead?${params.toString()}` : `${API_BASE}/kernels/dead`;
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Failed to get dead sessions: ${response.statusText}`);
  }
  const data = await response.json();
  return data.sessions || [];
};

/**
 * Cleanup dead kernel sessions
 * @param sessionIds Optional list of specific session IDs to clean up. If not provided, cleans all.
 */
export const cleanupDeadKernelSessions = async (sessionIds?: string[], serverId?: string | null): Promise<number> => {
  const token = authService.getToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const response = await fetch(`${API_BASE}/kernels/dead/cleanup`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ session_ids: sessionIds, server_id: serverId || undefined }),
  });
  if (!response.ok) {
    throw new Error(`Failed to cleanup dead sessions: ${response.statusText}`);
  }
  const data = await response.json();
  return data.deleted || 0;
};
