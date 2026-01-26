/**
 * Kernel Service - Frontend client for Jupyter kernel management
 * Supports multiple concurrent kernel sessions
 */
import { CellOutput } from '../types';
import { authService } from './authService';

const API_BASE = '/api';

export interface KernelSpec {
  name: string;
  display_name: string;
  language: string;
  path: string;
}

export interface KernelSession {
  id: string;
  kernel_name: string;
  status: 'idle' | 'busy' | 'starting';
  execution_count: number;
}

export interface PythonEnvironment {
  path: string;
  version: string;
  display_name: string;
  env_type: 'system' | 'conda' | 'pyenv' | 'venv' | 'homebrew';
  env_name: string | null;
  has_ipykernel: boolean;
  kernel_name: string | null;
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
  }>;
  pendingCompletion?: {
    resolve: (result: CompletionResult) => void;
    reject: (error: any) => void;
  };
  filePath?: string; // Associated notebook file path
  kernelName?: string; // Kernel name for reconnection
}

// Reconnection callback type
type ReconnectCallback = (sessionId: string, filePath?: string) => void;
type StatusCallback = (sessionId: string, status: 'idle' | 'busy' | 'starting') => void;

class KernelService {
  // Multi-session state: sessionId -> SessionState
  private sessions: Map<string, SessionState> = new Map();

  // Reconnection state
  private reconnectInterval: NodeJS.Timeout | null = null;
  private disconnectedSessions: Set<string> = new Set();
  private onReconnectCallbacks: ReconnectCallback[] = [];
  private onDisconnectCallbacks: ((sessionId: string) => void)[] = [];
  private onStatusCallbacks: StatusCallback[] = [];

  /**
   * Get list of available kernels on the system
   */
  async getAvailableKernels(): Promise<KernelSpec[]> {
    const response = await fetch(`${API_BASE}/kernels`);
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
   * @returns The session ID
   */
  async startKernel(kernelName: string = 'python3', cwd?: string, filePath?: string): Promise<string> {
    const body: { kernel_name: string; cwd?: string; file_path?: string } = { kernel_name: kernelName };
    if (cwd) {
      body.cwd = cwd;
    }
    if (filePath) {
      body.file_path = filePath;
    }

    const response = await fetch(`${API_BASE}/kernels/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to start kernel');
    }

    const data = await response.json();
    const sessionId = data.session_id;

    // Initialize session state
    this.sessions.set(sessionId, {
      sessionId,
      ws: null,
      messageQueue: []
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
   * @returns The session ID
   */
  async getOrCreateKernelForFile(filePath: string, kernelName: string = 'python3'): Promise<string> {
    const response = await fetch(`${API_BASE}/kernels/for-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_path: filePath,
        kernel_name: kernelName
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to get/create kernel');
    }

    const data = await response.json();
    const sessionId = data.session_id;

    // Initialize session state if not already connected
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        sessionId,
        ws: null,
        messageQueue: [],
        filePath,
        kernelName,
      });

      // Connect WebSocket
      await this.connectWebSocket(sessionId);
    } else {
      // Update filePath and kernelName in case they changed
      const session = this.sessions.get(sessionId)!;
      session.filePath = filePath;
      session.kernelName = kernelName;

      if (!this.isConnected(sessionId)) {
        // Reconnect if disconnected
        await this.connectWebSocket(sessionId);
      }
    }

    return sessionId;
  }

  /**
   * Connect WebSocket for a specific session
   */
  private async connectWebSocket(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const baseWsUrl = `${protocol}//${window.location.host}${API_BASE}/kernels/${sessionId}/ws`;
      const wsUrl = authService.getAuthenticatedWebSocketUrl(baseWsUrl);

      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        console.log('Kernel WebSocket connected');
        session.ws = ws;
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

      ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleMessage(sessionId, data);
      };
    });
  }

  /**
   * Handle incoming WebSocket messages for a session
   */
  private handleMessage(sessionId: string, data: any) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const handler = session.messageQueue[0];
    if (!handler) return;

    switch (data.type) {
      case 'output':
        // Stream output to callback
        const output = data.output;
        handler.onOutput({
          id: crypto.randomUUID(),
          type: output.type,
          content: output.content,
          timestamp: Date.now()
        });
        break;

      case 'result':
        // Execution complete
        session.messageQueue.shift();
        handler.resolve(data.result);
        break;

      case 'error':
        session.messageQueue.shift();
        handler.reject(new Error(data.error));
        break;

      case 'status':
        // Status updates (busy/idle) - notify listeners
        const status = data.status as 'idle' | 'busy' | 'starting';
        for (const callback of this.onStatusCallbacks) {
          try {
            callback(sessionId, status);
          } catch (e) {
            console.error('Status callback error:', e);
          }
        }
        break;

      case 'complete_reply':
        // Code completion response
        if (session.pendingCompletion) {
          session.pendingCompletion.resolve(data.result);
          session.pendingCompletion = undefined;
        }
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
    onOutput: (output: CellOutput) => void
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!session.ws || session.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Kernel not connected');
    }

    return new Promise((resolve, reject) => {
      session.messageQueue.push({ resolve, reject, onOutput });

      session.ws!.send(JSON.stringify({
        type: 'execute',
        code: code
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
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // Close WebSocket
    if (session.ws) {
      session.ws.close();
    }

    // Remove from sessions map
    this.sessions.delete(sessionId);

    // Stop kernel on server
    await fetch(`${API_BASE}/kernels/${sessionId}`, {
      method: 'DELETE'
    });
  }

  /**
   * Interrupt kernel execution for a specific session
   */
  async interruptKernel(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return;

    const response = await fetch(`${API_BASE}/kernels/${sessionId}/interrupt`, {
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
    if (!this.sessions.has(sessionId)) return;

    const response = await fetch(`${API_BASE}/kernels/${sessionId}/restart`, {
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

    const response = await fetch(`${API_BASE}/kernels/${sessionId}/status`);
    if (!response.ok) return null;

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
          const status = await this.getStatus(sessionId);

          if (!status && session.filePath && session.kernelName) {
            // Session no longer exists on server, recreate it
            console.log(`Session ${sessionId} not found on server, recreating for ${session.filePath}`);

            // Remove old session tracking
            this.sessions.delete(sessionId);
            this.disconnectedSessions.delete(sessionId);

            // Create new session - this will call onReconnect with the new session
            try {
              const newSessionId = await this.getOrCreateKernelForFile(session.filePath, session.kernelName);
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
  async getPythonEnvironments(refresh: boolean = false): Promise<PythonEnvironmentsResponse> {
    const response = await fetch(`${API_BASE}/python/environments?refresh=${refresh}`);
    if (!response.ok) {
      throw new Error('Failed to fetch Python environments');
    }
    return response.json();
  }

  /**
   * Install ipykernel and register a Python environment as a kernel
   */
  async installKernel(pythonPath: string, kernelName?: string): Promise<{ kernel_name: string; message: string }> {
    const response = await fetch(`${API_BASE}/python/install-kernel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        python_path: pythonPath,
        kernel_name: kernelName
      })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to install kernel');
    }

    return response.json();
  }

  /**
   * Force refresh Python environment discovery cache
   */
  async refreshPythonEnvironments(): Promise<{ count: number }> {
    const response = await fetch(`${API_BASE}/python/refresh`, {
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
  async getAllSessions(): Promise<KernelSessionInfo[]> {
    const response = await fetch(`${API_BASE}/kernels/sessions`);
    if (!response.ok) {
      throw new Error('Failed to fetch kernel sessions');
    }
    const data = await response.json();
    return data.sessions;
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
