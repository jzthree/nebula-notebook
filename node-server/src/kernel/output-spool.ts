/**
 * Kernel Output Spool
 *
 * Persist streaming kernel outputs to disk without modifying the notebook file.
 * This avoids spurious notebook mtime conflicts during UI disconnect/reconnect.
 *
 * Format: JSON Lines (one entry per line) with monotonically increasing `seq`.
 */

import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

export type SpoolEntry = {
  seq: number;
  output: { type: string; content: string };
  cellId?: string | null;
};

const DEFAULT_SPOOL_DIR = path.join(os.homedir(), '.nebula', 'kernel-output-spool');
const SPOOL_DIR = process.env.NEBULA_KERNEL_OUTPUT_SPOOL_DIR
  ? path.resolve(process.env.NEBULA_KERNEL_OUTPUT_SPOOL_DIR)
  : DEFAULT_SPOOL_DIR;

function safeSessionId(sessionId: string): string {
  // Session IDs may contain characters like "::" for proxied sessions. Keep filenames portable.
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function getOutputSpoolPath(sessionId: string): string {
  return path.join(SPOOL_DIR, `${safeSessionId(sessionId)}.jsonl`);
}

async function ensureSpoolDir(): Promise<void> {
  await fsp.mkdir(SPOOL_DIR, { recursive: true, mode: 0o700 });
}

export async function appendOutputSpool(sessionId: string, entries: SpoolEntry[]): Promise<number> {
  if (!entries.length) return 0;
  await ensureSpoolDir();
  const spoolPath = getOutputSpoolPath(sessionId);
  const payload = entries.map(entry => (
    `${JSON.stringify({ seq: entry.seq, output: entry.output, cell_id: entry.cellId ?? null })}\n`
  )).join('');
  await fsp.appendFile(spoolPath, payload, { encoding: 'utf-8', mode: 0o600, flag: 'a' });
  return entries[entries.length - 1].seq;
}

export async function readOutputSpoolSince(sessionId: string, sinceSeq: number): Promise<SpoolEntry[]> {
  const spoolPath = getOutputSpoolPath(sessionId);
  try {
    await fsp.access(spoolPath, fs.constants.F_OK);
  } catch {
    return [];
  }

  const stream = fs.createReadStream(spoolPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  const outputs: SpoolEntry[] = [];
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { seq?: unknown; output?: unknown; cell_id?: unknown; cellId?: unknown };
        const seq = Number(parsed.seq);
        if (!Number.isFinite(seq) || seq <= sinceSeq) continue;
        const out = parsed.output as { type?: unknown; content?: unknown } | undefined;
        if (!out || typeof out.type !== 'string' || typeof out.content !== 'string') continue;
        const cellIdRaw = (parsed.cell_id ?? parsed.cellId) as unknown;
        const cellId = typeof cellIdRaw === 'string' ? cellIdRaw : null;
        outputs.push({ seq, output: { type: out.type, content: out.content }, cellId });
      } catch {
        // Skip malformed lines.
        continue;
      }
    }
  } finally {
    rl.close();
    stream.close();
  }

  return outputs;
}

export async function pruneOutputSpoolUpTo(sessionId: string, upToSeq: number): Promise<void> {
  if (!Number.isFinite(upToSeq) || upToSeq <= 0) return;
  const spoolPath = getOutputSpoolPath(sessionId);
  try {
    await fsp.access(spoolPath, fs.constants.F_OK);
  } catch {
    return;
  }

  await ensureSpoolDir();
  const tmpPath = `${spoolPath}.tmp.${process.pid}.${Date.now()}`;

  const input = fs.createReadStream(spoolPath, { encoding: 'utf-8' });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  const output = fs.createWriteStream(tmpPath, { encoding: 'utf-8', mode: 0o600 });

  let kept = 0;
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as { seq?: unknown };
        const seq = Number(parsed.seq);
        if (!Number.isFinite(seq) || seq <= upToSeq) continue;
        output.write(`${trimmed}\n`);
        kept += 1;
      } catch {
        // Skip malformed lines.
        continue;
      }
    }
  } finally {
    rl.close();
    input.close();
    await new Promise<void>((resolve) => output.end(() => resolve()));
  }

  try {
    if (kept === 0) {
      await fsp.unlink(spoolPath).catch(() => undefined);
      await fsp.unlink(tmpPath).catch(() => undefined);
      return;
    }
    await fsp.rename(tmpPath, spoolPath);
  } catch {
    // Best-effort cleanup on failure.
    await fsp.unlink(tmpPath).catch(() => undefined);
  }
}
