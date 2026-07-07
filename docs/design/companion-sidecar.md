# Nebula Companion Sidecar — design

Status: **proposal / implementation-ready.** One open decision (how to consume
`hay`) is flagged in §7.

## 1. Problem

When Nebula runs on a remote cluster and the user views it through an `ssh -L`
forward tunnel, two features want to run on the **user's laptop**, not the
cluster login node:

- **Agent terminal** — Claude Code / Codex in a real terminal, using the user's
  local RAM/network and local login (no cluster memory pressure, no "claude is
  blocked on the login node").
- **AI autocomplete** — inline completions driven by the local `claude`/`codex`
  CLI subscription.

The shipped solution routed the agent through a **reverse SSH tunnel**
(`ssh -R`), which the cluster's node-server used to reach back into the laptop's
`sshd`. That works but drags in a pile of fragility:

- macOS **Remote Login must be ON**; `sss_ssh_knownhostsproxy` breaks loopback
  hops (needs `-o ProxyCommand=none`); login+interactive shell gymnastics for
  `PATH`; and — worst — the macOS **Keychain is unreadable over ssh**, so the
  local `claude` prompts for auth again and needs `claude setup-token` +
  `CLAUDE_CODE_OAUTH_TOKEN`.

## 2. Key insight

**The browser runs on the laptop.** The Nebula UI is *served* from the cluster,
but its JavaScript executes locally, so it can reach a **local loopback service**
directly — no tunnel. The reverse tunnel was only ever needed because we made the
*cluster* process initiate the callback. If the request originates in the browser
instead, a small local **companion sidecar** on `127.0.0.1` serves both features:

```
Nebula browser (on laptop)
  ├─ xterm ───────ws──▶ companion :PORT ─▶ PTY ─▶ claude/codex   (persistent, replayable)
  └─ autocomplete ─http/SSE─▶ companion :PORT ─▶ nebula-autocomplete engine
Nebula UI/API/kernels/filesystem ───ssh -L forward──▶ cluster node-server   (unchanged)
```

The `-L` forward stays (it's how you see Nebula at all). The `-R` reverse **goes
away** for interactive use. And because `claude` now runs as a normal local
process (not over ssh), it uses the user's **existing local login** — no token
setup, no Keychain problem, no Remote-Login toggle.

The only thing pure-loopback can't do that the reverse tunnel could: let a
*cluster-side* process initiate a call to the laptop with no browser open
(headless/server-driven agent runs). That's out of scope here; keep the reverse
path documented for that edge case.

## 3. Reuse `hay`, don't reimplement the terminal

`~/Code/hop2/hay` is an embeddable, **tmux-free** terminal-session runtime (the
from-scratch replacement for hop v1's ttyd+tmux). It already implements the hard
parts of the sidecar's terminal surface:

| Need | hay provides |
|---|---|
| PTY host | one `node-pty-prebuilt-multiarch` child per `Room` (`apps/server/src/pty.ts`, `rooms.ts`) — **same native dep Nebula already bundles** |
| Persistence + replay | daemon holds the PTY; in-memory scrollback ring (20 MB, `HAY_SNAPSHOT_BUFFER_BYTES`); `snapshot` message replayed on reattach. **No tmux/screen.** |
| Wire protocol | clean JSON discriminated-union over WebSocket (one zod file, `packages/shared/src/protocol.ts`); xterm speaks it directly (`apps/web` is the reference client) |
| Reconnect / resume | `getRoom(id)` is create-or-attach; resume = reconnect WS with same `?room=<id>` |
| Multi-client | presence + take/release control + size-election (superset of Nebula's current "another tab took over") |
| Embed API | `import { attachTermshare, RoomManager, createPty } from "hay-server"` — bolt rooms onto any `http.Server`; `hop2/scripts/hay-host.js` is the loopback-daemon reference |

This directly satisfies the earlier constraint against tmux ("no extra dependency,
no sessions users don't realize they need to kill"): hay persists by keeping the
PTY in a long-lived local process with a scrollback ring — nothing to clean up.

**What hay intentionally omits** (we add it in the companion): auth, tunneling,
binding to loopback only, and the agent-driver REST (that lives in hop's closed
compiled binary — but the *pattern* is tiny to reimplement; see §5).

Protocol summary (for the client work in §6):

```
client → server:  {input,data} {resize,cols,rows} {typing,active} {take_control} {release_control} {ping,t} {kill_session}
server → client:  {hello,...} {output,data} {snapshot,data,...} {presence,clients} {active_size,...}
                  {session_ended,exitCode,...} {cwd_changed,cwd} {pong,t} {error,message}
attach:           WS handshake query params ?room=<id>&name=<disp>&cols=<n>&rows=<n>&cwd=<path>
```

## 4. Companion architecture

One local Node process = **hay terminal core** + our thin shell:

1. **hay PTY/rooms core** (§7 decides how it's sourced) mounted via
   `attachTermshare` on a loopback `http.Server`.
2. **Loopback bind** — `127.0.0.1` only (never all interfaces).
3. **Token gate** — a bearer token minted on startup, printed once, pasted into
   Nebula settings. Enforced on the WS `upgrade` (token in URL query, since
   browsers can't set WS handshake headers) and on the autocomplete HTTP route
   (header or query). Plus an `Origin` allowlist. Defeats DNS-rebinding / random
   local web pages hitting the port.
4. **Autocomplete route** — reuse `registerAutocompleteRoute` +
   `ClaudeBackend`/`CodexBackend` from `nebula-autocomplete` (already factored
   for this; `createCompletionFetcher(endpoint, {headers})` on the client already
   takes an arbitrary URL + auth header).
5. **Agent launch + resume** — create a room whose shell runs `claude`/`codex`;
   inject `HOP_SESSION`; install `claude-session-hook.js` (copied from hop2) for
   deterministic "turn done" + `claude --resume` mapping.
6. **Health/discovery** — `GET /health` → `{version, features:[terminal,autocomplete], sessions:[...]}`
   so the UI can auto-detect the companion and show status.

Distribution: `npx nebula-notebook-companion` (or `nebula companion`). Because it
runs on the laptop (where npm/npx can fetch deps), it does **not** need to live
inside Nebula's published tarball the way `nebula-autocomplete` did.

## 5. Agent sessions (from the hay/hop eval)

An agent session is just a hay room whose shell is the agent CLI. Reusable bits:
- `HOP_SESSION` env injected into every PTY (hay does this already).
- `claude-session-hook.js`: on `SessionStart` writes `{sessionId,cwd}` (enables
  `claude --resume <id>`); on `Stop` bumps a monotonic per-turn counter (lets the
  UI detect "turn complete" without screen-scraping).
- Driving/reading (send keystrokes, read scrollback) is `pty.write` + the
  `output`/`snapshot` stream we already have — reimplement only the thin verbs we
  need; the rich `/api/terminals` REST in the closed `hop` binary is not required.

## 6. Client + settings changes in Nebula (this repo)

Decision-independent of §7 — the companion is behind a URL + token:

- **settingsService.ts** — add `aiAutocompleteSource: 'server' | 'local'` (mirror
  the `remoteAgent*` pattern), `companionPort?: number`, `companionToken?: string`.
- **aiAutocompleteService.ts** — when source is `local`, build the fetcher against
  `http://127.0.0.1:<port>/autocomplete` with `{ Authorization: Bearer <token> }`
  instead of `/api/autocomplete`.
- **Terminal client (TerminalInstance/TerminalPanel/terminalService)** — add a
  "local (companion)" target that connects xterm to `ws://127.0.0.1:<port>/ws?...`
  speaking hay's protocol (map `output`/`snapshot`→write, `onData`→`{input}`,
  fit→`{resize}`). Reuse the reconnect/replay UI already built.
- **Settings/onboarding UI** — a "Local companion" pane: how to start it
  (`npx nebula-notebook-companion`), where to paste the token, live status pill
  from `/health`. Reuse `RemoteAgentSetupModal` patterns; the `<Where loc>` badges
  become "local" for everything.
- **Status probe** — replace the server-side `/api/autocomplete/status` check with
  a companion `/health` ping when in local mode.

## 7. OPEN DECISION — how to consume hay

hay is the user's code, not on npm (private, v0.9.0, inside hop2). Options:

- **(A) Publish `hay-server` + `hay-shared` to npm; depend by version.** Cleanest
  long-term — Nebula tracks hay upstream; fixes flow automatically. Cost: cut a
  hay release from hop2. Best if hay is meant to be the standard terminal runtime.
- **(B) Vendor hay's ~1100-line core** (`pty.ts`, `rooms.ts`, `protocol.ts`,
  `lib.ts`; no closed deps) into the companion package. Fastest, fully
  self-contained, no hop2 release. Cost: a fork that can drift until (A) happens.
- **(C) git/file dependency on hop2/hay.** No publish, but needs a build step and
  git access at install — reintroduces the cross-repo fragility we just removed
  for `nebula-autocomplete`. Least recommended for a shippable Nebula.

**Recommendation:** (A) if you're ready to treat hay as a published product; else
(B) to prototype now and migrate to (A) when hay stabilizes. Either way, keep hay
behind a single import boundary in the companion so switching (B)→(A) is a
dependency swap, not a rewrite. Avoid (C).

## 8. Phased plan

1. **Companion skeleton** — package + loopback `http.Server` + token gate +
   `/health`. Wire hay per §7.
2. **Terminal surface** — `attachTermshare`; verify persistence/replay/reconnect
   against a throwaway xterm.
3. **Autocomplete surface** — mount `registerAutocompleteRoute` with the shared
   engine; token-gate it.
4. **Agent launch/resume** — claude/codex room + `HOP_SESSION` + session hook.
5. **Nebula client + settings** (§6) — `local` modes + companion pane + status.
6. **Onboarding + docs** — first-run guidance; update remote-agent docs to point
   here for interactive use (keep reverse-tunnel note for headless callback).

## 9. What this supersedes / preserves

- **Supersedes** the reverse-SSH remote-agent path for interactive browser use
  (and removes its token/Keychain/Remote-Login pain).
- **Preserves** the `-L` forward (unchanged) and the server-side autocomplete
  path (still valid when Nebula + agent both run on the same host).
- **Privacy note:** in local mode, terminal + completion context stay on the
  laptop and never transit the cluster.
