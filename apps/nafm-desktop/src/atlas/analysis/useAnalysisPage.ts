import { useEffect, useState } from "react";

interface AnalysisPage {
  offset: number;
  limit: number;
  total_matches: number;
  matches: unknown[];
}

export function useAnalysisPage<Page extends AnalysisPage>(load: (offset: number) => Promise<Page>) {
  const [request, setRequest] = useState({ offset: 0 });
  const [result, setResult] = useState<{ request: typeof request; page: Page } | null>(null);
  const [failure, setFailure] = useState<{ request: typeof request; message: string } | null>(null);
  const page = result?.page ?? null;
  const error = failure?.request === request ? failure.message : null;
  const loading = result?.request !== request && failure?.request !== request;

  useEffect(() => {
    let active = true;
    // Skip StrictMode's probe mount before issuing an IPC request.
    const timer = window.setTimeout(async () => {
      try {
        const next = await load(request.offset);
        if (active) setResult({ request, page: next });
      } catch (error) {
        if (active) setFailure({ request, message: error instanceof Error ? error.message : String(error) });
      }
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [load, request]);

  return {
    page,
    loading,
    error,
    goTo: (offset: number) => setRequest({ offset }),
    retry: () => setRequest({ offset: request.offset }),
  };
}
