/**
 * ErrorBoundary - Catches React errors and displays a fallback UI
 *
 * Recovery ladder: (1) "Try again" resets the boundary and re-renders in
 * place — many render crashes are transient (a bad prop from a race) and
 * recover cleanly without losing any in-memory state. (2) Reload — but
 * first best-effort flush any unsaved notebook edits through the global
 * hook the Notebook installs (window.__nebulaFlushSave), so a crash
 * doesn't eat the edits autosave hadn't shipped yet.
 */
import React, { Component, ErrorInfo, ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
  saving: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null, saving: false };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('React Error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  handleTryAgain = () => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  handleReload = async () => {
    this.setState({ saving: true });
    try {
      const flush = (window as any).__nebulaFlushSave as (() => Promise<void>) | undefined;
      if (flush) {
        // Cap the flush wait — a hung save must not block recovery forever.
        await Promise.race([flush(), new Promise((r) => setTimeout(r, 4000))]);
      }
    } catch {
      /* the reload is the recovery; a failed flush must not stop it */
    }
    window.location.reload();
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-red-50 p-8">
          <h1 className="text-2xl font-bold text-red-600 mb-2">Something went wrong</h1>
          <p className="text-sm text-slate-700 mb-4">
            {this.state.error?.message || 'An unexpected error occurred.'}
          </p>
          <div className="flex gap-3 mb-4">
            <button
              onClick={this.handleTryAgain}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
            >
              Try again
            </button>
            <button
              onClick={this.handleReload}
              disabled={this.state.saving}
              className="px-4 py-2 bg-red-600 text-white rounded hover:bg-red-700 disabled:opacity-60 transition-colors"
            >
              {this.state.saving ? 'Saving your work…' : 'Save & reload'}
            </button>
          </div>
          <details className="bg-white p-4 rounded border border-red-200 text-sm">
            <summary className="cursor-pointer text-slate-600 select-none">Technical details</summary>
            <pre className="mt-2 overflow-auto">
              {this.state.error?.toString()}
              {'\n\n'}
              {this.state.errorInfo?.componentStack}
            </pre>
          </details>
        </div>
      );
    }
    return this.props.children;
  }
}
