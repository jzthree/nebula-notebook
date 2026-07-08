/**
 * `nebula run` — the flagship combined operation (AXI): execute a cell and
 * report status, execution count, elapsed time, and the output tail in a
 * single invocation.
 */

import {
  EXIT,
  makeClient,
  parse,
  parseIntFlag,
  printHint,
  printJson,
  requirePositional,
  resolveUrl,
  tailLines,
  toCliError,
} from './shared.js';

const RUN_HELP = `usage: nebula run <path> <cell-id> [--tail N] [--max-wait S] [--no-wait]

Executes the cell and BLOCKS until it completes (up to --max-wait, default
300s; 0 = no limit), then prints status, execution_count, elapsed, and the
last N output lines (default 40). Long runs are followed with cheap internal
polling — launch this as a background shell task and the process exit IS the
completion signal (no agent-side polling needed).

Non-ok status exits 1 with the error/traceback tail.
Exit 3 = still running when --max-wait expired (not an error).
--no-wait = fire-and-forget: start execution and return immediately.

examples:
  nebula run analysis.ipynb cell-3
  nebula run analysis.ipynb train-cell --max-wait 0     # wait however long it takes
  nebula run analysis.ipynb train-cell --no-wait        # start it and come back later`;

/** Per-request cap on the server-side long-poll (tunnel/proxy safe). */
const SERVER_WAIT_CHUNK_S = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function cmdRun(argv: string[]): Promise<number> {
  const { values, positionals } = parse(argv, {
    tail: { type: 'string' },
    'max-wait': { type: 'string' },
    'no-wait': { type: 'boolean' },
  });
  if (values.help) {
    console.log(RUN_HELP);
    return EXIT.OK;
  }
  const usage = 'nebula run <path> <cell-id> [--tail N] [--max-wait S] [--no-wait]';
  const nbPath = requirePositional(positionals, 0, 'path', usage);
  const cellId = requirePositional(positionals, 1, 'cell-id', usage);
  const tailN = parseIntFlag(values.tail, '--tail', 40);
  const maxWait = parseIntFlag(values['max-wait'], '--max-wait', 300);
  const noWait = values['no-wait'] === true;

  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);

  const started = Date.now();
  // --max-wait 0 (CLI) = wait forever. (The MCP's max_wait=0 means "return
  // immediately" — the CLI expresses that as --no-wait instead.)
  const deadline = noWait ? started : maxWait <= 0 ? Number.POSITIVE_INFINITY : started + maxWait * 1000;

  const initialWait = noWait ? 0 : Math.min(maxWait <= 0 ? SERVER_WAIT_CHUNK_S : maxWait, SERVER_WAIT_CHUNK_S);
  const result = await client.executeCellOp(nbPath, { cellId, maxWait: initialWait });
  if (!result.success) throw toCliError(result.error, nbPath);

  let d = result.data!;

  if (noWait) {
    if (values.json) {
      printJson({ ...d, status: 'started' });
    } else {
      console.log('status: started');
      printHint(`check on it with: nebula nb read ${nbPath} --cells ${cellId} --outputs`, values);
    }
    return EXIT.OK;
  }

  // Follow the execution: the server long-polls up to SERVER_WAIT_CHUNK_S per
  // request; between requests we back off 2s → 10s. The agent never polls —
  // this process simply doesn't exit until the cell is done (or deadline).
  let pollMs = 2000;
  while (d.executionStatus === 'busy' && Date.now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    pollMs = Math.min(pollMs * 1.4, 10_000);
    try {
      const r = await client.readCellOutputOp(nbPath, { cellId });
      if (r.success && r.data) {
        d = {
          ...d,
          outputs: (r.data.outputs as typeof d.outputs) ?? d.outputs,
          executionCount: r.data.executionCount ?? d.executionCount,
          executionStatus: r.data.executionStatus ?? d.executionStatus,
        };
      }
    } catch {
      // transient network blip — keep following
    }
  }
  const failed = d.executionStatus === 'error' || d.outputs.some((o) => o.type === 'error');
  const status = failed ? 'error' : d.executionStatus === 'busy' ? 'busy' : 'ok';
  // A cell still "busy" has no meaningful executionTime yet (the initial execute's
  // value is stale/partial), so report the wall-clock time we actually waited — that
  // lines up with the "still running after Ns" hint. Only a completed cell reports
  // its true executionTime.
  const elapsedSec = status !== 'busy' && d.executionTime !== undefined ? d.executionTime / 1000 : (Date.now() - started) / 1000;

  if (values.json) {
    printJson({ ...d, status, elapsed: elapsedSec });
    return failed ? EXIT.ERROR : status === 'busy' ? EXIT.RUNNING : EXIT.OK;
  }

  console.log(`status: ${status}`);
  console.log(`execution_count: ${d.executionCount ?? '-'}`);
  console.log(status === 'busy' ? `running: ${elapsedSec.toFixed(1)}s (not finished)` : `elapsed: ${elapsedSec.toFixed(1)}s`);

  const text = d.outputs
    .map((o) => (o.type === 'image' ? '[image]\n' : o.type === 'error' ? `${o.content}\n` : o.content))
    .join('');
  if (!text.trim()) {
    console.log('(no output)');
  } else {
    const lines = tailLines(text, tailN);
    console.log(`--- output tail (last ${lines.length} line${lines.length === 1 ? '' : 's'}) ---`);
    for (const line of lines) console.log(line);
  }

  if (failed) {
    console.error('error: cell execution failed');
    return EXIT.ERROR;
  }
  if (status === 'busy') {
    printHint(`still running after ${maxWait}s (exit 3); wait to completion with: nebula run ${nbPath} ${cellId} --max-wait 0`, values);
    return EXIT.RUNNING;
  }
  printHint(`see all saved outputs with: nebula nb read ${nbPath} --outputs`, values);
  return EXIT.OK;
}
