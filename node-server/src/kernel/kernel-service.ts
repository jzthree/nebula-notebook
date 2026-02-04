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
import { spawn, exec, ChildProcess } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
import {
  KernelSession,
  KernelOutput,
  ExecutionResult,
  ExecutionQueueInfo,
  StartKernelOptions,
  SessionInfo,
  KernelServiceConfig,
  PersistedSession,
  ConnectionConfig,
  DEFAULT_CONFIG,
} from './types';
import {
  MAX_OUTPUT_LINES,
  MAX_OUTPUT_CHARS,
  MAX_OUTPUT_LINES_ERROR,
  MAX_OUTPUT_CHARS_ERROR,
} from '../config/output-limits';
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
  private executionQueues: Map<string, Promise<unknown>> = new Map();
  private executionQueueSizes: Map<string, number> = new Map();
  private shellRequestQueues: Map<string, Promise<unknown>> = new Map();
  private reattachInProgress = false;
  private serverId: string;
  private serverInstanceId: string;
  private legacyCleanupWarned: Set<string> = new Set();
  private outputSeq: Map<string, number> = new Map();
  private outputBuffers: Map<string, { seq: number; output: KernelOutput; cellId?: string | null }[]> = new Map();
  private outputLineCounts: Map<string, { regular: number; error: number }> = new Map();
  private outputCharCounts: Map<string, { regular: number; error: number }> = new Map();
  private outputTruncation: Map<string, { regular: boolean; error: boolean }> = new Map();

  constructor(config?: KernelServiceConfig, sessionStore?: SessionStore) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sessionStore = sessionStore || new SessionStore();
    this.serverId = process.env.NEBULA_SERVER_ID || 'local';
    this.serverInstanceId = process.env.NEBULA_SERVER_INSTANCE_ID || uuidv4();
  }

  setServerIdentity(serverId: string, serverInstanceId?: string): void {
    this.serverId = serverId;
    if (serverInstanceId) {
      this.serverInstanceId = serverInstanceId;
    }
  }

  /**
   * Check if a PID is still alive.
   */
  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load a Jupyter connection file.
   */
  private loadConnectionFile(connFile: string): ConnectionConfig | null {
    try {
      if (!connFile || !fs.existsSync(connFile)) {
        return null;
      }
      const raw = JSON.parse(fs.readFileSync(connFile, 'utf-8')) as Record<string, unknown>;
      return {
        ip: raw.ip as string,
        transport: raw.transport as string,
        signatureScheme: raw.signature_scheme as string,
        key: raw.key as string,
        shellPort: raw.shell_port as number,
        stdinPort: raw.stdin_port as number,
        controlPort: raw.control_port as number,
        iopubPort: raw.iopub_port as number,
        hbPort: raw.hb_port as number,
      };
    } catch {
      return null;
    }
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
   * Attempt to reattach to orphaned kernel sessions from a previous server run.
   */
  async reattachOrphanedSessions(): Promise<{ attempted: number; reattached: number; failed: number; skipped: number }> {
    if (this.reattachInProgress) {
      return { attempted: 0, reattached: 0, failed: 0, skipped: 0 };
    }
    this.reattachInProgress = true;
    try {
      await this.initialize();

      // Mark any previously active sessions (for this server) as orphaned
      this.sessionStore.markAllOrphaned(this.serverId, this.serverInstanceId);
      const orphanedSessions = this.sessionStore.getOrphanedSessions(this.serverId);

      if (orphanedSessions.length === 0) {
        return { attempted: 0, reattached: 0, failed: 0, skipped: 0 };
      }

      let reattached = 0;
      let failed = 0;
      let skipped = 0;

      for (const session of orphanedSessions) {
        const sessionId = session.sessionId;

        // Check if kernel process is still alive and matches recorded start time (if available)
        if (session.kernelPid) {
          if (!this.isPidAlive(session.kernelPid)) {
            this.sessionStore.updateStatus(sessionId, 'terminated');
            skipped++;
            continue;
          }
          if (session.kernelStartTime) {
            const currentStartTime = await this.getProcessStartTime(session.kernelPid);
            if (!currentStartTime || currentStartTime !== session.kernelStartTime) {
              this.sessionStore.updateStatus(sessionId, 'terminated');
              skipped++;
              continue;
            }
          }
        }

        // Try to get connection config: from file first, then from DB
        let connectionConfig: ConnectionConfig | null = null;
        if (session.connectionFile) {
          connectionConfig = this.loadConnectionFile(session.connectionFile);
        }
        // Fall back to DB-stored config if file is missing (e.g., temp cleanup)
        if (!connectionConfig && session.connectionConfig) {
          try {
            connectionConfig = JSON.parse(session.connectionConfig);
          } catch {
            // Invalid JSON in DB
          }
        }
        if (!connectionConfig) {
          console.log(`[Kernel] Skipping session ${sessionId}: no connection config available`);
          this.sessionStore.updateStatus(sessionId, 'terminated');
          skipped++;
          continue;
        }

        const normalizedFilePath = session.filePath ? this.normalizePath(session.filePath) : null;
        const now = Date.now() / 1000;
        const kernelSession: KernelSession = {
          id: sessionId,
          kernelName: session.kernelName,
          filePath: normalizedFilePath,
          status: 'starting',
          executionCount: 0,
          pid: session.kernelPid ?? null,
          connectionFile: session.connectionFile,
          connectionConfig,
          createdAt: session.createdAt,
          lastActivity: now,
        };

        this.sessions.set(sessionId, kernelSession);
        if (normalizedFilePath) {
          this.fileToSession.set(normalizedFilePath, sessionId);
        }

        try {
          // Use shorter timeout for reattach - kernel should already be running
          await this.waitForReady(sessionId, 10);
          kernelSession.status = 'idle';
          const kernelStartTime = session.kernelStartTime
            ?? (session.kernelPid ? await this.getProcessStartTime(session.kernelPid) : null);
          this.sessionStore.saveSession({
            sessionId,
            kernelName: session.kernelName,
            filePath: normalizedFilePath,
            kernelPid: session.kernelPid ?? null,
            serverId: this.serverId,
            serverInstanceId: this.serverInstanceId,
            kernelStartTime,
            status: 'active',
            createdAt: session.createdAt,
            lastHeartbeat: now,
            connectionFile: session.connectionFile,
            connectionConfig: JSON.stringify(connectionConfig),
          });
          reattached++;
          console.log(`[Kernel] Reattached session ${sessionId} for ${normalizedFilePath || 'no file'}`);
        } catch (err) {
          failed++;
          kernelSession.status = 'dead';
          this.cleanupInMemorySession(sessionId);
          this.sessionStore.updateStatus(sessionId, 'terminated');
          console.log(`[Kernel] Failed to reattach session ${sessionId}: ${err instanceof Error ? err.message : err}`);
        }
      }

      return {
        attempted: orphanedSessions.length,
        reattached,
        failed,
        skipped,
      };
    } finally {
      this.reattachInProgress = false;
    }
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
   * Normalize notebook path for external callers (e.g., routes).
   */
  normalizeNotebookPath(filePath: string): string {
    return this.normalizePath(filePath);
  }

  /**
   * Save kernel preference for a notebook file.
   */
  saveNotebookKernelPreference(filePath: string, kernelName: string, serverId?: string | null): void {
    const normalizedPath = this.normalizePath(filePath);
    this.sessionStore.saveNotebookKernelPreference(normalizedPath, kernelName, serverId);
  }

  /**
   * Get kernel preference for a notebook file.
   */
  getNotebookKernelPreference(filePath: string): { kernelName: string; serverId: string | null; updatedAt: number } | null {
    const normalizedPath = this.normalizePath(filePath);
    return this.sessionStore.getNotebookKernelPreference(normalizedPath);
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
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Log kernel stdout/stderr for debugging
    proc.stdout?.on('data', (data) => {
      console.log(`[Kernel ${sessionId.slice(0, 8)}] stdout: ${data.toString().trim()}`);
    });
    proc.stderr?.on('data', (data) => {
      console.error(`[Kernel ${sessionId.slice(0, 8)}] stderr: ${data.toString().trim()}`);
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

    const kernelStartTime = proc.pid ? await this.getProcessStartTime(proc.pid) : null;

    // Save to persistence store (include connection config for reattach if file is deleted)
    this.sessionStore.saveSession({
      sessionId,
      kernelName,
      filePath: normalizedFilePath,
      kernelPid: proc.pid || null,
      serverId: this.serverId,
      serverInstanceId: this.serverInstanceId,
      kernelStartTime,
      status: 'active',
      createdAt: now,
      lastHeartbeat: now,
      connectionFile: connFile,
      connectionConfig: JSON.stringify(session.connectionConfig),
    });

    session.status = 'idle';
    return sessionId;
  }

  /**
   * Wait for kernel to be ready by connecting to ZeroMQ channels
   * @param timeoutSeconds Optional override for startup timeout (default: use config)
   */
  private async waitForReady(sessionId: string, timeoutSeconds?: number): Promise<void> {
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
    const actualTimeout = timeoutSeconds ?? this.config.startupTimeoutSeconds;
    const timeout = actualTimeout * 1000;

    while (Date.now() - startTime < timeout) {
      try {
        await this.sendKernelInfoRequest(sessionId);
        // If we get here without error, kernel is ready
        return;
      } catch {
        await this.sleep(100);
      }
    }

    throw new Error(`Kernel did not start within ${actualTimeout} seconds`);
  }

  /**
   * Send kernel_info_request and wait for reply to verify kernel is ready
   * Throws if no reply received within timeout
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

    // Wait for kernel_info_reply with timeout
    const receivePromise = sockets.shell.receive();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Kernel not responding')), 1000);
    });

    const frames = await Promise.race([receivePromise, timeoutPromise]);
    const { msgType } = this.parseJupyterMessage(frames);

    if (msgType !== 'kernel_info_reply') {
      throw new Error(`Unexpected message type: ${msgType}`);
    }
    // Kernel is ready!
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
   * Get or create kernel for a file (one notebook = one kernel).
   * Returns whether a new session was created.
   */
  async getOrCreateKernel(filePath: string, kernelName: string = 'python3'): Promise<{ sessionId: string; created: boolean }> {
    const normalizedPath = this.normalizePath(filePath);

    // Check for existing session in fileToSession map
    let existingSessionId = this.fileToSession.get(normalizedPath);

    // Fallback: search all sessions for matching filePath (handles race after server restart)
    if (!existingSessionId) {
      for (const [sessionId, session] of this.sessions.entries()) {
        if (session.filePath === normalizedPath && session.status !== 'dead') {
          console.log(`[Kernel] Found orphaned session ${sessionId} for ${normalizedPath}, restoring fileToSession mapping`);
          this.fileToSession.set(normalizedPath, sessionId);
          existingSessionId = sessionId;
          break;
        }
      }
    }

    if (existingSessionId) {
      const session = this.sessions.get(existingSessionId);
      if (session && session.status !== 'dead') {
        // If session is stuck in 'starting' for too long, treat as dead
        if (session.status === 'starting') {
          const startingDuration = Date.now() / 1000 - session.lastActivity;
          // Allow a longer grace period for slow environments before declaring it stuck
          if (startingDuration > 120) {
            console.log(`[Kernel] Session ${existingSessionId} stuck in 'starting' for ${Math.round(startingDuration)}s, restarting`);
            await this.stopKernel(existingSessionId);
          } else {
            // Wait a bit and check if it becomes ready
            for (let i = 0; i < 20; i++) {
              await this.sleep(500);
              const updated = this.sessions.get(existingSessionId);
              if (!updated || updated.status === 'dead') break;
              if (updated.status === 'idle' || updated.status === 'busy') {
                if (updated.kernelName === kernelName) {
                  return { sessionId: existingSessionId, created: false };
                }
                break;
              }
            }
            // Still starting after wait; keep it rather than restarting unless it exceeds grace
            const stillStarting = this.sessions.get(existingSessionId);
            if (stillStarting?.status === 'starting') {
              console.log(`[Kernel] Session ${existingSessionId} still starting after wait; keeping it alive`);
              return { sessionId: existingSessionId, created: false };
            }
          }
        } else {
          // Session is idle or busy
          if (session.kernelName === kernelName) {
            return { sessionId: existingSessionId, created: false };
          }
          // Kernel type changed, stop old and start new
          await this.stopKernel(existingSessionId);
        }
      }
    }

    // Start new kernel
    const sessionId = await this.startKernel({
      kernelName,
      filePath: normalizedPath,
      cwd: path.dirname(normalizedPath),
    });
    return { sessionId, created: true };
  }

  /**
   * Get existing kernel session ID for a notebook file (if any).
   * Returns null if no live session is associated with the file.
   */
  getSessionIdForFile(filePath: string): string | null {
    const normalizedPath = this.normalizePath(filePath);

    let existingSessionId = this.fileToSession.get(normalizedPath);
    if (existingSessionId) {
      const session = this.sessions.get(existingSessionId);
      if (session && session.status !== 'dead') {
        return existingSessionId;
      }
    }

    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.filePath === normalizedPath && session.status !== 'dead') {
        this.fileToSession.set(normalizedPath, sessionId);
        existingSessionId = sessionId;
        break;
      }
    }

    return existingSessionId || null;
  }

  /**
   * Check if a kernel session exists.
   */
  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /**
   * Execute code in a kernel session
   */
  async executeCode(
    sessionId: string,
    code: string,
    onOutput: (entry: { seq: number; output: KernelOutput; cellId?: string | null }) => Promise<void>,
    onQueueInfo?: (info: ExecutionQueueInfo) => void,
    cellId?: string | null
  ): Promise<ExecutionResult> {
    const queueInfo = this.reserveExecutionSlot(sessionId);
    if (onQueueInfo) {
      onQueueInfo(queueInfo);
    }
    return this.enqueueExecution(sessionId, async () => {
      try {
        const result = await this.executeCodeInternal(sessionId, code, async (output) => {
          const entries = this.bufferOutput(sessionId, output, cellId);
          for (const entry of entries) {
            await onOutput(entry);
          }
        });
        return { ...result, ...queueInfo };
      } catch (err) {
        const errorMsg = this.formatExecutionError(err);
        const entries = this.bufferOutput(sessionId, { type: 'error', content: errorMsg }, cellId);
        for (const entry of entries) {
          await onOutput(entry);
        }
        return { status: 'error', executionCount: null, error: errorMsg, ...queueInfo };
      } finally {
        this.releaseExecutionSlot(sessionId);
      }
    });
  }

  private enqueueExecution<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.executionQueues.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const chain = run.catch(() => undefined);
    this.executionQueues.set(sessionId, chain);
    chain.finally(() => {
      if (this.executionQueues.get(sessionId) === chain) {
        this.executionQueues.delete(sessionId);
      }
    });
    return run;
  }

  /**
   * Queue shell socket requests to prevent concurrent receive operations
   */
  private enqueueShellRequest<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.shellRequestQueues.get(sessionId) || Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    const chain = run.catch(() => undefined);
    this.shellRequestQueues.set(sessionId, chain);
    chain.finally(() => {
      if (this.shellRequestQueues.get(sessionId) === chain) {
        this.shellRequestQueues.delete(sessionId);
      }
    });
    return run;
  }

  private reserveExecutionSlot(sessionId: string): ExecutionQueueInfo {
    const currentSize = this.executionQueueSizes.get(sessionId) ?? 0;
    const info = {
      queuePosition: currentSize,
      queueLength: currentSize + 1,
    };
    this.executionQueueSizes.set(sessionId, currentSize + 1);
    return info;
  }

  private releaseExecutionSlot(sessionId: string): void {
    const currentSize = this.executionQueueSizes.get(sessionId) ?? 0;
    if (currentSize <= 1) {
      this.executionQueueSizes.delete(sessionId);
    } else {
      this.executionQueueSizes.set(sessionId, currentSize - 1);
    }
  }

  private formatExecutionError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('Socket is busy reading')) {
      return 'Kernel output stream is busy because another execution is running. Wait for it to finish or poll with read_output before starting a new execute_cell.';
    }
    return message;
  }

  private async executeCodeInternal(
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
      const errorMsg = 'ZeroMQ not available for kernel communication';
      await onOutput({ type: 'error', content: errorMsg });
      return { status: 'error', executionCount: null, error: errorMsg };
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
      const errorMsg = this.formatExecutionError(err);
      await onOutput({ type: 'error', content: errorMsg });
      return { status: 'error', executionCount: null, error: errorMsg };
    }
  }

  /**
   * Request code completion from the kernel
   * Uses a separate queue for shell socket operations to avoid "socket busy" errors
   */
  async complete(
    sessionId: string,
    code: string,
    cursorPos: number
  ): Promise<{ status: string; matches: string[]; cursor_start: number; cursor_end: number }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    if (!this.zmq || !this.zmqSockets.has(sessionId)) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    // Queue completion requests to avoid "socket busy" errors
    return this.enqueueShellRequest(sessionId, () =>
      this.completeInternal(sessionId, code, cursorPos)
    );
  }

  /**
   * Internal completion implementation (runs within shell queue)
   */
  private async completeInternal(
    sessionId: string,
    code: string,
    cursorPos: number
  ): Promise<{ status: string; matches: string[]; cursor_start: number; cursor_end: number }> {
    const session = this.sessions.get(sessionId);
    const sockets = this.zmqSockets.get(sessionId);

    if (!session || !sockets) {
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
    }

    try {
      // Create complete_request message
      const msgId = uuidv4();
      const header = {
        msg_id: msgId,
        session: sessionId,
        username: 'nebula',
        msg_type: 'complete_request',
        version: '5.3',
        date: new Date().toISOString(),
      };

      const content = {
        code,
        cursor_pos: cursorPos,
      };

      const message = this.createJupyterMessage(
        header,
        {},
        content,
        session.connectionConfig!.key
      );

      await sockets.shell.send(message);

      // Wait for complete_reply with timeout
      const timeoutPromise = new Promise<null>((resolve) => {
        setTimeout(() => resolve(null), 3000);
      });

      const receivePromise = (async () => {
        while (true) {
          const frames = await sockets.shell.receive();
          const { msgType, content: msgContent, parentMsgId } = this.parseJupyterMessage(frames);

          if (parentMsgId === msgId && msgType === 'complete_reply') {
            return {
              status: (msgContent.status as string) || 'ok',
              matches: (msgContent.matches as string[]) || [],
              cursor_start: (msgContent.cursor_start as number) ?? cursorPos,
              cursor_end: (msgContent.cursor_end as number) ?? cursorPos,
            };
          }
        }
      })();

      const result = await Promise.race([receivePromise, timeoutPromise]);

      if (result === null) {
        return { status: 'timeout', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
      }

      return result;
    } catch (err) {
      console.error('[KernelService] Completion error:', err);
      return { status: 'error', matches: [], cursor_start: cursorPos, cursor_end: cursorPos };
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

  private getOutputStats(output: KernelOutput): { lines: number; chars: number; isError: boolean } {
    const isError = output.type === 'error';
    const chars = output.content?.length || 0;
    const lines = output.type === 'image' || output.type === 'html'
      ? 0
      : (output.content?.match(/\n/g) || []).length + 1;
    return { lines, chars, isError };
  }

  private ensureOutputTracking(sessionId: string): void {
    if (!this.outputLineCounts.has(sessionId)) {
      this.outputLineCounts.set(sessionId, { regular: 0, error: 0 });
    }
    if (!this.outputCharCounts.has(sessionId)) {
      this.outputCharCounts.set(sessionId, { regular: 0, error: 0 });
    }
    if (!this.outputTruncation.has(sessionId)) {
      this.outputTruncation.set(sessionId, { regular: false, error: false });
    }
    if (!this.outputSeq.has(sessionId)) {
      this.outputSeq.set(sessionId, 0);
    }
    if (!this.outputBuffers.has(sessionId)) {
      this.outputBuffers.set(sessionId, []);
    }
  }

  private appendBufferedOutput(sessionId: string, output: KernelOutput, cellId?: string | null): { seq: number; output: KernelOutput; cellId?: string | null } {
    this.ensureOutputTracking(sessionId);
    const nextSeq = (this.outputSeq.get(sessionId) ?? 0) + 1;
    this.outputSeq.set(sessionId, nextSeq);
    const entry = { seq: nextSeq, output, cellId };
    const buffer = this.outputBuffers.get(sessionId)!;
    buffer.push(entry);
    return entry;
  }

  private bufferOutput(
    sessionId: string,
    output: KernelOutput,
    cellId?: string | null
  ): { seq: number; output: KernelOutput; cellId?: string | null }[] {
    this.ensureOutputTracking(sessionId);

    const stats = this.getOutputStats(output);
    const lineCounts = this.outputLineCounts.get(sessionId)!;
    const charCounts = this.outputCharCounts.get(sessionId)!;
    const truncation = this.outputTruncation.get(sessionId)!;

    const maxLines = stats.isError ? MAX_OUTPUT_LINES_ERROR : MAX_OUTPUT_LINES;
    const maxChars = stats.isError ? MAX_OUTPUT_CHARS_ERROR : MAX_OUTPUT_CHARS;
    const currentLines = stats.isError ? lineCounts.error : lineCounts.regular;
    const currentChars = stats.isError ? charCounts.error : charCounts.regular;

    if (currentLines + stats.lines > maxLines || currentChars + stats.chars > maxChars) {
      const bucket = stats.isError ? 'error' : 'regular';
      if (!truncation[bucket]) {
        truncation[bucket] = true;
        const warning: KernelOutput = {
          type: 'stderr',
          content: `\n⚠️ Output limit reached. Additional output not displayed.`,
        };
        const warningStats = this.getOutputStats(warning);
        lineCounts.regular += warningStats.lines;
        charCounts.regular += warningStats.chars;
        return [this.appendBufferedOutput(sessionId, warning, cellId)];
      }
      return [];
    }

    if (stats.isError) {
      lineCounts.error += stats.lines;
      charCounts.error += stats.chars;
    } else {
      lineCounts.regular += stats.lines;
      charCounts.regular += stats.chars;
    }

    return [this.appendBufferedOutput(sessionId, output, cellId)];
  }

  getBufferedOutputs(sessionId: string, sinceSeq: number = 0): { outputs: { seq: number; output: KernelOutput; cellId?: string | null }[]; latestSeq: number } {
    this.ensureOutputTracking(sessionId);
    const buffer = this.outputBuffers.get(sessionId)!;
    const outputs = buffer.filter(entry => entry.seq > sinceSeq);
    const latestSeq = this.outputSeq.get(sessionId) ?? 0;
    return { outputs, latestSeq };
  }

  ackOutputs(sessionId: string, upToSeq: number): void {
    if (!this.outputBuffers.has(sessionId)) return;
    const buffer = this.outputBuffers.get(sessionId)!;
    if (buffer.length === 0) return;
    const remaining = buffer.filter(entry => entry.seq > upToSeq);
    this.outputBuffers.set(sessionId, remaining);

    // Recompute counts to allow output to resume after acknowledgements.
    const lineCounts = { regular: 0, error: 0 };
    const charCounts = { regular: 0, error: 0 };
    for (const entry of remaining) {
      const stats = this.getOutputStats(entry.output);
      if (stats.isError) {
        lineCounts.error += stats.lines;
        charCounts.error += stats.chars;
      } else {
        lineCounts.regular += stats.lines;
        charCounts.regular += stats.chars;
      }
    }
    this.outputLineCounts.set(sessionId, lineCounts);
    this.outputCharCounts.set(sessionId, charCounts);

    const truncation = this.outputTruncation.get(sessionId) || { regular: false, error: false };
    truncation.regular = lineCounts.regular >= MAX_OUTPUT_LINES || charCounts.regular >= MAX_OUTPUT_CHARS;
    truncation.error = lineCounts.error >= MAX_OUTPUT_LINES_ERROR || charCounts.error >= MAX_OUTPUT_CHARS_ERROR;
    this.outputTruncation.set(sessionId, truncation);
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
    } else if (session.pid) {
      try {
        process.kill(session.pid, 'SIGTERM');
        await this.sleep(1000);
        if (this.isPidAlive(session.pid)) {
          process.kill(session.pid, 'SIGKILL');
        }
      } catch {
        // Ignore kill errors
      }
    }

    // Cleanup resources
    this.cleanupKernelResources(sessionId);

    return true;
  }

  /**
   * Check command line for a PID (best-effort).
   */
  private async getPidCommand(pid: number): Promise<string | null> {
    try {
      if (process.platform === 'linux') {
        const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
        const cmdline = raw.toString('utf8').replace(/\0/g, ' ').trim();
        return cmdline || null;
      }
      const { stdout } = await execAsync(`ps -o command= -p ${pid}`, { timeout: 500 });
      const cmd = stdout.trim();
      return cmd.length > 0 ? cmd : null;
    } catch {
      return null;
    }
  }

  /**
   * Get process start time (best-effort), used to prevent PID reuse mistakes.
   */
  private async getProcessStartTime(pid: number): Promise<string | null> {
    try {
      const { stdout } = await execAsync(`ps -o lstart= -p ${pid}`, { timeout: 500 });
      const startTime = stdout.trim();
      return startTime.length > 0 ? startTime : null;
    } catch {
      return null;
    }
  }

  /**
   * Best-effort check to ensure the PID is a kernel process we started.
   */
  private async isExpectedKernelProcess(
    pid: number,
    connectionFile: string | null,
    expectedStartTime?: string | null
  ): Promise<boolean> {
    if (expectedStartTime) {
      const currentStartTime = await this.getProcessStartTime(pid);
      if (currentStartTime && currentStartTime === expectedStartTime) {
        return true;
      }
      return false;
    }
    const cmd = await this.getPidCommand(pid);
    if (!cmd) return false;
    if (connectionFile && cmd.includes(connectionFile)) {
      return true;
    }
    // Fallback: ensure it's an ipykernel process before killing
    return cmd.includes('ipykernel_launcher') || cmd.includes('ipykernel');
  }

  /**
   * Attempt to terminate a PID gracefully, then force kill.
   */
  private async terminatePid(pid: number): Promise<boolean> {
    if (!this.isPidAlive(pid)) return true;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Ignore kill errors
    }
    await this.sleep(500);
    if (this.isPidAlive(pid)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // Ignore kill errors
      }
    }
    await this.sleep(200);
    return !this.isPidAlive(pid);
  }

  private cleanupPersistedSessionArtifacts(session: PersistedSession): void {
    if (session.connectionFile && fs.existsSync(session.connectionFile)) {
      try {
        fs.unlinkSync(session.connectionFile);
      } catch {
        // Ignore delete errors
      }
    }
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

    this.executionQueues.delete(sessionId);
    this.executionQueueSizes.delete(sessionId);
    this.shellRequestQueues.delete(sessionId);
    this.outputSeq.delete(sessionId);
    this.outputBuffers.delete(sessionId);
    this.outputLineCounts.delete(sessionId);
    this.outputCharCounts.delete(sessionId);
  }

  /**
   * Cleanup only in-memory tracking for a session (keeps connection file and session store).
   */
  private cleanupInMemorySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session?.filePath) {
      this.fileToSession.delete(session.filePath);
    }

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

    this.sessions.delete(sessionId);
    this.kernelProcesses.delete(sessionId);
    this.executionQueues.delete(sessionId);
    this.executionQueueSizes.delete(sessionId);
    this.shellRequestQueues.delete(sessionId);
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
   * Restart a kernel (in-place, preserving session ID like Python)
   */
  async restartKernel(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    const { kernelName, filePath, connectionFile: oldConnFile } = session;

    // Set status to restarting
    session.status = 'starting';

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

    // Kill existing kernel process
    const proc = this.kernelProcesses.get(sessionId);
    if (proc) {
      try {
        proc.kill('SIGTERM');
        await this.sleep(500);
        if (!proc.killed) {
          proc.kill('SIGKILL');
        }
      } catch {
        // Ignore kill errors
      }
      this.kernelProcesses.delete(sessionId);
    }

    // Delete old connection file
    if (oldConnFile && fs.existsSync(oldConnFile)) {
      try {
        fs.unlinkSync(oldConnFile);
      } catch {
        // Ignore delete errors
      }
    }

    // Get kernel spec
    const spec = getKernelSpec(kernelName);
    if (!spec) {
      session.status = 'dead';
      return false;
    }

    try {
      // Generate new connection file (reusing same session ID)
      const { config: connConfig, filePath: connFile } = this.generateConnectionFile(sessionId);

      // Build kernel command
      const argv = (spec.argv || []).map(arg =>
        arg.replace('{connection_file}', connFile)
      );

      // Spawn new kernel process
      const cwd = filePath ? path.dirname(filePath) : process.cwd();
      const newProc = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      // Log kernel stdout/stderr
      newProc.stdout?.on('data', (data) => {
        console.log(`[Kernel ${sessionId.slice(0, 8)}] stdout: ${data.toString().trim()}`);
      });
      newProc.stderr?.on('data', (data) => {
        console.error(`[Kernel ${sessionId.slice(0, 8)}] stderr: ${data.toString().trim()}`);
      });

      // Update session in-place
      session.connectionFile = connFile;
      session.connectionConfig = connConfig;
      session.pid = newProc.pid || null;
      session.executionCount = 0;
      session.lastActivity = Date.now() / 1000;

      this.kernelProcesses.set(sessionId, newProc);

      // Handle process events
      newProc.on('error', (err) => {
        console.error(`Kernel ${sessionId} error:`, err);
        session.status = 'dead';
      });

      newProc.on('exit', (code) => {
        console.log(`Kernel ${sessionId} exited with code ${code}`);
        session.status = 'dead';
      });

      // Wait for kernel to be ready
      await this.waitForReady(sessionId);

      const kernelStartTime = newProc.pid ? await this.getProcessStartTime(newProc.pid) : null;

      // Update persistence store
      this.sessionStore.saveSession({
        sessionId,
        kernelName,
        filePath,
        kernelPid: newProc.pid || null,
        serverId: this.serverId,
        serverInstanceId: this.serverInstanceId,
        kernelStartTime,
        status: 'active',
        createdAt: session.createdAt,
        lastHeartbeat: Date.now() / 1000,
        connectionFile: connFile,
        connectionConfig: JSON.stringify(session.connectionConfig),
      });

      session.status = 'idle';
      return true;
    } catch (err) {
      console.error(`Failed to restart kernel ${sessionId}:`, err);
      session.status = 'dead';
      return false;
    }
  }

  /**
   * Get session status
   */
  async getSessionStatus(sessionId: string): Promise<SessionInfo | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return null;
    }

    const memoryMap = session.pid ? await this.getProcessMemoryMap([session.pid]) : new Map();

    return {
      id: session.id,
      kernelName: session.kernelName,
      filePath: session.filePath,
      status: session.status,
      executionCount: session.executionCount,
      pid: session.pid,
      memoryMb: session.pid ? (memoryMap.get(session.pid) ?? null) : null,
      createdAt: session.createdAt,
    };
  }

  /**
   * Get all sessions
   */
  async getAllSessions(): Promise<SessionInfo[]> {
    // Collect all PIDs for batch memory lookup
    const pids: number[] = [];
    for (const session of this.sessions.values()) {
      if (session.pid) pids.push(session.pid);
    }

    // Single ps call for all PIDs
    const memoryMap = await this.getProcessMemoryMap(pids);

    const sessions: SessionInfo[] = [];
    for (const [_, session] of this.sessions) {
      sessions.push({
        id: session.id,
        kernelName: session.kernelName,
        filePath: session.filePath,
        status: session.status,
        executionCount: session.executionCount,
        pid: session.pid,
        memoryMb: session.pid ? (memoryMap.get(session.pid) ?? null) : null,
        createdAt: session.createdAt,
      });
    }

    return sessions;
  }

  /**
   * Get dead sessions (orphaned or terminated) that can be cleaned up
   */
  getDeadSessions(): { sessionId: string; kernelName: string; filePath: string | null; status: string; lastHeartbeat: number }[] {
    const deadSessions = this.sessionStore.getDeadSessions(this.serverId);
    return deadSessions.map(s => ({
      sessionId: s.sessionId,
      kernelName: s.kernelName,
      filePath: s.filePath,
      status: s.status,
      lastHeartbeat: s.lastHeartbeat,
    }));
  }

  /**
   * Cleanup dead sessions by deleting them from the database
   */
  async cleanupDeadSessions(sessionIds?: string[]): Promise<number> {
    const deadSessions = this.sessionStore.getDeadSessions(this.serverId);
    const targets = sessionIds && sessionIds.length > 0
      ? deadSessions.filter(s => sessionIds.includes(s.sessionId))
      : deadSessions;
    const deletableIds: string[] = [];

    for (const session of targets) {
      let canDelete = true;
      if (session.kernelPid && this.isPidAlive(session.kernelPid)) {
        if (!session.kernelStartTime && !this.legacyCleanupWarned.has(session.sessionId)) {
          console.warn(
            `[Kernel] Deprecated cleanup fallback for session ${session.sessionId}: kernel_start_time missing. ` +
              'This fallback will be removed after legacy sessions are cleaned up.'
          );
          this.legacyCleanupWarned.add(session.sessionId);
        }
        const expected = await this.isExpectedKernelProcess(
          session.kernelPid,
          session.connectionFile,
          session.kernelStartTime
        );
        if (!expected) {
          canDelete = false;
        } else {
          const killed = await this.terminatePid(session.kernelPid);
          if (!killed) {
            canDelete = false;
          }
        }
      }

      if (canDelete) {
        this.cleanupPersistedSessionArtifacts(session);
        deletableIds.push(session.sessionId);
      }
    }

    if (deletableIds.length === 0) {
      return 0;
    }

    return this.sessionStore.deleteSessions(deletableIds);
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
   * Shutdown kernel service.
   * If preserveKernels is true, keep kernel processes running and close the session store.
   */
  async shutdown(options?: { preserveKernels?: boolean }): Promise<void> {
    if (options?.preserveKernels) {
      try {
        this.sessionStore.markAllOrphaned(this.serverId, this.serverInstanceId);
      } catch {
        // Ignore errors marking orphaned
      }
      this.sessionStore.close();
      return;
    }
    await this.cleanup();
  }

  /**
   * Helper: sleep for ms milliseconds
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Get memory usage (RSS) for multiple processes in MB
   * Returns a map of pid -> memoryMb
   * Cross-platform: uses /proc on Linux, ps on macOS
   */
  private async getProcessMemoryMap(pids: number[]): Promise<Map<number, number>> {
    const result = new Map<number, number>();
    if (pids.length === 0) return result;

    const isLinux = process.platform === 'linux';

    if (isLinux) {
      // On Linux, read directly from /proc/{pid}/statm (more reliable)
      // statm format: size resident shared text lib data dt (all in pages)
      // resident (2nd field) * page_size = RSS in bytes
      const pageSize = 4096; // Standard page size, could use os.constants.POSIX.PAGE_SIZE
      const fs = await import('fs/promises');

      await Promise.all(pids.map(async (pid) => {
        try {
          const statm = await fs.readFile(`/proc/${pid}/statm`, 'utf8');
          const fields = statm.trim().split(/\s+/);
          if (fields.length >= 2) {
            const residentPages = parseInt(fields[1], 10);
            if (!isNaN(residentPages)) {
              const rssBytes = residentPages * pageSize;
              result.set(pid, Math.round(rssBytes / 1024 / 1024 * 10) / 10);
            }
          }
        } catch {
          // Process may have exited or permission denied
        }
      }));
    } else {
      // macOS/BSD: use ps command with comma-separated PIDs
      try {
        const pidList = pids.join(',');
        const { stdout } = await execAsync(`ps -o pid=,rss= -p ${pidList}`, { timeout: 500 });

        for (const line of stdout.trim().split('\n')) {
          const parts = line.trim().split(/\s+/);
          if (parts.length >= 2) {
            const pid = parseInt(parts[0], 10);
            const rssKb = parseInt(parts[1], 10);
            if (!isNaN(pid) && !isNaN(rssKb)) {
              result.set(pid, Math.round(rssKb / 1024 * 10) / 10);
            }
          }
        }
      } catch {
        // ps command failed or timed out
      }
    }

    return result;
  }
}

// Global instance
export const kernelService = new KernelService();
