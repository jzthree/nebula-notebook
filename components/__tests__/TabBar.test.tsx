/**
 * Tests for TabBar component
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TabBar } from '../TabBar';
import { Tab } from '../../types';

describe('TabBar', () => {
  const mockTabs: Tab[] = [
    { id: 'tab-1', fileId: '/path/to/notebook1.ipynb', title: 'notebook1', isDirty: false, isLoading: false },
    { id: 'tab-2', fileId: '/path/to/notebook2.ipynb', title: 'notebook2', isDirty: true, isLoading: false },
    { id: 'tab-3', fileId: '/path/to/notebook3.ipynb', title: 'notebook3', isDirty: false, isLoading: true },
  ];

  it('renders all tabs', () => {
    render(
      <TabBar
        tabs={mockTabs}
        activeTabId="tab-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewTab={() => {}}
      />
    );

    expect(screen.getByText('notebook1')).toBeInTheDocument();
    expect(screen.getByText('notebook2')).toBeInTheDocument();
    expect(screen.getByText('notebook3')).toBeInTheDocument();
  });

  it('shows dirty indicator for unsaved tabs', () => {
    render(
      <TabBar
        tabs={mockTabs}
        activeTabId="tab-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewTab={() => {}}
      />
    );

    // notebook2 has isDirty: true, should show asterisk
    const tab2 = screen.getByText('notebook2').closest('[data-testid="tab"]');
    expect(tab2).toHaveTextContent('*');
  });

  it('calls onSelectTab when tab is clicked', () => {
    const onSelectTab = vi.fn();
    render(
      <TabBar
        tabs={mockTabs}
        activeTabId="tab-1"
        onSelectTab={onSelectTab}
        onCloseTab={() => {}}
        onNewTab={() => {}}
      />
    );

    fireEvent.click(screen.getByText('notebook2'));
    expect(onSelectTab).toHaveBeenCalledWith('tab-2');
  });

  it('calls onCloseTab when close button is clicked', () => {
    const onCloseTab = vi.fn();
    render(
      <TabBar
        tabs={mockTabs}
        activeTabId="tab-1"
        onSelectTab={() => {}}
        onCloseTab={onCloseTab}
        onNewTab={() => {}}
      />
    );

    // Find close buttons and click the first one
    const closeButtons = screen.getAllByTitle('Close tab');
    fireEvent.click(closeButtons[0]);
    expect(onCloseTab).toHaveBeenCalledWith('tab-1');
  });

  it('calls onNewTab when new tab button is clicked', () => {
    const onNewTab = vi.fn();
    render(
      <TabBar
        tabs={mockTabs}
        activeTabId="tab-1"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewTab={onNewTab}
      />
    );

    fireEvent.click(screen.getByTitle('Open new notebook'));
    expect(onNewTab).toHaveBeenCalled();
  });

  it('highlights active tab', () => {
    render(
      <TabBar
        tabs={mockTabs}
        activeTabId="tab-2"
        onSelectTab={() => {}}
        onCloseTab={() => {}}
        onNewTab={() => {}}
      />
    );

    const activeTab = screen.getByText('notebook2').closest('[data-testid="tab"]');
    expect(activeTab).toHaveAttribute('data-active', 'true');
  });
});
