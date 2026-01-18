/**
 * Kernel Service
 *
 * Manages Jupyter kernel sessions - spawning, execution, and lifecycle.
 * Uses ZeroMQ for kernel communication following the Jupyter messaging protocol.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { spawn, ChildProcess } from 'child_process';
import {
  KernelSession,
  KernelOutput,
  ExecutionResult,
  StartKernelOptions,
  SessionInfo,
  KernelServiceConfig,
  ConnectionConfig,
  DEFAULT_CONFIG,
} from './types';
import { SessionStore } from './session-store';
import { discoverKernelSpecs, getKernelSpec, KernelSpec } from './kernelspec';

// ZeroMQ types - imported dynamically to handle missing native bindings
type ZmqSocket = {
  connect: (endpoint: string) => void;
  close: () => void;
  send: (data: Buffer | Buffer[]) => Promise<void>;
  receive: () => Promise<Buffer[]>;
  subscribe: (topic: string) => void;
};

type ZmqModule = {
  Dealer: new () => ZmqSocket;
  Subscriber: new () => ZmqSocket;
};

export class KernelService {
  private sessions: Map<string, KernelSession> = new Map();
  private fileToSession: Map<string, string> = new Map();
  private kernelProcesses: Map<string, ChildProcess> = new Map();
  private zmqSockets: Map<string, { shell: ZmqSocket; iopub: ZmqSocket }> = new Map();
  private sessionStore: SessionStore;
  private config: Required<KernelServiceConfig>;
  private kernelSpecsCache: KernelSpec[] | null = null;
  private ready: boolean = false;
  private zmq: ZmqModule | null = null;

  constructor(config?: KernelServiceConfig, sessionStore?: SessionStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionStore = sessionStore || new SessionStore();
  }

  /**
   * Initialize the service (lazy load ZeroMQ and discover kernels)
   */
  async initialize(): Promise<void> {
    if (this.ready) return;

    // Try to load ZeroMQ
    try {
      this.zmq = await import('zeromq') as unknown as ZmqModule;
    } catch (err) {
      console.warn('ZeroMQ not available, kernel execution will be limited:', err);
    }

    // Discover kernels in background
    this.kernelSpecsCache = discoverKernelSpecs();
    this.ready = true;
    console.log(`Kernel service initialized. Found ${this.kernelSpecsCache.length} kernels.`);
  }

  /**
   * Check if service is ready
   */
  get isReady(): boolean {
    return this.ready;
  }

  /**
   * Get available kernelspecs
   */
  getAvailableKernels(): KernelSpec[] {
    if (this.kernelSpecsCache) {
      return this.kernelSpecsCache;
    }
    return discoverKernelSpecs();
  }

  /**
   * Normalize file path for consistent lookup
   */
  private normalizePath(filePath: string): string {
    return path.resolve(filePath.replace(/^~/, os.homedir()));
  }

  /**
   * Generate a connection file for the kernel
   */
  private generateConnectionFile(sessionId: string): { config: ConnectionConfig; filePath: string } {
    // Generate random ports
    const getPort = () => Math.floor(Math.random() * 10000) + 50000;

    const config: ConnectionConfig = {
      ip: '127.0.0.1',
      transport: 'tcp',
      signatureScheme: 'hmac-sha256',
      key: crypto.randomBytes(16).toString('hex'),
      shellPort: getPort(),
      stdinPort: getPort(),
      controlPort: getPort(),
      iopubPort: getPort(),
      hbPort: getPort(),
    };

    // Write connection file
    const connDir = path.join(os.tmpdir(), 'nebula-kernels');
    fs.mkdirSync(connDir, { recursive: true });

    const connFile = path.join(connDir, `kernel-${sessionId}.json`);
    const connData = {
      ip: config.ip,
      transport: config.transport,
      signature_scheme: config.signatureScheme,
      key: config.key,
      shell_port: config.shellPort,
      stdin_port: config.stdinPort,
      control_port: config.controlPort,
      iopub_port: config.iopubPort,
      hb_port: config.hbPort,
    };

    fs.writeFileSync(connFile, JSON.stringify(connData, null, 2));

    return { config, filePath: connFile };
  }

  /**
   * Start a new kernel session
   */
  async startKernel(options: StartKernelOptions = {}): Promise<string> {
    const kernelName = options.kernelName || 'python3';
    const spec = getKernelSpec(kernelName);

    if (!spec) {
      throw new Error(`Kernel '${kernelName}' not found`);
    }

    const sessionId = uuidv4();
    const normalizedFilePath = options.filePath ? this.normalizePath(options.filePath) : null;

    // Generate connection file
    const { config: connConfig, filePath: connFile } = this.generateConnectionFile(sessionId);

    // Build kernel command
    const argv = (spec.argv || []).map(arg =>
      arg.replace('{connection_file}', connFile)
    );

    if (argv.length === 0) {
      throw new Error(`Kernel '${kernelName}' has no argv defined`);
    }

    // Spawn the kernel process
    const cwd = options.cwd || (normalizedFilePath ? path.dirname(normalizedFilePath) : process.cwd());

    const proc = spawn(argv[0], argv.slice(1), {
      cwd,
      env: { ...process.env, ...spec.env },
      stdio: 'pipe',
    });

    const now = Date.now() / 1000;
    const session: KernelSession = {
      id: sessionId,
      kernelName,
      filePath: normalizedFilePath,
      status: 'starting',
      executionCount: 0,
      pid: proc.pid || null,
      connectionFile: connFile,
      connectionConfig: connConfig,
      createdAt: now,
      lastActivity: now,
    };

    this.sessions.set(sessionId, session);
    this.kernelProcesses.set(sessionId, proc);

    if (normalizedFilePath) {
      this.fileToSession.set(normalizedFilePath, sessionId);
    }

    // Handle process events
    proc.on('error', (err) => {
      console.error(`Kernel ${sessionId} error:`, err);
      session.status = 'dead';
    });

    proc.on('exit', (code) => {
      console.log(`Kernel ${sessionId} exited with code ${code}`);
      session.status = 'dead';
      this.cleanupKernelResources(sessionId);
    });

    // Wait for kernel to be ready
    await this.waitForReady(sessionId);

    // Save to persistence store
    this.sessionStore.saveSession({
      sessionId,
      kernelName,
      filePath: normalizedFilePath,
      kernelPid: proc.pid || null,
      status: 'active',
      createdAt: now,
      lastHeartbeat: now,
      connectionFile: connFile,
    });

    session.status = 'idle';
    return sessionId;
  }

  /**
   * Wait for kernel to be ready by connecting to ZeroMQ channels
   */
  private async waitForReady(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.connectionConfig) {
      throw new Error('Session or connection config not found');
    }

    if (!this.zmq) {
      // No ZeroMQ available, just wait a bit and hope the kernel starts
      await this.sleep(1000);
      return;
    }

    const config = session.connectionConfig;
    const shellEndpoint = `tcp://${config.ip}:${config.shellPort}`;
    const iopubEndpoint = `tcp://${config.ip}:${config.iopubPort}`;

    // Create ZeroMQ sockets
    const shell = new this.zmq.Dealer();
    const iopub = new this.zmq.Subscriber();

    shell.connect(shellEndpoint);
    iopub.connect(iopubEndpoint);
    iopub.subscribe('');

    this.zmqSockets.set(sessionId, { shell, iopub });

    // Send kernel_info_request to verify connectivity
    const startTime = Date.now();
    const timeout = this.config.startupTimeoutSeconds * 1000;

    while (Date.now() - startTime < timeout) {
      try {
        await this.sendKernelInfoRequest(sessionId);
        // If we get here without error, kernel is ready
        return;
      } catch {
        await this.sleep(100);
      }
    }

    throw new Error(`Kernel did not start within ${this.config.startupTimeoutSeconds} seconds`);
  }

  /**
   * Send kernel_info_request to verify kernel is ready
   */
  private async sendKernelInfoRequest(sessionId: string): Promise<void> {
    const sockets = this.zmqSockets.get(sessionId);
    const session = this.sessions.get(sessionId);

    if (!sockets || !session) {
      throw new Error('Session or sockets not found');
    }

    const msgId = uuidv4();
    const header = {
      msg_id: msgId,
      session: sessionId,
      username: 'nebula',
      msg_type: 'kernel_info_request',
      version: '5.3',
      date: new Date().toISOString(),
    };

    const message = this.createJupyterMessage(
      header,
      {},
      {},
      session.connectionConfig!.key
    );

    await sockets.shell.send(message);
  }

  /**
   * Create a Jupyter protocol message
   */
  private createJupyterMessage(
    header: Record<string, unknown>,
    parentHeader: Record<string, unknown>,
    content: Record<string, unknown>,
    key: string
  ): Buffer[] {
    const headerJson = JSON.stringify(header);
    const parentHeaderJson = JSON.stringify(parentHeader);
    const metadataJson = JSON.stringify({});
    const contentJson = JSON.stringify(content);

    // Create HMAC signature
    const hmac = crypto.createHmac('sha256', key);
    hmac.update(headerJson);
    hmac.update(parentHeaderJson);
    hmac.update(metadataJson);
    hmac.update(contentJson);
    const signature = hmac.digest('hex');

    // Build multipart message
    return [
      Buffer.from('<IDS|MSG>'),
      Buffer.from(signature),
      Buffer.from(headerJson),
      Buffer.from(parentHeaderJson),
      Buffer.from(metadataJson),
      Buffer.from(contentJson),
    ];
  }

  /**
   * Get or create kernel for a file (one notebook = one kernel)
   */
  async getOrCreateKernel(filePath: string, kernelName: string = 'python3'): Promise<string> {
    const normalizedPath = this.normalizePath(filePath);

    // Check for existing session
    const existingSessionId = this.fileToSession.get(normalizedPath);
    if (existingSessionId) {
      const session = this.sessions.get(existingSessionId);
      if (session && session.status !== 'dead') {
        // Check if kernel type matches
        if (session.kernelName === kernelName) {
          return existingSessionId;
        }
        // Kernel type changed, stop old and start new
        await this.stopKernel(existingSessionId);
      }
    }

    // Start new kernel
    return this.startKernel({
      kernelName,
      filePath: normalizedPath,
      cwd: path.dirname(normalizedPath),
    });
  }

  /**
   * Execute code in a kernel session
   */
  async executeCode(
    sessionId: string,
    code: string,
    onOutput: (output: KernelOutput) => Promise<void>
  ): Promise<ExecutionResult> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    if (!this.zmq || !this.zmqSockets.has(sessionId)) {
      // Fallback: no ZeroMQ, cannot execute
      await onOutput({ type: 'error', content: 'ZeroMQ not available for kernel communication' });
      return { status: 'error', executionCount: null, error: 'ZeroMQ not available' };
    }

    session.status = 'busy';
    const sockets = this.zmqSockets.get(sessionId)!;
    let execCount: number | null = null;

    try {
      // Create execute_request message
      const msgId = uuidv4();
      const header = {
        msg_id: msgId,
        session: sessionId,
        username: 'nebula',
        msg_type: 'execute_request',
        version: '5.3',
        date: new Date().toISOString(),
      };

      const content = {
        code,
        silent: false,
        store_history: true,
        user_expressions: {},
        allow_stdin: false,
        stop_on_error: true,
      };

      const message = this.createJupyterMessage(
        header,
        {},
        content,
        session.connectionConfig!.key
      );

      await sockets.shell.send(message);

      // Process iopub messages
      while (true) {
        const frames = await sockets.iopub.receive();
        const { msgType, content: msgContent, parentMsgId } = this.parseJupyterMessage(frames);

        // Only process messages for our execution
        if (parentMsgId !== msgId) {
          continue;
        }

        // Handle different message types
        if (msgType === 'execute_input') {
          execCount = msgContent.execution_count as number;
        } else if (msgType === 'stream') {
          const streamName = msgContent.name as string;
          await onOutput({
            type: streamName === 'stderr' ? 'stderr' : 'stdout',
            content: msgContent.text as string,
          });
        } else if (msgType === 'execute_result' || msgType === 'display_data') {
          const output = this.formatDisplayData(msgContent.data as Record<string, string>);
          if (output) {
            await onOutput(output);
          }
        } else if (msgType === 'error') {
          const traceback = (msgContent.traceback as string[]) || [];
          const cleanTb = traceback.map(line => this.stripAnsi(line)).join('\n');
          await onOutput({ type: 'error', content: cleanTb });
        } else if (msgType === 'status') {
          if (msgContent.execution_state === 'idle') {
            break;
          }
        }
      }

      session.executionCount = execCount || session.executionCount;
      session.status = 'idle';
      session.lastActivity = Date.now() / 1000;

      return { status: 'ok', executionCount: execCount };
    } catch (err) {
      session.status = 'idle';
      const errorMsg = err instanceof Error ? err.message : String(err);
      await onOutput({ type: 'error', content: errorMsg });
      return { status: 'error', executionCount: null, error: errorMsg };
    }
  }

  /**
   * Parse a Jupyter protocol message
   */
  private parseJupyterMessage(frames: Buffer[]): {
    msgType: string;
    content: Record<string, unknown>;
    parentMsgId: string;
  } {
    // Find delimiter
    let delimIdx = -1;
    for (let i = 0; i < frames.length; i++) {
      if (frames[i].toString() === '<IDS|MSG>') {
        delimIdx = i;
        break;
      }
    }

    if (delimIdx === -1) {
      throw new Error('Invalid Jupyter message: no delimiter found');
    }

    // Parse message parts after delimiter
    const signature = frames[delimIdx + 1].toString();
    const header = JSON.parse(frames[delimIdx + 2].toString());
    const parentHeader = JSON.parse(frames[delimIdx + 3].toString());
    const metadata = JSON.parse(frames[delimIdx + 4].toString());
    const content = JSON.parse(frames[delimIdx + 5].toString());

    return {
      msgType: header.msg_type,
      content,
      parentMsgId: parentHeader.msg_id || '',
    };
  }

  /**
   * Format display data for output
   */
  private formatDisplayData(data: Record<string, string>): KernelOutput | null {
    if ('image/png' in data) {
      return { type: 'image', content: data['image/png'] };
    }
    if ('text/html' in data) {
      return { type: 'html', content: data['text/html'] };
    }
    if ('text/plain' in data) {
      return { type: 'stdout', content: data['text/plain'] };
    }
    return null;
  }

  /**
   * Strip ANSI escape codes from text
   */
  private stripAnsi(text: string): string {
    return text.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
  }

  /**
   * Stop a kernel session
   */
  async stopKernel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Close ZeroMQ sockets
    const sockets = this.zmqSockets.get(sessionId);
    if (sockets) {
      try {
        sockets.shell.close();
        sockets.iopub.close();
      } catch {
        // Ignore close errors
      }
      this.zmqSockets.delete(sessionId);
    }

    // Kill kernel process
    const proc = this.kernelProcesses.get(sessionId);
    if (proc) {
      try {
        proc.kill('SIGTERM');
        // Wait for graceful shutdown
        await this.sleep(1000);
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignore kill errors
      }
      this.kernelProcesses.delete(sessionId);
    }

    // Cleanup resources
    this.cleanupKernelResources(sessionId);

    return true;
  }

  /**
   * Cleanup kernel resources
   */
  private cleanupKernelResources(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      // Remove file mapping
      if (session.filePath) {
        this.fileToSession.delete(session.filePath);
      }

      // Delete connection file
      if (session.connectionFile && fs.existsSync(session.connectionFile)) {
        try {
          fs.unlinkSync(session.connectionFile);
        } catch {
          // Ignore delete errors
        }
      }

      // Remove from sessions
      this.sessions.delete(sessionId);

      // Update persistence store
      this.sessionStore.deleteSession(sessionId);
    }
  }

  /**
   * Interrupt kernel execution
   */
  async interruptKernel(sessionId: string): Promise<boolean> {
    const proc = this.kernelProcesses.get(sessionId);
    if (proc) {
      try {
        proc.kill('SIGINT');
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  /**
   * Restart a kernel
   */
  async restartKernel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const { kernelName, filePath } = session;

    // Stop the existing kernel
    await this.stopKernel(sessionId);

    // Start a new one with the same settings
    try {
      const newSessionId = await this.startKernel({
        kernelName,
        filePath: filePath || undefined,
      });

      // Note: The session ID changes on restart
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get session status
   */
  getSessionStatus(sessionId: string): SessionInfo | null {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    return {
      id: session.id,
      kernelName: session.kernelName,
      filePath: session.filePath,
      status: session.status,
      executionCount: session.executionCount,
      pid: session.pid,
      memoryMb: null, // Would need platform-specific code
    };
  }

  /**
   * Get all sessions
   */
  getAllSessions(): SessionInfo[] {
    const sessions: SessionInfo[] = [];

    for (const [_, session] of this.sessions) {
      sessions.push({
        id: session.id,
        kernelName: session.kernelName,
        filePath: session.filePath,
        status: session.status,
        executionCount: session.executionCount,
        pid: session.pid,
        memoryMb: null,
      });
    }

    return sessions;
  }

  /**
   * Cleanup all sessions
   */
  async cleanup(): Promise<void> {
    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopKernel(sessionId);
    }
    this.sessionStore.close();
  }

  /**
   * Helper: sleep for ms milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Global instance
export const kernelService = new KernelService();
