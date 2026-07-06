import React from 'react';
import { useModalA11y } from '../hooks/useModalA11y';

/**
 * Accessible modal panel: role="dialog", aria-modal, Escape-to-close, Tab
 * focus trap, focus restore. Use for inline modal panels (the white box, not
 * the backdrop). Render it only while the modal is open — the a11y behavior
 * binds on mount.
 */
export const ModalShell: React.FC<{
  onClose: () => void;
  label: string;
  className?: string;
  trapFocus?: boolean;
  skipInitialFocus?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}> = ({ onClose, label, className, trapFocus, skipInitialFocus, onClick, children }) => {
  const modalRef = useModalA11y<HTMLDivElement>(onClose, { trapFocus, skipInitialFocus });
  return (
    <div
      ref={modalRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      className={className}
      onClick={onClick}
    >
      {children}
    </div>
  );
};
