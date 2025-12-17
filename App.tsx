import React from 'react';
import { NotebookContainer } from './components/NotebookContainer';

const App: React.FC = () => {
  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 font-sans selection:bg-blue-100">
      <NotebookContainer />
      <div className="fixed bottom-2 right-2 text-[10px] text-slate-400 pointer-events-none">
        Powered by Pyodide & Gemini 2.5
      </div>
    </div>
  );
};

export default App;