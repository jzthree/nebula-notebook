import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalPanel } from '../TerminalPanel';
import { NotificationProvider } from '../NotificationSystem';

let resizeSpy: ReturnType<typeof vi.fn> | null = null;
let rafSpy: ReturnType<typeof vi.spyOn> | null = null;

vi.mock('../../services/terminalService', () => ({
  getTerminalServerInfo: vi.fn().mockResolvedValue({ available: true, repoRoot: '/srv/nebula' }),
  getOrCreateNamedTerminal: vi.fn().mockResolvedValue({ id: 'terminal-1' }),
  listTerminals: vi.fn().mockResolvedValue([{ id: 'terminal-1', cwd: '/', pid: 1 }]),
  checkReverseTunnel: vi.fn().mockResolvedValue({ up: false, ssh: null }),
  // Shell plane: the shared default. Agent plane: no stored binding, so the
  // panel derives the terminal name from the workdir (project scope).
  getTerminalBinding: vi.fn().mockImplementation((_path: string, plane?: string) =>
    plane === 'agent'
      ? Promise.reject(new Error('no binding'))
      : Promise.resolve({ plane: 'shell', scope: 'server', name: 'srv-main', custom_name: null, stored: false })),
  setTerminalBinding: vi.fn().mockResolvedValue({ plane: 'shell', scope: 'server', name: 'srv-main', custom_name: null, stored: true }),
  closeTerminal: vi.fn(),
}));

vi.mock('../../services/environmentService', () => ({
  fetchEnvironment: vi.fn().mockResolvedValue({ kind: 'remote' }),
  serverIsRemote: vi.fn().mockReturnValue(true),
}));

vi.mock('../../services/agentRegistryService', () => ({
  getActiveAgentId: vi.fn().mockReturnValue(null),
  setActiveAgentId: vi.fn(),
  notebookDirOf: vi.fn().mockReturnValue('/tmp'),
  agentTerminalNameFor: vi.fn().mockReturnValue('terminal-1'),
  listAgents: vi.fn().mockResolvedValue([]),
  registerAgent: vi.fn().mockResolvedValue(undefined),
  hibernateAgent: vi.fn().mockResolvedValue(true),
  deleteAgent: vi.fn().mockResolvedValue(true),
}));

vi.mock('../TerminalInstance', () => ({
  TerminalInstance: () => {
    useEffect(() => {
      const container = document.querySelector('[data-terminal-container]');
      if (container) {
        resizeSpy = vi.fn();
        (container as any).__terminalResize = resizeSpy;
      }
    }, []);
    return <div data-testid="terminal-instance" />;
  },
}));

describe('TerminalPanel', () => {
  beforeEach(() => {
    resizeSpy = null;
    rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb(0);
      return 1;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('offers restart without a manage-tab trip when a remote agent loses its connection', async () => {
    const { agentTerminalService } = await import('../../services/agentTerminalService');
    window.localStorage.setItem('nebula-settings', JSON.stringify({
      remoteAgentEnabled: true,
      remoteAgentPort: 34567,
      remoteAgentUser: 'yuchen',
      remoteAgentLocalUrl: 'http://localhost:3000',
    }));
    const sent: string[] = [];
    agentTerminalService.setAgentTerminal('terminal-1');
    agentTerminalService.registerSender('terminal-1', (d) => { sent.push(d); return true; });
    agentTerminalService.adoptRunningState('codex');

    try {
      render(
        <NotificationProvider>
          <TerminalPanel isOpen={true} onClose={() => {}} notebookPath="/tmp/test.ipynb" />
        </NotificationProvider>
      );
      fireEvent.click(screen.getByText('Agent'));

      // Tunnel polling (mocked down) + running remote agent → the frozen-session
      // bar appears over the terminal, with recovery actions.
      const bar = await screen.findByTestId('agent-conn-lost-bar');
      expect(bar.textContent).toContain('Connection to your machine lost');
      expect(screen.getByText('start new agent')).toBeInTheDocument();

      // Recovery kills the hung ssh (client escape) and resets agent state so
      // launching no longer requires deleting records in the manage tab.
      fireEvent.click(screen.getByText('start new agent'));
      expect(sent).toContain('\r~.');
      expect(agentTerminalService.getState().status).toBe('none');
    } finally {
      agentTerminalService.unregisterSender('terminal-1');
      agentTerminalService.markStopped();
      agentTerminalService.setAgentTerminal(null);
      window.localStorage.removeItem('nebula-settings');
    }
  });

  it('treats a live record with an idle shell as resumable, not attachable-running', async () => {
    const { agentTerminalService } = await import('../../services/agentTerminalService');
    const { listAgents } = await import('../../services/agentRegistryService');
    // Server says: pty alive ('live') but its shell has NO child — the agent
    // (or its ssh hop) is gone. Attaching must not adopt a phantom "running".
    vi.mocked(listAgents).mockResolvedValue([{
      terminalId: 'terminal-1', kind: 'codex', workdir: '/tmp', location: 'server',
      state: 'live', idleShell: true, createdAt: 1, lastLaunchAt: 1,
    } as any]);

    try {
      render(
        <NotificationProvider>
          <TerminalPanel isOpen={true} onClose={() => {}} notebookPath="/tmp/test.ipynb" />
        </NotificationProvider>
      );
      fireEvent.click(screen.getByText('Agent'));

      // Guidance bar offers Continue (the conversation is resumable), not
      // Attach (there is nothing running to attach to).
      await screen.findByText('⟳ Continue session');
      expect(screen.queryByText('Attach agent')).toBeNull();
      expect(agentTerminalService.getState().status).not.toBe('running');
    } finally {
      vi.mocked(listAgents).mockResolvedValue([]);
      agentTerminalService.markStopped();
      agentTerminalService.setAgentTerminal(null);
    }
  });

  it('uses a transparent container that clips overflow', async () => {
    render(
      <NotificationProvider>
        <TerminalPanel isOpen={true} onClose={() => {}} notebookPath="/tmp/test.ipynb" />
      </NotificationProvider>
    );
    const panel = await screen.findByTestId('terminal-panel');
    expect(panel.className).toContain('bg-transparent');
    expect(panel.className).toContain('overflow-hidden');
  });

  it('triggers terminal resize during drag', async () => {
    render(
      <NotificationProvider>
        <TerminalPanel isOpen={true} onClose={() => {}} notebookPath="/tmp/test.ipynb" />
      </NotificationProvider>
    );

    await waitFor(() => {
      // Both planes may reattach (shell + agent), each with an instance
      expect(screen.getAllByTestId('terminal-instance').length).toBeGreaterThan(0);
    });
    await waitFor(() => {
      expect(resizeSpy).toBeTruthy();
    });

    const handle = screen.getByTestId('terminal-resize-handle');
    fireEvent.mouseDown(handle, { clientY: 300 });
    fireEvent.mouseMove(document, { clientY: 250 });

    await waitFor(() => {
      expect(rafSpy).toHaveBeenCalled();
    });
  });
});
