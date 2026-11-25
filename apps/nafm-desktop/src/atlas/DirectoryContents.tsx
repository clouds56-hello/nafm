import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { formatCount } from "../lib/format";
import type {
  DirectoryRefresh, DirectoryRefreshPosition, DirectoryRefreshTarget, DirectorySort, FolderOpenDestination, HealthMetric,
  StorageChildrenPage, StorageLocation, StorageNode,
} from "../lib/types";
import { CloseIcon, SearchIcon } from "../management/Icons";
import { revealInCompactAtlas } from "./compactAtlasScroll";
import { DirectorySortControl } from "./DirectorySortControl";
import { canOpenFolder, FolderOpenControl } from "./FolderOpenControl";
import { DirectoryEntryLabel, useDirectoryPreview } from "./useDirectoryPreview";
import { useDirectoryViewport } from "./useDirectoryViewport";
import "./directory.css";

interface DirectoryContentsProps {
  location: StorageLocation | null;
  page: StorageChildrenPage | null;
  total: number;
  directoryTotal: number;
  searchText: string | null;
  onSearchChange: (text: string | null) => void;
  onRestoreSearch?: () => void;
  selection: StorageNode | null;
  sort: DirectorySort;
  onSort: (sort: DirectorySort) => Promise<void>;
  metric: HealthMetric | null;
  targetCompleteness: number;
  scrollPane: RefObject<HTMLDivElement | null>;
  scrollPositions: Map<string, number | "end">;
  cursorPositions: Map<string, string>;
  contentsKey: string;
  anchorIndex: number;
  reveal?: { index: number; onApplied: () => void };
  refreshHandler?: RefObject<DirectoryRefreshTarget | null>;
  returnEntryId: string | null;
  revealedEntry?: { id: string; origin?: Element | null };
  resumeVisibleRow: boolean;
  contentsFocusOrigin: HTMLElement | null;
  onContentsFocusHandled: () => void;
  active: boolean;
  loading: boolean;
  loadingMore: boolean;
  awaitingInventory: boolean;
  error: string | null;
  onSelect: (node: StorageNode) => void;
  onOpenFolder: (node: StorageNode, destination: FolderOpenDestination) => Promise<void>;
  onGoUp: (origin?: HTMLElement) => void;
  onLoadRange: (start: number, end: number, preferredIndex?: number) => void;
  onRetry: () => void;
}

function entryTabStop(list: HTMLUListElement | null) {
  return list?.querySelector<HTMLButtonElement>('[data-entry-id][tabindex="0"]');
}

