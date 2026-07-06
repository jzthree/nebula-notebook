/**
 * Widget Manager - per-kernel-session ipywidgets support (frontend half).
 *
 * Bridges @jupyter-widgets/html-manager to the simplified comm protocol the
 * node-server exposes on the kernel WebSocket:
 *   -> { type: 'comm', comm: { msg_type, comm_id, target_name?, data, buffers? } }
 *   -> { type: 'comm_info' }  =>  { type: 'comm_info_reply', comms: {...} }
 *
 * Design notes:
 * - One manager per kernel session, created lazily via getWidgetManager().
 *   The heavy @jupyter-widgets/* stack is loaded with a dynamic import() so
 *   Vite splits it into a separate chunk that only loads when a widget output
 *   is first rendered.
 * - Widget MODEL state lives here (not in React components). The cell list is
 *   virtualized: components create/destroy VIEWS on mount/unmount, and models
 *   survive so a cell scrolled back into view re-renders its widget.
 * - Comm messages that arrive while the manager chunk is still loading are
 *   queued and flushed once the manager is ready.
 * - On manager creation we restore pre-existing widget state from the kernel
 *   (control-comm `request_states`, falling back to comm_info + per-comm
 *   `request_state`), so widgets created before this page connected are live.
 * - On kernel restart/dead the manager is disposed so stale comms don't leak.
 *
 * Protocol limitations (documented deviations from the full Jupyter protocol):
 * - The WS contract carries no `metadata`, so the widget protocol version from
 *   the kernel's comm_open is not available; we assume protocol 2.x (ipywidgets 7/8).
 * - There is no message-id correlation, so `echo_update` messages are dropped
 *   (equivalent to a client without echo support; plain `update`s still apply).
 */
import type {
  DOMWidgetModel,
  DOMWidgetView,
  IClassicComm,
  ICallbacks,
  WidgetModel,
  WidgetView,
} from '@jupyter-widgets/base';
import { kernelService, CommMessage, CommInfoReply } from './kernelService';

/** Handle for a rendered widget view. dispose() destroys the VIEW only — the
 * model stays alive in the manager so the widget can re-render later. */
export interface WidgetViewHandle {
  dispose(): void;
}

/** Public surface of a per-session widget manager. */
export interface NebulaWidgetManager {
  readonly sessionId: string;
  /** True if the widget model is known (live) in this manager. */
  hasModel(modelId: string): boolean;
  /**
   * Render a widget model into a host element. Resolves null when the model
   * is not live (e.g. it predates the current kernel/page).
   */
  renderModel(modelId: string, host: HTMLElement): Promise<WidgetViewHandle | null>;
}

interface ManagerInternal extends NebulaWidgetManager {
  handleComm(comm: CommMessage): void;
  disposeManager(): void;
  /** Live widget state in application/vnd.jupyter.widget-state+json format. */
  getStateSnapshot(): Promise<Record<string, unknown>>;
}

interface ManagerEntry {
  promise: Promise<ManagerInternal>;
  /** Comm messages received while the manager chunk is still loading. */
  queue: CommMessage[];
  deliver: ((comm: CommMessage) => void) | null;
  unsubscribeComm: () => void;
  disposed: boolean;
}

const managerEntries = new Map<string, ManagerEntry>();

/** Cap on waiting for pre-existing widget state restore at manager creation. */
const STATE_RESTORE_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Buffer conversion: WS contract uses base64 strings; widgets use ArrayBuffers.
// ---------------------------------------------------------------------------

function encodeBuffers(
  buffers?: (ArrayBuffer | ArrayBufferView)[],
): string[] | undefined {
  if (!buffers || buffers.length === 0) return undefined;
  return buffers.map((buffer) => {
    const bytes =
      buffer instanceof ArrayBuffer
        ? new Uint8Array(buffer)
        : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    // Chunked conversion avoids call-stack limits on large buffers.
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  });
}

function decodeBuffers(buffers?: string[]): DataView[] {
  if (!buffers || buffers.length === 0) return [];
  return buffers.map((b64) => {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new DataView(bytes.buffer);
  });
}

// ---------------------------------------------------------------------------
// Jupyter message synthesis: the widget stack expects Jupyter-shaped messages
// (header/parent_header/content/buffers); reconstruct them from the WS payload.
// ---------------------------------------------------------------------------

