import { useEffect, useState } from "react";

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
  load: (offset: number) => Promise<Page>, initialOffset = 0, cachedPage?: Page,
) {
  const [request, setRequest] = useState({ offset: initialOffset });
  const [result, setResult] = useState<{ request: typeof request; page: Page } | null>(
    () => cachedPage ? { request, page: cachedPage } : null,
  );
  const [failure, setFailure] = useState<{ request: typeof request; message: string } | null>(null);
  const page = result?.page ?? null;
  const error = failure?.request === request ? failure.message : null;
  const loading = result?.request !== request && failure?.request !== request;

  useEffect(() => {
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
          setRequest((current) => current === request ? { offset } : current);
          return;
        }
        setResult({ request, page: next });
      } catch (error) {
        if (active) setFailure({ request, message: error instanceof Error ? error.message : String(error) });
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, loading, request]);

  return {
    page,
    loading,
    error,
    goTo: (offset: number) => setRequest({ offset }),
    retry: () => setRequest({ offset: request.offset }),
  };
}