export function DirectoryContents({
  location, page, total, directoryTotal, searchText, onSearchChange, onRestoreSearch, selection, sort, onSort, metric, targetCompleteness,
  scrollPane, scrollPositions, cursorPositions, contentsKey, anchorIndex, reveal, refreshHandler, returnEntryId, revealedEntry, resumeVisibleRow,
  contentsFocusOrigin, onContentsFocusHandled,
  active, loading, loadingMore, awaitingInventory, error, onSelect, onOpenFolder, onGoUp, onLoadRange, onRetry,
}: DirectoryContentsProps) {
  const labelId = useId();
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchFocus = useRef<"input" | "trigger" | null>(null);
  const searchOpen = searchText !== null;
  const filtering = Boolean(searchText?.trim());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  const [focusedCursor, setFocusedCursor] = useState<{ key: string; id: string } | null>(null);
  const cursor = focusedCursor?.key === contentsKey ? focusedCursor.id : cursorPositions.get(contentsKey);
  const folderFocus = useRef<{ folder: string; origin: Element | null; row?: string; fromPointer?: boolean } | null>(null);
  const keyboardRow = useRef<{
    key: string; index: number; refreshPage?: StorageChildrenPage; preventScroll?: boolean;
    retryPosition?: { top: number; total: number };
  } | null>(null);
  const returningEntry = useRef<{ id: string | null; origin?: Element | null; index?: number } | null>(null);
  const [refreshReveal, setRefreshReveal] = useState<{
    key: string; page: StorageChildrenPage; index: number; position: number | "end"; onApplied: () => void;
  } | null>(null);
  const [missingRefreshKey, setMissingRefreshKey] = useState<string | null>(null);
  const directoryId = location?.root.id;
  const offset = page?.offset ?? 0;
  const committedReveal = refreshReveal?.key === contentsKey && refreshReveal.page === page ? refreshReveal : undefined;
  const placingRefresh = Boolean(committedReveal);
  const viewport = useDirectoryViewport({
    contentsKey, anchorIndex, total, active, scrollPane, scrollPositions,
    reveal: reveal ?? committedReveal,
  });
  const { listRef, first, start, end, focusStart, focusEnd, ready, scrollToRow } = viewport;
  const hasVisibleRows = focusStart < focusEnd;
  const firstVisibleRow = hasVisibleRows ? focusStart : first;
  const rowPreview = useDirectoryPreview({
    root: location?.root, entries: page?.children, metric, targetCompleteness, awaitingInventory, active, contentsKey, scrollPane,
  });

  useLayoutEffect(() => {
    if (!active || searchFocus.current !== (searchOpen ? "input" : "trigger")) return;
    searchFocus.current = null;
    (searchOpen ? searchInput.current : searchTrigger.current)?.focus({ preventScroll: true });
  }, [searchOpen, active]);

  useLayoutEffect(() => {
    if (!refreshHandler || !active) return;
    const target = { getUnfilteredPosition, receive: receiveRefresh };
    refreshHandler.current = target;
    return () => { if (refreshHandler.current === target) refreshHandler.current = null; };
  });

  useEffect(() => {
    const id = returnEntryId ?? revealedEntry?.id ?? null;
    returningEntry.current = active && (id || resumeVisibleRow) ? { id, origin: revealedEntry?.origin } : null;
  }, [active, returnEntryId, revealedEntry, resumeVisibleRow, contentsKey]);

  useEffect(() => {
    const request = returningEntry.current;
    const pane = scrollPane.current;
    if (!request || !pane || loading || (total > 0 && !ready)) return;
    const tab = document.getElementById(pane.getAttribute("aria-labelledby") ?? "");
    const focus = document.activeElement;
    if (focus === pane || focus === tab || (request.origin && (focus === request.origin || focus === document.body))) {
      const row = request.id
        ? listRef.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(request.id)}"]`)
        : entryTabStop(listRef.current);
      if (!row && total && !error && (request.id || hasVisibleRows)) {
        // The file's page can arrive after Contents has already reopened.
        const index = request.id ? page?.children.findIndex((entry) => entry.id === request.id) ?? -1 : -1;
        if (index >= 0) {
          request.index = offset + index;
          scrollToRow(request.index);
        }
        return;
      }
      const retry = request.id && error ? retryButton.current : null;
      if (request.origin) revealInCompactAtlas(pane.closest("[data-atlas-panel]"));
      (row || retry || searchInput.current || headingRef.current)?.focus({ preventScroll: true });
      if (row && request.id) {
        const paneBounds = pane.getBoundingClientRect();
        const headerBottom = pane.querySelector(".atlas-directory-header")?.getBoundingClientRect().bottom ?? paneBounds.top;
        const rect = row.getBoundingClientRect();
        if (rect.top < headerBottom - 1 || rect.bottom > paneBounds.bottom + 1) row.scrollIntoView({ block: "nearest" });
      }
    }
    returningEntry.current = null;
  }, [active, returnEntryId, revealedEntry, resumeVisibleRow, cursor, focusStart, focusEnd, hasVisibleRows, ready, loading, total, error, page, offset, listRef, scrollPane, scrollToRow]);

  useEffect(() => {
    if (!active || !ready || loading || placingRefresh || !page || end <= start) return;
    const index = returningEntry.current?.index;
    if (index !== undefined && (index < start || index >= end)) return;
    const request = () => {
      const { pending, focusedIndex } = readResultFocus();
      const preferred = pending?.index ?? focusedIndex ?? first;
      onLoadRange(start, end, preferred >= start && preferred < end ? preferred : first);
    };
    if (end <= offset || start >= offset + page.children.length) {
      // Let a thumb drag cross distant ranges without reading every folder slice along its path.
      const timer = window.setTimeout(request, 60);
      return () => window.clearTimeout(timer);
    }
    request();
  }, [active, ready, loading, placingRefresh, first, start, end, page, offset, cursor, contentsKey, listRef, onLoadRange]);

  useLayoutEffect(() => {
    if (!active || loading) return;
    const destination = folderFocus.current;
    const pending = keyboardRow.current;
    if (!pending && !destination) return;
    const pane = scrollPane.current;
    const focus = document.activeElement;
    if (!pane || (focus !== document.body && !pane.contains(focus))) {
      keyboardRow.current = null;
      folderFocus.current = null;
      return;
    }
    if (destination && destination.folder !== directoryId) {
      folderFocus.current = null;
      return;
    }
    const originRemoved = destination?.origin && !destination.origin.isConnected && focus === document.body;
    if (destination && !originRemoved && focus !== destination.origin && focus !== listRef.current) {
      folderFocus.current = null;
      return;
    }
    if (pending) {
      const onFailedRetry = error && focus === retryButton.current;
      const moved = pending.retryPosition?.total === total && pending.retryPosition.top !== pane.scrollTop;
      if (pending.key !== contentsKey || moved || (total > 0 && focus !== listRef.current && !onFailedRetry)) {
        keyboardRow.current = null;
        return;
      }
      if (error) {
        retryButton.current?.focus({ preventScroll: true });
        return;
      }
    }
    if (pending?.refreshPage) {
      if (pending.refreshPage !== page) return;
      pending.refreshPage = undefined;
    }
    if (!ready && total) return;
    const parentEntry = destination?.row
      ? listRef.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(destination.row)}"]`) : null;
    const target = Math.min(total - 1, pending?.index ?? first);
    const pointerEntry = destination?.fromPointer ? entryTabStop(listRef.current) : null;
    const row = parentEntry ?? pointerEntry ?? listRef.current?.querySelector<HTMLButtonElement>(`[aria-rowindex="${target + 1}"] [data-entry-id]`);
    if (row || !total || error) {
      keyboardRow.current = null;
      folderFocus.current = null;
      (row ?? headingRef.current)?.focus({ preventScroll: Boolean(pending?.preventScroll || destination?.fromPointer) });
    }
  }, [active, contentsKey, directoryId, error, first, listRef, loading, page, ready, scrollPane, start, end, total]);

  useLayoutEffect(() => {
    if (!contentsFocusOrigin) return;
    const focus = document.activeElement;
    const originRemoved = focus === document.body && !contentsFocusOrigin.isConnected;
    if (!active || (focus !== contentsFocusOrigin && focus !== scrollPane.current && !originRemoved)) {
      onContentsFocusHandled();
      return;
    }
    if (loading || (total > 0 && !ready)) return;
    const row = entryTabStop(listRef.current);
    if (!row && total && hasVisibleRows && !error) return;
    (row ?? (error ? retryButton.current : null) ?? searchInput.current ?? headingRef.current)?.focus({ preventScroll: true });
    onContentsFocusHandled();
  }, [active, contentsFocusOrigin, cursor, error, focusStart, focusEnd, hasVisibleRows, listRef, loading, onContentsFocusHandled, page, ready, scrollPane, total]);

  if (!location) return null;
  const parent = location.breadcrumbs.at(-2);
  const visible = Array.from({ length: Math.max(0, end - start) }, (_, i) => {
    const index = start + i;
    return { index, node: page?.children[index - offset] };
  });
  const visibleEntries = visible.flatMap(({ index, node }) => node && index >= focusStart && index < focusEnd ? [node] : []);
  const tabStop = visibleEntries.find((node) => node.id === (cursor ?? selection?.id))?.id ?? visibleEntries[0]?.id;

  function readResultFocus() {
    const list = listRef.current;
    const focus = document.activeElement;
    const row = focus?.closest<HTMLElement>("[data-virtual-row]");
    const focusedIndex = row && list?.contains(row) ? Number(row.dataset.virtualRow) : null;
    const onList = list !== null && focus === list;
    const pending = onList && keyboardRow.current?.key === contentsKey ? keyboardRow.current : null;
    return { list, onList, focusedIndex, pending };
  }

  function getUnfilteredPosition(): DirectoryRefreshPosition | null {
    if (filtering || loading || !ready || reveal || contentsFocusOrigin || folderFocus.current || returningEntry.current
      || !location || !page || page.parent.id !== location.root.id) return null;
    const { pending, focusedIndex } = readResultFocus();
    if (pending?.refreshPage && pending.refreshPage !== page) return null;
    const keyboardIndex = pending?.index ?? focusedIndex;
    const firstLoaded = Math.max(first, offset);
    if (keyboardIndex === null && firstLoaded >= first + viewport.capacity) return null;
    const index = keyboardIndex ?? firstLoaded;
    const entry = page.children[index - offset];
    if (!entry) return null;
    return {
      siteId: location.site_id,
      targetSiteId: location.coverage_target?.id ?? null,
      nodeId: location.root.id,
      childId: entry.id,
      index,
      total,
    };
  }

  function receiveRefresh({ previousIndex, index, previousTotal, page: nextPage, missingEntry }: DirectoryRefresh) {
    if (reveal || loading || folderFocus.current) return;
    const total = nextPage.total_children;
    const { list, onList, focusedIndex, pending } = readResultFocus();
    const newerIndex = pending?.index ?? focusedIndex;
    if (newerIndex !== null && newerIndex !== previousIndex) {
      const insideWindow = newerIndex >= start && newerIndex < end;
      onLoadRange(insideWindow ? start : newerIndex, insideWindow ? end : newerIndex + 1, newerIndex);
      return false;
    }
    const ownsFocusedRow = focusedIndex === previousIndex;
    setMissingRefreshKey(missingEntry && ownsFocusedRow ? contentsKey : null);
    if (!total) {
      keyboardRow.current = null;
      if (ownsFocusedRow || onList) {
        (filtering ? searchInput.current : headingRef.current)?.focus({ preventScroll: true });
      }
      return;
    }
    if (ownsFocusedRow && (index !== previousIndex || missingEntry)) {
      list?.focus({ preventScroll: true });
      keyboardRow.current = { key: contentsKey, index, refreshPage: nextPage, preventScroll: true };
    } else if (pending) {
      keyboardRow.current = { key: contentsKey, index, refreshPage: nextPage, preventScroll: true };
    }
    if (index !== previousIndex || total !== previousTotal) {
      const saved = scrollPositions.get(contentsKey) ?? first;
      const keepEnd = saved === "end" && total - index <= previousTotal - previousIndex;
      const position = keepEnd ? "end" : Math.max(0, (saved === "end" ? first : saved) + index - previousIndex);
      setRefreshReveal({
        key: contentsKey, page: nextPage, index, position,
        onApplied: () => setRefreshReveal((current) => current?.page === nextPage ? null : current),
      });
    }
  }

  function activate(node: StorageNode, origin: HTMLElement, fromPointer: boolean) {
    folderFocus.current = null;
    if (node.kind !== "file" && node.kind !== "smaller_items") {
      origin.focus({ preventScroll: true });
      folderFocus.current = { folder: node.id, origin, fromPointer };
    }
    onSelect(node);
  }

  function closeSearch() {
    searchFocus.current = "trigger";
    setMissingRefreshKey(null);
    onSearchChange(null);
  }

  function goUp(pointerButton?: HTMLButtonElement) {
    if (!parent || loading) return;
    pointerButton?.focus({ preventScroll: true });
    const origin = pointerButton ?? document.activeElement;
    // Keep a clicked Up button ready to climb again until it disappears at the site root.
    folderFocus.current = !pointerButton || location?.breadcrumbs.length === 2
      ? { folder: parent.id, row: directoryId, origin, fromPointer: Boolean(pointerButton) } : null;
    const keyboardOrigin = !pointerButton && origin instanceof HTMLElement && scrollPane.current?.contains(origin) ? origin : undefined;
    onGoUp(keyboardOrigin);
  }

  function retryDirectory() {
    const pane = scrollPane.current;
    const list = listRef.current;
    const pending = keyboardRow.current;
    folderFocus.current = null;
    if (pane && list && total) {
      const index = pending?.key === contentsKey && pending.index >= first && pending.index < first + viewport.capacity
        ? pending.index : first;
      keyboardRow.current = { key: contentsKey, index, preventScroll: true, retryPosition: { top: pane.scrollTop, total } };
      list.focus({ preventScroll: true });
    } else {
      keyboardRow.current = null;
      if (pane && returnEntryId) {
        // The filtered window is still empty while the file's anchored read is retried.
        returningEntry.current = { id: returnEntryId };
        pane.focus({ preventScroll: true });
      } else {
        (searchInput.current ?? headingRef.current)?.focus({ preventScroll: true });
      }
    }
    onRetry();
  }

  function moveRow(event: KeyboardEvent<HTMLElement>, node?: StorageNode, index?: number) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const pending = keyboardRow.current;
    const cursorIndex = index ?? (pending?.key === contentsKey ? pending.index : undefined);
    const current = cursorIndex ?? firstVisibleRow;
    let target: number;
    switch (event.key) {
      case "ArrowDown": target = cursorIndex === undefined ? current : current + 1; break;
      case "ArrowUp": target = cursorIndex === undefined ? current : current - 1; break;
      case "Home": target = 0; break;
      case "End": target = total - 1; break;
      case "PageDown": target = current + viewport.capacity; break;
      case "PageUp": target = current - viewport.capacity; break;
      case "ArrowLeft":
        event.preventDefault();
        keyboardRow.current = null;
        goUp();
        return;
      case "ArrowRight":
        if (node) {
          event.preventDefault();
          activate(node, event.currentTarget, false);
        }
        return;
      default: return;
    }
    event.preventDefault();
    target = Math.min(total - 1, Math.max(0, target));
    if (target === index || loading) return;
    const row = listRef.current?.querySelector<HTMLButtonElement>(`[aria-rowindex="${target + 1}"] [data-entry-id]`);
    if (row) {
      keyboardRow.current = null;
      row.focus();
    } else {
      keyboardRow.current = { key: contentsKey, index: target };
      listRef.current?.focus({ preventScroll: true });
      viewport.scrollToRow(target);
    }
  }

  return (
    <section className="atlas-directory" aria-labelledby={labelId} onBlurCapture={(event) => {
      if (event.target === folderFocus.current?.origin && event.relatedTarget && event.relatedTarget !== listRef.current) {
        folderFocus.current = null;
      }
    }} onKeyDown={(event) => {
      if (!event.defaultPrevented && parent && event.key === "ArrowUp" && (event.altKey || event.metaKey)
        && event.target instanceof Element && !event.target.closest("input, textarea, select, dialog, [contenteditable]")) {
        event.preventDefault();
        goUp();
        return;
      }
      if (!searchOpen || event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    }}>
      <header className="atlas-directory-header">
        {parent && (
          <button
            className="atlas-directory-up" type="button" aria-disabled={loading || undefined}
            aria-label={`Up to ${parent.name}`} title={`Up to ${parent.name}`}
            onClick={(event) => goUp(event.detail === 0 ? undefined : event.currentTarget)}
          >
            <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 14V4m-4 5 4-5 4 5" />
            </svg>
          </button>
        )}
        <div className="atlas-directory-heading">
          <h2 id={labelId} ref={headingRef} tabIndex={-1} title={location.root.name}>{location.root.name || "Contents"}</h2>
          {filtering && !loading && !error && (
            <span className="atlas-directory-total" role="status">
              {missingRefreshKey === contentsKey ? "Previous match unavailable" : `${formatCount(total)} ${total === 1 ? "match" : "matches"}`}
            </span>
          )}
          {!filtering && (total > 0 || missingRefreshKey === contentsKey) && (
            <span className="atlas-directory-total" role={missingRefreshKey === contentsKey ? "status" : undefined}>
              {missingRefreshKey === contentsKey ? "Previous entry unavailable" : `${formatCount(total)} ${total === 1 ? "entry" : "entries"}`}
            </span>
          )}
        </div>
        <FolderOpenControl node={location.root} onOpen={onOpenFolder} />
        {directoryTotal > 1 && <DirectorySortControl key={location.root.id} sort={sort} onChange={onSort} />}
        {directoryTotal > 0 && !searchOpen && !onRestoreSearch && !awaitingInventory && (
          <button
            type="button" className="atlas-directory-search-toggle" ref={searchTrigger}
            aria-label="Search this folder" title="Search this folder"
            onClick={() => {
              searchFocus.current = "input";
              onSearchChange("");
            }}
          >
            <SearchIcon width="16" height="16" />
          </button>
        )}
        {onRestoreSearch && (
          <div className="atlas-directory-search-pause">
            <span role="status">Search paused</span>
            <button type="button" className="atlas-text-button" onClick={() => {
              searchFocus.current = "input";
              onRestoreSearch();
            }}>Restore search</button>
          </div>
        )}
        {searchOpen && (
          <div className="atlas-directory-search-row">
            <input
              type="search" ref={searchInput} aria-label="Find in folder" placeholder="Find by name"
              autoComplete="off" spellCheck={false} value={searchText}
              onChange={(event) => {
                setMissingRefreshKey(null);
                onSearchChange(event.currentTarget.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey || loading || error) return;
                const row = listRef.current?.querySelector<HTMLButtonElement>(`[aria-rowindex="${firstVisibleRow + 1}"] [data-entry-id]`);
                if (row) {
                  event.preventDefault();
                  row.focus();
                }
              }}
            />
            <button type="button" onClick={closeSearch} aria-label="Close search" title="Close search"><CloseIcon /></button>
          </div>
        )}
      </header>

      <div role="region" aria-label="Directory entries" aria-busy={loading || loadingMore || undefined}>
        {total > 0 ? (
          <ul
            className="atlas-directory-list" ref={listRef} role="grid" tabIndex={-1} style={{ height: viewport.trackHeight }}
            aria-label={`${location.root.name} entries`} aria-rowcount={total}
            aria-description="Use Up and Down to move between entries, Enter to open, and Left to return to the parent."
            onKeyDown={(event) => { if (event.target === event.currentTarget) moveRow(event); }}
          >
            {visible.map(({ index, node }) => {
              const style = { top: viewport.rowTop(index) };
              if (!node) return <li key={index} style={style} className="atlas-directory-placeholder" aria-hidden="true" role="presentation" />;
              const isFile = node.kind === "file";
              return (
                <li key={node.id} style={style} role="row" data-virtual-row={index}
                  aria-rowindex={index + 1} aria-selected={isFile ? selection?.id === node.id : undefined}>
                  <div role="gridcell" data-openable={canOpenFolder(node) || undefined} onFocus={() => {
                    if (cursor === node.id) return;
                    cursorPositions.set(contentsKey, node.id);
                    setFocusedCursor({ key: contentsKey, id: node.id });
                  }}>
                    <button
                      type="button"
                      className="atlas-directory-entry"
                      {...rowPreview.bind(node)}
                      data-entry-id={node.id}
                      tabIndex={tabStop === node.id ? 0 : -1}
                      onKeyDown={(event) => moveRow(event, node, index)}
                      onClick={(event) => activate(node, event.currentTarget, event.detail !== 0)}
                    >
                      <DirectoryEntryLabel node={node} awaitingInventory={awaitingInventory} showDate={sort.field === "date"} />
                    </button>
                    <FolderOpenControl node={node} onOpen={onOpenFolder} tabIndex={tabStop === node.id ? 0 : -1} />
                  </div>
                </li>
              );
            })}
          </ul>
        ) : !error && (
          <p className="atlas-directory-status" role="status">
            {filtering
              ? loading ? "Searching folder…" : "No matching files or folders."
              : loading ? "Reading directory…" : awaitingInventory ? "Waiting for the first inventory." : "This directory is empty."}
          </p>
        )}
        {error && (
          <div className="atlas-directory-feedback">
            <div className="atlas-directory-status" role="alert">
              <span>{error}</span>
              <button ref={retryButton} type="button" className="atlas-text-button" onClick={retryDirectory}>Retry</button>
            </div>
          </div>
        )}
      </div>
      {rowPreview.card}
    </section>
  );
}
