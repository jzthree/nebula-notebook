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
  getTerminalBinding: vi.fn().mockResolvedValue({ plane: 'shell', scope: 'server', name: 'srv-main', custom_name: null, stored: false }),
  setTerminalBinding: vi.fn().mockResolvedValue({ plane: 'shell', scope: 'server', name: 'srv-main', custom_name: null, stored: true }),
  closeTerminal: vi.fn(),
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
      expect(screen.getByTestId('terminal-instance')).toBeInTheDocument();
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
