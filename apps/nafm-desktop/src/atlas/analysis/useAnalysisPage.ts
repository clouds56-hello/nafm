import { useLayoutEffect, useState } from "react";

interface AnalysisPage {
  offset: number;
  limit: number;
  total_matches: number;
  matches: unknown[];
}

export interface AnalysisPosition<Page> {
  page: Page;
  selected_id: string;
  scroll_top: number;
  revision: number;
}

export function useAnalysisPage<Page extends AnalysisPage>(
  load: (offset: number) => Promise<Page>, revision: number, initialOffset = 0, cachedPage?: Page,
) {
  const [request, setRequest] = useState({ offset: initialOffset, sequence: 0 });
  const [result, setResult] = useState<{ request: typeof request; revision: number; page: Page } | null>(
    () => cachedPage ? { request, revision, page: cachedPage } : null,
  );
  const [failure, setFailure] = useState<{ request: typeof request; revision: number; message: string } | null>(null);
  const page = result?.page ?? null;
  const failed = failure?.request === request && failure.revision === revision;
  const error = failed ? failure.message : null;
  const loading = !failed && (result?.request !== request || result.revision !== revision);

  useLayoutEffect(() => {
    if (!loading) return;
    let active = true;
    // Skip StrictMode's probe mount before issuing an IPC request.
    const timer = window.setTimeout(async () => {
      try {
        const next = await load(request.offset);
        if (!active) return;
        if (next.offset > 0 && next.offset >= next.total_matches) {
          // A newer index snapshot can leave the saved page past the end.
          const limit = Math.max(1, next.limit);
          const offset = Math.max(0, Math.floor((next.total_matches - 1) / limit) * limit);
          setRequest((current) => current === request ? { ...current, offset } : current);
          return;
        }
        setResult({ request, revision, page: next });
      } catch (error) {
        if (active) setFailure({ request, revision, message: error instanceof Error ? error.message : String(error) });
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, loading, request, revision]);

  return {
    page,
    pageSequence: result?.request.sequence ?? 0,
    loading,
    error,
    goTo: (offset: number) => setRequest((current) => ({ offset, sequence: current.sequence + 1 })),
    retry: () => setRequest((current) => ({ ...current })),
  };
}
