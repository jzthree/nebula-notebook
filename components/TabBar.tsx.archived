import React from 'react';
import { Tab } from '../types';
import { X, Plus, Loader2 } from 'lucide-react';

interface TabBarProps {
  tabs: Tab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
}

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab
}) => {
  return (
    <div className="flex items-center bg-slate-100 border-b border-slate-200 h-9 overflow-x-auto">
      {tabs.map(tab => (
        <div
          key={tab.id}
          data-testid="tab"
          data-active={activeTabId === tab.id}
          onClick={() => onSelectTab(tab.id)}
          className={`
            flex items-center gap-2 px-3 h-full border-r border-slate-200 cursor-pointer
            min-w-[120px] max-w-[200px] group
            ${activeTabId === tab.id
              ? 'bg-white border-b-2 border-b-blue-500'
              : 'hover:bg-slate-50'
            }
          `}
        >
          <span className="truncate text-sm flex-1">
            {tab.isDirty && <span className="text-amber-500 mr-1">*</span>}
            {tab.title}
          </span>
          {tab.isLoading ? (
            <Loader2 className="w-3 h-3 animate-spin text-slate-400" />
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); onCloseTab(tab.id); }}
              className="opacity-0 group-hover:opacity-100 p-0.5 hover:bg-slate-200 rounded"
              title="Close tab"
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </div>
      ))}
      <button
        onClick={onNewTab}
        className="p-2 hover:bg-slate-200 text-slate-500"
        title="Open new notebook"
      >
        <Plus className="w-4 h-4" />
      </button>
    </div>
  );
};
