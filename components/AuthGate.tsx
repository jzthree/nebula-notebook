import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, Shield } from 'lucide-react';
import { authService, AuthStatus } from '../services/authService';
import { TOTPLogin } from './TOTPLogin';

interface Props {
  children: React.ReactNode;
}

type GateState = 'loading' | 'login' | 'authenticated';

/**
 * AuthGate - Wraps the app and shows login screen if not authenticated
 *
 * Flow:
 * 1. Check auth status
 * 2. If authenticated, show children
 * 3. If not authenticated (or setup needed), show TOTPLogin
 */
export const AuthGate: React.FC<Props> = ({ children }) => {
  const [state, setState] = useState<GateState>('loading');
  const [setupRequired, setSetupRequired] = useState(false);

  const checkAuth = useCallback(async () => {
    try {
      const status = await authService.getStatus(true);

      if (status.authenticated) {
        setState('authenticated');
      } else {
        setSetupRequired(!status.configured);
        setState('login');
      }
    } catch (error) {
      console.error('[AuthGate] Failed to check auth status:', error);
      // On error, assume login is needed
      setState('login');
    }
  }, []);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  const handleLoginSuccess = useCallback(() => {
    setState('authenticated');
  }, []);

  // Loading state
  if (state === 'loading') {
    return (
      <div className="fixed inset-0 bg-slate-50 flex items-center justify-center z-50">
        <div className="bg-white rounded-xl shadow-lg p-8 max-w-md w-full mx-4">
          <div className="flex flex-col items-center text-center">
            <div className="w-16 h-16 rounded-full bg-blue-100 flex items-center justify-center mb-4">
              <Shield className="w-8 h-8 text-blue-600" />
            </div>
            <h2 className="text-xl font-semibold text-slate-800 mb-2">
              Checking Authentication
            </h2>
            <div className="flex items-center gap-2 text-slate-500">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span>Please wait...</span>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Login state
  if (state === 'login') {
    return (
      <TOTPLogin
        setupRequired={setupRequired}
        onSuccess={handleLoginSuccess}
      />
    );
  }

  // Authenticated - show app
  return <>{children}</>;
};
