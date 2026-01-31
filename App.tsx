import React, { useMemo } from 'react';
import { Notebook } from './components/Notebook';
import { TerminalPage } from './components/TerminalPage';
import { Dashboard } from './components/Dashboard';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BackendStatus } from './components/BackendStatus';
import { NotificationProvider } from './components/NotificationSystem';
import { AuthGate } from './components/AuthGate';

type PageMode = 'dashboard' | 'notebook' | 'terminal';

const App: React.FC = () => {
  // Determine page mode from URL parameters
  const { mode, param } = useMemo(() => {
    const url = new URL(window.location.href);
    const terminalName = url.searchParams.get('terminal');
    const filePath = url.searchParams.get('file');

    if (terminalName) return { mode: 'terminal' as PageMode, param: terminalName };
    if (filePath) return { mode: 'notebook' as PageMode, param: filePath };
    return { mode: 'dashboard' as PageMode, param: null };
  }, []);

  return (
    <ErrorBoundary>
      <NotificationProvider>
        <BackendStatus>
          <AuthGate>
            {mode === 'terminal' ? (
              <TerminalPage terminalName={param!} />
            ) : mode === 'notebook' ? (
              <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
                <Notebook />
              </div>
            ) : (
              <Dashboard />
            )}
          </AuthGate>
        </BackendStatus>
      </NotificationProvider>
    </ErrorBoundary>
  );
};

export default App;
