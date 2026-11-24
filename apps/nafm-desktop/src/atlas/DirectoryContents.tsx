import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { formatBytes, formatCount } from "../lib/format";
import type { StorageChildrenPage, StorageLocation, StorageNode } from "../lib/types";
import "./directory.css";

interface DirectoryContentsProps {
  location: StorageLocation | null;
  page: StorageChildrenPage | null;
  selection: StorageNode | null;
  scrollPane: RefObject<HTMLDivElement | null>;
  active: boolean;
  loading: boolean;
  loadingMore: boolean;
  awaitingInventory: boolean;
  error: string | null;
  onSelect: (node: StorageNode) => void;
  onGoUp: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
}

export function DirectoryContents({
  location,
  page,
  selection,
  scrollPane,
  active,
  loading,
  loadingMore,
  awaitingInventory,
  error,
  onSelect,
  onGoUp,
  onPrevious,
  onNext,
  onRetry,
}: DirectoryContentsProps) {
  const labelId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const keyboardDestination = useRef<{ folder: string; row?: string } | null>(null);
  const pendingRow = useRef<{ from: HTMLButtonElement; index: number } | null>(null);
  const firstRow = useRef<{ element: Element; offset: number } | null>(null);
  const directoryId = location?.root.id;
  const offset = page?.offset ?? 0;
  const count = page?.children.length ?? 0;
  const total = page?.total_children ?? 0;
  const hasPrevious = offset > 0;
  const hasNext = offset + count < total;

  // Keep the same row in view when scrolling upward from a grouped arc or file reveal.
  useLayoutEffect(() => {
    const first = listRef.current?.firstElementChild;
    const previous = firstRow.current;
    if (active && first && previous && offset < previous.offset && scrollPane.current
      && listRef.current?.contains(previous.element)) {
      scrollPane.current.scrollTop += previous.element.getBoundingClientRect().top - first.getBoundingClientRect().top;
    }
    firstRow.current = first ? { element: first, offset } : null;
  }, [active, directoryId, offset, count, scrollPane]);

  useEffect(() => {
    const root = scrollPane.current;
    const first = listRef.current?.firstElementChild;
    const last = listRef.current?.lastElementChild;
    if (!root || !first || !last || !active || loading || loadingMore || error || !(hasNext || hasPrevious)) return;
    const observer = new IntersectionObserver((entries) => {
      if (hasPrevious && entries.some((entry) => entry.target === first && entry.isIntersecting)) onPrevious();
      else if (hasNext && entries.some((entry) => entry.target === last && entry.isIntersecting)) onNext();
    }, { root, rootMargin: "48px 0px" });
    if (hasPrevious) observer.observe(first);
    if (hasNext) observer.observe(last);
    return () => observer.disconnect();
  }, [scrollPane, active, loading, loadingMore, error, hasPrevious, hasNext, page, onPrevious, onNext]);

  useLayoutEffect(() => {
    const destination = keyboardDestination.current;
    if (loading || !destination) return;
    keyboardDestination.current = null;
    if (directoryId !== destination.folder) return;
    const active = document.activeElement;
    if (active !== document.body && !headingRef.current?.closest(".atlas-directory")?.contains(active)) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const next = rows.find((row) => row.dataset.entryId === destination.row) ?? rows[0] ?? headingRef.current;
    next?.focus();
  }, [directoryId, loading]);

  useLayoutEffect(() => {
    const pending = pendingRow.current;
    if (!pending || loadingMore) return;
    if (document.activeElement !== pending.from || !active || loading || error || !count) {
      pendingRow.current = null;
      return;
    }
    const index = Math.min(pending.index, total - 1) - offset;
    const row = listRef.current?.children[index]?.querySelector("button");
    if (row) {
      pendingRow.current = null;
      row.focus();
    } else if (index < 0) onPrevious();
    else onNext();
  }, [offset, count, total, loadingMore, loading, active, error, onPrevious, onNext]);

  if (!location) return null;

  const children = page?.children ?? [];
  const parent = location.breadcrumbs.at(-2);
  const tabStop = children.find((node) => node.id === cursor)?.id
    ?? children.find((node) => node.id === selection?.id)?.id ?? children[0]?.id;

  function activate(node: StorageNode, keyboard: boolean) {
    keyboardDestination.current = keyboard && node.kind !== "file" && node.kind !== "smaller_items"
      ? { folder: node.id } : null;
    onSelect(node);
  }

  function goUp(keyboard: boolean) {
    if (!parent || loading) return;
    keyboardDestination.current = keyboard ? { folder: parent.id, row: directoryId } : null;
    onGoUp();
  }

  function moveRow(event: KeyboardEvent<HTMLButtonElement>, node: StorageNode, index: number) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const button = event.currentTarget;
    const viewport = (scrollPane.current?.clientHeight ?? 0) - (headingRef.current?.parentElement?.offsetHeight ?? 0);
    const screenful = Math.max(1, Math.floor(viewport / Math.max(1, button.offsetHeight + 1)));
    let target = index;
    pendingRow.current = null;
    switch (event.key) {
      case "ArrowDown": target++; break;
      case "ArrowUp": target--; break;
      case "Home": target = 0; break;
      case "End": target = count - 1; break;
      case "PageDown": target += screenful; break;
      case "PageUp": target -= screenful; break;
      case "ArrowLeft": goUp(true); break;
      case "ArrowRight": activate(node, true); break;
      default: return;
    }
    event.preventDefault();
    if (target === index) return;
    const absolute = Math.min(total - 1, Math.max(0, offset + target));
    const next = listRef.current?.children[absolute - offset]?.querySelector("button");
    if (next) next.focus();
    else if (!loading && !error) {
      pendingRow.current = { from: button, index: absolute };
      if (absolute < offset) onPrevious();
      else onNext();
    }
  }

  return (
    <section className="atlas-directory" aria-labelledby={labelId}>
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
        <h2 id={labelId} ref={headingRef} tabIndex={-1} title={location.root.name}>{location.root.name || "Contents"}</h2>
        {total > 0 && <span className="atlas-directory-total">{formatCount(total)} {total === 1 ? "entry" : "entries"}</span>}
      </header>

      <div role="region" aria-label="Directory entries" aria-busy={loading || loadingMore || undefined}>
        {children.length > 0 ? (
          <ul
            className="atlas-directory-list" ref={listRef} role="grid"
            aria-label={`${location.root.name} entries`} aria-rowcount={total}
            aria-description="Use Up and Down to move between entries, Enter to open, and Left to return to the parent."
          >
            {children.map((node, index) => {
              const isFile = node.kind === "file";
              return (
                <li key={node.id} role="row" aria-rowindex={offset + index + 1} aria-selected={isFile ? selection?.id === node.id : undefined}>
                  <div role="gridcell">
                    <button
                      type="button"
                      className="atlas-directory-entry"
                      data-entry-id={node.id}
                      tabIndex={tabStop === node.id ? 0 : -1}
                      onFocus={() => setCursor(node.id)}
                      onKeyDown={(event) => moveRow(event, node, index)}
                      onClick={(event) => activate(node, event.detail === 0)}
                    >
                      <span className="atlas-directory-name" title={node.name}>
                        <span className="atlas-directory-icon" data-kind={node.kind} aria-hidden="true" />
                        <span className="atlas-directory-identity">
                          <span>{node.name}</span>
                          {!isFile && (
                            <span className="atlas-directory-count">
                              {awaitingInventory ? "Awaiting inventory"
                                : `${formatCount(node.file_count)} ${node.file_count === 1 ? "file" : "files"}`}
                            </span>
                          )}
                        </span>
                      </span>
                      <span className="atlas-directory-size">{awaitingInventory ? "—" : formatBytes(node.total_bytes)}</span>
                      <span className="atlas-directory-chevron" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : !error && (
          <p className="atlas-directory-status" role="status">
            {loading ? "Reading directory…" : awaitingInventory ? "Waiting for the first inventory." : "This directory is empty."}
          </p>
        )}
        {error ? (
          <div className="atlas-directory-status atlas-directory-feedback" role="alert">
            <span>{error}</span>
            <button type="button" className="atlas-text-button" onClick={onRetry}>Retry</button>
          </div>
        ) : loadingMore && (
          <p className="atlas-directory-status" role="status">Loading more entries…</p>
        )}
      </div>
    </section>
  );
}
