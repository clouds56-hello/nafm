import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { formatBytes, formatCount } from "../lib/format";
import type { FinderPosition, IndexedFileSearchResult } from "../lib/types";
import { FolderIcon, OpenInIcon, SearchIcon } from "../management/Icons";
import { AnalysisDialog } from "./analysis/AnalysisDialog";
import { AnalysisError } from "./analysis/AnalysisPageControls";
import { useAnalysisNavigation } from "./analysis/useAnalysisNavigation";
import { useDirectoryViewport } from "./useDirectoryViewport";
import { useIndexedFileSearch, type FinderRefresh, type FinderSearchCache } from "./useIndexedFileSearch";
import "./file-finder.css";

interface FileFinderProps {
  workspace: string;
  contentRevision: number;
  session: symbol;
  position: FinderPosition | null;
  open: boolean;
  onOpen: (file: IndexedFileSearchResult, signal: AbortSignal, position: FinderPosition) => Promise<string | null>;
  onOpened: (file: IndexedFileSearchResult, position: FinderPosition) => void;
  onClose: () => void;
}

interface FinderChoice {
  file: IndexedFileSearchResult;
  position: FinderPosition;
}

function FinderResultPath({ path }: { path: string }) {
  // Use the original characters for display, including drive roots and SMB URLs.
  const separators = path.startsWith("/") || path.includes("://") ? path : path.replaceAll("\\", "/");
  const end = separators.lastIndexOf("/");
  const start = end > 0 ? separators.lastIndexOf("/", end - 1) + 1 : 0;
  const ancestors = path.slice(0, start);
  const folder = start ? path.slice(start, end) : path.slice(0, end + 1);
  return (
    <small className="atlas-finder-path" title={path}>
      <span className="atlas-finder-full-path">{path}</span>
      <span className="atlas-finder-folder" aria-hidden="true">{folder && <FolderIcon />}<span>{folder || path}</span></span>
      {ancestors && <span className="atlas-finder-ancestors" aria-hidden="true"><bdi dir="ltr">{ancestors}</bdi></span>}
    </small>
  );
}

export function FileFinder({ open, ...props }: FileFinderProps) {
  const { workspace, session } = props;
  const cache = useMemo<FinderSearchCache>(() => new Map(), [workspace, session]);
  if (!open) return null;
  return <FileFinderDialog {...props} cache={cache} />;
}

interface FileFinderDialogProps extends Omit<FileFinderProps, "open"> {
  cache: FinderSearchCache;
}

