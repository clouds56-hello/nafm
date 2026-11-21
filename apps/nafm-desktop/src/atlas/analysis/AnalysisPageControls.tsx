import { formatCount } from "../../lib/format";

interface AnalysisPageControlsProps {
  page: { offset: number; limit: number; total_matches: number; matches: unknown[] };
  loading: boolean;
  goTo: (offset: number) => void;
}

export function AnalysisPageControls({ page, loading, goTo }: AnalysisPageControlsProps) {
  if (!page.total_matches) return null;
  const end = page.offset + page.matches.length;
  return (
    <div className="atlas-analysis-pagination" role="group" aria-label="Result pages">
      <span aria-live="polite">
        {formatCount(page.offset + 1)}–{formatCount(end)} of {formatCount(page.total_matches)}
      </span>
      <button type="button" disabled={loading || page.offset === 0} onClick={() => goTo(Math.max(0, page.offset - page.limit))}>
        Previous
      </button>
      <button type="button" disabled={loading || end >= page.total_matches} onClick={() => goTo(page.offset + page.limit)}>
        Next
      </button>
    </div>
  );
}

export function AnalysisError({ error, retry }: { error: string; retry: () => void }) {
  return (
    <div className="atlas-analysis-error" role="alert">
      <span>{error}</span>
      <button type="button" onClick={retry}>Retry</button>
    </div>
  );
}
