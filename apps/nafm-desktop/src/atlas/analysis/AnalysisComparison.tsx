import { useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { OpenInIcon } from "../../management/Icons";
import "./analysis-comparison.css";

interface AnalysisLocationProps {
  label: string;
  name: string;
  site: string;
  path?: string | null;
  detail?: ReactNode;
  unavailable?: boolean;
  children?: ReactNode;
}

export function AnalysisLocation({ label, name, site, path, detail, unavailable, children }: AnalysisLocationProps) {
  return (
    <section className="atlas-analysis-entity" aria-label={label} data-unavailable={unavailable || undefined}>
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
  onShow?: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  showWhenUnavailable?: boolean;
  describedBy?: string;
}

export function AnalysisNavigationFooter({ error, opening, disabled, pendingLabel, onShow, buttonRef, showWhenUnavailable, describedBy }: AnalysisNavigationFooterProps) {
  const canShow = Boolean(onShow) && !disabled && !opening;
  return (
    <>
      {error && <p className="atlas-analysis-reveal-error" role="alert">{error}</p>}
      {(opening || onShow || showWhenUnavailable) && (
        <button
          className="atlas-analysis-primary atlas-analysis-reveal-button" type="button"
          ref={buttonRef}
          aria-disabled={!canShow || undefined} aria-busy={opening || undefined}
          aria-describedby={describedBy}
          onClick={canShow ? onShow : undefined}
        >
          {opening ? pendingLabel : "Show in Atlas"} <OpenInIcon />
        </button>
      )}
    </>
  );
}

export function useRemovedComparisonFocus(results: RefObject<HTMLElement | null>, closeButton: RefObject<HTMLButtonElement | null>) {
  const removedFocus = useRef(false);
  const rememberFocus = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    return () => {
      if (element.contains(document.activeElement)) removedFocus.current = true;
    };
  }, []);

  useLayoutEffect(() => {
    if (!removedFocus.current) return;
    removedFocus.current = false;
    if (document.activeElement !== document.body) return;
    const choices = results.current?.querySelectorAll<HTMLElement>('[data-comparison-choice]:not([aria-disabled="true"]):not(:disabled)');
    const visibleChoice = choices && Array.from(choices).find((element) => element.getClientRects().length > 0);
    (visibleChoice ?? closeButton.current)?.focus({ preventScroll: true });
    visibleChoice?.scrollIntoView({ block: "nearest", inline: "nearest" });
  });

  return rememberFocus;
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
