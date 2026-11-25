import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { searchIndexedFiles } from "../lib/tauri";
import type { IndexedFileSearchResult } from "../lib/types";

export const FINDER_PAGE_SIZE = 48;
const MAX_CACHED_PAGES = 8;
const MAX_CACHED_QUERIES = 12;
const firstRow = { start: 0, end: 1 };

interface SearchRange {
  start: number;
  end: number;
}

interface SearchIntent {
  query: string;
  range: SearchRange;
  anchorFileId?: string;
  preferredIndex?: number;
}

interface CachedSearch {
  total: number;
  pages: Map<number, IndexedFileSearchResult[]>;
}

export type FinderSearchCache = Map<string, CachedSearch>;

export interface FinderRefresh {
  key: string;
  previousIndex: number;
  index: number;
  previousTotal: number | null;
  total: number;
  missingFile: boolean;
}

function searchKey(workspace: string, revision: number, name: string) {
  return JSON.stringify([workspace, revision, name]);
}

function pageOffset(index: number) {
  return Math.floor(index / FINDER_PAGE_SIZE) * FINDER_PAGE_SIZE;
}

function cachedFile(cached: CachedSearch | undefined, index: number) {
  const offset = pageOffset(index);
  return cached?.pages.get(offset)?.[index - offset];
}

function coveringPages(range: SearchRange, total: number | null): SearchRange {
  const max = total ?? Infinity;
  const start = pageOffset(Math.min(range.start, Math.max(0, max - 1)));
  return { start, end: Math.min(range.end, max, start + MAX_CACHED_PAGES * FINDER_PAGE_SIZE) };
}

function includesPage(range: SearchRange, offset: number) {
  return range.start <= offset && offset < range.end;
}

function firstMissingPage(range: SearchRange, cached?: CachedSearch) {
  for (let offset = range.start; offset < range.end; offset += FINDER_PAGE_SIZE) {
    if (!cached?.pages.has(offset)) return offset;
  }
  return null;
}

