import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { OpenInIcon } from "../../management/Icons";
import "./analysis-comparison.css";

interface AnalysisLocationProps {
  label: string;
  name: string;
  site: string;
  path?: string | null;
  detail?: ReactNode;
  children?: ReactNode;
}

export function AnalysisLocation({ label, name, site, path, detail, children }: AnalysisLocationProps) {
  return (
    <section className="atlas-analysis-entity" aria-label={label}>
      <p>{label}</p>
      <h3>{name}</h3>
      <div className="atlas-analysis-entity-meta">
        <span>{site}</span>
        {detail != null && <span>{detail}</span>}
      </div>
      {path && <code>{path}</code>}
      {children}
    </section>
  );
}

interface AnalysisNavigationFooterProps {
  error: string | null;
  opening: boolean;
  disabled: boolean;
  pendingLabel: string;
  onShow: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}

export function AnalysisNavigationFooter({ error, opening, disabled, pendingLabel, onShow, buttonRef }: AnalysisNavigationFooterProps) {
  return (
    <>
      {error && <p className="atlas-analysis-reveal-error" role="alert">{error}</p>}
      <button
        className="atlas-analysis-primary atlas-analysis-reveal-button" type="button"
        ref={buttonRef}
        aria-disabled={disabled || opening || undefined} aria-busy={opening || undefined}
        onClick={disabled || opening ? undefined : onShow}
      >
        {opening ? pendingLabel : "Show in Atlas"} <OpenInIcon />
      </button>
    </>
  );
}

export function useComparisonScroll(scrollTop: number | undefined, ready: boolean) {
  const results = useRef<HTMLElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const pendingScroll = useRef<number | undefined>(undefined);

  useLayoutEffect(() => {
    pendingScroll.current = scrollTop;
  }, [scrollTop]);

  useLayoutEffect(() => {
    const pane = results.current?.closest(".atlas-analysis-body");
    if (!ready || pendingScroll.current === undefined || !pane) return;
    pane.scrollTop = pendingScroll.current;
    pendingScroll.current = undefined;
    const close = pane.closest("dialog")?.querySelector<HTMLButtonElement>(".atlas-analysis-close");
    if (document.activeElement === close || document.activeElement === document.body) {
      (showButton.current ?? close)?.focus({ preventScroll: true });
    }
  }, [ready, scrollTop]);

  return { results, showButton, readScroll: () => results.current?.closest(".atlas-analysis-body")?.scrollTop ?? 0 };
}
