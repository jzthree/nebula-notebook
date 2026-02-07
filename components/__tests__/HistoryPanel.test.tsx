import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HistoryPanel } from '../HistoryPanel';

describe('HistoryPanel', () => {
  it('calls onResetHistory when reset button is clicked', () => {
    const onResetHistory = vi.fn();

    render(
      <HistoryPanel
        isOpen={true}
        onClose={() => {}}
        history={[]}
        onResetHistory={onResetHistory}
      />
    );

    fireEvent.click(screen.getByTestId('history-reset'));
    expect(onResetHistory).toHaveBeenCalledTimes(1);
  });

  it('does not render reset button when onResetHistory is not provided', () => {
    render(
      <HistoryPanel
        isOpen={true}
        onClose={() => {}}
        history={[]}
      />
    );

    expect(screen.queryByTestId('history-reset')).toBeNull();
  });
});

