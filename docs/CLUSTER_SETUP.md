# Running Nebula on a cluster or remote server

Nebula's cluster story is simple: **run the server where your files and compute
live, browse it from your laptop through one SSH tunnel.** Everything else —
scheduler integration, compute-node kernels, remote agents — turns on
automatically when it applies.

This guide covers the generic setup. Five minutes the first time, zero after.

## 1. Install & start (on the cluster)

SSH to the machine that should host the server — typically a **login node**
with access to your data and (optionally) the batch scheduler:

```bash
npx nebula-notebook            # needs Node 20+; --workdir /path/to/projects to pick the root
```

No Node on the cluster? Get one without root via conda/mamba
(`conda create -n node nodejs -c conda-forge`) or your site's
`module load nodejs`.

On first start a **QR code** prints in the terminal — scan it with an
authenticator app (Google Authenticator, Authy, 1Password…). That 6-digit code
is the login for the web UI; nothing else is exposed.

When startup finishes, a banner shows the URLs, the root directory, and whether
a scheduler was detected.

### Keep it running

The server should outlive your SSH session. Simplest: tmux.

```bash
tmux new -s nebula
npx nebula-notebook
# detach: Ctrl-b d   ·   later: tmux attach -t nebula
```

Kernels are restart-proof (`NEBULA_PRESERVE_KERNELS`), so even a server restart
won't kill your running computations — the UI reattaches to them.

## 2. Reach it from your laptop

Cluster nodes aren't (and shouldn't be) exposed to the internet. Forward one
port over SSH — from your laptop:

```bash
ssh -L 3000:localhost:3000 <login-node>        # then open http://localhost:3000
```

If the server host is an internal node you normally reach through a bastion,
add a jump: `ssh -J <bastion> -L 3000:localhost:3000 <server-host>`.

**Tip (macOS):** [Burrow](https://github.com/jzthree/Burrow) manages exactly
this kind of tunnel from the menu bar — supervised, auto-reconnecting, one
click to bring up:

```bash
burrow add --name nebula --host <server-host> --jump <bastion> --local 3000:localhost:3000
```

## 3. What lights up on a cluster

Detection-gated — none of this appears on a laptop install:

- **Compute allocations** (SLURM): the kernel menu grows a *New compute
  allocation* entry — pick partition/QoS/CPUs/GPUs with a live queue-load
  monitor, and your kernel runs **on the compute node**, streamed back into the
  same notebook. No sbatch script, no extra tunnels. See
  [SLURM_COMPUTE.md](SLURM_COMPUTE.md).
- **Login-node protection**: starting a kernel on the shared login node asks
  first and nudges toward an allocation (configurable in Settings).
- **Agents with their own compute**: the `nebula` CLI / MCP includes
  `compute status | queues | alloc --wait | use | cancel`, so an agent can
  request a GPU node for a task and release it after.

## 4. Agents on a cluster — three placements

| Where the agent runs | When | How |
|---|---|---|
| **On the cluster** (default) | API reachable from the cluster; plenty of RAM on the host | Open a notebook → Agent tab → one-click launch. Everything pre-wired. |
| **On your laptop, terminal in the page** | Cluster blocks the agent's API, or login node is memory-tight | Agent tab → *on: my machine*. Guided setup composes the reverse-tunnel command (random per-user port) and detects when it's connected. |
| **On your laptop, plain terminal** | You just want CLI access from anywhere | `NEBULA_URL=http://localhost:3000` (through your tunnel) + the `nebula` CLI or MCP. `nebula setup-skill` teaches Claude Code the rest. |

## 5. Troubleshooting

- **Can't ssh to the server host directly** — internal nodes usually accept SSH
  only from inside the cluster (often not even on VPN). Always go through the
  bastion (`-J` / Burrow `--jump`).
- **IPA/SSSD-managed clusters** wrap ssh in `sss_ssh_knownhostsproxy`
  system-wide; loopback hops (e.g. the remote-agent channel) need
  `-o ProxyCommand=none` — Nebula's generated commands include it.
- **Firewalled ports**: everything rides the one forwarded port (kernels,
  terminals, files, compute) — if the UI loads, everything works.
- **Multiple users, one login node**: each user runs their own server on their
  own port (`PORT=… npx nebula-notebook`); remote-agent reverse ports are
  random per user by design.
