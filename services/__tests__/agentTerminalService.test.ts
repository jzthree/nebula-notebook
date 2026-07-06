import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  agentTerminalService,
  sanitizePromptText,
  sanitizeErrorExcerpt,
  shellSingleQuote,
} from '../agentTerminalService';

describe('sanitizePromptText', () => {
  it('collapses newlines and tabs to single spaces (raw \\n would submit a TUI prompt early)', () => {
    expect(sanitizePromptText('fix\nthis\r\nerror\tnow')).toBe('fix this error now');
  });

  it('strips ANSI escape sequences', () => {
    expect(sanitizePromptText('\x1b[31mNameError\x1b[0m: x is not defined')).toBe(
      'NameError: x is not defined'
    );
  });

  it('collapses repeated spaces and trims', () => {
    expect(sanitizePromptText('  a   b  ')).toBe('a b');
  });
});

describe('sanitizeErrorExcerpt', () => {
  it('takes the last non-empty line of a traceback (the ExceptionType: message line)', () => {
    const tb = 'Traceback (most recent call last):\n  File "x.py", line 1\n    foo()\nNameError: name \'foo\' is not defined\n';
    expect(sanitizeErrorExcerpt(tb)).toBe("NameError: name 'foo' is not defined");
  });

  it('strips ANSI codes from kernel error output', () => {
    const tb = 'line1\n\x1b[0;31mZeroDivisionError\x1b[0m: division by zero';
    expect(sanitizeErrorExcerpt(tb)).toBe('ZeroDivisionError: division by zero');
  });

  it('truncates very long error lines', () => {
    const excerpt = sanitizeErrorExcerpt('E: ' + 'x'.repeat(1000));
    expect(excerpt.length).toBeLessThanOrEqual(281); // cap + ellipsis
    expect(excerpt.endsWith('…')).toBe(true);
  });

  it('handles empty input', () => {
    expect(sanitizeErrorExcerpt('')).toBe('');
  });
});

describe('shellSingleQuote', () => {
  it('wraps in single quotes and escapes embedded single quotes', () => {
    expect(shellSingleQuote("it's a $TEST `with` stuff")).toBe("'it'\\''s a $TEST `with` stuff'");
  });
});

describe('agentTerminalService prompt injection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    agentTerminalService.setAgentTerminal('t1');
  });

  afterEach(() => {
    vi.useRealTimers();
    agentTerminalService.unregisterSender('t1');
    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setNotebookContext(null);
    agentTerminalService.setServerContext(null);
    agentTerminalService.setRepoRoot(null);
    agentTerminalService.setPanelOpener(null);
    window.sessionStorage.clear();
  });

  it('uses the machine-agnostic npx setup command, with server repo path as context', () => {
    agentTerminalService.setRepoRoot('/srv/my nebula');
    expect(agentTerminalService.buildSetupMcpCommand()).toBe('npx nebula-notebook-mcp setup-mcp');
    const prompt = agentTerminalService.buildBootstrapPrompt();
    expect(prompt).toContain('npx nebula-notebook-mcp setup-mcp');
    expect(prompt).toContain('/srv/my nebula');
  });

  it('restores running status when the sender re-registers (panel closed and reopened)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');

    // Panel closes: WS drops — status survives (pty is alive server-side).
    agentTerminalService.unregisterSender('t1');
    expect(agentTerminalService.getState().status).toBe('running');

    // Panel reopens: sender re-registers for the still-designated terminal.
    agentTerminalService.registerSender('t1', () => true);
    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('restores running status after a refresh (same named terminal, new page)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('claude');
    expect(agentTerminalService.getState().status).toBe('running');

    // Simulate refresh: WS closes, designation drops, then the new page
    // reattaches to the SAME named terminal id.
    agentTerminalService.unregisterSender('t1');
    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setAgentTerminal('t1');

    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('does not restore after an explicit stop (flag cleared)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('codex');
    agentTerminalService.markStopped();

    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setAgentTerminal('t1');
    expect(agentTerminalService.getState().status).toBe('none');
  });

  it('refuses to inject when no agent was launched (would type into a bare shell)', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });

    const result = agentTerminalService.sendPrompt('echo pwned');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('agent-not-running');
    expect(sent).toHaveLength(0);
  });

  it('opens the panel when asked to send with no agent running', () => {
    const opener = vi.fn();
    agentTerminalService.setPanelOpener(opener);
    agentTerminalService.sendPrompt('hello');
    expect(opener).toHaveBeenCalled();
  });

  it('sends sanitized text first, then Enter after a delay', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('claude');
    expect(sent).toHaveLength(1);

    const result = agentTerminalService.sendPrompt('fix\nthe error');
    expect(result.ok).toBe(true);
    expect(sent[1]).toBe('fix the error');

    vi.advanceTimersByTime(200);
    expect(sent[2]).toBe('\r');
  });

  it('launch command carries server URL + notebook path as a quoted bootstrap prompt', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.setServerContext('http://localhost:8000');
    agentTerminalService.setNotebookContext("/tmp/my analysis's.ipynb");

    agentTerminalService.launchAgent('claude');
    const cmd = sent[0];
    expect(cmd.startsWith("claude '")).toBe(true);
    expect(cmd.endsWith('\r')).toBe(true);
    expect(cmd).toContain('connect_server');
    expect(cmd).toContain('http://localhost:8000');
    // teaches the agent how to get the MCP if it's missing
    expect(cmd).toContain('setup-mcp');
    // and to ask the user when the URL isn't reachable from its machine
    expect(cmd).toContain('not reachable');
    // single quote in path is shell-escaped, so the arg can't break out
    expect(cmd).toContain("my analysis'\\''s.ipynb");
    expect(cmd).not.toContain('\n');
  });

  it('markRunning injects the bootstrap context into a manually started agent', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.setServerContext('http://localhost:8000');
    agentTerminalService.setNotebookContext('/tmp/demo.ipynb');

    agentTerminalService.markRunning();
    expect(sent[0]).toContain('connect_server');
    expect(sent[0]).toContain('http://localhost:8000');
    expect(sent[0]).toContain('/tmp/demo.ipynb');
    vi.advanceTimersByTime(200);
    expect(sent[1]).toBe('\r');
  });

  it('composes fix prompts with notebook path, cell ref, and error excerpt', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t1', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('claude');
    agentTerminalService.setNotebookContext('/tmp/demo.ipynb');

    agentTerminalService.sendFixPrompt({
      cellNumber: 3,
      cellId: 'abc',
      errorContent: 'Traceback...\nNameError: x is not defined',
    });
    const prompt = sent[1];
    expect(prompt).toContain('/tmp/demo.ipynb');
    expect(prompt).toContain('cell 3 (id abc)');
    expect(prompt).toContain('NameError: x is not defined');
    expect(prompt).toContain('nebula-notebook MCP');
    expect(prompt).not.toContain('\n');
  });

  it('keeps agent status through a dropped connection (pty survives; terminal auto-reconnects)', () => {
    agentTerminalService.registerSender('t1', () => true);
    agentTerminalService.launchAgent('codex');
    expect(agentTerminalService.getState().status).toBe('running');

    agentTerminalService.unregisterSender('t1');
    // Status survives the WS drop, but injection is gated until reconnect.
    expect(agentTerminalService.getState().status).toBe('running');
    expect(agentTerminalService.isConnected()).toBe(false);
    const result = agentTerminalService.sendPrompt('hi');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('not-connected');

    // Reconnect: sender re-registers, everything works again.
    agentTerminalService.registerSender('t1', () => true);
    expect(agentTerminalService.isConnected()).toBe(true);
    expect(agentTerminalService.getState().status).toBe('running');

    // A real exit still clears the state.
    agentTerminalService.markStopped();
    expect(agentTerminalService.getState().status).toBe('none');
  });
});

