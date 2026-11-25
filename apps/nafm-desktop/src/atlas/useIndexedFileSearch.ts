import { useCallback, useEffect, useState } from "react";
import { searchIndexedFiles } from "../lib/tauri";
import type { IndexedFileSearchResult } from "../lib/types";

const PAGE_SIZE = 24;
const firstPage = { offset: 0 };

export interface FinderSearchResult {
  key: string;
  request: typeof firstPage;
  files: IndexedFileSearchResult[];
  total: number;
  next: number | null;
  error: string | null;
}

export function useIndexedFileSearch(workspace: string, revision: number, initialQuery: string, cache: Map<string, FinderSearchResult>) {
  const [query, setQuery] = useState(initialQuery);
  const name = query.trim();
  const key = JSON.stringify([workspace, revision, name]);
  const [requested, setRequested] = useState<{ key: string; request: typeof firstPage } | null>(null);
  const [result, setResult] = useState<FinderSearchResult | null>(null);
  const cached = cache.get(name) ?? null;
  const request = requested?.key === key ? requested.request : cached?.request ?? firstPage;
  const current = result?.key === key ? result : cached;
  const settled = current?.request === request;
  const loading = Boolean(name) && !settled;
  const error = settled ? current.error : null;

  useEffect(() => {
    if (!name || settled) return;
    let active = true;
    const timer = window.setTimeout(async () => {
      try {
        const { matches, offset, total_matches } = await searchIndexedFiles(workspace, name, request.offset, PAGE_SIZE);
        if (!active) return;
        if (offset !== request.offset) throw new Error("The search returned an unexpected page.");
        const end = offset + matches.length;
        setResult((previous) => {
          const lastPage = previous?.key === key ? previous : cached;
          const files = offset > 0 ? lastPage?.files ?? [] : [];
          const seen = new Set(files.map((file) => file.file_id));
          return {
            key, request, files: [...files, ...matches.filter((file) => !seen.has(file.file_id))],
            total: total_matches, next: matches.length > 0 && end < total_matches ? end : null, error: null,
          };
        });
      } catch (error) {
        if (active) {
          setResult((previous) => {
            const previousPage = previous?.key === key ? previous : cached;
            return {
              key, request, files: previousPage?.files ?? [], total: previousPage?.total ?? 0,
              next: previousPage?.next ?? null, error: error instanceof Error ? error.message : String(error),
            };
          });
        }
      }
    }, request === firstPage ? 160 : 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [cached, key, name, request, settled, workspace]);

  const next = current?.next;
  const loadMore = useCallback(() => {
    if (loading || error || next == null) return;
    setRequested((previous) => previous?.key === key && previous.request.offset === next
      ? previous : { key, request: { offset: next } });
  }, [loading, error, key, next]);

  function changeQuery(text: string) {
    setQuery(text);
    if (text.trim() !== name) {
      setRequested(null);
      setResult(null);
    }
  }

  return {
    query, name, changeQuery, loading, error, files: current?.files ?? [], total: current?.total ?? 0, hasMore: next != null,
    loadMore,
    remember: () => { if (current && !current.error) cache.set(name, current); },
    retry: () => setRequested({ key, request: { ...request } }),
  };
}
