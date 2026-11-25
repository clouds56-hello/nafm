import type { Ref, RefObject } from "react";
import { formatCount } from "../../lib/format";

interface AnalysisPageControlsProps {
  page: { offset: number; limit: number; total_matches: number; matches: unknown[] };
  loading: boolean;
  goTo: (offset: number) => void;
  pageNumbers?: boolean;
  focusRef?: Ref<HTMLDivElement>;
}

export function AnalysisPageControls({ page, loading, goTo, pageNumbers, focusRef }: AnalysisPageControlsProps) {
  if (!page.total_matches) return null;
  const end = page.offset + page.matches.length;
  const previousDisabled = loading || page.offset === 0;
  const nextDisabled = loading || end >= page.total_matches;
  return (
    <div className="atlas-analysis-pagination" role="group" aria-label="Result pages" ref={focusRef}>
      <span aria-live="polite">
        {pageNumbers
          ? `Page ${formatCount(Math.floor(page.offset / page.limit) + 1)} of ${formatCount(Math.ceil(page.total_matches / page.limit))}`
          : `${formatCount(page.offset + 1)}–${formatCount(end)} of ${formatCount(page.total_matches)}`}
      </span>
      <button type="button" aria-disabled={previousDisabled || undefined} onClick={previousDisabled ? undefined : () => goTo(Math.max(0, page.offset - page.limit))}>
        Previous
      </button>
      <button type="button" aria-disabled={nextDisabled || undefined} onClick={nextDisabled ? undefined : () => goTo(page.offset + page.limit)}>
        Next
      </button>
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

export function AnalysisError({ error, retry, focusTarget }: {
  error: string;
  retry: () => void;
  focusTarget?: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <div className="atlas-analysis-error" role="alert">
      <span>{error}</span>
      <button type="button" onClick={() => {
        focusTarget?.current?.focus();
        retry();
      }}>Retry</button>
    </div>
  );
}
