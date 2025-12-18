import React from 'react';
import { Notebook } from './components/Notebook';
import { ErrorBoundary } from './components/ErrorBoundary';
import { BackendStatus } from './components/BackendStatus';

const App: React.FC = () => {
  return (
    <ErrorBoundary>
      <BackendStatus>
        <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
          <Notebook />
          <div className="fixed bottom-2 right-2 text-[10px] text-slate-400 pointer-events-none">
            Powered by Jupyter Kernels
          </div>
        </div>
      </BackendStatus>
    </ErrorBoundary>
  );
};

export default App;
