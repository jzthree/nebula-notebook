import React, { useState, useEffect, useCallback } from 'react';
import { X, Folder, Bot, Check, Palette, Bell, Volume2, AlignLeft, Hash, Key, Eye, EyeOff, AlertTriangle, Settings, Sparkles } from 'lucide-react';
import {
  getSettings,
  saveSettings,
  getAvailableProviders,
  LLMProvider,
  NebulaSettings,
  DEFAULT_MODELS,
  IndentationPreference
} from '../services/llmService';
import { useNotification } from './NotificationSystem';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

type SettingsTab = 'general' | 'ai' | 'appearance' | 'notifications';

export const SettingsModal: React.FC<Props> = ({ isOpen, onClose, onRefresh }) => {
  const [settings, setSettings] = useState<NebulaSettings>(getSettings());
  const [providers, setProviders] = useState<Record<string, string[]>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [showApiKeys, setShowApiKeys] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<SettingsTab>('general');
  const { toast } = useNotification();

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
      loadProviders();
    }
  }, [isOpen]);

  const loadProviders = async () => {
    try {
      const response = await getAvailableProviders();
      setProviders(response.providers);
    } catch (error) {
      console.error('Failed to load providers:', error);
      // Fallback to default providers
      setProviders({
        google: ['gemini-2.5-flash', 'gemini-2.5-pro'],
        openai: ['gpt-4o', 'gpt-4o-mini'],
        anthropic: ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514']
      });
    }
  };

  const handleSave = () => {
    setIsSaving(true);
    saveSettings(settings);
    setTimeout(() => {
      setIsSaving(false);
      onRefresh();
      onClose();
    }, 300);
  };

  const handleProviderChange = (provider: LLMProvider) => {
    const models = providers[provider] || [];
    setSettings({
      ...settings,
      llmProvider: provider,
      llmModel: models[0] || DEFAULT_MODELS[provider]
    });
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

  const availableProviders = Object.keys(providers) as LLMProvider[];
  const availableModels = providers[settings.llmProvider] || [];

  const tabs: { id: SettingsTab; label: string; icon: React.ReactNode }[] = [
    { id: 'general', label: 'General', icon: <Settings className="w-4 h-4" /> },
    { id: 'ai', label: 'AI', icon: <Sparkles className="w-4 h-4" /> },
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
          className="bg-white rounded-xl shadow-2xl w-full max-w-lg overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
            <h2 className="text-lg font-semibold text-slate-900">Settings</h2>
            <button
              onClick={onClose}
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
          <div className="px-6 py-4 space-y-5 min-h-[320px] max-h-[60vh] overflow-y-auto">
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
                    The default directory for the file browser. Use ~ for home directory.
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
              </>
            )}

            {/* AI Tab */}
            {activeTab === 'ai' && (
              <>
                {/* LLM Provider */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Bot className="w-4 h-4" />
                    AI Provider
                  </label>
                  <div className="grid grid-cols-3 gap-2">
                    {(['google', 'openai', 'anthropic'] as LLMProvider[]).map((provider) => {
                      // Provider is available if server has env var OR user has configured API key in settings
                      const hasServerKey = availableProviders.includes(provider);
                      const hasClientKey = !!settings.apiKeys?.[provider];
                      const isAvailable = hasServerKey || hasClientKey;
                      const isSelected = settings.llmProvider === provider;

                      return (
                        <button
                          key={provider}
                          onClick={() => handleProviderChange(provider)}
                          className={`
                            relative px-3 py-2 rounded-lg text-xs font-medium transition-all
                            ${isSelected
                              ? 'bg-blue-600 text-white ring-2 ring-blue-200'
                              : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            }
                          `}
                        >
                          {isSelected && (
                            <Check className="absolute top-1 right-1 w-3 h-3" />
                          )}
                          {provider === 'google' && 'Google'}
                          {provider === 'openai' && 'OpenAI'}
                          {provider === 'anthropic' && 'Anthropic'}
                          {!isAvailable && (
                            <span className="ml-1 text-amber-500" title="No API key configured">⚠</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  {availableProviders.length === 0 && !Object.values(settings.apiKeys || {}).some(k => k) && (
                    <p className="mt-2 text-xs text-amber-600">
                      No API keys configured. Add keys below or in the server .env file.
                    </p>
                  )}
                </div>

                {/* Model Selection */}
                <div>
                  <label className="text-sm font-medium text-slate-700 mb-2 block">
                    Model
                  </label>
                  <select
                    value={settings.llmModel}
                    onChange={(e) => setSettings({ ...settings, llmModel: e.target.value })}
                    className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white"
                  >
                    {availableModels.map((model) => (
                      <option key={model} value={model}>
                        {model}
                      </option>
                    ))}
                  </select>
                </div>

                {/* API Keys */}
                <div>
                  <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                    <Key className="w-4 h-4" />
                    API Keys
                  </label>
                  <div className="space-y-3">
                    {(['google', 'openai', 'anthropic'] as const).map((provider) => {
                      const providerNames = { google: 'Google (Gemini)', openai: 'OpenAI', anthropic: 'Anthropic' };
                      const apiKey = settings.apiKeys?.[provider] || '';
                      const isVisible = showApiKeys[provider];

                      return (
                        <div key={provider} className="relative">
                          <label className="text-xs text-slate-500 mb-1 block">{providerNames[provider]}</label>
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <input
                                type={isVisible ? 'text' : 'password'}
                                value={apiKey}
                                onChange={(e) => setSettings({
                                  ...settings,
                                  apiKeys: { ...settings.apiKeys, [provider]: e.target.value }
                                })}
                                placeholder={`Enter ${providerNames[provider]} API key`}
                                className="w-full px-3 py-2 pr-10 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono"
                              />
                              <button
                                type="button"
                                onClick={() => setShowApiKeys({ ...showApiKeys, [provider]: !isVisible })}
                                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-600"
                              >
                                {isVisible ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                              </button>
                            </div>
                            {apiKey && (
                              <button
                                onClick={() => setSettings({
                                  ...settings,
                                  apiKeys: { ...settings.apiKeys, [provider]: '' }
                                })}
                                className="px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded"
                              >
                                Clear
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="mt-3 p-2 bg-amber-50 border border-amber-200 rounded-lg flex gap-2">
                    <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-700">
                      API keys are stored in your browser's local storage. Avoid using on shared computers.
                      Keys configured here override server environment variables.
                    </p>
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
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-lg">
                    <div className="flex-1">
                      <p className="text-sm text-slate-700">AI-Generated Icons</p>
                      <p className="text-xs text-slate-500">
                        Use AI to generate unique icons for each notebook (uses API credits)
                      </p>
                    </div>
                    <button
                      onClick={() => setSettings({ ...settings, useAIAvatars: !settings.useAIAvatars })}
                      className={`relative w-11 h-6 rounded-full transition-colors ${
                        settings.useAIAvatars ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`absolute top-1 left-1 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                          settings.useAIAvatars ? 'translate-x-5' : 'translate-x-0'
                        }`}
                      />
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    When disabled, colorful auto-generated icons based on notebook name are used (no API calls).
                  </p>
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
