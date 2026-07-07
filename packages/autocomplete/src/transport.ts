/**
 * Process transport for backends: run a provider CLI either LOCALLY (same host
 * as this process) or OVER SSH on a remote host.
 *
 * The over-ssh case powers "remote Nebula, local agent": the Nebula server runs
 * on a cluster, but autocomplete should drive the user's OWN claude/codex on
 * their laptop — reached over the reverse SSH tunnel the user already has. The
 * CLI's stream-json stdio flows transparently over the ssh channel; a persistent
 * warm worker keeps one ssh connection open (handshake paid once, not per turn),
 * and ControlMaster makes any reconnect ~free. See the validated latency probe:
 * per-turn overhead ≈ one network RTT (~50ms), negligible vs ~2s model latency.
 */

export interface SshTransport {
  kind: 'ssh';
  /** Host to ssh to — typically 'localhost' (the reverse-tunnel endpoint). */
  host: string;
  /** Reverse-tunnel port on this (server) host that forwards to the user's sshd. */
  port: number;
  /** Username on the user's machine. */
  user: string;
  /** Absolute path to the provider binary ON THE USER'S machine (PATH isn't set
   *  for a non-interactive ssh, so this must be absolute). */
  remoteBin: string;
  /** ControlMaster socket path, so warm workers + reconnects reuse one connection. */
  controlPath?: string;
  /** Working dir on the remote side (created if absent). Keep it empty of any
   *  CLAUDE.md so the agent harness stays minimal. */
  remoteCwd?: string;
}

export type Transport = { kind: 'local' } | SshTransport;

export interface SpawnPlan {
  command: string;
  args: string[];
  /** Options to pass to child_process.spawn (env/cwd). For ssh these are empty
   *  because env/cwd are embedded in the remote command line. */
  options: { env?: NodeJS.ProcessEnv; cwd?: string };
}

/** POSIX single-quote a string so it survives the remote shell verbatim. */
export function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const SSH_BASE_OPTS = [
  '-o', 'ProxyCommand=none',
  '-o', 'StrictHostKeyChecking=accept-new',
  '-o', 'BatchMode=yes',
  '-o', 'ServerAliveInterval=30',
];

/**
 * Plan how to spawn `bin argv` with `env` in `cwd`, honoring the transport.
 * - local: spawn the binary directly; env/cwd go to spawn().
 * - ssh: spawn `ssh …host <remoteCmd>` where remoteCmd re-establishes cwd + env
 *   on the far side (via `cd` and `env K=V …`) and execs the binary. `cwd`/`env`
 *   passed here are interpreted on the REMOTE side.
 */
export function planSpawn(
  transport: Transport,
  bin: string,
  argv: string[],
  env: Record<string, string>,
  cwd: string,
): SpawnPlan {
  if (transport.kind === 'local') {
    return { command: bin, args: argv, options: { env: { ...process.env, ...env }, cwd } };
  }
  const sshOpts = [...SSH_BASE_OPTS, '-p', String(transport.port)];
  if (transport.controlPath) {
    sshOpts.push('-o', 'ControlMaster=auto', '-o', `ControlPath=${transport.controlPath}`, '-o', 'ControlPersist=120');
  }
  const remoteCwd = transport.remoteCwd ?? cwd;
  const envPrefix = Object.entries(env).map(([k, v]) => `${k}=${shellQuote(v)}`).join(' ');
  // mkdir+cd so the remote agent runs in a clean, CLAUDE.md-free dir; `exec env …`
  // sets the child env on the far side (the local process.env doesn't reach it).
  const remoteCmd =
    `mkdir -p ${shellQuote(remoteCwd)} 2>/dev/null; cd ${shellQuote(remoteCwd)} 2>/dev/null; ` +
    `exec env ${envPrefix} ${shellQuote(transport.remoteBin)} ${argv.map(shellQuote).join(' ')}`;
  return {
    command: 'ssh',
    args: [...sshOpts, `${transport.user}@${transport.host}`, remoteCmd],
    options: {},
  };
}

/** Best-effort remote cleanup (e.g. wipe an ephemeral config dir) over the same
 *  ssh path. Returns the command+args for a fire-and-forget spawn. */
export function planRemoteCleanup(transport: SshTransport, remotePath: string): SpawnPlan {
  const sshOpts = [...SSH_BASE_OPTS, '-p', String(transport.port)];
  if (transport.controlPath) sshOpts.push('-o', `ControlPath=${transport.controlPath}`);
  return {
    command: 'ssh',
    args: [...sshOpts, `${transport.user}@${transport.host}`, `rm -rf ${shellQuote(remotePath)}`],
    options: {},
  };
}
