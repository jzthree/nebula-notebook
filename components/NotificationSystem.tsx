import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { X, AlertCircle, CheckCircle, AlertTriangle, Info } from 'lucide-react';

// Toast types
type ToastType = 'success' | 'error' | 'warning' | 'info';

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

// Confirm dialog state
interface ConfirmState {
  isOpen: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: 'danger' | 'warning' | 'default';
  resolve?: (result: boolean) => void;
}

// Context type
interface NotificationContextType {
  toast: (message: string, type?: ToastType, duration?: number) => void;
  confirm: (options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
  }) => Promise<boolean>;
}

const NotificationContext = createContext<NotificationContextType | null>(null);

// Toast icons
const toastIcons: Record<ToastType, React.ReactNode> = {
  success: <CheckCircle className="w-5 h-5 text-green-500" />,
  error: <AlertCircle className="w-5 h-5 text-red-500" />,
  warning: <AlertTriangle className="w-5 h-5 text-amber-500" />,
  info: <Info className="w-5 h-5 text-blue-500" />,
};

// Toast styles
const toastStyles: Record<ToastType, string> = {
  success: 'bg-green-50 border-green-200 text-green-800',
  error: 'bg-red-50 border-red-200 text-red-800',
  warning: 'bg-amber-50 border-amber-200 text-amber-800',
  info: 'bg-blue-50 border-blue-200 text-blue-800',
};

// Individual Toast component
const ToastItem: React.FC<{ toast: Toast; onDismiss: (id: string) => void }> = ({ toast, onDismiss }) => {
  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border shadow-lg animate-in slide-in-from-right-5 max-w-sm ${toastStyles[toast.type]}`}
      role="alert"
    >
      <div className="flex-shrink-0">{toastIcons[toast.type]}</div>
      <p className="flex-1 text-sm font-medium break-words min-w-0">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="p-0.5 hover:bg-black/5 rounded transition-colors flex-shrink-0"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};

// Confirm Dialog component
const ConfirmDialog: React.FC<{
  state: ConfirmState;
  onConfirm: () => void;
  onCancel: () => void;
}> = ({ state, onConfirm, onCancel }) => {
  if (!state.isOpen) return null;

  const variantStyles = {
    danger: 'bg-red-600 hover:bg-red-700 focus:ring-red-500',
    warning: 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500',
    default: 'bg-blue-600 hover:bg-blue-700 focus:ring-blue-500',
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 animate-in fade-in"
        onClick={onCancel}
      />

      {/* Dialog */}
      <div className="relative bg-white rounded-xl shadow-2xl max-w-md w-full mx-4 animate-in zoom-in-95 fade-in">
        <div className="p-6">
          <h3 className="text-lg font-semibold text-slate-900 mb-2">
            {state.title}
          </h3>
          <p className="text-sm text-slate-600 break-words">
            {state.message}
          </p>
        </div>

        <div className="flex justify-end gap-3 px-6 py-4 bg-slate-50 rounded-b-xl border-t border-slate-100">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-slate-500 focus:ring-offset-2 transition-colors"
          >
            {state.cancelLabel || 'Cancel'}
          </button>
          <button
            onClick={onConfirm}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg focus:outline-none focus:ring-2 focus:ring-offset-2 transition-colors ${variantStyles[state.variant || 'default']}`}
          >
            {state.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );
};

// Provider component
export const NotificationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [confirmState, setConfirmState] = useState<ConfirmState>({
    isOpen: false,
    title: '',
    message: '',
  });

  const toastTimeouts = useRef<Map<string, NodeJS.Timeout>>(new Map());

  // Dismiss toast
  const dismissToast = useCallback((id: string) => {
    setToasts(prev => prev.filter(t => t.id !== id));
    const timeout = toastTimeouts.current.get(id);
    if (timeout) {
      clearTimeout(timeout);
      toastTimeouts.current.delete(id);
    }
  }, []);

  // Add toast
  const toast = useCallback((message: string, type: ToastType = 'info', duration: number = 4000) => {
    const id = crypto.randomUUID();
    const newToast: Toast = { id, type, message, duration };

    setToasts(prev => [...prev, newToast]);

    // Auto-dismiss
    if (duration > 0) {
      const timeout = setTimeout(() => {
        dismissToast(id);
      }, duration);
      toastTimeouts.current.set(id, timeout);
    }
  }, [dismissToast]);

  // Show confirm dialog
  const confirm = useCallback((options: {
    title: string;
    message: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'danger' | 'warning' | 'default';
  }): Promise<boolean> => {
    return new Promise((resolve) => {
      setConfirmState({
        isOpen: true,
        ...options,
        resolve,
      });
    });
  }, []);

  // Handle confirm
  const handleConfirm = useCallback(() => {
    confirmState.resolve?.(true);
    setConfirmState(prev => ({ ...prev, isOpen: false }));
  }, [confirmState.resolve]);

  // Handle cancel
  const handleCancel = useCallback(() => {
    confirmState.resolve?.(false);
    setConfirmState(prev => ({ ...prev, isOpen: false }));
  }, [confirmState.resolve]);

  return (
    <NotificationContext.Provider value={{ toast, confirm }}>
      {children}

      {/* Toast container */}
      <div className="fixed top-4 right-4 z-[101] flex flex-col gap-2 max-w-sm">
        {toasts.map(t => (
          <ToastItem key={t.id} toast={t} onDismiss={dismissToast} />
        ))}
      </div>

      {/* Confirm dialog */}
      <ConfirmDialog
        state={confirmState}
        onConfirm={handleConfirm}
        onCancel={handleCancel}
      />
    </NotificationContext.Provider>
  );
};

// Hook to use notifications
export const useNotification = (): NotificationContextType => {
  const context = useContext(NotificationContext);
  if (!context) {
    throw new Error('useNotification must be used within a NotificationProvider');
  }
  return context;
};