function FileFinderDialog({ workspace, contentRevision, session, position, cache, onOpen, onOpened, onClose }: FileFinderDialogProps) {
  const search = useIndexedFileSearch(
    workspace, contentRevision, position?.query ?? "", position?.row_index ?? 0, cache, position?.file_id, receiveRefresh,
  );
  const total = search.locatingFile ? 0 : search.total ?? 0;
  const input = useRef<HTMLInputElement>(null);
  const scrollPane = useRef<HTMLDivElement>(null);
  const [scrollPositions] = useState(() => new Map<string, number | "end">(position ? [[search.key, position.scroll_position]] : []));
  const [refreshReveal, setRefreshReveal] = useState<{ key: string; index: number; onApplied: () => void } | null>(null);
  const [missingRefreshKey, setMissingRefreshKey] = useState<string | null>(null);
  const anchorApplied = useRef(false);
  const restoredIndex = search.anchorIndex ?? Math.min(position?.row_index ?? 0, Math.max(0, total - 1));

  useLayoutEffect(() => {
    if (!position || search.anchorIndex === undefined || anchorApplied.current || !total) return;
    anchorApplied.current = true;
    // Preserve the row's relative offset, or keep the scrollbar at the end if the same tail still follows it.
    const top = position.scroll_position === "end"
      ? total - restoredIndex <= position.result_count - position.row_index ? "end" : restoredIndex
      : Math.max(0, position.scroll_position + restoredIndex - position.row_index);
    scrollPositions.set(search.key, top);
  }, [position, restoredIndex, scrollPositions, search.anchorIndex, search.key, total]);

  const viewport = useDirectoryViewport({
    contentsKey: search.key, anchorIndex: 0, total, active: total > 0, scrollPane, scrollPositions,
    rowHeightProperty: "--finder-row-height",
    reveal: refreshReveal?.key === search.key ? refreshReveal : undefined,
  });
  const { listRef, first, start, end, ready, capacity, focusStart, focusEnd } = viewport;
  const [cursor, setCursor] = useState<{ key: string; index: number } | null>(null);
  const pendingFocus = useRef<{ key: string; index: number | null; scrollTop: number | null; requireVisible?: boolean } | null>(null);
  const restoring = useRef<FinderPosition | null>(null);
  const navigation = useAnalysisNavigation(
    ({ file, position }: FinderChoice, signal) => onOpen(file, signal, position),
    onClose,
    ({ file, position }) => onOpened(file, position),
  );

  useLayoutEffect(() => {
    // The modal re-applies its initial input focus when mount effects are replayed.
    restoring.current = position;
  }, [position]);

  useLayoutEffect(() => {
    if (!ready || end <= start) return;
    const list = listRef.current;
    const active = document.activeElement;
    const pending = active === list && pendingFocus.current?.key === search.key ? pendingFocus.current.index : null;
    const row = active?.closest<HTMLElement>("[data-virtual-row]");
    const focusedIndex = row && list?.contains(row) ? Number(row.dataset.virtualRow) : null;
    const preferred = pending ?? focusedIndex ?? first;
    search.loadRange(start, end, preferred >= start && preferred < end ? preferred : first);
  }, [ready, first, start, end, cursor, listRef, search.key, search.refreshing, search.loadRange]);

  useLayoutEffect(() => {
    const saved = restoring.current;
    if (!saved || search.locatingFile) return;
    if (document.activeElement !== input.current) {
      restoring.current = null;
      return;
    }
    if (search.total === 0) {
      restoring.current = null;
      return;
    }
    if (!ready || !scrollPane.current) return;
    const row = listRef.current?.querySelector<HTMLButtonElement>(search.anchorIndex === null
      ? `[data-virtual-row="${restoredIndex}"] button` : 'button[aria-current="true"]');
    if (!row) {
      if (restoredIndex < start || restoredIndex >= end) viewport.scrollToRow(restoredIndex);
      return;
    }
    restoring.current = null;
    row.focus({ preventScroll: true });
    const bounds = scrollPane.current.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    if (rowBounds.top < bounds.top - 1 || rowBounds.bottom > bounds.bottom + 1) row.scrollIntoView({ block: "nearest" });
  }, [ready, start, end, restoredIndex, search.anchorIndex, search.locatingFile, search.total, search.fileAt, listRef, viewport.scrollToRow]);

  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    if (pending.key !== search.key || document.activeElement !== listRef.current) {
      pendingFocus.current = null;
      return;
    }
    if (!ready) return;
    const target = pending.index ?? first;
    if (pending.requireVisible && (target < focusStart || target >= focusEnd)) {
      pendingFocus.current = null;
      return;
    }
    if (target < start || target >= end) {
      if (pending.scrollTop !== null && scrollPane.current?.scrollTop !== pending.scrollTop) pendingFocus.current = null;
      return;
    }
    const row = listRef.current?.querySelector<HTMLButtonElement>(`[data-virtual-row="${target}"] button`);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: true });
    }
  }, [ready, first, start, end, focusStart, focusEnd, search.key, search.fileAt, listRef]);

  function receiveRefresh({ key, previousIndex, index, previousTotal, total, missingFile }: FinderRefresh) {
    const list = listRef.current;
    const active = document.activeElement;
    const row = active?.closest<HTMLElement>("[data-virtual-row]");
    const focusedIndex = row && list?.contains(row) ? Number(row.dataset.virtualRow) : null;
    const pending = active === list && pendingFocus.current?.key === key ? pendingFocus.current : null;
    const newerIndex = pending?.index ?? focusedIndex;
    if (newerIndex !== null && newerIndex !== previousIndex) {
      const insideViewport = newerIndex >= start && newerIndex < end;
      search.loadRange(insideViewport ? start : newerIndex, insideViewport ? end : newerIndex + 1, newerIndex);
      return false;
    }
    const ownsFocusedRow = focusedIndex === previousIndex;
    setMissingRefreshKey(missingFile && ownsFocusedRow ? key : null);

    if (!total) {
      pendingFocus.current = null;
      if (ownsFocusedRow || active === list) input.current?.focus({ preventScroll: true });
      return;
    }

    if (ownsFocusedRow && (index !== previousIndex || missingFile)) {
      list?.focus({ preventScroll: true });
      pendingFocus.current = { key, index, scrollTop: null };
    } else if (pending) {
      pendingFocus.current = { key, index, scrollTop: null };
    }

    if (index !== previousIndex || total !== previousTotal) {
      const saved = scrollPositions.get(key) ?? first;
      const keepEnd = saved === "end" && previousTotal !== null && total - index <= previousTotal - previousIndex;
      const next = keepEnd ? "end" : Math.max(0, (saved === "end" ? first : saved) + index - previousIndex);
      scrollPositions.set(key, next);
      setRefreshReveal({ key, index, onApplied: () => setRefreshReveal(null) });
    }
  }

  const entries = Array.from({ length: Math.max(0, end - start) }, (_, offset) => {
    const index = start + offset;
    return { index, file: search.fileAt(index) };
  });
  const tabStop = entries.find(({ index, file }) =>
    file && cursor?.key === search.key && cursor.index === index && index >= first && index < first + capacity,
  )?.index ?? entries.find(({ index, file }) => file && index >= first)?.index;

  function focusResult(index: number, { keepViewport = false } = {}) {
    if (!total || navigation.opening) return;
    restoring.current = null;
    const target = Math.min(total - 1, Math.max(0, index));
    const row = listRef.current?.querySelector<HTMLButtonElement>(`[data-virtual-row="${target}"] button`);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: keepViewport });
    } else {
      listRef.current?.focus({ preventScroll: true });
      if (!keepViewport) viewport.scrollToRow(target);
      pendingFocus.current = {
        key: search.key, index: target, scrollTop: scrollPane.current?.scrollTop ?? 0, requireVisible: keepViewport,
      };
    }
  }

  function enterVisibleResults() {
    const firstVisible = ready && focusStart < focusEnd ? focusStart : first;
    const visibleCursor = ready && cursor?.key === search.key && cursor.index >= focusStart && cursor.index < focusEnd
      ? cursor.index : firstVisible;
    focusResult(visibleCursor, { keepViewport: true });
  }

  function moveResult(event: KeyboardEvent<HTMLElement>, index?: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || navigation.opening) return;
    const pending = pendingFocus.current;
    const current = index ?? (pending?.key === search.key ? pending.index ?? undefined : undefined);
    let target: number;
    switch (event.key) {
      case "ArrowUp":
        if (current === 0) {
          event.preventDefault();
          pendingFocus.current = null;
          input.current?.focus();
          return;
        }
        target = current === undefined ? first : current - 1;
        break;
      case "ArrowDown": target = current === undefined ? first : current + 1; break;
      case "Home": target = 0; break;
      case "End": target = total - 1; break;
      case "PageUp": target = (current ?? first) - capacity; break;
      case "PageDown": target = (current ?? first) + capacity; break;
      default: return;
    }
    event.preventDefault();
    focusResult(target);
  }

  function openFile(file: IndexedFileSearchResult, index: number, scrollPosition = scrollPositions.get(search.key) ?? index) {
    restoring.current = null;
    void navigation.show({
      file,
      position: {
        session, content_revision: search.resultRevision, query: search.query, file_id: file.file_id, row_index: index,
        scroll_position: scrollPosition, result_count: total,
      },
    });
  }

  function cancelOpen() {
    const choice = navigation.match;
    navigation.cancel();
    if (!choice) return;
    const index = choice.position.row_index;
    const visibleChoice = index >= viewport.focusStart && index < viewport.focusEnd
      && search.fileAt(index)?.file_id === choice.file.file_id;
    const target = visibleChoice ? index : viewport.focusStart;
    const list = listRef.current;
    const row = list?.querySelector<HTMLButtonElement>(`[data-virtual-row="${target}"] button`);
    (row ?? list ?? input.current)?.focus({ preventScroll: true });
  }

  function keepSearchFocus() {
    // The saved result can still load while the user edits its search.
    restoring.current = null;
  }

  function retrySearch() {
    const list = listRef.current;
    if (total && list) {
      list.focus({ preventScroll: true });
      pendingFocus.current = { key: search.key, index: null, scrollTop: scrollPane.current?.scrollTop ?? 0 };
    } else {
      input.current?.focus({ preventScroll: true });
    }
    search.retry();
  }

  const matches = search.name && search.total !== null ? `${formatCount(total)} ${total === 1 ? "match" : "matches"}` : "";
  const status = navigation.opening ? "Opening file…"
    : search.locatingFile ? search.loading ? "Locating previous result…" : ""
      : search.loading && search.total === null ? "Searching…"
        : matches;

  return (
    <AnalysisDialog
      title="Find files" subtitle={workspace} className="atlas-file-finder" onClose={navigation.close} initialFocus={input}
      bodyRef={scrollPane}
      toolbar={
        <div className="atlas-finder-toolbar">
          <div className="atlas-finder-field">
            <SearchIcon />
            <input
              ref={input} type="search" aria-label="File name" autoComplete="off" spellCheck={false}
              placeholder="Search by file name" value={search.query} readOnly={navigation.opening}
              onPointerDown={keepSearchFocus}
              onCompositionStart={keepSearchFocus}
              onChange={(event) => {
                keepSearchFocus();
                const text = event.currentTarget.value;
                setMissingRefreshKey(null);
                if (text.trim() !== search.name || search.locatingFile) {
                  pendingFocus.current = null;
                  scrollPositions.clear();
                  if (scrollPane.current) scrollPane.current.scrollTop = 0;
                }
                search.changeQuery(text);
                navigation.clearError();
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                keepSearchFocus();
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  navigation.close();
                  return;
                }
                if (!total || navigation.opening || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  enterVisibleResults();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const top = search.fileAt(0);
                  if (top) openFile(top, 0, 0);
                  else focusResult(0);
                }
              }}
            />
          </div>
          <span className="atlas-finder-count" role="status">{status}</span>
          {(search.anchorIndex === null || missingRefreshKey === search.key) && (
            <span className="atlas-finder-feedback atlas-finder-count" role="status">The previous file is no longer in these results.</span>
          )}
          {search.error && <div className="atlas-finder-feedback">
            <AnalysisError error={search.error} retry={retrySearch} />
          </div>}
        </div>
      }
      footer={navigation.match && (
        <div className="atlas-finder-open-feedback">
          <div role={navigation.error ? "alert" : undefined}>
            <strong title={navigation.match.file.name}>{navigation.match.file.name}</strong>
            {navigation.error && <p className="atlas-finder-error">{navigation.error}</p>}
          </div>
          <button type="button" onClick={navigation.opening ? cancelOpen : navigation.retry}>
            {navigation.opening ? "Cancel opening" : "Retry opening"}
          </button>
        </div>
      )}
    >
      <section className="atlas-analysis-results" aria-label="File search results" aria-busy={search.loading || undefined}>
        {!search.name && <p>Search indexed files across all sites in this workspace.</p>}
        {search.name && !search.loading && !search.error && search.total === 0 && <p>No indexed files match this name.</p>}
        {total > 0 && (
          <ul
            ref={listRef} className="atlas-analysis-list atlas-finder-results" role="list" aria-label="Matching files"
            tabIndex={tabStop === undefined ? 0 : -1} style={{ height: viewport.trackHeight }}
            onKeyDown={(event) => { if (event.target === event.currentTarget) moveResult(event); }}
            onBlur={(event) => {
              if (event.target === event.currentTarget && !event.currentTarget.contains(event.relatedTarget)) {
                pendingFocus.current = null;
              }
            }}
          >
            {entries.map(({ file, index }) => {
              const style = { top: viewport.rowTop(index) };
              if (!file) return <li key={index} className="atlas-finder-placeholder" aria-hidden="true" style={style} />;
              return (
                <li key={file.file_id} data-virtual-row={index} aria-posinset={index + 1} aria-setsize={total} style={style}>
                  <button
                    className="atlas-analysis-row atlas-finder-result" type="button"
                    tabIndex={index === tabStop ? 0 : -1}
                    aria-current={(file.file_id === position?.file_id && position.query === search.query) || undefined}
                    aria-disabled={navigation.opening || undefined}
                    onFocus={() => setCursor((current) =>
                      current?.key === search.key && current.index === index ? current : { key: search.key, index })}
                    onClick={navigation.opening ? undefined : () => openFile(file, index)}
                    onKeyDown={(event) => moveResult(event, index)}
                  >
                    <span className="atlas-finder-location">
                      <strong title={file.name}>{file.name}</strong>
                      <span className="atlas-finder-site" title={file.site_name}>{file.site_name}</span>
                      <FinderResultPath path={file.path} />
                    </span>
                    <span className="atlas-finder-file-info">
                      <span>{formatBytes(file.size_bytes)}</span>
                      <small data-verified={file.verified || undefined}>{file.verified ? "Verified" : "Hash pending"}</small>
                    </span>
                    <OpenInIcon />
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </AnalysisDialog>
  );
}
