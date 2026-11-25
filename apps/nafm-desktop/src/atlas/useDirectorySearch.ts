import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getStorageChildren } from "../lib/tauri";
import type { DirectoryRefresh, DirectorySort, StorageChildrenPage } from "../lib/types";

const firstWindow = { offset: 0, limit: 64 };
type SearchRange = typeof firstWindow;

interface DirectoryRequest {
  key: string;
  range: SearchRange;
  preferredIndex?: number;
}

interface DirectoryRead extends DirectoryRequest {
  targetId: string | undefined;
  revision: number;
}

interface DirectorySearchOptions {
  scope: string;
  siteId?: string;
  targetId?: string;
  folderId?: string;
  query: string;
  sort: DirectorySort;
  contentRevision: number;
  inspectedFileId?: string;
  onRefresh?: (update: DirectoryRefresh) => boolean | void;
}

function directorySearchKey(scope: string, query: string, sort: DirectorySort) {
  return JSON.stringify([scope, query, sort.field, sort.direction]);
}

function refreshAnchorIndex(page: StorageChildrenPage | null, fallback: number, inspectedFileId?: string) {
  if (!page || !inspectedFileId) return fallback;
  const index = page.children.findIndex((file) => file.id === inspectedFileId);
  return index < 0 ? fallback : page.offset + index;
}

export function useDirectorySearch({
  scope, siteId, targetId, folderId, query, sort: { field, direction }, contentRevision, inspectedFileId, onRefresh,
}: DirectorySearchOptions) {
  const enabled = Boolean(query && siteId && folderId);
  const key = directorySearchKey(scope, query, { field, direction });
  const [requested, setRequested] = useState<DirectoryRequest | null>(null);
  const [result, setResult] = useState<(DirectoryRead & { page: StorageChildrenPage }) | null>(null);
  const [failure, setFailure] = useState<(DirectoryRead & { refreshIndex?: number; message: string }) | null>(null);
  const request = requested?.key === key ? requested : null;
  const delivered = result?.key === key ? result : null;
  const page = delivered?.page ?? null;
  const range = request?.range ?? delivered?.range ?? firstWindow;
  const preferredIndex = request?.preferredIndex;
  const changingTarget = delivered !== null && delivered.targetId !== targetId;
  const refreshing = delivered !== null && !changingTarget && delivered.revision !== contentRevision;
  const refreshIndex = refreshing ? refreshAnchorIndex(page, preferredIndex ?? range.offset, inspectedFileId) : undefined;
  const anchor = page && refreshIndex !== undefined ? page.children[refreshIndex - page.offset]?.id : undefined;
  const error = failure?.key === key && failure.targetId === targetId && failure.revision === contentRevision && failure.range === range
    && failure.refreshIndex === refreshIndex ? failure.message : null;
  const pending = enabled && !error && (changingTarget || refreshing || delivered?.range !== range);
  const latest = useRef({ key, targetId, revision: contentRevision, range, preferredIndex, inspectedFileId, onRefresh });

  useLayoutEffect(() => {
    latest.current = { key, targetId, revision: contentRevision, range, preferredIndex, inspectedFileId, onRefresh };
  }, [key, targetId, contentRevision, range, preferredIndex, inspectedFileId, onRefresh]);

  const requestWindow = useCallback((next: DirectoryRequest) => {
    latest.current = { ...latest.current, ...next };
    setRequested(next);
  }, []);

  useEffect(() => {
    if (!pending || !siteId || !folderId) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      const stillWanted = () => {
        const active = latest.current;
        return current && active.key === key && active.targetId === targetId
          && active.revision === contentRevision && active.range === range
          && (refreshIndex === undefined
            || refreshAnchorIndex(page, active.preferredIndex ?? range.offset, active.inspectedFileId) === refreshIndex);
      };
      if (!stillWanted()) return;
      try {
        const read = (offset: number, id?: string) =>
          getStorageChildren(siteId, targetId ?? null, folderId, offset, range.limit, { field, direction }, query, id);
        let next = await read(range.offset, anchor);
        if (!stillWanted()) return;
        if (refreshIndex !== undefined && next.total_children > 0 && next.offset >= next.total_children) {
          next = await read(Math.max(0, next.total_children - range.limit));
          if (!stillWanted()) return;
        }
        if (!next.children.length && next.offset < next.total_children) throw new Error("Matches could not be read.");
        let nextRange = range;
        if (refreshIndex !== undefined && page) {
          const match = anchor ? next.children.findIndex((node) => node.id === anchor) : -1;
          const index = match >= 0 ? next.offset + match : Math.min(refreshIndex, Math.max(0, next.total_children - 1));
          if (latest.current.onRefresh?.({
            page: next, previousIndex: refreshIndex, index, previousTotal: page.total_children,
            missingEntry: Boolean(anchor && match < 0),
          }) === false) return;
          nextRange = { offset: next.offset, limit: next.limit };
          requestWindow({ key, range: nextRange, preferredIndex: index });
        }
        setResult({ key, targetId, revision: contentRevision, range: nextRange, page: next });
        setFailure(null);
      } catch (error) {
        if (stillWanted()) setFailure({
          key, targetId, revision: contentRevision, range, refreshIndex, message: error instanceof Error ? error.message : String(error),
        });
      }
    }, !page && range === firstWindow ? 160 : 0);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [anchor, pending, siteId, targetId, folderId, key, contentRevision, query, field, direction, range, refreshIndex, page, requestWindow]);

  const loadRange = useCallback((start: number, end: number, preferredIndex = start) => {
    if (!delivered || !page || end <= start || latest.current.key !== key) return;
    let nextRange = range;
    if (start >= page.offset && end <= page.offset + page.children.length) nextRange = delivered.range;
    else if (range === delivered.range || start < range.offset || end > range.offset + range.limit) {
      const limit = Math.min(page.total_children, Math.max(firstWindow.limit, end - start));
      const offset = Math.max(0, Math.min(page.total_children - limit, start - Math.floor((limit - (end - start)) / 2)));
      nextRange = { offset, limit };
    }
    const active = latest.current;
    if (nextRange !== active.range || preferredIndex !== active.preferredIndex) {
      requestWindow({ key, range: nextRange, preferredIndex });
    }
  }, [delivered, key, page, range, requestWindow]);

  const prime = useCallback((
    destination: Pick<DirectorySearchOptions, "scope" | "targetId" | "query" | "sort">, page: StorageChildrenPage,
  ) => {
    const key = directorySearchKey(destination.scope, destination.query, destination.sort);
    const range = { offset: page.offset, limit: page.limit };
    requestWindow({ key, range });
    setResult({ key, targetId: destination.targetId, revision: contentRevision, range, page });
    setFailure(null);
  }, [contentRevision, requestWindow]);

  return {
    enabled,
    // Keep the scroll track and window while waiting for coverage from the new target.
    total: page?.total_children ?? 0,
    page: changingTarget ? null : page,
    error,
    loading: pending && (changingTarget || !page),
    loadingMore: pending && !changingTarget && Boolean(page),
    loadRange,
    retry: () => requestWindow({ key, range: { ...range }, preferredIndex }),
    prime,
  };
}
