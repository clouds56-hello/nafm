import { useCallback, useEffect, useRef, useState } from "react";
import { searchIndexedFiles } from "../lib/tauri";
import type { IndexedFileSearchResult } from "../lib/types";

const PAGE_SIZE = 48;
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
}

interface CachedSearch {
  total: number;
  pages: Map<number, IndexedFileSearchResult[]>;
}

export type FinderSearchCache = Map<string, CachedSearch>;

function searchKey(workspace: string, revision: number, name: string) {
  return JSON.stringify([workspace, revision, name]);
}

function pageOffset(index: number) {
  return Math.floor(index / PAGE_SIZE) * PAGE_SIZE;
}

function coveringPages(range: SearchRange, total: number | null): SearchRange {
  const max = total ?? Infinity;
  const start = pageOffset(Math.min(range.start, Math.max(0, max - 1)));
  return { start, end: Math.min(range.end, max, start + MAX_CACHED_PAGES * PAGE_SIZE) };
}

function includesPage(range: SearchRange, offset: number) {
  return range.start <= offset && offset < range.end;
}

function firstMissingPage(range: SearchRange, cached?: CachedSearch) {
  for (let offset = range.start; offset < range.end; offset += PAGE_SIZE) {
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
) {
  const [intent, setIntent] = useState<SearchIntent>(() => {
    const start = pageOffset(initialIndex);
    const cached = cache.get(searchKey(workspace, revision, initialQuery.trim()));
    const knownFile = cached?.pages.get(start)?.[initialIndex - start];
    return {
      query: initialQuery,
      range: { start: initialIndex, end: initialIndex + 1 },
      anchorFileId: knownFile?.file_id === initialFileId ? undefined : initialFileId,
    };
  });
  const latest = useRef(intent);
  const [, refreshCache] = useState(0);
  const [anchorIndex, setAnchorIndex] = useState<number | null>();
  const [failure, setFailure] = useState<{ key: string; offset: number; message: string } | null>(null);
  const { query, range, anchorFileId } = intent;
  const name = query.trim();
  const key = searchKey(workspace, revision, name);
  const cached = cache.get(key);
  const total = name ? cached?.total ?? null : 0;
  const offset = name && anchorFileId ? pageOffset(range.start) : firstMissingPage(coveringPages(range, total), cached);
  const error = failure?.key === key && failure.offset === offset ? failure.message : null;
  const loading = offset !== null && !error;
  const initialRead = total === null;

  useEffect(() => {
    if (offset === null || error) return;
    let active = true;
    // A thumb drag can cross distant windows before settling on one viewport.
    const timer = window.setTimeout(async () => {
      const stillWanted = () => active && latest.current.query.trim() === name
        && latest.current.anchorFileId === anchorFileId
        && (Boolean(anchorFileId) || includesPage(coveringPages(latest.current.range, cache.get(key)?.total ?? null), offset));
      if (!stillWanted()) return;
      try {
        const page = await searchIndexedFiles(workspace, name, offset, PAGE_SIZE, anchorFileId);
        if (!stillWanted()) return;
        const count = page.total_matches;
        const index = anchorFileId ? page.anchor_index : undefined;
        const expectedOffset = !anchorFileId ? offset : index !== undefined ? pageOffset(index)
          : Math.min(offset, pageOffset(Math.max(0, count - 1)));
        if (page.offset !== expectedOffset || page.matches.length !== Math.min(PAGE_SIZE, Math.max(0, count - page.offset))
          || (index !== undefined && page.matches[index - page.offset]?.file_id !== anchorFileId)) {
          throw new Error("The search returned an unexpected page.");
        }

        const previous = cache.get(key);
        // A changed result count can move rows between pages.
        const pages = previous?.total === count ? new Map(previous.pages) : new Map<number, IndexedFileSearchResult[]>();
        if (page.offset < count) pages.set(page.offset, page.matches);
        const target = index ?? Math.min(latest.current.range.start, Math.max(0, count - 1));
        const nextRange = anchorFileId ? { start: target, end: target + 1 } : latest.current.range;
        const wanted = coveringPages(nextRange, count);
        for (const start of pages.keys()) {
          if (pages.size <= MAX_CACHED_PAGES) break;
          if (start !== 0 && !includesPage(wanted, start)) pages.delete(start);
        }
        // Enter from the search field can still open the first result after scrolling.
        if (pages.size > MAX_CACHED_PAGES) pages.delete(0);
        cache.delete(key);
        cache.set(key, { total: count, pages });
        if (cache.size > MAX_CACHED_QUERIES) {
          const oldest = cache.keys().next().value;
          if (oldest !== undefined) cache.delete(oldest);
        }
        if (anchorFileId) {
          const next = { query: latest.current.query, range: nextRange };
          latest.current = next;
          setAnchorIndex(index ?? null);
          setIntent(next);
        } else {
          refreshCache((version) => version + 1);
        }
      } catch (error) {
        if (stillWanted()) {
          setFailure({ key, offset, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }, initialRead ? 160 : 55);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [anchorFileId, cache, error, initialRead, key, name, offset, workspace]);

  const changeQuery = useCallback((text: string) => {
    const current = latest.current;
    if (current.query === text) return;
    const nameChanged = text.trim() !== current.query.trim();
    const next = { query: text, range: nameChanged || current.anchorFileId ? firstRow : current.range };
    latest.current = next;
    setIntent(next);
    setAnchorIndex(undefined);
    if (nameChanged || current.anchorFileId) setFailure(null);
  }, []);

  const loadRange = useCallback((start: number, end: number) => {
    const current = latest.current;
    if (!name || current.anchorFileId || current.query.trim() !== name
      || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
    const range = { start: Math.max(0, Math.floor(start)), end: Math.max(1, Math.ceil(end)) };
    if (range.start === current.range.start && range.end === current.range.end) return;
    const next = { query: current.query, range };
    latest.current = next;
    setIntent(next);
    setFailure((previous) => previous?.key === key && includesPage(coveringPages(range, total), previous.offset)
      ? previous : null);
  }, [key, name, total]);

  const fileAt = useCallback((index: number) => {
    const offset = pageOffset(index);
    return cached?.pages.get(offset)?.[index - offset];
  }, [cached]);

  return {
    query, name, key, changeQuery, loading, error, total, fileAt, loadRange, retry: () => setFailure(null),
    locatingFile: Boolean(anchorFileId), anchorIndex,
  };
}
