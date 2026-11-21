import { useEffect, useId, useRef } from "react";
import { formatBytes, formatCount } from "../lib/format";
import type { StorageNode } from "../lib/types";
import "./directory.css";

export const DIRECTORY_PAGE_SIZE = 8;

interface DirectoryTapeProps {
  directory: StorageNode;
  selection: StorageNode | null;
  children: StorageNode[];
  offset: number;
  total: number;
  loading: boolean;
  error: string | null;
  onSelect: (node: StorageNode) => void;
  onOffset: (offset: number) => void;
  onRetry: () => void;
}

export function DirectoryTape({
  directory,
  selection,
  children,
  offset,
  total,
  loading,
  error,
  onSelect,
  onOffset,
  onRetry,
}: DirectoryTapeProps) {
  const labelId = useId();
  const viewport = useRef<HTMLDivElement>(null);
  const rangeStart = Math.min(total, offset + 1);
  const rangeEnd = Math.min(total, offset + DIRECTORY_PAGE_SIZE);
  const hasPrevious = offset > 0;
  const hasNext = rangeEnd < total;
  const hasPages = hasPrevious || hasNext;
  const location = directory.path ?? "Site root";

  useEffect(() => {
    if (viewport.current) viewport.current.scrollLeft = 0;
  }, [directory.id, offset]);

  return (
    <section className="atlas-directory-tape" aria-labelledby={labelId}>
      <header className="atlas-tape-header">
        <div className="atlas-tape-current">
          <h2 id={labelId} title={directory.name}>
            <span className="atlas-tape-glyph" data-kind={directory.kind} aria-hidden="true" />
            <span className="atlas-tape-track-name">{directory.name}</span>
          </h2>
          <span className="atlas-tape-total">{formatBytes(directory.total_bytes)}</span>
          <span className="atlas-tape-location" title={location}>{location}</span>
        </div>
        <div className="atlas-tape-pagination" role="group" aria-label="Directory pages">
          {total > 0 && (
            <span className="atlas-tape-cursor" aria-live="polite">
              {hasPages ? `${formatCount(rangeStart)}–${formatCount(rangeEnd)} of ${formatCount(total)}`
                : `${formatCount(total)} ${total === 1 ? "entry" : "entries"}`}
            </span>
          )}
          {hasPages && (
            <>
              <button
                className="atlas-tape-arrow"
                type="button"
                aria-label="Previous directory page"
                title="Previous page"
                disabled={loading || !hasPrevious}
                onClick={() => onOffset(Math.max(0, offset - DIRECTORY_PAGE_SIZE))}
              />
              <button
                className="atlas-tape-arrow is-next"
                type="button"
                aria-label="Next directory page"
                title="Next page"
                disabled={loading || !hasNext}
                onClick={() => onOffset(offset + DIRECTORY_PAGE_SIZE)}
              />
            </>
          )}
        </div>
      </header>

      <div
        ref={viewport}
        className="atlas-tape-viewport"
        role="region"
        aria-label="Directory entries"
        aria-busy={loading || undefined}
        tabIndex={children.length > 0 && !error ? 0 : undefined}
      >
        {error ? (
          <div className="atlas-tape-status" role="alert">
            <span>{error}</span>
            <button type="button" onClick={onRetry}>Retry</button>
          </div>
        ) : children.length > 0 ? (
          <ul className="atlas-tape-tracks">
            {children.map((node) => (
              <li key={node.id}>
                <button
                  type="button"
                  className="atlas-tape-track"
                  aria-pressed={node.kind === "file" ? selection?.id === node.id : undefined}
                  onClick={(event) => {
                    if (event.detail === 0 && node.kind !== "file") viewport.current?.focus();
                    onSelect(node);
                  }}
                >
                  <span className="atlas-tape-track-heading">
                    <span className="atlas-tape-glyph" data-kind={node.kind} aria-hidden="true" />
                    <span className="atlas-tape-track-name" title={node.name}>{node.name}</span>
                  </span>
                  <span className="atlas-tape-track-data">
                    <span>{node.kind === "file" ? "File" : `${formatCount(node.file_count)} ${node.file_count === 1 ? "file" : "files"}`}</span>
                    <span>{formatBytes(node.total_bytes)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="atlas-tape-status" role="status">{loading ? "Reading directory…" : "This directory is empty."}</p>
        )}
      </div>
    </section>
  );
}
