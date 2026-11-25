import { useId, useLayoutEffect, useRef, type KeyboardEventHandler, type ReactNode, type RefObject } from "react";
import "./analysis.css";

interface AnalysisDialogProps {
  title: string;
  subtitle?: string;
  drawer?: boolean;
  className?: string;
  children: ReactNode;
  toolbar?: ReactNode;
  initialFocus?: RefObject<HTMLElement | null>;
  closeButtonRef?: RefObject<HTMLButtonElement | null>;
  footer?: ReactNode;
  onKeyDown?: KeyboardEventHandler<HTMLDialogElement>;
  onClose: () => void;
}

export function AnalysisDialog({
  title, subtitle, drawer, className, children, toolbar, initialFocus, closeButtonRef, footer, onKeyDown, onClose,
}: AnalysisDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const localCloseRef = useRef<HTMLButtonElement>(null);
  const closeRef = closeButtonRef ?? localCloseRef;

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const activeElement = document.activeElement;
    const opener = activeElement instanceof HTMLElement || activeElement instanceof SVGElement ? activeElement : null;
    dialog.showModal();
    (initialFocus?.current ?? closeRef.current)?.focus();
    return () => {
      const active = document.activeElement;
      dialog.close();
      if ((active === document.body || dialog.contains(active)) && opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [initialFocus, closeRef]);

  return (
    <dialog
      ref={dialogRef}
      className={["atlas-analysis-dialog", drawer && "is-drawer", className].filter(Boolean).join(" ")}
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="atlas-analysis-panel">
        <header className="atlas-analysis-heading">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <p title={subtitle}>{subtitle}</p>}
          </div>
          <button className="atlas-analysis-close" ref={closeRef} type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`}>
            <span aria-hidden="true">×</span>
          </button>
        </header>
        {toolbar}
        <div className="atlas-analysis-body">{children}</div>
        {footer && <footer className="atlas-analysis-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
