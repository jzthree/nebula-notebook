import React, { useState, useEffect, useCallback } from 'react';
import { X, Folder, Palette, Bell, Volume2, AlignLeft, Hash, Settings, Cpu, MousePointerClick, Keyboard } from 'lucide-react';
import {
  getSettings,
  saveSettings,
  NebulaSettings,
  IndentationPreference,
} from '../services/settingsService';
import { getRootDirectory, setRootDirectory } from '../services/fileService';
import { useNotification } from './NotificationSystem';
import { useModalA11y } from '../hooks/useModalA11y';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
  /** True when the server is a scheduler (login) node — shows the login-node kernel toggle. */
  isLoginNode?: boolean;
}

type SettingsTab = 'general' | 'appearance' | 'notifications';

export const SettingsModal: React.FC<Props> = (props) => {
  // Mount the panel only while open so useModalA11y attaches/cleans up per open.
  if (!props.isOpen) return null;
  return <SettingsModalContent {...props} />;
};

const SettingsModalContent: React.FC<Props> = ({ isOpen, onClose, onRefresh, isLoginNode = false }) => {
  const [settings, setSettings] = useState<NebulaSettings>(getSettings());
  const [isSaving, setIsSaving] = useState(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const [serverRoot, setServerRoot] = useState<string | null>(null);
  const { toast } = useNotification();
  const modalRef = useModalA11y<HTMLDivElement>(onClose);

  const persistSettings = useCallback((next: Partial<NebulaSettings>) => {
    setSettings(prev => ({ ...prev, ...next }));
    saveSettings(next);
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('nebula-settings');
      if (!stored) {
        saveSettings({ notifyOnLongRun: false });
        setSettings(prev => ({ ...prev, notifyOnLongRun: false }));
        return;
      }

      const parsed = JSON.parse(stored) as Partial<NebulaSettings> | null;
      if (parsed && parsed.notifyOnLongRun === undefined) {
        saveSettings({ notifyOnLongRun: false });
        setSettings(prev => ({ ...prev, notifyOnLongRun: false }));
      }
    } catch (error) {
      console.warn('Failed to apply default notification setting:', error);
    }
  }, []);

  useEffect(() => {
    if (isOpen) {
      setSettings(getSettings());
      getRootDirectory()
        .then((root) => {
          setServerRoot(root);
          setSettings(prev => ({ ...prev, rootDirectory: root }));
          saveSettings({ rootDirectory: root });
        })
        .catch(() => {
          // Ignore root fetch errors
        });
    }
  }, [isOpen]);

  const handleSave = async () => {
    setIsSaving(true);
    let resolvedRoot = serverRoot;
    if (settings.rootDirectory && settings.rootDirectory !== serverRoot) {
      try {
        const updated = await setRootDirectory(settings.rootDirectory);
        resolvedRoot = updated;
        setServerRoot(updated);
        setSettings(prev => ({ ...prev, rootDirectory: updated }));
        saveSettings({ rootDirectory: updated });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to update root directory';
        toast(message, 'error');
        setIsSaving(false);
        return;
      }
    }
    const finalSettings = {
      ...settings,
      rootDirectory: resolvedRoot || settings.rootDirectory
    };
    saveSettings(finalSettings);
    setTimeout(() => {
      setIsSaving(false);
      onRefresh();
      onClose();
    }, 300);
  };

  const handleToggleLongRunNotifications = async () => {
    const nextEnabled = !settings.notifyOnLongRun;

    if (nextEnabled) {
      if (typeof window === 'undefined' || !('Notification' in window)) {
        toast('Browser notifications are not supported in this environment.', 'warning');
        persistSettings({ notifyOnLongRun: false });
        return;
      }

      if (Notification.permission === 'default') {
        try {
          const permission = await Notification.requestPermission();
          if (permission === 'granted') {
            toast('Browser notifications enabled.', 'success', 3000);
          } else {
            toast('Browser notifications were not granted. Enable them in your browser settings.', 'warning', 5000);
          }
        } catch (error) {
          console.warn('Failed to request notification permission:', error);
          toast('Could not request notification permission.', 'error', 5000);
        }
      } else if (Notification.permission === 'denied') {
        toast('Browser notifications are blocked in your browser settings.', 'warning', 5000);
      }
    }

    persistSettings({ notifyOnLongRun: nextEnabled });
  };

  if (!isOpen) return null;

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Settings className="w-4 h-4" /> },
    { id: 'appearance', label: 'Appearance', icon: <Palette className="w-4 h-4" /> },
    { id: 'notifications', label: 'Notifications', icon: <Bell className="w-4 h-4" /> },
  ];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          ref={modalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          tabIndex={-1}
          className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
            <h2 className="text-lg font-semibold text-slate-900">Settings</h2>
            <button
              onClick={onClose}
              aria-label="Close settings"
              className="p-1 hover:bg-slate-100 rounded-md transition-colors"
            >
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>

          {/* Tabs */}
          <div className="flex border-b border-slate-200 px-4">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1.5 px-3 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.id
                    ? 'border-blue-600 text-blue-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="px-6 py-4 space-y-5 min-h-[20rem] max-h-[60vh] overflow-y-auto">
            {/* General Tab */}
            {activeTab === 'general' && (
              <>
                {/* Root Directory */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Folder className="w-4 h-4" />
                    Root Directory
                  </label>
                  <input
                    type="text"
                    value={settings.rootDirectory}
                    onChange={(e) => setSettings({ ...settings, rootDirectory: e.target.value })}
                    placeholder="/Users/username or ~"
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  />
                  <p className="mt-1 text-xs text-slate-500">
                    Sets the server root directory (used by file browser and terminals). Use ~ for home directory.
                  </p>
                </div>

                {/* Indentation */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <AlignLeft className="w-4 h-4" />
                    Indentation
                  </label>
                  <select
                    value={settings.indentation || 'auto'}
                    onChange={(e) => setSettings({ ...settings, indentation: e.target.value as IndentationPreference })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="2">2 spaces</option>
                    <option value="4">4 spaces</option>
                    <option value="8">8 spaces</option>
                    <option value="tab">Tabs</option>
                  </select>
                  <p className="mt-1 text-xs text-slate-500">
                    Auto-detect analyzes file content. Default is 4 spaces when content is ambiguous.
                  </p>
                </div>

                {/* Line Numbers */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Hash className="w-4 h-4" />
                    Line Numbers
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Show Line Numbers</p>
                      <p className="text-xs text-slate-500">
                        Display line numbers in code cells
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, showLineNumbers: !settings.showLineNumbers })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.showLineNumbers ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.showLineNumbers ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Cell IDs */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Hash className="w-4 h-4" />
                    Cell IDs
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Show Cell IDs</p>
                      <p className="text-xs text-slate-500">
                        Display cell IDs in the header (advanced)
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, showCellIds: !settings.showCellIds })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.showCellIds ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.showCellIds ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Jupyter classic keybindings */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Keyboard className="w-4 h-4" />
                    Keyboard
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Jupyter classic shortcuts</p>
                      <p className="text-xs text-slate-500">
                        In cell mode: dd deletes, z undoes, Shift+Z redoes, 00 restarts the kernel, ii interrupts.
                        (Suspends the D dequeue key while on.)
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, jupyterShortcuts: !settings.jupyterShortcuts })}
                      aria-label="Toggle Jupyter classic shortcuts"
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.jupyterShortcuts ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.jupyterShortcuts ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Login-node kernels — only relevant on a scheduler (login) node */}
                {isLoginNode && (
                  <div>
                    <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                      <Cpu className="w-4 h-4" />
                      Login-node kernels
                    </label>
                    <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                      <div className="flex-1 pr-3">
                        <p className="text-sm text-slate-700">Allow kernels on the login node</p>
                        <p className="text-xs text-slate-500">
                          This node runs a scheduler. When off, starting a kernel prompts you to
                          allocate compute instead of running on the shared login node.
                        </p>
                      </div>
                      <button
                        onClick={() => setSettings({ ...settings, allowLoginNodeKernels: settings.allowLoginNodeKernels === 'allow' ? 'deny' : 'allow' })}
                        className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${
                          settings.allowLoginNodeKernels === 'allow' ? 'bg-blue-600' : 'bg-slate-300'
                        }`}
                      >
                        <span
                          className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                            settings.allowLoginNodeKernels === 'allow' ? 'translate-x-5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                )}

                {/* Resource Monitor */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Cpu className="w-4 h-4" />
                    Resource Monitor
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Show Resource Monitor</p>
                      <p className="text-xs text-slate-500">
                        Display RAM/GPU usage in notebook status bar
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, showResourceMonitor: !settings.showResourceMonitor })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.showResourceMonitor ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.showResourceMonitor ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>

                {/* Auto-Scroll Animation */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <MousePointerClick className="w-4 h-4" />
                    Auto-Scroll Animation
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Smooth Notebook Auto-Scroll</p>
                      <p className="text-xs text-slate-500">
                        Animate jumps triggered by notebook actions like run-and-advance
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, smoothAutoScroll: !(settings.smoothAutoScroll ?? true) })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        (settings.smoothAutoScroll ?? true) ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          (settings.smoothAutoScroll ?? true) ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </>
            )}

            {/* Appearance Tab */}
            {activeTab === 'appearance' && (
              <>
                {/* Notebook Icons */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Palette className="w-4 h-4" />
                    Notebook Icons
                  </label>
                  <div className="p-3 bg-slate-50 rounded-lg">
                    <p className="text-sm text-slate-700">Deterministic Avatars</p>
                    <p className="text-xs text-slate-500 mt-1">
                      Each notebook gets a unique, colorful icon generated from its name.
                      Icons are consistent across sessions with no API calls required.
                    </p>
                  </div>
                </div>
              </>
            )}

            {/* Notifications Tab */}
            {activeTab === 'notifications' && (
              <>
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Bell className="w-4 h-4" />
                    Long-Running Job Alerts
                  </label>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">Browser Notifications</p>
                      <p className="text-xs text-slate-500">
                        Notify when queued cells finish after threshold
                      </p>
                    </div>
                    <button
                      onClick={handleToggleLongRunNotifications}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.notifyOnLongRun ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.notifyOnLongRun ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                  {settings.notifyOnLongRun && (
                    <div className="mt-2 flex items-center gap-2">
                      <label className="text-xs text-slate-600">Threshold:</label>
                      <input
                        type="number"
                        min="1"
                        max="600"
                        step="1"
                        value={settings.notifyThresholdSeconds ?? 60}
                        onChange={(e) => {
                          const nextValue = parseInt(e.target.value, 10);
                          persistSettings({ notifyThresholdSeconds: Number.isFinite(nextValue) ? nextValue : 60 });
                        }}
                        className="w-20 px-2 py-1 border border-slate-300 rounded text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                      <span className="text-xs text-slate-500">seconds</span>
                    </div>
                  )}
                </div>

                <div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex items-center gap-2">
                      <Volume2 className="w-4 h-4 text-slate-500" />
                      <div>
                        <p className="text-sm text-slate-700">Sound Alert</p>
                        <p className="text-xs text-slate-500">Play sound when job completes</p>
                      </div>
                    </div>
                    <button
                      onClick={() => persistSettings({ notifySoundEnabled: !settings.notifySoundEnabled })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.notifySoundEnabled ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.notifySoundEnabled ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* Footer */}
          <div className="flex justify-end gap-3 px-6 py-4 border-t border-slate-200 bg-slate-50">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-200 rounded-lg transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving}
              className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50 flex items-center gap-2"
            >
              {isSaving ? (
                <>
                  <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Saving...
                </>
              ) : (
                'Save Settings'
              )}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};
