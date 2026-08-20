import { useEffect, useRef, type ReactNode } from "react";

interface Props {
  onClose: () => void;
  children: ReactNode;
  labelledBy?: string;
  className?: string;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Wraps any dialog content with the keyboard/ARIA behavior every modal in
 * this app needs: traps Tab focus inside itself, closes on Escape, restores
 * focus to whatever triggered it on close, and is announced correctly to
 * screen readers via role="dialog" + aria-modal.
 */
export function Modal({ onClose, children, labelledBy, className }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    const container = containerRef.current;
    const focusables = container?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);
    (focusables?.[0] ?? container)?.focus();

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !container) return;

      const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (el) => el.offsetParent !== null // skip hidden elements
      );
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      previouslyFocused.current?.focus?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/60" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={containerRef} role="dialog" aria-modal="true" aria-labelledby={labelledBy} tabIndex={-1} className={className}>
        {children}
      </div>
    </div>
  );
}
