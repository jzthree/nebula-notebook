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
