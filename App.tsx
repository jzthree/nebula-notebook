import React from 'react';
import { Notebook } from './components/Notebook';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BackendStatus } from './components/BackendStatus';
import { NotificationProvider } from './components/NotificationSystem';

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <NotificationProvider>
        <BackendStatus>
          <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
            <Notebook />
          </div>
        </BackendStatus>
      </NotificationProvider>
    </ErrorBoundary>
  );
};

export default App;
