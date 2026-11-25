import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { formatCount } from "../lib/format";
import type { DirectorySort, FolderOpenDestination, HealthMetric, StorageChildrenPage, StorageLocation, StorageNode } from "../lib/types";
import { CloseIcon, SearchIcon } from "../management/Icons";
import { DirectorySortControl } from "./DirectorySortControl";
import { canOpenFolder, FolderOpenControl } from "./FolderOpenControl";
import { DirectoryEntryLabel, useDirectoryPreview } from "./useDirectoryPreview";
import { useDirectoryViewport } from "./useDirectoryViewport";
import "./directory.css";

interface DirectoryContentsProps {
  location: StorageLocation | null;
  page: StorageChildrenPage | null;
  directoryTotal: number;
  searchText: string | null;
  onSearchChange: (text: string | null) => void;
  selection: StorageNode | null;
  sort: DirectorySort;
  onSort: (sort: DirectorySort) => Promise<void>;
  metric: HealthMetric | null;
  targetCompleteness: number;
  scrollPane: RefObject<HTMLDivElement | null>;
  scrollPositions: Map<string, number | "end">;
  contentsKey: string;
  anchorIndex: number;
  returnFileId: string | null;
  active: boolean;
  loading: boolean;
  loadingMore: boolean;
  awaitingInventory: boolean;
  error: string | null;
  onSelect: (node: StorageNode) => void;
  onOpenFolder: (node: StorageNode, destination: FolderOpenDestination) => Promise<void>;
  onGoUp: () => void;
  onLoadRange: (start: number, end: number) => void;
  onRetry: () => void;
}

