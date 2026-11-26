import { useLayoutEffect, useRef, type Ref, type RefObject } from "react";
import { formatCount } from "../../lib/format";
import type { AnalysisPageRequest } from "./useAnalysisPage";

interface AnalysisPageControlsProps {
  page: { offset: number; limit: number; total_matches: number; matches: unknown[] };
  loading: boolean;
  goTo: (offset: number) => void;
  pageNumbers?: boolean;
  focusRef?: Ref<HTMLDivElement>;
  request?: AnalysisPageRequest;
}

function revealFocus(button: HTMLButtonElement | null) {
  button?.focus({ preventScroll: true });
  button?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function AnalysisPageControls({ page, loading, goTo, pageNumbers, focusRef, request }: AnalysisPageControlsProps) {
  const previous = useRef<HTMLButtonElement>(null);
  const next = useRef<HTMLButtonElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const retryOrigin = useRef<HTMLButtonElement>(null);
  const end = page.offset + page.matches.length;
  const previousDisabled = loading || page.offset === 0;
  const nextDisabled = loading || end >= page.total_matches;
  const failedOffset = request?.error ? request.offset : undefined;
  const pageError = request?.error;

  useLayoutEffect(() => {
    if (failedOffset === undefined) return;
    const origin = failedOffset < page.offset ? previous.current : next.current;
    if (document.activeElement === origin) revealFocus(retryButton.current);
  }, [failedOffset, page.offset, pageError]);

  useLayoutEffect(() => {
    const origin = retryOrigin.current;
    if (!origin) return;
    if (document.activeElement !== origin) {
      retryOrigin.current = null;
      return;
    }
    if (loading) return;
    retryOrigin.current = null;
    const destination = origin === next.current && nextDisabled ? previous.current
      : origin === previous.current && previousDisabled ? next.current : origin;
    revealFocus(destination);
  }, [loading, nextDisabled, previousDisabled, page.offset]);

  if (!page.total_matches) return null;
  return (
    <div className="atlas-analysis-pagination" role="group" aria-label="Result pages" ref={focusRef}>
      <span aria-live="polite">
        {request && loading && !pageError ? "Loading page…" : pageNumbers
          ? `Page ${formatCount(Math.floor(page.offset / page.limit) + 1)} of ${formatCount(Math.ceil(page.total_matches / page.limit))}`
          : `${formatCount(page.offset + 1)}–${formatCount(end)} of ${formatCount(page.total_matches)}`}
      </span>
      <button ref={previous} type="button" aria-disabled={previousDisabled || undefined} onClick={previousDisabled ? undefined : (event) => {
        event.currentTarget.focus({ preventScroll: true });
        goTo(Math.max(0, page.offset - page.limit));
      }}>
        Previous
      </button>
      <button ref={next} type="button" aria-disabled={nextDisabled || undefined} onClick={nextDisabled ? undefined : (event) => {
        event.currentTarget.focus({ preventScroll: true });
        goTo(page.offset + page.limit);
      }}>
        Next
      </button>
      {pageError && request && (
        <AnalysisError error={pageError} retryButtonRef={retryButton} retry={() => {
          const origin = request.offset < page.offset ? previous.current : next.current;
          const active = document.activeElement;
          // A pointer activation in WebKit can leave focus on the old paginator or the dialog itself.
          if (active === retryButton.current || active === origin || active === document.body
            || active === retryButton.current?.closest("dialog")) {
            retryOrigin.current = origin;
            revealFocus(origin);
          }
          request.retry();
        }} />
      )}
    </div>
  );
}

export function VerificationNote({ pending, incomplete }: { pending: number; incomplete: number }) {
  if (!pending && !incomplete) return null;
  const notes = [
    pending > 0 && `${formatCount(pending)} pending ${pending === 1 ? "hash" : "hashes"}`,
    incomplete > 0 && `${formatCount(incomplete)} ${incomplete === 1 ? "site" : "sites"} with an incomplete inventory`,
  ].filter(Boolean);
  return <p className="atlas-analysis-warning" role="status">Results may be incomplete · {notes.join(" · ")}</p>;
}

export function AnalysisError({ error, retry, focusTarget, retryButtonRef }: {
  error: string;
  retry: () => void;
  focusTarget?: RefObject<HTMLButtonElement | null>;
  retryButtonRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <div className="atlas-analysis-error" role="alert">
      <span>{error}</span>
      <button ref={retryButtonRef} type="button" onClick={() => {
        focusTarget?.current?.focus();
        retry();
      }}>Retry</button>
    </div>
  );
}
