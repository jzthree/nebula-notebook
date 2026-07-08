/**
 * `nebula kernel …` — kernel status / restart / interrupt for a notebook.
 *
 * Uses the shared NebulaClient kernel-session helpers (same logic as the
 * MCP kernel tools, but addressed by notebook path per invocation).
 */

import type { NebulaClient } from '../notebook/client.js';
import {
  CliError,
  EXIT,
  makeClient,
  parse,
  printHint,
  printJson,
  requirePositional,
  resolveUrl,
  toCliError,
  type ParsedArgs,
} from './shared.js';

const KERNEL_HELP = `usage: nebula kernel <status|start|stop|restart|interrupt> <path>
       nebula kernel ls

examples:
  nebula kernel ls                         # available kernels on the server
  nebula kernel status analysis.ipynb      # session id, kernel, state
  nebula kernel start analysis.ipynb       # start (kernel from notebook metadata)
  nebula kernel start analysis.ipynb --name ir
  nebula kernel stop analysis.ipynb        # shut the session down
  nebula kernel interrupt analysis.ipynb   # stop the running cell
  nebula kernel restart analysis.ipynb     # fresh kernel (variables cleared)

Exit code 7 means no kernel session exists for the notebook.`;

export async function cmdKernel(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === '--help' || sub === '-h') {
    console.log(KERNEL_HELP);
    return sub === undefined ? EXIT.USAGE : EXIT.OK;
  }
  const { values, positionals } = parse(rest, { name: { type: 'string' } });
  if (values.help) {
    console.log(KERNEL_HELP);
    return EXIT.OK;
  }

  // Path-less subcommands
  if (sub === 'ls') {
    return kernelLs(makeClient(resolveUrl(values.url)), values);
  }

  const nbPath = requirePositional(positionals, 0, 'path', `nebula kernel ${sub} <path>`);
  const url = resolveUrl(values.url);
  const client = makeClient(url, nbPath);

  switch (sub) {
    case 'status':
      return kernelStatus(client, nbPath, values);
    case 'start':
      return kernelStart(client, nbPath, values);
    case 'stop':
      return kernelStop(client, nbPath, values);
    case 'restart':
      return kernelRestart(client, nbPath, values);
    case 'interrupt':
      return kernelInterrupt(client, nbPath, values);
    default:
      throw new CliError(`unknown kernel subcommand: ${sub}`, EXIT.USAGE, "run 'nebula kernel --help' for the list");
  }
}

async function kernelLs(client: NebulaClient, values: ParsedArgs['values']): Promise<number> {
  const result = await client.listKernels();
  if (!result.success) throw toCliError(result.error);

  const kernels = result.data ?? [];
  if (values.json) {
    printJson(kernels);
    return EXIT.OK;
  }
  if (kernels.length === 0) {
    console.log('no kernels discovered on the server');
    return EXIT.OK;
  }
  const nameWidth = Math.max(...kernels.map((k) => k.name.length), 4);
  console.log(`${'NAME'.padEnd(nameWidth)}  LANGUAGE  DISPLAY NAME`);
  for (const k of kernels) {
    console.log(`${k.name.padEnd(nameWidth)}  ${(k.language || '-').padEnd(8)}  ${k.displayName}`);
  }
  printHint('start one for a notebook with: nebula kernel start <path> --name <NAME>', values);
  return EXIT.OK;
}

async function kernelStart(client: NebulaClient, nbPath: string, values: ParsedArgs['values']): Promise<number> {
  // No --name → the server resolves the kernel from the notebook's kernelspec.
  const started = await client.getOrCreateKernelForFile(nbPath, values.name as string | undefined);
  if (!started.success) throw toCliError(started.error, nbPath);

  if (values.json) {
    printJson({ sessionId: started.data!.sessionId, kernelName: started.data!.kernelName });
    return EXIT.OK;
  }
  console.log(`kernel session: ${started.data!.sessionId} (${started.data!.kernelName})`);
  printHint(`execute a cell with: nebula run ${nbPath} <cell-id>`, values);
  return EXIT.OK;
}

