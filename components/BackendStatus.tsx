import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Server, AlertCircle, CheckCircle2 } from 'lucide-react';

interface BackendHealth {
  status: string;
  version: string;
  ready: boolean;
  llm_providers: string[];
}

type ConnectionState = 'connecting' | 'initializing' | 'ready' | 'error';

interface Props {
  onReady?: () => void;
  children: React.ReactNode;
}

/**
 * BackendStatus wraps the app and shows a loading screen until the backend is ready.
 * It polls /api/health until the backend responds and is fully initialized.
 */
export const BackendStatus: React.FC<Props> = ({ onReady, children }) => {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);

  const checkHealth = useCallback(async (): Promise<BackendHealth | null> => {
    try {
      const response = await fetch('/api/health', {
        signal: AbortSignal.timeout(5000), // 5s timeout
      });
      if (response.ok) {
        return await response.json();
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let mounted = true;
    let timeoutId: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (!mounted) return;

      const health = await checkHealth();

      if (!mounted) return;

      if (health) {
        if (health.ready) {
          setState('ready');
          onReady?.();
        } else {
          setState('initializing');
          // Backend is up but still initializing, poll faster
          timeoutId = setTimeout(poll, 500);
        }
      } else {
        // Backend not responding
        setState('connecting');
        setRetryCount(c => c + 1);
        // Poll every 1s while connecting
        timeoutId = setTimeout(poll, 1000);
      }
    };

    poll();

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [checkHealth, onReady]);

  // If ready, just render children
  if (state === 'ready') {
    return <>{children}</>;
  }

  // Show loading screen
  return (
    <div className="fixed inset-0 bg-slate-50 flex items-center justify-center z-50">
      <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full mx-4">
        <div className="flex flex-col items-center text-center">
          {/* Icon */}
          <div className={`w-16 h-16 rounded-full flex items-center justify-center mb-4 ${
            state === 'error' ? 'bg-red-100' : 'bg-blue-100'
          }`}>
            {state === 'connecting' && (
              <Server className="w-8 h-8 text-blue-600 animate-pulse" />
            )}
            {state === 'initializing' && (
              <Loader2 className="w-8 h-8 text-blue-600 animate-spin" />
            )}
            {state === 'error' && (
              <AlertCircle className="w-8 h-8 text-red-600" />
            )}
          </div>

          {/* Title */}
          <h2 className="text-xl font-semibold text-slate-800 mb-2">
            {state === 'connecting' && 'Connecting to Server'}
            {state === 'initializing' && 'Initializing'}
            {state === 'error' && 'Connection Error'}
          </h2>

          {/* Message */}
          <p className="text-slate-500 mb-4">
            {state === 'connecting' && (
              <>Waiting for backend server to start...</>
            )}
            {state === 'initializing' && (
              <>Discovering Python kernels...</>
            )}
            {state === 'error' && (
              <>{errorMessage || 'Could not connect to the server'}</>
            )}
          </p>

          {/* Progress indicator */}
          {state !== 'error' && (
            <div className="w-full bg-slate-100 rounded-full h-1.5 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${
                  state === 'initializing' ? 'bg-blue-500 w-2/3' : 'bg-slate-300 animate-pulse w-1/3'
                }`}
              />
            </div>
          )}

          {/* Retry count (subtle) */}
          {state === 'connecting' && retryCount > 3 && (
            <p className="text-xs text-slate-400 mt-4">
              Still trying... ({retryCount} attempts)
            </p>
          )}

          {/* Hint */}
          {state === 'connecting' && retryCount > 5 && (
            <p className="text-xs text-slate-500 mt-2 bg-slate-100 px-3 py-2 rounded">
              Make sure the backend is running: <code className="font-mono">npm run server</code>
            </p>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * Hook to check backend status without blocking UI
 */
export function useBackendStatus() {
  const [isReady, setIsReady] = useState(false);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    let mounted = true;

    const check = async () => {
      try {
        const response = await fetch('/api/health');
        if (response.ok && mounted) {
          setIsConnected(true);
          const data = await response.json();
          setIsReady(data.ready);
        }
      } catch {
        if (mounted) {
          setIsConnected(false);
          setIsReady(false);
        }
      }
    };

    check();
    const interval = setInterval(check, 5000);

    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  return { isConnected, isReady };
}
