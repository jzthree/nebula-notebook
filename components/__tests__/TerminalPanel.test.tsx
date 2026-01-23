import React, { useEffect } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TerminalPanel } from '../TerminalPanel';

let resizeSpy: ReturnType<typeof vi.fn> | null = null;
let rafSpy: ReturnType<typeof vi.spyOn> | null = null;

vi.mock('../../services/terminalService', () => ({
  checkTerminalServer: vi.fn().mockResolvedValue(true),
  createTerminal: vi.fn().mockResolvedValue({ id: 'terminal-1' }),
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
      <TerminalPanel isOpen={true} onClose={() => {}} notebookPath="/tmp/test.ipynb" />
    );
    const panel = await screen.findByTestId('terminal-panel');
    expect(panel.className).toContain('bg-transparent');
    expect(panel.className).toContain('overflow-hidden');
  });

  it('triggers terminal resize during drag', async () => {
    render(
      <TerminalPanel isOpen={true} onClose={() => {}} notebookPath="/tmp/test.ipynb" />
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
