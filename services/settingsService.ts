/**
 * App settings storage (localStorage).
 *
 * Extracted from the former llmService when direct-API AI features were
 * removed — these are general app settings, unrelated to any model provider.
 * The storage key is unchanged for backwards compatibility; stale AI fields
 * (llmProvider, llmModel, apiKeys) in previously-saved JSON are simply ignored.
 */

const SETTINGS_KEY = 'nebula-settings';

export type IndentationPreference = 'auto' | '2' | '4' | '8' | 'tab';

export interface NebulaSettings {
  rootDirectory: string;
  lastKernel: string;
  notifyOnLongRun?: boolean; // Send browser notification when long-running jobs complete
  notifyThresholdSeconds?: number; // Threshold in seconds for "long-running" (default 60)
  notifySoundEnabled?: boolean; // Play sound when long-running jobs complete
  indentation?: IndentationPreference; // Indentation style: 'auto' (detect), '2', '4', '8', or 'tab'
  showLineNumbers?: boolean; // Show line numbers in code cells
  showCellIds?: boolean; // Show cell IDs in the cell header
  showResourceMonitor?: boolean; // Show RAM/GPU usage in notebook status bar (disabled by default for typing perf)
  smoothAutoScroll?: boolean; // Animate notebook-driven auto-scroll actions
  jupyterShortcuts?: boolean; // Jupyter classic cell-mode keys: dd delete, z undo, Shift+Z redo, 00 restart, ii interrupt
  // On a scheduler login node, whether to run kernels directly on this (shared) node.
  // undefined = undecided → the user is asked once, on first login-node kernel start.
  allowLoginNodeKernels?: 'allow' | 'deny';
  // Remote-agent mode: run the coding agent on the USER'S machine (its RAM,
  // its network) while its terminal lives in the Nebula page — over a reverse
  // SSH channel (-R <port>:localhost:22) carried by the user's own tunnel.
  remoteAgentEnabled?: boolean;
  remoteAgentPort?: number;     // reverse-channel port on the server host; random per user to avoid collisions on shared login nodes
  remoteAgentUser?: string;     // username on the user's machine (for ssh back)
  remoteAgentLocalUrl?: string; // Nebula URL as seen FROM the user's machine (their -L forward), default http://localhost:3000
  remoteAgentJumpHost?: string; // optional ProxyJump host for the displayed tunnel command
}

export const getSettings = (): NebulaSettings => {
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if (stored) {
      return JSON.parse(stored);
    }
  } catch (e) {
    console.error('Failed to load settings:', e);
  }

  // Default settings
  return {
    rootDirectory: '~',
    lastKernel: 'python3',
    notifyOnLongRun: true,
    notifySoundEnabled: true,
    notifyThresholdSeconds: 60,
    indentation: 'auto',
    showCellIds: false,
    smoothAutoScroll: true,
  };
};

export const saveSettings = (settings: Partial<NebulaSettings>): void => {
  const current = getSettings();
  const updated = { ...current, ...settings };
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(updated));
};

/**
 * Reverse-channel port for remote-agent mode. Generated once per browser
 * (random in 20000-59999 so users on a shared login node don't collide),
 * then stable so the user's saved tunnel command keeps working.
 */
export const ensureRemoteAgentPort = (): number => {
  const s = getSettings();
  if (s.remoteAgentPort && Number.isInteger(s.remoteAgentPort)) return s.remoteAgentPort;
  const port = 20000 + Math.floor(Math.random() * 40000);
  saveSettings({ remoteAgentPort: port });
  return port;
};
