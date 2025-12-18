import React, { useState, useEffect } from 'react';
import { X, Folder, Bot, Check, Palette } from 'lucide-react';
import {
  getSettings,
  saveSettings,
  getAvailableProviders,
  LLMProvider,
  NebulaSettings,
  DEFAULT_MODELS
} from '../services/llmService';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onRefresh: () => void;
}

export const SettingsModal: React.FC<Props> = ({ isOpen, onClose, onRefresh }) => {
  const [settings, setSettings] = useState<NebulaSettings>(getSettings());
  const [providers, setProviders] = useState<Record<string, string[]>>({});
  const [isSaving, setIsSaving] = useState(false);

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

  if (!isOpen) return null;

  const availableProviders = Object.keys(providers) as LLMProvider[];
  const availableModels = providers[settings.llmProvider] || [];

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
          className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden"
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

          {/* Content */}
          <div className="px-6 py-4 space-y-6">
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

            {/* LLM Provider */}
            <div>
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-2">
                <Bot className="w-4 h-4" />
                AI Provider
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['google', 'openai', 'anthropic'] as LLMProvider[]).map((provider) => {
                  const isAvailable = availableProviders.includes(provider);
                  const isSelected = settings.llmProvider === provider;

                  return (
                    <button
                      key={provider}
                      onClick={() => isAvailable && handleProviderChange(provider)}
                      disabled={!isAvailable}
                      className={`
                        relative px-3 py-2 rounded-lg text-xs font-medium transition-all
                        ${isSelected
                          ? 'bg-blue-600 text-white ring-2 ring-blue-200'
                          : isAvailable
                            ? 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                            : 'bg-slate-50 text-slate-400 cursor-not-allowed'
                        }
                      `}
                    >
                      {isSelected && (
                        <Check className="absolute top-1 right-1 w-3 h-3" />
                      )}
                      {provider === 'google' && 'Google'}
                      {provider === 'openai' && 'OpenAI'}
                      {provider === 'anthropic' && 'Anthropic'}
                    </button>
                  );
                })}
              </div>
              {availableProviders.length === 0 && (
                <p className="mt-2 text-xs text-amber-600">
                  No API keys configured. Add keys to the server .env file.
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
