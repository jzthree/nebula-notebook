/**
 * Kernel Service - Frontend client for Jupyter kernel management
 * Supports multiple concurrent kernel sessions
 */
import { CellOutput } from '../types';

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

// Internal session state for each kernel session
interface SessionState {
  sessionId: string;
  ws: WebSocket | null;
  messageQueue: Array<{
    resolve: (value: any) => void;
    reject: (error: any) => void;
    onOutput: (output: CellOutput) => void;
  }>;
}

class KernelService {
  // Multi-session state: sessionId -> SessionState
  private sessions: Map<string, SessionState> = new Map();

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
   * @returns The session ID
   */
  async startKernel(kernelName: string = 'python3', cwd?: string): Promise<string> {
    const body: { kernel_name: string; cwd?: string } = { kernel_name: kernelName };
    if (cwd) {
      body.cwd = cwd;
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
   * Connect WebSocket for a specific session
   */
  private async connectWebSocket(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}${API_BASE}/kernels/${sessionId}/ws`;

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
        // Status updates (busy/idle) - can be used for UI
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

    await fetch(`${API_BASE}/kernels/${sessionId}/interrupt`, {
      method: 'POST'
    });
  }

  /**
   * Restart a specific kernel
   */
  async restartKernel(sessionId: string): Promise<void> {
    if (!this.sessions.has(sessionId)) return;

    await fetch(`${API_BASE}/kernels/${sessionId}/restart`, {
      method: 'POST'
    });
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
   * Clear all sessions (for testing)
   * @internal
   */
  _clearAllSessions(): void {
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
