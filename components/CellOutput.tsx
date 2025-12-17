import React from 'react';
import { CellOutput as ICellOutput } from '../types';

interface Props {
  outputs: ICellOutput[];
}

const OutputItem: React.FC<{ output: ICellOutput }> = ({ output }) => {
  switch (output.type) {
    case 'stdout':
      return <div className="font-mono text-sm text-slate-700 whitespace-pre-wrap mb-1">{output.content}</div>;
    case 'stderr':
      return <div className="font-mono text-sm text-red-600 bg-red-50 p-2 rounded mb-1 whitespace-pre-wrap">{output.content}</div>;
    case 'error':
      return (
        <div className="font-mono text-sm text-red-700 bg-red-100 border-l-4 border-red-500 p-2 mb-2 rounded-r overflow-x-auto">
          <strong>Error:</strong> {output.content}
        </div>
      );
    case 'image':
      return (
        <div className="my-4 flex justify-start">
          <img 
            src={`data:image/png;base64,${output.content}`} 
            alt="Plot Output" 
            className="max-w-full h-auto bg-white rounded shadow-sm border border-slate-200"
          />
        </div>
      );
    case 'html':
      return <div dangerouslySetInnerHTML={{ __html: output.content }} className="my-2" />;
    default:
      return null;
  }
};

export const CellOutput: React.FC<Props> = ({ outputs }) => {
  if (outputs.length === 0) return null;

  return (
    <div className="mt-2 p-4 bg-white border-t border-slate-100 rounded-b-lg">
      {outputs.map((out) => (
        <OutputItem key={out.id} output={out} />
      ))}
    </div>
  );
};