export function DirectoryContents({
  location, page, directoryTotal, searchText, onSearchChange, selection, sort, onSort, metric, targetCompleteness,
  scrollPane, scrollPositions, contentsKey, anchorIndex, returnFileId,
  active, loading, loadingMore, awaitingInventory, error, onSelect, onOpenFolder, onGoUp, onLoadRange, onRetry,
}: DirectoryContentsProps) {
  const labelId = useId();
  const searchTrigger = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchFocus = useRef<"input" | "trigger" | null>(null);
  const searchOpen = searchText !== null;
  const filtering = Boolean(searchText?.trim());
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const keyboardFolder = useRef<{ folder: string; row?: string } | null>(null);
  const keyboardRow = useRef<{ key: string; index: number } | null>(null);
  const returningFile = useRef<string | null>(null);
  const directoryId = location?.root.id;
  const total = page?.total_children ?? 0;
  const offset = page?.offset ?? 0;
  const viewport = useDirectoryViewport({ contentsKey, anchorIndex, total, active, scrollPane, scrollPositions });
  const { listRef, first, start, end, ready } = viewport;
  const rowPreview = useDirectoryPreview({
    root: location?.root, entries: page?.children, metric, targetCompleteness, awaitingInventory, active, contentsKey, scrollPane,
  });

  useLayoutEffect(() => {
    if (!active || searchFocus.current !== (searchOpen ? "input" : "trigger")) return;
    searchFocus.current = null;
    (searchOpen ? searchInput.current : searchTrigger.current)?.focus({ preventScroll: true });
  }, [searchOpen, active]);

  useEffect(() => {
    if (!active || !ready || loading || !page || end <= start) return;
    if (end <= offset || start >= offset + page.children.length) {
      // Let a thumb drag cross distant ranges without reading every folder slice along its path.
      const timer = window.setTimeout(() => onLoadRange(start, end), 60);
      return () => window.clearTimeout(timer);
    }
    onLoadRange(start, end);
  }, [active, ready, loading, start, end, page, offset, onLoadRange]);

  useEffect(() => {
    returningFile.current = active ? returnFileId : null;
  }, [active, returnFileId, contentsKey]);

  useEffect(() => {
    const fileId = returningFile.current;
    const pane = scrollPane.current;
    if (!fileId || !pane || !ready) return;
    const tab = document.getElementById(pane.getAttribute("aria-labelledby") ?? "");
    if (document.activeElement === pane || document.activeElement === tab) {
      const row = listRef.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(fileId)}"]`);
      if (!row) return;
      row.focus({ preventScroll: true });
    }
    returningFile.current = null;
  }, [active, returnFileId, ready, page, start, end, listRef, scrollPane]);

  useLayoutEffect(() => {
    if (!active || loading) return;
    const destination = keyboardFolder.current;
    const pending = keyboardRow.current;
    if (!pending && !destination) return;
    const pane = scrollPane.current;
    if (!pane || (document.activeElement !== document.body && !pane.contains(document.activeElement))) {
      keyboardRow.current = null;
      keyboardFolder.current = null;
      return;
    }
    if (destination && destination.folder !== directoryId) {
      keyboardFolder.current = null;
      return;
    }
    if (pending && (pending.key !== contentsKey || error)) {
      keyboardRow.current = null;
      return;
    }
    if (!ready && total) return;
    const parentEntry = destination?.row
      ? listRef.current?.querySelector<HTMLButtonElement>(`[data-entry-id="${CSS.escape(destination.row)}"]`) : null;
    const row = parentEntry ?? listRef.current?.querySelector<HTMLButtonElement>(`[aria-rowindex="${(pending?.index ?? first) + 1}"] [data-entry-id]`);
    if (row || !total || error) {
      keyboardRow.current = null;
      keyboardFolder.current = null;
      (row ?? headingRef.current)?.focus();
    }
  }, [active, contentsKey, directoryId, error, first, listRef, loading, page, ready, scrollPane, start, end, total]);

  if (!location) return null;
  const parent = location.breadcrumbs.at(-2);
  const visible = Array.from({ length: Math.max(0, end - start) }, (_, i) => {
    const index = start + i;
    return { index, node: page?.children[index - offset] };
  });
  const loaded = visible.flatMap(({ node }) => node ? [node] : []);
  const tabStop = loaded.find((node) => node.id === cursor)?.id
    ?? loaded.find((node) => node.id === selection?.id)?.id
    ?? visible.find((row) => row.index >= first && row.node)?.node?.id ?? loaded[0]?.id;

  function activate(node: StorageNode, keyboard: boolean) {
    keyboardFolder.current = keyboard && node.kind !== "file" && node.kind !== "smaller_items" ? { folder: node.id } : null;
    onSelect(node);
  }

  function closeSearch() {
    searchFocus.current = "trigger";
    onSearchChange(null);
  }

  function goUp(keyboard: boolean) {
    if (!parent || loading) return;
    keyboardFolder.current = keyboard ? { folder: parent.id, row: directoryId } : null;
    onGoUp();
  }

  function moveRow(event: KeyboardEvent<HTMLButtonElement>, node: StorageNode, index: number) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    let target = index;
    switch (event.key) {
      case "ArrowDown": target++; break;
      case "ArrowUp": target--; break;
      case "Home": target = 0; break;
      case "End": target = total - 1; break;
      case "PageDown": target += viewport.capacity; break;
      case "PageUp": target -= viewport.capacity; break;
      case "ArrowLeft": goUp(true); break;
      case "ArrowRight": activate(node, true); break;
      default: return;
    }
    event.preventDefault();
    target = Math.min(total - 1, Math.max(0, target));
    if (target === index || loading) return;
    const row = listRef.current?.querySelector<HTMLButtonElement>(`[aria-rowindex="${target + 1}"] [data-entry-id]`);
    if (row) row.focus();
    else {
      keyboardRow.current = { key: contentsKey, index: target };
      scrollPane.current?.focus({ preventScroll: true });
      viewport.scrollToRow(target);
    }
  }

  return (
    <section className="atlas-directory" aria-labelledby={labelId} onKeyDown={(event) => {
      if (!searchOpen || event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    }}>
      <header className="atlas-directory-header">
        {parent && (
          <button
            className="atlas-directory-up" type="button" disabled={loading}
            aria-label={`Up to ${parent.name}`} title={`Up to ${parent.name}`}
            onClick={(event) => goUp(event.detail === 0)}
          >
            <svg viewBox="0 0 18 18" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M9 14V4m-4 5 4-5 4 5" />
            </svg>
          </button>
        )}
        <div className="atlas-directory-heading">
          <h2 id={labelId} ref={headingRef} tabIndex={-1} title={location.root.name}>{location.root.name || "Contents"}</h2>
          {filtering && !loading && !error && (
            <span className="atlas-directory-total" role="status">{formatCount(total)} {total === 1 ? "match" : "matches"}</span>
          )}
          {!filtering && total > 0 && <span className="atlas-directory-total">{formatCount(total)} {total === 1 ? "entry" : "entries"}</span>}
        </div>
        <FolderOpenControl node={location.root} onOpen={onOpenFolder} />
        {directoryTotal > 1 && <DirectorySortControl key={location.root.id} sort={sort} onChange={onSort} />}
        {directoryTotal > 0 && !searchOpen && !awaitingInventory && (
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
        {searchOpen && (
          <div className="atlas-directory-search-row">
            <input
              type="search" ref={searchInput} aria-label="Find in folder" placeholder="Find by name"
              autoComplete="off" spellCheck={false} value={searchText}
              onChange={(event) => onSearchChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" || event.altKey || event.ctrlKey || event.metaKey || loading || error) return;
                const row = listRef.current?.querySelector<HTMLButtonElement>(`[aria-rowindex="${first + 1}"] [data-entry-id]`);
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
            className="atlas-directory-list" ref={listRef} role="grid" style={{ height: viewport.trackHeight }}
            aria-label={`${location.root.name} entries`} aria-rowcount={total}
            aria-description="Use Up and Down to move between entries, Enter to open, and Left to return to the parent."
          >
            {visible.map(({ index, node }) => {
              const style = { top: viewport.rowTop(index) };
              if (!node) return <li key={index} style={style} className="atlas-directory-placeholder" aria-hidden="true" role="presentation" />;
              const isFile = node.kind === "file";
              return (
                <li key={node.id} style={style} role="row" aria-rowindex={index + 1} aria-selected={isFile ? selection?.id === node.id : undefined}>
                  <div role="gridcell" data-openable={canOpenFolder(node) || undefined} onFocus={() => setCursor(node.id)}>
                    <button
                      type="button"
                      className="atlas-directory-entry"
                      {...rowPreview.bind(node)}
                      data-entry-id={node.id}
                      tabIndex={tabStop === node.id ? 0 : -1}
                      onKeyDown={(event) => moveRow(event, node, index)}
                      onClick={(event) => activate(node, event.detail === 0)}
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
              <button type="button" className="atlas-text-button" onClick={onRetry}>Retry</button>
            </div>
          </div>
        )}
      </div>
      {rowPreview.card}
    </section>
  );
}
