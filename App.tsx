import React, { useMemo } from 'react';
import { Notebook } from './components/Notebook';
import { TerminalPage } from './components/TerminalPage';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BackendStatus } from './components/BackendStatus';
import { NotificationProvider } from './components/NotificationSystem';
import { AuthGate } from './components/AuthGate';

const App: React.FC = () => {
  // Check for terminal mode via URL parameter
  const terminalName = useMemo(() => {
    const url = new URL(window.location.href);
    return url.searchParams.get('terminal');
  }, []);

  return (
    <ErrorBoundary>
      <NotificationProvider>
        <BackendStatus>
          <AuthGate>
            {terminalName ? (
              // Standalone terminal mode
              <TerminalPage terminalName={terminalName} />
            ) : (
              // Normal notebook mode
              <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
                <Notebook />
              </div>
            )}
          </AuthGate>
        </BackendStatus>
      </NotificationProvider>
    </ErrorBoundary>
  );
};

export default App;