async function kernelStop(client: NebulaClient, nbPath: string, values: ParsedArgs['values']): Promise<number> {
  const session = await client.resolveKernelSessionIdForNotebook(nbPath, { createIfMissing: false });
  if (!session.success) {
    throw new CliError(`no kernel session for ${nbPath}`, EXIT.KERNEL);
  }
  const result = await client.shutdownKernel(session.data!.sessionId);
  if (!result.success) throw toCliError(result.error, nbPath);

  if (values.json) {
    printJson({ stopped: true, sessionId: session.data!.sessionId });
    return EXIT.OK;
  }
  console.log('kernel stopped');
  printHint(`start a fresh one with: nebula kernel start ${nbPath}`, values);
  return EXIT.OK;
}

async function kernelStatus(client: NebulaClient, nbPath: string, values: ParsedArgs['values']): Promise<number> {
  const sessions = await client.listSessions();
  if (!sessions.success) throw toCliError(sessions.error, nbPath);

  const matching = (sessions.data ?? []).filter((s) => s.file_path === nbPath);
  if (matching.length === 0) {
    throw new CliError(
      `no kernel session for ${nbPath}`,
      EXIT.KERNEL,
      `one starts automatically on: nebula run ${nbPath} <cell-id>`
    );
  }
  const session = matching[matching.length - 1];

  if (values.json) {
    printJson(session);
    return EXIT.OK;
  }
  console.log(`session: ${session.id}`);
  console.log(`kernel: ${session.kernel_name}`);
  console.log(`status: ${session.status}`);
  if (session.execution_count !== undefined) {
    console.log(`execution_count: ${session.execution_count}`);
  }
  printHint(`if stuck: nebula kernel interrupt ${nbPath}; for a clean slate: nebula kernel restart ${nbPath}`, values);
  return EXIT.OK;
}

async function kernelRestart(client: NebulaClient, nbPath: string, values: ParsedArgs['values']): Promise<number> {
  // Robust restart (same approach as the MCP kernel_restart tool): shut down
  // any existing session for the file, then start a fresh one.
  const existing = await client.resolveKernelSessionIdForNotebook(nbPath, { createIfMissing: false });
  if (existing.success) {
    const stopped = await client.shutdownKernel(existing.data!.sessionId);
    if (!stopped.success && !/not found/i.test(stopped.error ?? '')) {
      throw toCliError(stopped.error, nbPath);
    }
  }

  const started = await client.getOrCreateKernelForFile(nbPath);
  if (!started.success) throw toCliError(started.error, nbPath);

  if (values.json) {
    printJson({ restarted: true, sessionId: started.data!.sessionId, kernelName: started.data!.kernelName });
    return EXIT.OK;
  }
  console.log(`kernel restarted: ${started.data!.sessionId} (${started.data!.kernelName})`);
  printHint('variables were cleared — re-run setup cells before dependent ones', values);
  return EXIT.OK;
}

async function kernelInterrupt(client: NebulaClient, nbPath: string, values: ParsedArgs['values']): Promise<number> {
  const session = await client.resolveKernelSessionIdForNotebook(nbPath, { createIfMissing: false });
  if (!session.success) {
    throw new CliError(`no kernel session for ${nbPath}`, EXIT.KERNEL);
  }
  const result = await client.interruptKernel(session.data!.sessionId);
  if (!result.success) {
    const notFound = /not found/i.test(result.error ?? '');
    throw new CliError(result.error ?? 'interrupt failed', notFound ? EXIT.KERNEL : EXIT.ERROR);
  }

  if (values.json) {
    printJson({ interrupted: true, sessionId: session.data!.sessionId });
    return EXIT.OK;
  }
  console.log('kernel interrupted');
  printHint(`check state with: nebula kernel status ${nbPath}`, values);
  return EXIT.OK;
}
