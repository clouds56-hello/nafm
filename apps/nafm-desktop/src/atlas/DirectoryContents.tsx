import { useEffect, useId, useRef } from "react";
import { formatBytes, formatCount } from "../lib/format";
import type { StorageChildrenPage, StorageLocation, StorageNode } from "../lib/types";
import "./directory.css";

interface DirectoryContentsProps {
  location: StorageLocation | null;
  page: StorageChildrenPage | null;
  selection: StorageNode | null;
  loading: boolean;
  error: string | null;
  onSelect: (node: StorageNode) => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetry: () => void;
}

export function DirectoryContents({
  location,
  page,
  selection,
  loading,
  error,
  onSelect,
  onPrevious,
  onNext,
  onRetry,
}: DirectoryContentsProps) {
  const labelId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const focusDestination = useRef<string | null>(null);
  const directoryId = location?.root.id;

  useEffect(() => {
    if (directoryId && directoryId === focusDestination.current) {
      headingRef.current?.focus();
      focusDestination.current = null;
    }
  }, [directoryId]);

  if (!location) return null;

  const children = page?.children ?? [];
  const offset = page?.offset ?? 0;
  const total = page?.total_children ?? 0;
  const rangeStart = Math.min(total, offset + 1);
  const rangeEnd = Math.min(total, offset + children.length);
  const hasPrevious = offset > 0;
  const hasNext = rangeEnd < total;
  const hasPages = hasPrevious || hasNext;

  function activate(node: StorageNode, keyboard: boolean) {
    focusDestination.current = null;
    if (keyboard && node.kind !== "file") {
      if (node.kind === "smaller_items") headingRef.current?.focus();
      else focusDestination.current = node.id;
    }
    onSelect(node);
  }

  return (
    <section className="atlas-directory" aria-labelledby={labelId}>
      <header className="atlas-directory-header">
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
                onClick={onPrevious}
              />
              <button
                className="atlas-directory-page is-next"
                type="button"
                aria-label="Next directory page"
                title="Next page"
                disabled={loading || !hasNext}
                onClick={onNext}
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
          <ul className="atlas-directory-list">
            {children.map((node) => {
              const isFile = node.kind === "file";
              return (
                <li key={node.id}>
                  <button
                    type="button"
                    className="atlas-directory-entry"
                    aria-pressed={isFile ? selection?.id === node.id : undefined}
                    onClick={(event) => activate(node, event.detail === 0)}
                  >
                    <span className="atlas-directory-name" title={node.name}>
                      <span className="atlas-directory-icon" data-kind={node.kind} aria-hidden="true" />
                      <span className="atlas-directory-identity">
                        <span>{node.name}</span>
                        {!isFile && (
                          <span className="atlas-directory-count">
                            {formatCount(node.file_count)} {node.file_count === 1 ? "file" : "files"}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="atlas-directory-size">{formatBytes(node.total_bytes)}</span>
                    {!isFile && <span className="atlas-directory-chevron" aria-hidden="true" />}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="atlas-directory-status" role="status">
            {loading ? "Reading directory…" : "This directory is empty."}
          </p>
        )}
      </div>
    </section>
  );
}
