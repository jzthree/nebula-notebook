import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Dashboard } from '../Dashboard';
import { NotificationProvider } from '../NotificationSystem';

// Mock heavy children that do their own data fetching — the welcome card
// lives directly in Dashboard and doesn't depend on any of them.
vi.mock('../FileBrowser', () => ({ FileBrowser: () => <div data-testid="file-browser" /> }));
vi.mock('../ResourcePanel', () => ({ ResourcePanel: () => null }));
vi.mock('../ComputeDashboardCard', () => ({ default: () => null }));
vi.mock('../KernelManager', () => ({ KernelManager: () => null }));
vi.mock('../TerminalManager', () => ({ TerminalManager: () => null }));

vi.mock('../../services/terminalService', () => ({
  listTerminals: vi.fn(() => Promise.resolve([])),
}));
vi.mock('../../services/kernelService', () => ({
  getDeadKernelSessions: vi.fn(() => Promise.resolve([])),
  cleanupDeadKernelSessions: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../services/clusterService', () => ({
  getClusterInfo: vi.fn(() => Promise.reject(new Error('no cluster'))),
}));
vi.mock('../../services/fileService', () => ({
  writeFile: vi.fn(() => Promise.resolve()),
  getFileMtime: vi.fn(() => Promise.reject(new Error('not found'))),
  createNotebook: vi.fn(),
}));

const WELCOME_DISMISSED_KEY = 'nebula-welcome-dismissed';
const RECENT_NOTEBOOKS_KEY = 'nebula-recent-notebooks';

function renderDashboard() {
  return render(
    <NotificationProvider>
      <Dashboard />
    </NotificationProvider>
  );
}

describe('Dashboard welcome card', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    // Dashboard fetches /api/health and /api/kernels/sessions directly;
    // a non-ok response falls back to defaults in both code paths.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false } as Response)));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shows the welcome card when there is no dismissed flag and no recent notebooks', async () => {
    renderDashboard();

    expect(await screen.findByTestId('welcome-card')).toBeInTheDocument();
    expect(screen.getByText('Welcome to Nebula')).toBeInTheDocument();
    expect(screen.getByText('Open the sample notebook')).toBeInTheDocument();
    expect(screen.getByText('Start with your own notebook')).toBeInTheDocument();
    expect(screen.getByText('See what agents can do')).toBeInTheDocument();
  });

  it('does not show the welcome card when it was dismissed', async () => {
    localStorage.setItem(WELCOME_DISMISSED_KEY, '1');
    renderDashboard();

    await waitFor(() => {
      expect(screen.queryByTestId('welcome-card')).toBeNull();
    });
  });

  it('does not show the welcome card when there are recent notebooks', async () => {
    localStorage.setItem(
      RECENT_NOTEBOOKS_KEY,
      JSON.stringify([{ path: '~/analysis.ipynb', name: 'analysis', openedAt: Date.now() }])
    );
    renderDashboard();

    await waitFor(() => {
      expect(screen.queryByTestId('welcome-card')).toBeNull();
    });
  });

  it('dismissing via the X button sets the flag and hides the card', async () => {
    renderDashboard();

    const dismissButton = await screen.findByLabelText('Dismiss welcome');
    fireEvent.click(dismissButton);

    expect(localStorage.getItem(WELCOME_DISMISSED_KEY)).toBe('1');
    expect(screen.queryByTestId('welcome-card')).toBeNull();
  });
});
