import React, { useState, useEffect } from 'react';
import { X, Cpu, Trash2, RefreshCw, HardDrive, Clock } from 'lucide-react';
import { kernelService, KernelSessionInfo } from '../services/kernelService';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  currentSessionId: string | null;
  onKernelKilled?: (sessionId: string) => void;
  serverId?: string | null;
}

function getFilenameFromPath(filePath: string): string {
  const parts = filePath.split('/');
  return parts[parts.length - 1] || 'Unknown';
}

function formatUptime(createdAtSeconds: number): string {
  const now = Date.now() / 1000;
  const seconds = Math.floor(now - createdAtSeconds);

  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }

  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

export const KernelManager: React.FC<Props> = ({ isOpen, onClose, currentSessionId, onKernelKilled, serverId }) => {
  const [sessions, setSessions] = useState<KernelSessionInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [killingId, setKillingId] = useState<string | null>(null);

  const loadSessions = async () => {
    setIsLoading(true);
    try {
      const data = await kernelService.getAllSessions(serverId);
      setSessions(data);
    } catch (error) {
      console.error('Failed to load sessions:', error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      loadSessions();
    }
  }, [isOpen, serverId]);

  const handleKillKernel = async (sessionId: string) => {
    setKillingId(sessionId);
    try {
      await kernelService.stopKernel(sessionId);
      setSessions(prev => prev.filter(s => s.id !== sessionId));
      onKernelKilled?.(sessionId);
    } catch (error) {
      console.error('Failed to kill kernel:', error);
    } finally {
      setKillingId(null);
    }
  };

  const totalMemory = sessions.reduce((sum, s) => sum + (s.memory_mb || 0), 0);

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 bg-black/30 backdrop-blur-sm z-50" onClick={onClose} />
      <div className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 bg-white rounded-xl shadow-2xl z-50 w-full max-w-lg max-h-[80vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h2 className="text-lg font-semibold text-slate-800 flex items-center gap-2">
            <Cpu className="w-5 h-5 text-purple-600" />
            Kernel Manager
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={loadSessions}
              disabled={isLoading}
              className="p-1.5 hover:bg-slate-100 rounded text-slate-500"
              title="Refresh"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
            <button onClick={onClose} className="p-1.5 hover:bg-slate-100 rounded">
              <X className="w-5 h-5 text-slate-500" />
            </button>
          </div>
        </div>

        {/* Summary */}
        <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between text-sm">
          <span className="text-slate-600">
            {sessions.length} active kernel{sessions.length !== 1 ? 's' : ''}
          </span>
          {totalMemory > 0 && (
            <span className="flex items-center gap-1 text-slate-500">
              <HardDrive className="w-3.5 h-3.5" />
              {totalMemory.toFixed(1)} MB total
            </span>
          )}
        </div>

        {/* Sessions List */}
        <div className="flex-1 overflow-y-auto p-2">
          {sessions.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-sm">
              No active kernels
            </div>
          ) : (
            sessions.map(session => (
              <div
                key={session.id}
                className={`flex items-center justify-between p-3 rounded-lg mb-2 ${
                  session.id === currentSessionId
                    ? 'bg-purple-50 border border-purple-200'
                    : 'bg-slate-50 border border-slate-200'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-slate-800 truncate">
                      {session.file_path ? getFilenameFromPath(session.file_path) : 'Unnamed'}
                    </span>
                    {session.id === currentSessionId && (
                      <span className="text-[0.625rem] bg-purple-600 text-white px-1.5 py-0.5 rounded">
                        Current
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                    <span>{session.kernel_name}</span>
                    <span className={`flex items-center gap-1 ${
                      session.status === 'busy' ? 'text-amber-600' : 'text-green-600'
                    }`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${
                        session.status === 'busy' ? 'bg-amber-500' : 'bg-green-500'
                      }`} />
                      {session.status}
                    </span>
                    {session.memory_mb !== null && (
                      <span className="flex items-center gap-1">
                        <HardDrive className="w-3 h-3" />
                        {session.memory_mb} MB
                      </span>
                    )}
                    {session.created_at && (
                      <span className="flex items-center gap-1" title={`Started: ${new Date(session.created_at * 1000).toLocaleString()}`}>
                        <Clock className="w-3 h-3" />
                        {formatUptime(session.created_at)}
                      </span>
                    )}
                    <span className="text-slate-400">
                      [{session.execution_count}]
                    </span>
                  </div>
                  {session.file_path && (
                    <div className="text-[0.625rem] text-slate-400 mt-1 truncate" title={session.file_path}>
                      {session.file_path}
                    </div>
                  )}
                </div>
                <button
                  onClick={() => handleKillKernel(session.id)}
                  disabled={killingId === session.id}
                  className="ml-2 p-2 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors disabled:opacity-50"
                  title="Kill kernel"
                >
                  {killingId === session.id ? (
                    <RefreshCw className="w-4 h-4 animate-spin" />
                  ) : (
                    <Trash2 className="w-4 h-4" />
                  )}
                </button>
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div className="p-3 border-t border-slate-200 bg-slate-50 text-xs text-slate-500">
          Kernels persist until killed. Memory shown is RSS (resident set size).
        </div>
      </div>
    </>
  );
};