function toJupyterMessage(comm: CommMessage, parentMsgId: string): any {
  const content: Record<string, unknown> = {
    comm_id: comm.comm_id,
    data: comm.data ?? {},
  };
  if (comm.msg_type === 'comm_open') {
    content.target_name = comm.target_name;
  }
  return {
    header: {
      msg_id: crypto.randomUUID(),
      msg_type: comm.msg_type,
      username: '',
      session: '',
      date: new Date().toISOString(),
      version: '5.2',
    },
    // The transport has no real correlation; stamping the last message sent on
    // this comm satisfies the base manager's request_state reply matching.
    parent_header: parentMsgId ? { msg_id: parentMsgId } : {},
    // The WS contract drops metadata; assume widget protocol 2.x for comm_open.
    metadata: comm.msg_type === 'comm_open' ? { version: '2.1.0' } : {},
    content,
    buffers: decodeBuffers(comm.buffers),
    channel: 'iopub',
  };
}

// ---------------------------------------------------------------------------
// Kernel lifecycle: dispose managers when their kernel dies or restarts.
// ---------------------------------------------------------------------------

let statusSubscriptionInstalled = false;

function ensureStatusSubscription(): void {
  if (statusSubscriptionInstalled) return;
  statusSubscriptionInstalled = true;
  kernelService.onStatus((sessionId, status) => {
    // 'dead': kernel gone. 'starting': kernel (re)starting — any manager that
    // already exists for the session holds comms from the previous kernel
    // process, so it must be disposed either way.
    if ((status === 'dead' || status === 'starting') && managerEntries.has(sessionId)) {
      console.log(`[widgets] Kernel ${status} — disposing widget manager for session ${sessionId}`);
      disposeWidgetManager(sessionId);
    }
  });
}

/**
 * Dispose the widget manager for a session (kernel died/restarted or session
 * shut down). The next getWidgetManager() call creates a fresh manager.
 */
export function disposeWidgetManager(sessionId: string): void {
  const entry = managerEntries.get(sessionId);
  if (!entry) return;
  managerEntries.delete(sessionId);
  entry.disposed = true;
  entry.deliver = null;
  entry.queue.length = 0;
  entry.unsubscribeComm();
  entry.promise
    .then((manager) => manager.disposeManager())
    .catch(() => {
      /* manager never finished loading — nothing to dispose */
    });
}

/**
 * Snapshot the live widget state for a session in
 * application/vnd.jupyter.widget-state+json format — WITHOUT loading the lazy
 * widget chunk. Returns null when no manager was ever created for the session
 * (no widgets in use this page-load), so callers can skip persistence and
 * leave any previously saved metadata.widgets untouched.
 */
export async function peekWidgetStateSnapshot(sessionId: string): Promise<Record<string, unknown> | null> {
  const entry = managerEntries.get(sessionId);
  if (!entry || entry.disposed) return null;
  try {
    const manager = await entry.promise;
    return await manager.getStateSnapshot();
  } catch {
    return null;
  }
}

/**
 * Get (lazily creating) the widget manager for a kernel session.
 * The @jupyter-widgets stack is dynamic-imported on first call.
 */
export function getWidgetManager(sessionId: string): Promise<NebulaWidgetManager> {
  ensureStatusSubscription();

  const existing = managerEntries.get(sessionId);
  if (existing) return existing.promise;

  const entry: ManagerEntry = {
    promise: undefined as unknown as Promise<ManagerInternal>,
    queue: [],
    deliver: null,
    unsubscribeComm: () => undefined,
    disposed: false,
  };

  // Subscribe synchronously so comm messages arriving while the manager chunk
  // loads are not lost — they are queued and flushed once the manager is ready.
  entry.unsubscribeComm = kernelService.onComm((sid, comm) => {
    if (sid !== sessionId || entry.disposed) return;
    if (entry.deliver) {
      entry.deliver(comm);
    } else {
      entry.queue.push(comm);
    }
  });

  entry.promise = createManager(sessionId, entry).catch((err) => {
    // Failed to load/create — clear the entry so a later render can retry.
    if (managerEntries.get(sessionId) === entry) {
      entry.unsubscribeComm();
      managerEntries.delete(sessionId);
    }
    throw err;
  });
  managerEntries.set(sessionId, entry);
  return entry.promise;
}

