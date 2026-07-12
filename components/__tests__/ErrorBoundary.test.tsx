/**
 * Tests for ErrorBoundary component
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ErrorBoundary } from '../ErrorBoundary';

// Suppress console.error for cleaner test output
const originalError = console.error;
beforeEach(() => {
  console.error = vi.fn();
});

afterEach(() => {
  console.error = originalError;
});

// Component that throws an error
const ThrowingComponent = ({ shouldThrow }: { shouldThrow: boolean }) => {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div>No error</div>;
};

describe('ErrorBoundary', () => {
  it('renders children when there is no error', () => {
    render(
      <ErrorBoundary>
        <div>Test content</div>
      </ErrorBoundary>
    );

    expect(screen.getByText('Test content')).toBeInTheDocument();
  });

  it('renders error UI when child throws', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    // Message shows in the summary line and again inside technical details
    expect(screen.getAllByText(/Test error message/).length).toBeGreaterThan(0);
  });

  it('shows recovery buttons when error occurs', () => {
    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    expect(screen.getByText('Try again')).toBeInTheDocument();
    expect(screen.getByText('Save & reload')).toBeInTheDocument();
  });

  it('"Try again" resets the boundary and re-renders children', () => {
    let shouldThrow = true;
    const Flaky = () => {
      if (shouldThrow) throw new Error('Test error message');
      return <div>Recovered content</div>;
    };
    render(
      <ErrorBoundary>
        <Flaky />
      </ErrorBoundary>
    );
    expect(screen.getByText('Something went wrong')).toBeInTheDocument();

    shouldThrow = false;
    fireEvent.click(screen.getByText('Try again'));
    expect(screen.getByText('Recovered content')).toBeInTheDocument();
  });

  it('flushes unsaved work then reloads on "Save & reload"', async () => {
    const mockReload = vi.fn();
    Object.defineProperty(window, 'location', {
      value: { reload: mockReload },
      writable: true
    });
    const flush = vi.fn().mockResolvedValue(undefined);
    (window as any).__nebulaFlushSave = flush;

    render(
      <ErrorBoundary>
        <ThrowingComponent shouldThrow={true} />
      </ErrorBoundary>
    );

    fireEvent.click(screen.getByText('Save & reload'));
    await vi.waitFor(() => expect(mockReload).toHaveBeenCalled());
    expect(flush).toHaveBeenCalled();
    delete (window as any).__nebulaFlushSave;
  });
});