describe('remote-agent mode (agent on the user machine)', () => {
  const SETTINGS_KEY = 'nebula-settings';

  beforeEach(() => {
    agentTerminalService.setAgentTerminal('t9');
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({
      remoteAgentEnabled: true,
      remoteAgentPort: 34567,
      remoteAgentUser: 'jane',
      remoteAgentLocalUrl: 'http://localhost:3000',
      remoteAgentJumpHost: 'bastion',
    }));
  });

  afterEach(() => {
    agentTerminalService.unregisterSender('t9');
    agentTerminalService.setAgentTerminal(null);
    agentTerminalService.setNotebookContext(null);
    window.localStorage.removeItem(SETTINGS_KEY);
    window.sessionStorage.clear();
  });

  it('is inert unless enabled AND user is set', () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteAgentEnabled: true, remoteAgentPort: 34567 }));
    expect(agentTerminalService.getRemoteAgentConfig()).toBeNull();
    expect(agentTerminalService.buildRemoteLaunchCommand('claude')).toBeNull();
  });

  it('composes the tunnel command with jump host, forward, and reverse port', () => {
    const cmd = agentTerminalService.buildTunnelCommand('login-node-01', 3000);
    expect(cmd).toBe('ssh -J bastion -L 3000:localhost:3000 -R 34567:localhost:22 login-node-01');
  });

  it('launchAgent types an ssh-back line that survives nested quoting', () => {
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.setNotebookContext('/data/proj/nb.ipynb');
    agentTerminalService.launchAgent('claude');

    const line = sent[0];
    expect(line).toMatch(/^ssh -t -p 34567 -o ProxyCommand=none -o StrictHostKeyChecking=accept-new jane@localhost '/);
    expect(line).toContain('NEBULA_URL=http://localhost:3000 claude ');
    expect(line).toContain('exec "$SHELL" -l -i -c ');
    // survives tunnel drops: reattach via tmux when available
    expect(line).toContain('tmux new -A -s nebula-agent ');
    expect(line).toContain('command -v tmux');
    // bootstrap rides inside: server paths + local-URL guidance, single line
    expect(line).toContain('/data/proj/nb.ipynb');
    expect(line).toContain('paths on the SERVER');
    expect(line).not.toContain('\n');
    expect(agentTerminalService.getState().agentKind).toBe('claude');
  });

  it('local launch is unchanged when the mode is disabled', () => {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ remoteAgentEnabled: false }));
    const sent: string[] = [];
    agentTerminalService.registerSender('t9', (d) => { sent.push(d); return true; });
    agentTerminalService.launchAgent('codex');
    expect(sent[0].startsWith('codex ')).toBe(true);
    expect(sent[0]).not.toContain('ssh');
  });
});
