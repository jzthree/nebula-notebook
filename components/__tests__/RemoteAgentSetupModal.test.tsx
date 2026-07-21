import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { RemoteAgentSetupModal } from '../RemoteAgentSetupModal';

vi.mock('../../services/terminalService', () => ({
  getTerminalServerInfo: vi.fn().mockResolvedValue({
    available: true,
    repoRoot: null,
    hostname: 'login-node',
    port: 3000,
  }),
  checkReverseTunnel: vi.fn().mockResolvedValue({ up: false, ssh: null }),
}));

describe('RemoteAgentSetupModal', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('instructs storing the token under the Nebula-scoped name, not the global var', () => {
    render(<RemoteAgentSetupModal onClose={() => {}} />);

    // Storing the token as CLAUDE_CODE_OAUTH_TOKEN would hijack the user's own
    // interactive claude sessions; the setup must use the NEBULA-scoped name.
    expect(
      screen.getByText(/export CLAUDE_CODE_OAUTH_TOKEN_NEBULA=PASTE-TOKEN-HERE/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/export CLAUDE_CODE_OAUTH_TOKEN=PASTE-TOKEN-HERE/)
    ).toBeNull();
  });

  it('states the nebula CLI prerequisite for the user machine', () => {
    render(<RemoteAgentSetupModal onClose={() => {}} />);

    // The agent launched on the user's machine drives the notebook through the
    // nebula CLI — the guided setup must say so without pointing at the README.
    expect(screen.getByText(/nebula CLI/i)).toBeInTheDocument();
    expect(screen.getByText('npm install -g nebula-notebook-mcp')).toBeInTheDocument();
    // The zero-install path (Node's npx fallback) must be mentioned too.
    expect(screen.getByText(/npx -p nebula-notebook-mcp/)).toBeInTheDocument();
  });
});
