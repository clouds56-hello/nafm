import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import "./analysis.css";

interface AnalysisDialogProps {
  title: string;
  subtitle?: string;
  drawer?: boolean;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
}

export function AnalysisDialog({ title, subtitle, drawer, children, footer, onClose }: AnalysisDialogProps) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    closeRef.current?.focus();
    return () => {
      const active = document.activeElement;
      dialog.close();
      if ((active === document.body || dialog.contains(active)) && opener?.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={`atlas-analysis-dialog${drawer ? " is-drawer" : ""}`}
      aria-labelledby={titleId}
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
        <div className="atlas-analysis-body">{children}</div>
        {footer && <footer className="atlas-analysis-footer">{footer}</footer>}
      </div>
    </dialog>
  );
}
