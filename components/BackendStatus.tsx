import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Server, AlertCircle, RefreshCw, CheckCircle2, WifiOff } from 'lucide-react';
import { kernelService } from '../services/kernelService';

interface BackendHealth {
  status: string;
  version: string;
  ready: boolean;
}

type ConnectionState = 'connecting' | 'initializing' | 'ready' | 'error';

interface Props {
  onReady?: () => void;
  children: React.ReactNode;
}

// After this many consecutive failed health checks during initial load,
// switch from the "Connecting…" spinner to an explicit error screen.
// Polling continues in the background so the app still recovers on its own.
const MAX_CONNECT_ATTEMPTS = 15;

// Consecutive failed runtime health checks before the "connection lost"
// banner appears. Deliberately forgiving: on tunneled deploys (ssh -L to a
// shared login node) /api/health round-trips can spike well past a normal
// timeout without the server being down, and a flapping banner is worse than
// a slightly late one. Combined with the 10s fetch timeout below, the banner
// needs ~30s+ of continuous unreachability — and is suppressed entirely while
// any kernel WebSocket is open (see hasOpenConnection corroboration).
const RUNTIME_FAILURE_THRESHOLD = 4;

// Runtime health fetch timeout. Generous on purpose — a slow tunnel
// round-trip must not be counted as "down".
const RUNTIME_FETCH_TIMEOUT_MS = 10000;

/**
 * BackendStatus wraps the app and shows a loading screen until the backend is ready.
 * It polls /api/health until the backend responds and is fully initialized.
 * After the app is up, it keeps monitoring the connection and shows a
 * "connection lost" banner if the backend stops responding.
 */
export const BackendStatus: React.FC<Props> = ({ onReady, children }) => {
  const [state, setState] = useState<ConnectionState>('connecting');
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [retryCount, setRetryCount] = useState(0);

  const checkHealth = useCallback(async (): Promise<BackendHealth | null> => {
    try {
      const response = await fetch('/api/health', {
        // Generous timeout: on tunneled deploys a health round-trip can be
        // slow without the server being down.
        signal: AbortSignal.timeout(RUNTIME_FETCH_TIMEOUT_MS),
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
    let attempts = 0;

    const poll = async () => {
      if (!mounted) return;

      const health = await checkHealth();

      if (!mounted) return;

      if (health) {
        attempts = 0;
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
        attempts += 1;
        setRetryCount(attempts);
        if (attempts >= MAX_CONNECT_ATTEMPTS) {
          setState('error');
          setErrorMessage('The server is not responding. It may have crashed, or may still be starting up.');
          // Keep polling (slower) so the app recovers on its own if the server comes back
          timeoutId = setTimeout(poll, 3000);
        } else {
          setState('connecting');
          // Poll every 1s while connecting
          timeoutId = setTimeout(poll, 1000);
        }
      }
    };

    poll();

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
    };
  }, [checkHealth, onReady]);

  // If ready, render children plus a runtime connection monitor
  if (state === 'ready') {
    return (
      <>
        <ConnectionLostBanner />
        {children}
      </>
    );
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

          {/* Error actions */}
          {state === 'error' && (
            <>
              <button
                onClick={() => window.location.reload()}
                className="flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
              >
                <RefreshCw className="w-4 h-4" />
                Retry now
              </button>
              <p className="text-xs text-slate-400 mt-3">
                Still retrying automatically in the background ({retryCount} attempts so far)
              </p>
              <p className="text-xs text-slate-500 mt-2 bg-slate-100 px-3 py-2 rounded">
                Make sure the server is running: <code className="font-mono">npm run start</code>
              </p>
            </>
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
 * Runtime connection monitor. Mounted once the app is up: keeps polling
 * /api/health and shows a fixed banner when the backend stops responding,
 * plus a brief "Reconnected" confirmation when it comes back.
 */
const ConnectionLostBanner: React.FC = () => {
  const [lost, setLost] = useState(false);
  const [reconnected, setReconnected] = useState(false);

  useEffect(() => {
    let mounted = true;
    let timeoutId: ReturnType<typeof setTimeout>;
    let reconnectedTimeoutId: ReturnType<typeof setTimeout>;
    let consecutiveFailures = 0;

    const check = async () => {
      if (!mounted) return;

      let ok = false;
      try {
        const response = await fetch('/api/health', {
          signal: AbortSignal.timeout(RUNTIME_FETCH_TIMEOUT_MS),
        });
        ok = response.ok;
      } catch {
        ok = false;
      }

      if (!mounted) return;

      // Corroborate with the WebSocket layer: an open kernel WS proves the
      // server is reachable — a slow/timed-out health poll on its own (SSH
      // tunnel latency, busy login node) is then a false alarm.
      if (!ok && kernelService.hasOpenConnection()) {
        ok = true;
      }

      if (ok) {
        if (consecutiveFailures >= RUNTIME_FAILURE_THRESHOLD) {
          // We were showing the lost banner — flash a reconnected confirmation
          setReconnected(true);
          reconnectedTimeoutId = setTimeout(() => {
            if (mounted) setReconnected(false);
          }, 3000);
        }
        consecutiveFailures = 0;
        setLost(false);
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= RUNTIME_FAILURE_THRESHOLD) {
          setLost(true);
          setReconnected(false);
        }
      }

      // Poll faster while the connection is suspect (but not so fast that a
      // latency spike burns through the failure threshold in seconds)
      timeoutId = setTimeout(check, consecutiveFailures > 0 ? 4000 : 5000);
    };

    // First check after a grace period — the gate just verified health
    timeoutId = setTimeout(check, 5000);

    return () => {
      mounted = false;
      clearTimeout(timeoutId);
      clearTimeout(reconnectedTimeoutId);
    };
  }, []);

  if (!lost && !reconnected) return null;

  return (
    <div className="fixed top-3 left-1/2 -translate-x-1/2 z-[102] pointer-events-none">
      {lost ? (
        <div
          role="alert"
          className="flex items-center gap-2 px-4 py-2 rounded-full shadow-lg border border-red-200 bg-red-50 text-red-800 text-sm font-medium animate-in fade-in slide-in-from-top-2"
        >
          <WifiOff className="w-4 h-4 text-red-500" />
          <span>Server connection lost — retrying…</span>
          <Loader2 className="w-3.5 h-3.5 animate-spin text-red-400" />
        </div>
      ) : (
        <div
          role="status"
          className="flex items-center gap-2 px-4 py-2 rounded-full shadow-lg border border-green-200 bg-green-50 text-green-800 text-sm font-medium animate-in fade-in slide-in-from-top-2"
        >
          <CheckCircle2 className="w-4 h-4 text-green-500" />
          <span>Reconnected</span>
        </div>
      )}
    </div>
  );
};