export function useIndexedFileSearch(
  workspace: string,
  revision: number,
  initialQuery: string,
  initialIndex: number,
  cache: FinderSearchCache,
  initialFileId?: string,
  onRefresh?: (update: FinderRefresh) => boolean | void,
) {
  const [intent, setIntent] = useState<SearchIntent>(() => {
    const cached = cache.get(searchKey(workspace, revision, initialQuery.trim()));
    return {
      query: initialQuery,
      range: { start: initialIndex, end: initialIndex + 1 },
      anchorFileId: cachedFile(cached, initialIndex)?.file_id === initialFileId ? undefined : initialFileId,
    };
  });
  const latest = useRef(intent);
  const refreshContext = useRef({ revision, onRefresh });
  const [displayedRevision, setDisplayedRevision] = useState(revision);
  const [, refreshCache] = useState(0);
  const [anchorIndex, setAnchorIndex] = useState<number | null>();
  const [failure, setFailure] = useState<{ key: string; offset: number; message: string } | null>(null);
  const { query, range, anchorFileId: initialAnchor } = intent;
  const name = query.trim();
  const key = JSON.stringify([workspace, name]);
  const requestKey = searchKey(workspace, revision, name);
  const requested = cache.get(requestKey);
  const displayed = cache.get(searchKey(workspace, displayedRevision, name));
  const visible = displayed ?? requested;
  const total = name ? visible?.total ?? null : 0;
  const refreshing = Boolean(name && visible && !initialAnchor && displayedRevision !== revision);
  const previousIndex = refreshing ? intent.preferredIndex ?? range.start : initialAnchor ? range.start : 0;
  const anchorFileId = initialAnchor ?? (refreshing ? cachedFile(visible, previousIndex)?.file_id : undefined);
  const requestedTotal = name ? requested?.total ?? null : 0;
  const offset = name && (anchorFileId || refreshing)
    ? pageOffset(previousIndex) : firstMissingPage(coveringPages(range, requestedTotal), requested);
  const error = failure?.key === requestKey && failure.offset === offset ? failure.message : null;
  const loading = offset !== null && !error;
  const initialRead = requestedTotal === null && !refreshing;

  useLayoutEffect(() => {
    refreshContext.current = { revision, onRefresh };
  }, [revision, onRefresh]);

  useEffect(() => {
    if (offset === null || error) return;
    let active = true;
    // A thumb drag can cross distant windows before settling on one viewport.
    const timer = window.setTimeout(async () => {
      const stillWanted = () => {
        const current = latest.current;
        return active && refreshContext.current.revision === revision && current.query.trim() === name
          && current.anchorFileId === initialAnchor
          && (refreshing ? (current.preferredIndex ?? current.range.start) === previousIndex
            : Boolean(initialAnchor) || includesPage(coveringPages(current.range, cache.get(requestKey)?.total ?? null), offset));
      };
      if (!stillWanted()) return;
      try {
        const page = await searchIndexedFiles(workspace, name, offset, FINDER_PAGE_SIZE, anchorFileId);
        if (!stillWanted()) return;
        const count = page.total_matches;
        const index = anchorFileId ? page.anchor_index : undefined;
        const expectedOffset = !anchorFileId ? offset : index !== undefined ? pageOffset(index)
          : Math.min(offset, pageOffset(Math.max(0, count - 1)));
        if (page.offset !== expectedOffset || page.matches.length !== Math.min(FINDER_PAGE_SIZE, Math.max(0, count - page.offset))
          || (index !== undefined && page.matches[index - page.offset]?.file_id !== anchorFileId)) {
          throw new Error("The search returned an unexpected page.");
        }

        const target = index ?? Math.min(previousIndex, Math.max(0, count - 1));
        if (refreshing && refreshContext.current.onRefresh?.({
          key, previousIndex, index: target, previousTotal: total, total: count,
          missingFile: Boolean(anchorFileId && index === undefined),
        }) === false) return;

        const previous = cache.get(requestKey);
        // A changed result count can move rows between pages.
        const pages = previous?.total === count ? new Map(previous.pages) : new Map<number, IndexedFileSearchResult[]>();
        if (page.offset < count) pages.set(page.offset, page.matches);
        const nextRange = initialAnchor || refreshing ? { start: target, end: target + 1 } : latest.current.range;
        const wanted = coveringPages(nextRange, count);
        for (const start of pages.keys()) {
          if (pages.size <= MAX_CACHED_PAGES) break;
          if (start !== 0 && !includesPage(wanted, start)) pages.delete(start);
        }
        // Enter from the search field can still open the first result after scrolling.
        if (pages.size > MAX_CACHED_PAGES) pages.delete(0);
        cache.delete(requestKey);
        cache.set(requestKey, { total: count, pages });
        if (cache.size > MAX_CACHED_QUERIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        setDisplayedRevision(revision);
        if (initialAnchor || refreshing) {
          const next = { query: latest.current.query, range: nextRange, preferredIndex: target };
          latest.current = next;
          if (initialAnchor) setAnchorIndex(index ?? null);
          setIntent(next);
        } else {
          refreshCache((version) => version + 1);
        }
      } catch (error) {
        if (stillWanted()) {
          setFailure({ key: requestKey, offset, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }, initialRead ? 160 : 55);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [anchorFileId, cache, error, initialAnchor, initialRead, key, name, offset, previousIndex,
    refreshing, requestKey, revision, total, workspace]);

  const changeQuery = useCallback((text: string) => {
    const current = latest.current;
    if (current.query === text) return;
    const nameChanged = text.trim() !== current.query.trim();
    const next = { query: text, range: nameChanged || current.anchorFileId ? firstRow : current.range };
    latest.current = next;
    setIntent(next);
    setAnchorIndex(undefined);
    if (nameChanged || current.anchorFileId) {
      setFailure(null);
      setDisplayedRevision(revision);
    }
  }, [revision]);

  const loadRange = useCallback((start: number, end: number, preferredIndex?: number) => {
    const current = latest.current;
    if (!name || current.anchorFileId || current.query.trim() !== name
      || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const range = { start: Math.max(0, Math.floor(start)), end: Math.max(1, Math.ceil(end)) };
    if (range.start === current.range.start && range.end === current.range.end && preferredIndex === current.preferredIndex) return;
    const next = { query: current.query, range, preferredIndex };
    latest.current = next;
    setIntent(next);
    setFailure((previous) => previous?.key === requestKey && includesPage(coveringPages(range, total), previous.offset)
      ? previous : null);
  }, [name, requestKey, total]);

  const fileAt = useCallback((index: number) => cachedFile(visible, index), [visible]);

  return {
    query, name, key, changeQuery, loading, error, total, fileAt, loadRange, retry: () => setFailure(null),
    locatingFile: Boolean(initialAnchor), anchorIndex, refreshing, resultRevision: displayed ? displayedRevision : revision,
  };
}
