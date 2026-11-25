import { useCallback, useEffect, useState } from "react";
import { getStorageChildren } from "../lib/tauri";
import type { DirectorySort, StorageChildrenPage } from "../lib/types";

const firstWindow = { offset: 0, limit: 64 };
type SearchRange = typeof firstWindow;

interface DirectorySearchOptions {
  scope: string;
  siteId?: string;
  targetId?: string;
  folderId?: string;
  query: string;
  sort: DirectorySort;
  contentRevision: number;
}

export function useDirectorySearch({
  scope, siteId, targetId, folderId, query, sort: { field, direction }, contentRevision,
}: DirectorySearchOptions) {
  const enabled = Boolean(query && siteId && folderId);
  const key = JSON.stringify([scope, targetId, query, field, direction, contentRevision]);
  const [requested, setRequested] = useState<{ key: string; range: SearchRange } | null>(null);
  const [result, setResult] = useState<{ key: string; range: SearchRange; page: StorageChildrenPage } | null>(null);
  const [failure, setFailure] = useState<{ key: string; range: SearchRange; message: string } | null>(null);
  const range = requested?.key === key ? requested.range : firstWindow;
  const delivered = result?.key === key ? result : null;
  const page = delivered?.page ?? null;
  const error = failure?.key === key && failure.range === range ? failure.message : null;
  const pending = enabled && !error && delivered?.range !== range;

  useEffect(() => {
    if (!enabled || !siteId || !folderId || delivered?.range === range) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      try {
        const next = await getStorageChildren(siteId, targetId ?? null, folderId, range.offset, range.limit, { field, direction }, query);
        if (!current) return;
        if (!next.children.length && next.offset < next.total_children) throw new Error("Matches could not be read.");
        setResult({ key, range, page: next });
        setFailure(null);
      } catch (error) {
        if (current) setFailure({ key, range, message: error instanceof Error ? error.message : String(error) });
      }
    }, range === firstWindow ? 160 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [enabled, siteId, targetId, folderId, key, query, field, direction, range, delivered]);

  const loadRange = useCallback((start: number, end: number) => {
    if (!delivered || !page || end <= start) return;
    if (start >= page.offset && end <= page.offset + page.children.length) {
      if (range !== delivered.range) setRequested({ key, range: delivered.range });
      return;
    }
    if (range !== delivered.range && start >= range.offset && end <= range.offset + range.limit) return;
    const limit = Math.min(page.total_children, Math.max(firstWindow.limit, end - start));
    const offset = Math.max(0, Math.min(page.total_children - limit, start - Math.floor((limit - (end - start)) / 2)));
    setRequested({ key, range: { offset, limit } });
  }, [delivered, key, page, range]);

  return {
    enabled,
    page,
    error,
    loading: pending && !page,
    loadingMore: pending && Boolean(page),
    loadRange,
    retry: () => setRequested({ key, range: { ...range } }),
  };
}
