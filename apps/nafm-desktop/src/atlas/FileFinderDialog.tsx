import { useEffect, useLayoutEffect, useMemo, useRef, type KeyboardEvent } from "react";
import { formatBytes, formatCount } from "../lib/format";
import type { FinderPosition, IndexedFileSearchResult } from "../lib/types";
import { OpenInIcon, SearchIcon } from "../management/Icons";
import { AnalysisDialog } from "./analysis/AnalysisDialog";
import { AnalysisError } from "./analysis/AnalysisPageControls";
import { useAnalysisNavigation } from "./analysis/useAnalysisNavigation";
import { useIndexedFileSearch, type FinderSearchResult } from "./useIndexedFileSearch";
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

export function FileFinder({ open, ...props }: FileFinderProps) {
  const { workspace, session, contentRevision } = props;
  const cache = useMemo(() => new Map<string, FinderSearchResult>(), [workspace, session, contentRevision]);
  if (!open) return null;
  return <FileFinderDialog {...props} cache={cache} />;
}

interface FileFinderDialogProps extends Omit<FileFinderProps, "open"> {
  cache: Map<string, FinderSearchResult>;
}

function FileFinderDialog({ workspace, contentRevision, session, position, cache, onOpen, onOpened, onClose }: FileFinderDialogProps) {
  const search = useIndexedFileSearch(workspace, contentRevision, position?.query ?? "", cache);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const restoring = useRef<FinderPosition | null>(null);
  const navigation = useAnalysisNavigation(
    ({ file, position }: FinderChoice, signal) => onOpen(file, signal, position),
    onClose,
    ({ file, position }) => {
      search.remember();
      onOpened(file, position);
    },
  );

  useLayoutEffect(() => {
    // The modal re-applies its initial input focus when mount effects are replayed.
    restoring.current = position;
  }, [position]);

  useLayoutEffect(() => {
    pendingFocus.current = null;
    const pane = results.current?.closest(".atlas-analysis-body");
    if (pane) pane.scrollTop = 0;
  }, [contentRevision, search.name]);

  useLayoutEffect(() => {
    const saved = restoring.current;
    if (!saved) return;
    if (document.activeElement !== input.current) {
      restoring.current = null;
      return;
    }
    const row = list.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]');
    const pane = results.current?.closest(".atlas-analysis-body");
    // Let the saved pages restore the scrollable height before setting the offset.
    const needsMoreRows = search.hasMore && !search.error && search.files.length < saved.loaded_count;
    if (!row || !pane || needsMoreRows) return;

    restoring.current = null;
    pane.scrollTop = saved.scroll_top;
    row.focus({ preventScroll: true });
    const bounds = pane.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    if (rowBounds.bottom <= bounds.top || rowBounds.top >= bounds.bottom) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [search.error, search.files, search.hasMore]);

  useEffect(() => {
    const saved = restoring.current;
    if (!saved || search.loading || search.error) return;
    if (search.hasMore && search.files.length < saved.loaded_count) search.loadMore();
    else restoring.current = null;
  }, [search.loading, search.error, search.hasMore, search.files.length, search.loadMore]);

  useEffect(() => {
    const marker = sentinel.current;
    if (!marker || search.loading || search.error || navigation.opening) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some(({ isIntersecting }) => isIntersecting)) search.loadMore();
    }, { root: marker.closest(".atlas-analysis-body"), rootMargin: "0px 0px 96px 0px" });
    observer.observe(marker);
    return () => observer.disconnect();
  }, [navigation.opening, search.loading, search.error, search.loadMore]);

  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === null || search.loading) return;
    pendingFocus.current = null;
    const active = document.activeElement;
    if (active && list.current?.contains(active)) {
      list.current.querySelectorAll<HTMLButtonElement>("button")[index]?.focus();
    }
  }, [search.files.length, search.loading]);

  function moveResult(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        if (index === 0) input.current?.focus();
        else list.current?.querySelectorAll<HTMLButtonElement>("button")[index - 1]?.focus();
        break;
      case "ArrowDown":
        event.preventDefault();
        if (index + 1 < search.files.length) {
          list.current?.querySelectorAll<HTMLButtonElement>("button")[index + 1]?.focus();
        } else if (search.hasMore && !search.error) {
          pendingFocus.current = index + 1;
          search.loadMore();
        }
        break;
    }
  }

  function openFile(file: IndexedFileSearchResult) {
    restoring.current = null;
    void navigation.show({
      file,
      position: {
        session, query: search.query, file_id: file.file_id, loaded_count: search.files.length,
        scroll_top: results.current?.closest(".atlas-analysis-body")?.scrollTop ?? 0,
      },
    });
  }

  const count = search.total;
  const status = navigation.opening ? "Opening file…"
    : search.loading && !search.files.length ? "Searching…"
      : search.name && !search.error ? `${formatCount(count)} ${count === 1 ? "match" : "matches"}` : "";

  return (
    <AnalysisDialog
      title="Find files" subtitle={workspace} className="atlas-file-finder" onClose={navigation.close} initialFocus={input}
      toolbar={
        <div className="atlas-finder-toolbar">
          <div className="atlas-finder-field">
            <SearchIcon />
            <input
              ref={input} type="search" aria-label="File name" autoComplete="off" spellCheck={false}
              placeholder="Search by file name" value={search.query} readOnly={navigation.opening}
              onChange={(event) => {
                restoring.current = null;
                search.changeQuery(event.currentTarget.value);
                navigation.clearError();
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  navigation.close();
                  return;
                }
                if (!search.files.length || navigation.opening) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  restoring.current = null;
                  list.current?.querySelector("button")?.focus();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  openFile(search.files[0]);
                }
              }}
            />
          </div>
          <span className="atlas-finder-count" role="status">{status}</span>
        </div>
      }
      footer={navigation.error && <p className="atlas-finder-error" role="alert">{navigation.error}</p>}
    >
      <section ref={results} className="atlas-analysis-results" aria-label="File search results" aria-busy={search.loading || undefined}>
        {!search.name && <p>Search indexed files across all sites in this workspace.</p>}
        {search.name && !search.loading && !search.error && !search.files.length && <p>No indexed files match this name.</p>}
        {search.files.length > 0 && (
          <ul className="atlas-analysis-list atlas-finder-results" ref={list} aria-label="Matching files">
            {search.files.map((file, index) => (
              <li key={file.file_id}>
                <button
                  className="atlas-analysis-row atlas-finder-result" type="button"
                  aria-current={(file.file_id === position?.file_id && position.query === search.query) || undefined}
                  aria-disabled={navigation.opening || undefined}
                  onClick={navigation.opening ? undefined : () => openFile(file)}
                  onKeyDown={(event) => moveResult(event, index)}
                >
                  <span className="atlas-finder-location">
                    <strong>{file.name}</strong>
                    <span className="atlas-finder-site">{file.site_name}</span>
                    <small>{file.path}</small>
                  </span>
                  <span className="atlas-finder-file-info">
                    <span>{formatBytes(file.size_bytes)}</span>
                    <small data-verified={file.verified || undefined}>{file.verified ? "Verified" : "Hash pending"}</small>
                  </span>
                  <OpenInIcon />
                </button>
              </li>
            ))}
          </ul>
        )}
        {search.error && <AnalysisError error={search.error} retry={search.retry} />}
        {search.loading && search.files.length > 0 && <p role="status">Loading more matches…</p>}
        {search.hasMore && <div className="atlas-finder-sentinel" ref={sentinel} aria-hidden="true" />}
      </section>
    </AnalysisDialog>
  );
}
