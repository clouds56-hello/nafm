import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatBytes, formatCount } from "../lib/format";
import type { IndexedFileSearchResult } from "../lib/types";
import { OpenInIcon, SearchIcon } from "../management/Icons";
import { AnalysisDialog } from "./analysis/AnalysisDialog";
import { AnalysisError } from "./analysis/AnalysisPageControls";
import { useAnalysisNavigation } from "./analysis/useAnalysisNavigation";
import { useIndexedFileSearch } from "./useIndexedFileSearch";
import "./file-finder.css";

interface FileFinderProps {
  workspace: string;
  contentRevision: number;
  open: boolean;
  onOpen: (file: IndexedFileSearchResult, signal: AbortSignal) => Promise<string | null>;
  onOpened: (file: IndexedFileSearchResult) => void;
  onClose: () => void;
}

interface FinderPosition {
  fileId: string;
  query: string;
  revision: number;
  scrollTop: number;
}

export function FileFinder({ workspace, contentRevision, open, onOpen, onOpened, onClose }: FileFinderProps) {
  const search = useIndexedFileSearch(workspace, contentRevision, open);
  const [position, setPosition] = useState<FinderPosition | null>(null);
  if (!open) return null;

  return (
    <FileFinderDialog
      workspace={workspace} search={search} contentRevision={contentRevision}
      position={position?.query === search.name && position.revision === contentRevision ? position : null}
      onOpen={onOpen} onClose={onClose}
      onOpened={(file, scrollTop) => {
        setPosition({ fileId: file.file_id, query: search.name, revision: contentRevision, scrollTop });
        onOpened(file);
      }}
    />
  );
}

interface FileFinderDialogProps {
  workspace: string;
  contentRevision: number;
  search: ReturnType<typeof useIndexedFileSearch>;
  position: FinderPosition | null;
  onOpen: FileFinderProps["onOpen"];
  onOpened: (file: IndexedFileSearchResult, scrollTop: number) => void;
  onClose: () => void;
}

function FileFinderDialog({ workspace, contentRevision, search, position, onOpen, onOpened, onClose }: FileFinderDialogProps) {
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | null>(null);
  const navigation = useAnalysisNavigation(onOpen, onClose, (file) => {
    onOpened(file, results.current?.closest(".atlas-analysis-body")?.scrollTop ?? 0);
  });

  useLayoutEffect(() => {
    pendingFocus.current = null;
    const pane = results.current?.closest(".atlas-analysis-body");
    if (!pane) return;
    pane.scrollTop = position?.scrollTop ?? 0;
    const row = list.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]');
    if (!row) return;

    row.focus({ preventScroll: true });
    const bounds = pane.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    if (rowBounds.bottom <= bounds.top || rowBounds.top >= bounds.bottom) {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [contentRevision, search.name, position]);

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
                  list.current?.querySelector("button")?.focus();
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  void navigation.show(search.files[0]);
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
                  aria-current={file.file_id === position?.fileId || undefined}
                  aria-disabled={navigation.opening || undefined}
                  onClick={navigation.opening ? undefined : () => void navigation.show(file)}
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
