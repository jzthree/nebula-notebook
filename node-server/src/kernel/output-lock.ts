/**
 * Per-session async mutex for kernel output persistence.
 *
 * We use this to serialize:
 * - output drain (append spool + ack in-memory)
 * - UI reconnect sync (read spool + read in-memory snapshot)
 * - save pruning (prune spool + ack in-memory)
 *
 * Without this, we can race (e.g. drain acks outputs after sync reads spool
 * but before sync reads the in-memory buffer), causing gaps on refresh.
 */

type Release = () => void;

class Mutex {
  private locked = false;
  private waiters: Array<() => void> = [];

  async acquire(): Promise<Release> {
    if (!this.locked) {
      this.locked = true;
      return () => this.release();
    }

    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.locked = true;
    return () => this.release();
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.locked = false;
  }

  isIdle(): boolean {
    return !this.locked && this.waiters.length === 0;
  }
}

const locks: Map<string, Mutex> = new Map();

export async function withKernelOutputLock<T>(
  sessionId: string,
  fn: () => Promise<T>
): Promise<T> {
  let mutex = locks.get(sessionId);
  if (!mutex) {
    mutex = new Mutex();
    locks.set(sessionId, mutex);
  }

  const release = await mutex.acquire();
  try {
    return await fn();
  } finally {
    release();
    if (mutex.isIdle()) {
      locks.delete(sessionId);
    }
  }
}

