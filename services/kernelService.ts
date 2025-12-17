/**
 * Kernel Service - Frontend client for Jupyter kernel management
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

class KernelService {
  private ws: WebSocket | null = null;
  private currentSessionId: string | null = null;
  private messageQueue: Array<{
    resolve: (value: any) => void;
    reject: (error: any) => void;
    onOutput: (output: CellOutput) => void;
  }> = [];

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
   */
  async startKernel(kernelName: string = 'python3'): Promise<string> {
    const response = await fetch(`${API_BASE}/kernels/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kernel_name: kernelName })
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Failed to start kernel');
    }

    const data = await response.json();
    this.currentSessionId = data.session_id;

    // Connect WebSocket
    await this.connectWebSocket(data.session_id);

    return data.session_id;
  }

  /**
   * Connect WebSocket for streaming output
   */
  private async connectWebSocket(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}${API_BASE}/kernels/${sessionId}/ws`;

      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        console.log('Kernel WebSocket connected');
        resolve();
      };

      this.ws.onerror = (error) => {
        console.error('WebSocket error:', error);
        reject(error);
      };

      this.ws.onclose = () => {
        console.log('Kernel WebSocket closed');
        this.ws = null;
      };

      this.ws.onmessage = (event) => {
        const data = JSON.parse(event.data);
        this.handleMessage(data);
      };
    });
  }

  /**
   * Handle incoming WebSocket messages
   */
  private handleMessage(data: any) {
    const handler = this.messageQueue[0];
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
        this.messageQueue.shift();
        handler.resolve(data.result);
        break;

      case 'error':
        this.messageQueue.shift();
        handler.reject(new Error(data.error));
        break;

      case 'status':
        // Status updates (busy/idle) - can be used for UI
        break;
    }
  }

  /**
   * Execute code in the kernel
   */
  async executeCode(
    code: string,
    onOutput: (output: CellOutput) => void
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Kernel not connected');
    }

    return new Promise((resolve, reject) => {
      this.messageQueue.push({ resolve, reject, onOutput });

      this.ws!.send(JSON.stringify({
        type: 'execute',
        code: code
      }));
    });
  }

  /**
   * Stop the current kernel
   */
  async stopKernel(): Promise<void> {
    if (!this.currentSessionId) return;

    // Close WebSocket
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    // Stop kernel on server
    await fetch(`${API_BASE}/kernels/${this.currentSessionId}`, {
      method: 'DELETE'
    });

    this.currentSessionId = null;
  }

  /**
   * Interrupt kernel execution
   */
  async interruptKernel(): Promise<void> {
    if (!this.currentSessionId) return;

    await fetch(`${API_BASE}/kernels/${this.currentSessionId}/interrupt`, {
      method: 'POST'
    });
  }

  /**
   * Restart the kernel
   */
  async restartKernel(): Promise<void> {
    if (!this.currentSessionId) return;

    await fetch(`${API_BASE}/kernels/${this.currentSessionId}/restart`, {
      method: 'POST'
    });
  }

  /**
   * Get kernel status
   */
  async getStatus(): Promise<KernelSession | null> {
    if (!this.currentSessionId) return null;

    const response = await fetch(`${API_BASE}/kernels/${this.currentSessionId}/status`);
    if (!response.ok) return null;

    return response.json();
  }

  /**
   * Check if kernel is connected
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Get current session ID
   */
  getSessionId(): string | null {
    return this.currentSessionId;
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

// Also export for initialization
export const initializeKernel = async (kernelName: string = 'python3'): Promise<void> => {
  await kernelService.startKernel(kernelName);
};

export const runPythonCode = async (
  code: string,
  onOutput: (output: CellOutput) => void
): Promise<void> => {
  await kernelService.executeCode(code, onOutput);
};
