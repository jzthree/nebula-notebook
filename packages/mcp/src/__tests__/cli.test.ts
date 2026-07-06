/**
 * Integration tests for the `nebula` CLI (bin/nebula.js → dist/cli/index.js).
 *
 * Spawns the CLI as a subprocess against the in-process mock Nebula server
 * (run `npm run build` in packages/mcp first). Session state is isolated in a
 * temp NEBULA_STATE_DIR.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { NebulaClient } from '../notebook/client.js';
import { startMockNebulaServer, type MockNebulaServer } from './helpers/mock-nebula-server.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TEST_DIR, '../..');
const CLI_BIN = path.join(PACKAGE_ROOT, 'bin', 'nebula.js');
const CLI_ENTRY = path.join(PACKAGE_ROOT, 'dist', 'cli', 'index.js');

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe('nebula CLI', () => {
  let mockServer: MockNebulaServer;
  let nebulaUrl: string;
  let stateDir: string;
  /** Plain client with no agentId — acts as "the user" in OCC scenarios. */
  let userClient: NebulaClient;

  const uniquePath = (name: string) =>
    `/tmp/nebula-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}/${name}.ipynb`;

  function runCli(
    args: string[],
    opts: { env?: Record<string, string | undefined>; stdin?: string } = {}
  ): Promise<CliResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [CLI_BIN, ...args], {
        cwd: PACKAGE_ROOT,
        env: {
          ...process.env,
          NEBULA_URL: nebulaUrl,
          NEBULA_STATE_DIR: stateDir,
          ...opts.env,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
      if (opts.stdin !== undefined) {
        child.stdin.write(opts.stdin);
      }
      child.stdin.end();
    });
  }

  async function seedNotebook(nbPath: string, cells: Array<{ id: string; type?: 'code' | 'markdown'; content: string }>) {
    const created = await userClient.createNotebookOp(nbPath, { overwrite: true });
    expect(created.success).toBe(true);
    for (const cell of cells) {
      const inserted = await userClient.insertCellOp(nbPath, -1, {
        id: cell.id,
        type: cell.type ?? 'code',
        content: cell.content,
      });
      expect(inserted.success).toBe(true);
    }
  }

  beforeAll(async () => {
    if (!fs.existsSync(CLI_ENTRY)) {
      throw new Error(`CLI build not found at ${CLI_ENTRY}. Run "npm run build" in packages/mcp first.`);
    }
    mockServer = await startMockNebulaServer();
    nebulaUrl = mockServer.url;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nebula-cli-state-'));
    userClient = new NebulaClient({ baseUrl: nebulaUrl });
  });

  afterAll(async () => {
    await mockServer.close();
    fs.rmSync(stateDir, { recursive: true, force: true });
  });

  // ===========================================================================
  // Root / usage
  // ===========================================================================

  it('prints command list and NEBULA_URL requirement with no args', async () => {
    const r = await runCli([]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('NEBULA_URL');
    expect(r.stdout).toContain('nb read');
    expect(r.stdout).toContain('session start');
  });

  it('exits 2 with a hint when NEBULA_URL is missing', async () => {
    const r = await runCli(['nb', 'read', '/tmp/whatever.ipynb'], { env: { NEBULA_URL: undefined } });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('error: no Nebula server URL configured');
    expect(r.stderr).toContain('hint:');
    expect(r.stderr).toContain('NEBULA_URL');
  });

  it('exits 2 for unknown commands and unknown flags', async () => {
    const unknownCmd = await runCli(['frobnicate']);
    expect(unknownCmd.code).toBe(2);
    expect(unknownCmd.stderr).toContain('error: unknown command: frobnicate');

    const unknownFlag = await runCli(['nb', 'read', '/tmp/x.ipynb', '--bogus']);
    expect(unknownFlag.code).toBe(2);
    expect(unknownFlag.stderr).toContain('error:');
  });

  // ===========================================================================
  // nb read
  // ===========================================================================

  it('nb read: prints explicit (0 cells) for an empty notebook', async () => {
    const nbPath = uniquePath('empty');
    await seedNotebook(nbPath, []);

    const r = await runCli(['nb', 'read', nbPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${nbPath} (0 cells)`);
    expect(r.stdout).toContain('hint:');
  });

  it('nb read: one compact line per cell, with --full and --cells variants', async () => {
    const nbPath = uniquePath('read');
    await seedNotebook(nbPath, [
      { id: 'md-1', type: 'markdown', content: '# Title\n\nIntro text.' },
      { id: 'code-1', content: 'import numpy as np\nx = np.arange(10)' },
      { id: 'code-2', content: 'print("hi")' },
    ]);

    const r = await runCli(['nb', 'read', nbPath]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`${nbPath} (3 cells)`);
    expect(r.stdout).toContain('#1 md-1 markdown # Title…');
    expect(r.stdout).toContain('#2 code-1 code import numpy as np…');
    expect(r.stdout).toContain('#3 code-2 code print("hi")');

    const full = await runCli(['nb', 'read', nbPath, '--full', '--quiet']);
    expect(full.code).toBe(0);
    expect(full.stdout).toContain('x = np.arange(10)');
    expect(full.stdout).not.toContain('hint:');

    const byRange = await runCli(['nb', 'read', nbPath, '--cells', '2-3', '--quiet']);
    expect(byRange.stdout).not.toContain('#1 md-1');
    expect(byRange.stdout).toContain('#2 code-1');
    expect(byRange.stdout).toContain('#3 code-2');

    const byId = await runCli(['nb', 'read', nbPath, '--cells', 'code-2', '--quiet']);
    expect(byId.stdout).not.toContain('#2 code-1');
    expect(byId.stdout).toContain('#3 code-2');
  });

  it('nb read: --json emits raw JSON', async () => {
    const nbPath = uniquePath('read-json');
    await seedNotebook(nbPath, [{ id: 'c1', content: 'a = 1' }]);

    const r = await runCli(['nb', 'read', nbPath, '--json']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.totalCells).toBe(1);
    expect(parsed.cells[0].id).toBe('c1');
  });

  // ===========================================================================
  // nb edit
  // ===========================================================================

  it('nb edit: updates cell content (flag and stdin variants)', async () => {
    const nbPath = uniquePath('edit');
    await seedNotebook(nbPath, [{ id: 'c1', content: 'x = 1' }]);

    const r = await runCli(['nb', 'edit', nbPath, 'c1', '--content', 'x = 2']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('updated c1');

    const viaStdin = await runCli(['nb', 'edit', nbPath, 'c1', '-'], { stdin: 'y = 3\nprint(y)' });
    expect(viaStdin.code).toBe(0);

    const cell = await userClient.readCellOp(nbPath, { cellId: 'c1' });
    expect(cell.data!.cell.content).toBe('y = 3\nprint(y)');
  });

  it('nb edit: rejects ambiguous content sources with exit 2', async () => {
    const nbPath = uniquePath('edit-usage');
    await seedNotebook(nbPath, [{ id: 'c1', content: 'x = 1' }]);

    const r = await runCli(['nb', 'edit', nbPath, 'c1']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('error:');
  });

  // ===========================================================================
  // Sessions + OCC conflict (persistence across invocations)
  // ===========================================================================

  it('session start/end persists the lock token; conflicting edit exits 9 with current content', async () => {
    const nbPath = uniquePath('occ');
    await seedNotebook(nbPath, [{ id: 'c1', content: 'total = 1 + 1' }]);

    // Start a session in one invocation…
    const start = await runCli(['session', 'start', nbPath, '--name', 'test-agent']);
    expect(start.code).toBe(0);
    expect(start.stdout).toContain('session started');

    // …state token exists on disk and is shared by later invocations.
    const stateFiles = fs.readdirSync(stateDir).filter((f) => f.startsWith('cli-session-'));
    expect(stateFiles.length).toBe(1);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, stateFiles[0]), 'utf-8'));
    expect(state.agentId).toMatch(/^nebula-cli-/);
    expect(state.path).toBe(nbPath);

    // Read in a second invocation (arms OCC for the session)…
    const read = await runCli(['nb', 'read', nbPath]);
    expect(read.code).toBe(0);

    // …the user edits the cell behind the agent's back…
    const userEdit = await userClient.updateContentOp(nbPath, 'c1', 'total = 40 + 2  # user changed this');
    expect(userEdit.success).toBe(true);

    // …so the agent's edit conflicts: exit 9 + current content on stdout.
    const conflicted = await runCli(['nb', 'edit', nbPath, 'c1', '--content', 'total = 3']);
    expect(conflicted.code).toBe(9);
    expect(conflicted.stdout).toContain('CONFLICT: cell changed — current content below; retry your edit against it');
    expect(conflicted.stdout).toContain('total = 40 + 2  # user changed this');

    // Conflicts are self-healing: a retry against the shown content succeeds.
    const retry = await runCli(['nb', 'edit', nbPath, 'c1', '--content', 'total = 40 + 2 + 3']);
    expect(retry.code).toBe(0);

    // End the session; the state file is removed.
    const end = await runCli(['session', 'end', nbPath]);
    expect(end.code).toBe(0);
    expect(end.stdout).toContain('session ended');
    expect(fs.readdirSync(stateDir).filter((f) => f.startsWith('cli-session-'))).toHaveLength(0);

    // Ending again fails cleanly.
    const endAgain = await runCli(['session', 'end', nbPath]);
    expect(endAgain.code).toBe(1);
    expect(endAgain.stderr).toContain('no CLI session');
  });

  // ===========================================================================
  // nb insert / delete
  // ===========================================================================

  it('nb insert and nb delete round-trip', async () => {
    const nbPath = uniquePath('insert');
    await seedNotebook(nbPath, [{ id: 'c1', content: 'x = 1' }]);

    const inserted = await runCli([
      'nb', 'insert', nbPath,
      '--index', '-1',
      '--id', 'new-cell',
      '--type', 'markdown',
      '--content', '## Results',
    ]);
    expect(inserted.code).toBe(0);
    expect(inserted.stdout).toContain('inserted new-cell at #2');

    const afterInsert = await userClient.readNotebookViaRouter(nbPath);
    expect(afterInsert.data!.cells.map((c) => c.id)).toEqual(['c1', 'new-cell']);
    expect(afterInsert.data!.cells[1].type).toBe('markdown');

    const deleted = await runCli(['nb', 'delete', nbPath, 'new-cell']);
    expect(deleted.code).toBe(0);
    expect(deleted.stdout).toContain('deleted new-cell');

    const afterDelete = await userClient.readNotebookViaRouter(nbPath);
    expect(afterDelete.data!.cells.map((c) => c.id)).toEqual(['c1']);

    const deleteMissing = await runCli(['nb', 'delete', nbPath, 'new-cell']);
    expect(deleteMissing.code).toBe(1);
    expect(deleteMissing.stderr).toContain('error:');
  });

  // ===========================================================================
  // nb search
  // ===========================================================================

  it('nb search: reports matches and explicit 0 matches', async () => {
    const nbPath = uniquePath('search');
    await seedNotebook(nbPath, [
      { id: 'c1', content: 'import pandas as pd\ndf = pd.read_csv("data.csv")' },
      { id: 'c2', content: 'print(df.head())' },
    ]);

    const hits = await runCli(['nb', 'search', nbPath, 'read_csv']);
    expect(hits.code).toBe(0);
    expect(hits.stdout).toContain('1 match for "read_csv"');
    expect(hits.stdout).toContain('#1 c1 source:1');

    const none = await runCli(['nb', 'search', nbPath, 'matplotlib']);
    expect(none.code).toBe(0);
    expect(none.stdout).toContain('0 matches for "matplotlib"');
  });

  // ===========================================================================
  // run (combined execute + output tail)
  // ===========================================================================

  it('run: executes a cell and prints status, execution_count, and output tail', async () => {
    const nbPath = uniquePath('run');
    await seedNotebook(nbPath, [
      { id: 'hello', content: 'print("hello from cli")\nprint("second line")' },
    ]);

    const r = await runCli(['run', nbPath, 'hello']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('status: ok');
    expect(r.stdout).toMatch(/execution_count: \d+/);
    expect(r.stdout).toMatch(/elapsed: [\d.]+s/);
    expect(r.stdout).toContain('hello from cli');
    expect(r.stdout).toContain('second line');

    // --tail limits the printed lines.
    const tailed = await runCli(['run', nbPath, 'hello', '--tail', '1', '--quiet']);
    expect(tailed.code).toBe(0);
    expect(tailed.stdout).not.toContain('hello from cli');
    expect(tailed.stdout).toContain('second line');

    // Outputs were saved: visible via nb read --outputs.
    const read = await runCli(['nb', 'read', nbPath, '--outputs', '--quiet']);
    expect(read.stdout).toContain('out: hello from cli');

    const missing = await runCli(['run', nbPath, 'no-such-cell']);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('error:');
  });

  // ===========================================================================
  // kernel commands
  // ===========================================================================

  it('kernel status/restart/interrupt with exit 7 when no session exists', async () => {
    const nbPath = uniquePath('kernel');
    await seedNotebook(nbPath, [{ id: 'c1', content: 'print("k")' }]);

    // No kernel yet → exit 7.
    const statusBefore = await runCli(['kernel', 'status', nbPath]);
    expect(statusBefore.code).toBe(7);
    expect(statusBefore.stderr).toContain('no kernel session');

    const interruptBefore = await runCli(['kernel', 'interrupt', nbPath]);
    expect(interruptBefore.code).toBe(7);

    // Running a cell creates a session.
    const run = await runCli(['run', nbPath, 'c1', '--quiet']);
    expect(run.code).toBe(0);

    const status = await runCli(['kernel', 'status', nbPath]);
    expect(status.code).toBe(0);
    expect(status.stdout).toMatch(/session: mock-session-\d+/);
    expect(status.stdout).toContain('kernel: python3');
    expect(status.stdout).toContain('status: idle');

    const interrupt = await runCli(['kernel', 'interrupt', nbPath, '--quiet']);
    expect(interrupt.code).toBe(0);
    expect(interrupt.stdout).toContain('kernel interrupted');

    const restart = await runCli(['kernel', 'restart', nbPath, '--quiet']);
    expect(restart.code).toBe(0);
    expect(restart.stdout).toContain('kernel restarted');
  });

  // ===========================================================================
  // help
  // ===========================================================================

  it('command help is concise (≤ 25 lines) and example-first', async () => {
    for (const args of [
      ['--help'],
      ['nb', 'read', '--help'],
      ['nb', 'edit', '--help'],
      ['run', '--help'],
      ['kernel', '--help'],
      ['session', '--help'],
    ]) {
      const r = await runCli(args);
      expect(r.code).toBe(0);
      const lines = r.stdout.trimEnd().split('\n');
      expect(lines.length).toBeLessThanOrEqual(25);
      expect(r.stdout).toContain('usage:');
    }
  });
});
