import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { formatBytes, formatCount } from "../lib/format";
import type { StorageChildrenPage, StorageLocation, StorageNode } from "../lib/types";
import "./directory.css";

interface DirectoryContentsProps {
  location: StorageLocation | null;
  page: StorageChildrenPage | null;
  selection: StorageNode | null;
  loading: boolean;
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
  loading,
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
  const keyboardDestination = useRef<{ folder: string; offset?: number; row?: string } | null>(null);
  const directoryId = location?.root.id;
  const offset = page?.offset ?? 0;

  useLayoutEffect(() => {
    const destination = keyboardDestination.current;
    if (loading || !destination) return;
    keyboardDestination.current = null;
    if (directoryId !== destination.folder || (destination.offset !== undefined && destination.offset !== offset)) return;
    const active = document.activeElement;
    if (active !== document.body && !headingRef.current?.closest(".atlas-directory")?.contains(active)) return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("button") ?? []);
    const next = rows.find((row) => row.dataset.entryId === destination.row) ?? rows[0] ?? headingRef.current;
    next?.focus();
  }, [directoryId, offset, loading]);

  if (!location) return null;

  const children = page?.children ?? [];
  const parent = location.breadcrumbs.at(-2);
  const total = page?.total_children ?? 0;
  const rangeStart = Math.min(total, offset + 1);
  const rangeEnd = Math.min(total, offset + children.length);
  const hasPrevious = offset > 0;
  const hasNext = rangeEnd < total;
  const hasPages = hasPrevious || hasNext;
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

  function changePage(forward: boolean, keyboard: boolean) {
    if (!page || !directoryId || loading || !(forward ? hasNext : hasPrevious)) return;
    const nextOffset = forward ? offset + page.limit : Math.max(0, offset - page.limit);
    keyboardDestination.current = keyboard ? { folder: directoryId, offset: nextOffset } : null;
    if (forward) onNext();
    else onPrevious();
  }

  function moveRow(event: KeyboardEvent<HTMLButtonElement>, node: StorageNode, index: number) {
    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return;
    const rows = listRef.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!rows?.length) return;
    switch (event.key) {
      case "ArrowDown": rows[Math.min(index + 1, rows.length - 1)].focus(); break;
      case "ArrowUp": rows[Math.max(0, index - 1)].focus(); break;
      case "Home": rows[0].focus(); break;
      case "End": rows[rows.length - 1].focus(); break;
      case "ArrowLeft": goUp(true); break;
      case "ArrowRight": activate(node, true); break;
      case "PageDown": changePage(true, true); break;
      case "PageUp": changePage(false, true); break;
      default: return;
    }
    event.preventDefault();
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
        <div className="atlas-directory-pages" role="group" aria-label="Directory pages">
          {total > 0 && (
            <span className="atlas-directory-range" aria-live="polite">
              {hasPages ? `${formatCount(rangeStart)}–${formatCount(rangeEnd)} of ${formatCount(total)}`
                : `${formatCount(total)} ${total === 1 ? "entry" : "entries"}`}
            </span>
          )}
          {hasPages && (
            <>
              <button
                className="atlas-directory-page"
                type="button"
                aria-label="Previous directory page"
                title="Previous page"
                disabled={loading || !hasPrevious}
                onClick={(event) => changePage(false, event.detail === 0)}
              />
              <button
                className="atlas-directory-page is-next"
                type="button"
                aria-label="Next directory page"
                title="Next page"
                disabled={loading || !hasNext}
                onClick={(event) => changePage(true, event.detail === 0)}
              />
            </>
          )}
        </div>
      </header>

      <div role="region" aria-label="Directory entries" aria-busy={loading || undefined}>
        {error ? (
          <div className="atlas-directory-status" role="alert">
            <span>{error}</span>
            <button type="button" className="atlas-text-button" onClick={onRetry}>Retry</button>
          </div>
        ) : children.length > 0 ? (
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
        ) : (
          <p className="atlas-directory-status" role="status">
            {loading ? "Reading directory…" : awaitingInventory ? "Waiting for the first inventory." : "This directory is empty."}
          </p>
        )}
      </div>
    </section>
  );
}
