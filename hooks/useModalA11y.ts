import { useEffect, useRef } from 'react';

/**
 * Shared accessibility behavior for modal dialogs:
 * - Escape closes the dialog
 * - Tab / Shift+Tab cycle inside the dialog (focus trap)
 * - Focus moves into the dialog when it mounts and returns to the previously
 *   focused element when it unmounts
 *
 * Usage:
 *   const modalRef = useModalA11y<HTMLDivElement>(onClose);
 *   <div ref={modalRef} role="dialog" aria-modal="true" aria-label="Settings" tabIndex={-1}>
 *
 * Attach the ref to the dialog's outermost focusable container (give it
 * tabIndex={-1} so it can receive initial focus when the dialog has no
 * naturally focusable child).
 */
// Stack of currently open dialogs — only the topmost responds to Escape,
// so stacked dialogs (e.g. a confirm on top of settings) close one at a time.
const modalStack: HTMLElement[] = [];

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export function useModalA11y<T extends HTMLElement = HTMLDivElement>(
  onClose?: () => void,
  options?: {
    // Skip grabbing focus on mount (e.g. the dialog manages its own autoFocus)
    skipInitialFocus?: boolean;
    // Escape handling only — no focus trap (for non-modal panels)
    trapFocus?: boolean;
  }
) {
  const containerRef = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const trapFocus = options?.trapFocus !== false;
  const skipInitialFocus = options?.skipInitialFocus === true;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    modalStack.push(container);
    const isTopmost = () => modalStack[modalStack.length - 1] === container;

    // Move focus into the dialog unless something inside already has it
    // (e.g. an autoFocus input) or the caller opted out.
    if (!skipInitialFocus && !container.contains(document.activeElement)) {
      const firstFocusable = container.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable ?? container).focus({ preventScroll: true });
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Don't close over an inner element that handles Escape itself
        // (CodeMirror editors, autocomplete popups mark the event as handled).
        if (e.defaultPrevented || !isTopmost()) return;
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current?.();
        return;
      }

      if (trapFocus && e.key === 'Tab') {
        const focusables = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
          .filter(el => el.offsetParent !== null || el === document.activeElement);
        if (focusables.length === 0) {
          e.preventDefault();
          container.focus({ preventScroll: true });
          return;
        }
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || active === container)) {
          e.preventDefault();
          last.focus({ preventScroll: true });
        } else if (!e.shiftKey && active === last) {
          e.preventDefault();
          first.focus({ preventScroll: true });
        }
      }
    };

    // Listen on the container so nested dialogs stack naturally; capture so
    // Escape wins over global notebook shortcuts bound on window.
    container.addEventListener('keydown', handleKeyDown);
    // Also catch Escape when focus sits outside the dialog (e.g. after a
    // click on the backdrop parent) — window-level, capture phase.
    const handleWindowKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || !isTopmost()) return;
      // Container listener handles it. (instanceof guard: the target can be
      // window itself, which Node.contains() rejects with a TypeError.)
      if (e.target instanceof Node && container.contains(e.target)) return;
      e.preventDefault();
      e.stopPropagation();
      onCloseRef.current?.();
    };
    window.addEventListener('keydown', handleWindowKeyDown, { capture: true });

    return () => {
      const stackIdx = modalStack.indexOf(container);
      if (stackIdx !== -1) modalStack.splice(stackIdx, 1);
      container.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keydown', handleWindowKeyDown, { capture: true });
      // Return focus to the opener
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [trapFocus, skipInitialFocus]);

  return containerRef;
}