async function createManager(sessionId: string, entry: ManagerEntry): Promise<ManagerInternal> {
  // Lazy chunk: the whole @jupyter-widgets stack + CSS loads only when the
  // first widget output renders. base/controls are imported explicitly because
  // HTMLManager.loadClass resolves them with CommonJS require(), which does
  // not exist in a Vite browser bundle — we override loadClass below instead.
  const [{ HTMLManager }, baseModule, controlsModule] = await Promise.all([
    import('@jupyter-widgets/html-manager'),
    import('@jupyter-widgets/base'),
    import('@jupyter-widgets/controls'),
    // @ts-expect-error - CSS import is resolved by Vite, not tsc
    import('@jupyter-widgets/controls/css/widgets.css'),
  ]);

  /**
   * IClassicComm implementation backed by kernelService.sendComm().
   * Incoming traffic is delivered via handleIncoming() from the manager.
   */
  class NebulaComm implements IClassicComm {
    private onMsgCallback: ((msg: any) => void) | null = null;
    private onCloseCallback: ((msg: any) => void) | null = null;
    // Messages that arrived before on_msg was registered (e.g. an update sent
    // right after comm_open, while the widget model is still being built).
    private pendingMessages: any[] = [];
    private lastSentMsgId = '';
    private closed = false;

    constructor(
      readonly comm_id: string,
      readonly target_name: string,
      private readonly onLocalClose: (commId: string) => void,
    ) {}

    private nextMsgId(): string {
      this.lastSentMsgId = crypto.randomUUID();
      return this.lastSentMsgId;
    }

    open(
      data: unknown,
      _callbacks?: ICallbacks,
      _metadata?: unknown,
      buffers?: (ArrayBuffer | ArrayBufferView)[],
    ): string {
      kernelService.sendComm(sessionId, {
        msg_type: 'comm_open',
        comm_id: this.comm_id,
        target_name: this.target_name,
        data: (data ?? {}) as Record<string, unknown>,
        buffers: encodeBuffers(buffers),
      });
      return this.nextMsgId();
    }

    send(
      data: unknown,
      _callbacks?: ICallbacks,
      _metadata?: unknown,
      buffers?: (ArrayBuffer | ArrayBufferView)[],
    ): string {
      if (this.closed) return '';
      kernelService.sendComm(sessionId, {
        msg_type: 'comm_msg',
        comm_id: this.comm_id,
        data: (data ?? {}) as Record<string, unknown>,
        buffers: encodeBuffers(buffers),
      });
      return this.nextMsgId();
    }

    close(
      data?: unknown,
      _callbacks?: ICallbacks,
      _metadata?: unknown,
      buffers?: (ArrayBuffer | ArrayBufferView)[],
    ): string {
      if (this.closed) return '';
      this.closed = true;
      kernelService.sendComm(sessionId, {
        msg_type: 'comm_close',
        comm_id: this.comm_id,
        data: (data ?? {}) as Record<string, unknown>,
        buffers: encodeBuffers(buffers),
      });
      this.onLocalClose(this.comm_id);
      return this.nextMsgId();
    }

    on_msg(callback: (msg: any) => void): void {
      this.onMsgCallback = callback;
      const pending = this.pendingMessages.splice(0);
      for (const msg of pending) {
        try {
          callback(msg);
        } catch (err) {
          console.error('[widgets] Comm message handler error:', err);
        }
      }
    }

    on_close(callback: (msg: any) => void): void {
      this.onCloseCallback = callback;
    }

    /** Deliver a kernel->browser message for this comm. */
    handleIncoming(comm: CommMessage): void {
      if (comm.msg_type === 'comm_close') {
        this.closed = true;
        this.onCloseCallback?.(toJupyterMessage(comm, this.lastSentMsgId));
        return;
      }
      // No msg-id correlation over this transport: drop echo_update (clients
      // without echo support are allowed to ignore these per the widget spec).
      const method = (comm.data as { method?: string } | undefined)?.method;
      if (method === 'echo_update') return;
      const msg = toJupyterMessage(comm, this.lastSentMsgId);
      if (this.onMsgCallback) {
        this.onMsgCallback(msg);
      } else {
        this.pendingMessages.push(msg);
      }
    }
  }

  class Manager extends HTMLManager implements ManagerInternal {
    readonly sessionId = sessionId;
    private comms = new Map<string, NebulaComm>();

    private makeComm(commId: string, targetName: string): NebulaComm {
      const comm = new NebulaComm(commId, targetName, (id) => this.comms.delete(id));
      this.comms.set(commId, comm);
      return comm;
    }

    /** Widget->kernel comm creation (also used for state restoration). */
    _create_comm(
      targetName: string,
      modelId?: string,
      data?: any,
      metadata?: any,
      buffers?: ArrayBuffer[] | ArrayBufferView[],
    ): Promise<IClassicComm> {
      const comm = this.makeComm(modelId ?? crypto.randomUUID(), targetName);
      if (data !== undefined || metadata !== undefined) {
        // Opening a brand-new comm; otherwise we are reconstructing a comm
        // that already exists kernel-side and must NOT send comm_open.
        comm.open(data ?? {}, undefined, metadata, buffers);
      }
      return Promise.resolve(comm);
    }

    async _get_comm_info(): Promise<CommInfoReply> {
      // Only report widget comms: the base manager's fallback restore path
      // sends request_state to every comm returned here, and non-widget comms
      // would never reply.
      const comms = await kernelService.requestCommInfo(this.sessionId);
      const widgetComms: CommInfoReply = {};
      for (const [commId, info] of Object.entries(comms)) {
        if (info?.target_name === this.comm_target_name) {
          widgetComms[commId] = info;
        }
      }
      return widgetComms;
    }

    /**
     * Resolve widget classes from the statically-bundled base/controls modules.
     * HTMLManager's own implementation uses CommonJS require(), which is not
     * available in the browser bundle. ipywidgets 7 requests (base 1.x /
     * controls 1.x) are routed to the v8 modules on a best-effort basis;
     * third-party widget packages fall through to the default loader and
     * surface as an error widget.
     */
    protected loadClass(
      className: string,
      moduleName: string,
      moduleVersion: string,
    ): Promise<typeof WidgetModel | typeof WidgetView> {
      const mod =
        moduleName === '@jupyter-widgets/base'
          ? (baseModule as unknown as Record<string, unknown>)
          : moduleName === '@jupyter-widgets/controls'
            ? (controlsModule as unknown as Record<string, unknown>)
            : null;
      if (mod) {
        const cls = mod[className];
        if (cls) return Promise.resolve(cls as any);
        return Promise.reject(new Error(`Widget class ${className} not found in ${moduleName}`));
      }
      return super.loadClass(className, moduleName, moduleVersion);
    }

    /** Route an incoming kernel->browser comm message. */
    handleComm(comm: CommMessage): void {
      if (comm.msg_type === 'comm_open') {
        if (comm.target_name !== this.comm_target_name) return; // not a widget comm
        if (this.comms.has(comm.comm_id) || this.has_model(comm.comm_id)) return;
        const classicComm = this.makeComm(comm.comm_id, comm.target_name);
        void this.handle_comm_open(classicComm, toJupyterMessage(comm, '')).catch((err) => {
          console.error('[widgets] Failed to handle comm_open:', err);
        });
        return;
      }

      const classicComm = this.comms.get(comm.comm_id);
      if (!classicComm) return;
      if (comm.msg_type === 'comm_close') {
        this.comms.delete(comm.comm_id);
      }
      classicComm.handleIncoming(comm);
    }

    /** Fetch state of widgets that already exist kernel-side (page reload). */
    restoreState(): Promise<void> {
      return this._loadFromKernel();
    }

    hasModel(modelId: string): boolean {
      return this.has_model(modelId);
    }

    async renderModel(modelId: string, host: HTMLElement): Promise<WidgetViewHandle | null> {
      if (!this.has_model(modelId)) return null;
      const model = (await this.get_model(modelId)) as DOMWidgetModel;
      const view = await this.create_view<DOMWidgetView>(model);
      await this.display_view(view, host);
      let disposed = false;
      return {
        dispose: () => {
          // Destroy the VIEW only; the model stays registered so the widget
          // re-renders when its (virtualized) cell scrolls back into view.
          if (disposed) return;
          disposed = true;
          try {
            view.remove();
          } catch (err) {
            console.warn('[widgets] Failed to remove widget view:', err);
          }
        },
      };
    }

    disposeManager(): void {
      // Mark model comms dead, then drop all models and local comm stubs.
      try {
        this.disconnect();
      } catch {
        /* ignore */
      }
      void this.clear_state().catch(() => undefined);
      this.comms.clear();
    }

    async getStateSnapshot(): Promise<Record<string, unknown>> {
      // Base manager's get_state() already emits the
      // application/vnd.jupyter.widget-state+json shape
      // ({version_major, version_minor, state}).
      const state = await this.get_state();
      return state as unknown as Record<string, unknown>;
    }
  }

  const manager = new Manager();

  // Start live delivery and flush anything queued while the chunk loaded.
  entry.deliver = (comm) => manager.handleComm(comm);
  for (const queued of entry.queue.splice(0)) {
    manager.handleComm(queued);
  }

  // Restore widgets created before this manager existed (e.g. page reload, or
  // the comm_open arrived before the first widget output was rendered).
  if (!entry.disposed && kernelService.isConnected(sessionId)) {
    try {
      await Promise.race([
        manager.restoreState(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('widget state restore timed out')), STATE_RESTORE_TIMEOUT_MS),
        ),
      ]);
    } catch (err) {
      // Not fatal: widgets whose state couldn't be fetched simply show the
      // "no longer live" placeholder until their cell is re-run.
      console.warn('[widgets] Could not restore pre-existing widget state:', err);
    }
  }

  return manager;
}
