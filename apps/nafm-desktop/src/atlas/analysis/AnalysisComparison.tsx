import { useCallback, useId, useLayoutEffect, useRef, type ReactNode, type RefCallback, type RefObject } from "react";
import { OpenInIcon } from "../../management/Icons";
import "./analysis-comparison.css";

export function comparisonFolderLabel(path: string, alternatives: readonly string[], includesFile = false) {
  function folders(value: string) {
    if (/^smb:\/\//i.test(value)) {
      try { value = decodeURI(value); } catch { /* Keep the indexed spelling of malformed escapes. */ }
    } else if (!value.startsWith("/")) {
      value = value.replaceAll("\\", "/");
    }
    const parts = value.split("/").filter(Boolean);
    return includesFile ? parts.slice(0, -1) : parts;
  }
  const parts = folders(path);
  const others = alternatives.filter((other) => other !== path).map(folders);
  for (let depth = 1; depth < parts.length; depth++) {
    const label = parts.slice(-depth).join("/");
    if (!others.some((peer) => peer.slice(-depth).join("/") === label)) return label;
  }
  return parts.join("/") || (path.startsWith("/") ? "/" : "");
}

interface AnalysisLocationProps {
  label: string;
  name: string;
  site: string;
  path?: string | null;
  detail?: ReactNode;
  match?: boolean;
  unavailable?: boolean;
  children?: ReactNode;
}

export function AnalysisLocation({ label, name, site, path, detail, match, unavailable, children }: AnalysisLocationProps) {
  return (
    <section className="atlas-analysis-entity" aria-label={label} data-match={match || undefined} data-unavailable={unavailable || undefined}>
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

interface ComparisonPickerProps<Match> {
  matches: Match[];
  selected?: Match;
  unavailable?: Match;
  busy: boolean;
  summary?: string;
  identify: (match: Match) => string;
  label: (match: Match, unavailable?: boolean) => string;
  onChoose: (match: Match) => void;
  focusRef: RefCallback<HTMLSelectElement>;
}

export function ComparisonPicker<Match>({ matches, selected, unavailable, busy, summary, identify, label, onChoose, focusRef }: ComparisonPickerProps<Match>) {
  const labelId = useId();
  const displayed = selected ?? unavailable;
  if (!displayed) return null;
  const disabled = busy || matches.length === 0;
  return (
    <label className="atlas-comparison-picker">
      <span className="atlas-comparison-picker-heading">
        <span className="atlas-comparison-picker-label" id={labelId}>Compare with</span>
        {summary && <small role="status">{summary}</small>}
      </span>
      <select
        ref={focusRef} data-comparison-choice aria-labelledby={labelId} aria-disabled={disabled || undefined} value={identify(displayed)}
        onPointerDown={disabled ? (event) => event.preventDefault() : undefined}
        onKeyDown={disabled ? (event) => { if (event.key !== "Tab" && event.key !== "Escape") event.preventDefault(); } : undefined}
        onChange={disabled ? undefined : (event) => {
          const match = matches.find((item) => identify(item) === event.currentTarget.value);
          if (match) onChoose(match);
        }}
      >
        {unavailable && <option value={identify(unavailable)} disabled>{label(unavailable, true)} · Unavailable</option>}
        {matches.map((match) => <option key={identify(match)} value={identify(match)}>{label(match)}</option>)}
      </select>
    </label>
  );
}

interface AnalysisNavigationFooterProps {
  error: string | null;
  opening: boolean;
  disabled: boolean;
  pendingLabel: string;
  onShow?: () => void;
  onCancel: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
  showWhenUnavailable?: boolean;
  describedBy?: string;
}

export function AnalysisNavigationFooter({
  error, opening, disabled, pendingLabel, onShow, onCancel, buttonRef, showWhenUnavailable, describedBy,
}: AnalysisNavigationFooterProps) {
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
      {opening && (
        <button className="atlas-analysis-cancel-opening" type="button" onClick={() => {
          onCancel();
          buttonRef.current?.focus({ preventScroll: true });
        }}>Cancel opening</button>
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
    const area = results.current;
    if (!area) return;
    const compact = window.matchMedia("(max-width: 540px)");
    let focusedChoice: HTMLElement | null = null;
    function remember(event: FocusEvent) {
      const target = event.target;
      focusedChoice = target instanceof HTMLElement && target.matches("[data-comparison-choice]") ? target : null;
    }
    function forget(event: FocusEvent) {
      // When CSS hides the control, the browser can blur it before the media change event.
      if (focusedChoice === event.target && focusedChoice?.getClientRects().length) focusedChoice = null;
    }
    function switchControl() {
      if (!area || !focusedChoice?.isConnected || focusedChoice.getClientRects().length) return;
      const active = document.activeElement;
      if (active !== focusedChoice && active !== document.body && active !== area.closest("dialog")) return;
      const target = compact.matches ? area.querySelector<HTMLSelectElement>("select[data-comparison-choice]")
        : area.querySelector<HTMLButtonElement>('[data-comparison-choice][aria-pressed="true"]')
          ?? area.querySelector<HTMLButtonElement>('.atlas-analysis-choices [data-comparison-choice]');
      (target ?? closeButton.current)?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    area.addEventListener("focusin", remember);
    area.addEventListener("focusout", forget);
    compact.addEventListener("change", switchControl);
    return () => {
      area.removeEventListener("focusin", remember);
      area.removeEventListener("focusout", forget);
      compact.removeEventListener("change", switchControl);
    };
  }, [results, closeButton]);

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
  const pendingScroll = useRef<{ pane: HTMLElement; initialTop: number } | null>(null);

  useLayoutEffect(() => {
    const pane = results.current?.closest<HTMLElement>(".atlas-analysis-body");
    if (!pane || scrollTop === undefined) return;
    const pending = { pane, initialTop: pane.scrollTop };
    pendingScroll.current = pending;
    const trackScroll = () => {
      if (pendingScroll.current === pending && pane.scrollTop !== pending.initialTop) pendingScroll.current = null;
    };
    pane.addEventListener("scroll", trackScroll, { passive: true });
    return () => {
      pane.removeEventListener("scroll", trackScroll);
      if (pendingScroll.current === pending) pendingScroll.current = null;
    };
  }, [scrollTop]);

  useLayoutEffect(() => {
    const pending = pendingScroll.current;
    if (!ready || scrollTop === undefined || !pending) return;
    pendingScroll.current = null;
    const { pane, initialTop } = pending;
    if (pane.scrollTop !== initialTop) return;
    pane.scrollTop = scrollTop;
    const close = pane.closest("dialog")?.querySelector<HTMLButtonElement>(".atlas-analysis-close");
    if (document.activeElement === close || document.activeElement === document.body) {
      (showButton.current ?? close)?.focus({ preventScroll: true });
    }
  }, [ready, scrollTop]);

  return { results, showButton, readScroll: () => results.current?.closest(".atlas-analysis-body")?.scrollTop ?? 0 };
}
