import { useEffect, useRef } from "react";
import { formatBytes, formatHealth, healthColor } from "../lib/format";
import type { HealthMetric, StorageChildrenPage, StorageNode } from "../lib/types";
import { ChevronIcon, FileIcon, FolderIcon, RefreshIcon } from "./Icons";

interface FolderInspectorProps {
  page: StorageChildrenPage | null;
  metric: HealthMetric;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  canGoBack: boolean;
  onBack: () => void;
  onSelect: (node: StorageNode) => void;
  onRetry: () => void;
  onLoadMore: () => void;
}

function nodeType(node: StorageNode): string {
  switch (node.kind) {
    case "file": return "File";
    case "smaller_items": return "Grouped items";
    case "local_root": return "Local root";
    case "smb_root": return "SMB root";
    case "site": return "Site";
    default: return "Folder";
  }
}

function canOpen(node: StorageNode): boolean {
  return node.kind !== "file" && node.kind !== "smaller_items";
}

export function FolderInspector({
  page,
  metric,
  loading,
  loadingMore,
  error,
  canGoBack,
  onBack,
  onSelect,
  onRetry,
  onLoadMore,
}: FolderInspectorProps) {
  const shown = page?.children.length ?? 0;
  const hasMore = page ? shown < page.total_children : false;
  const headingRef = useRef<HTMLHeadingElement>(null);
  const previousParentIdRef = useRef<string | null>(page?.parent.id ?? null);

  useEffect(() => {
    const parentId = page?.parent.id ?? null;
    if (!parentId) return;
    if (previousParentIdRef.current && parentId !== previousParentIdRef.current) headingRef.current?.focus();
    previousParentIdRef.current = parentId;
  }, [page?.parent.id]);

  return (
    <section className="folder-inspector" aria-labelledby="folder-inspector-title">
      <header className="folder-inspector-header">
        <button className="inspector-back" type="button" onClick={onBack} disabled={!canGoBack}>
          <ChevronIcon /> Back
        </button>
        <div>
          <span className="eyebrow">SELECTED FOLDER</span>
          <h3 ref={headingRef} id="folder-inspector-title" tabIndex={-1} title={page?.parent.name}>
            {page?.parent.name ?? (loading ? "Loading…" : "Contents")}
          </h3>
        </div>
        <small aria-live="polite">{page ? `${shown} of ${page.total_children}` : ""}</small>
      </header>

      <div className="folder-list-heading" aria-hidden="true">
        <span>Name</span><span>Type</span><span>Size</span>
        <span>{metric === "space_health" ? "Space" : "Coverage"}</span><span />
      </div>

      {loading && !page ? (
        <div className="folder-list-state" role="status">
          <span className="mini-spinner" /> Loading contents…
        </div>
      ) : error && !page ? (
        <div className="folder-list-state is-error" role="alert">
          <p>{error}</p>
          <button className="secondary-button" type="button" onClick={onRetry}><RefreshIcon />Retry</button>
        </div>
      ) : page?.children.length === 0 ? (
        <div className="folder-list-state">
          {page.parent.kind === "file" ? <FileIcon /> : <FolderIcon />}
          <p>This selection has no direct children.</p>
        </div>
      ) : (
        <>
          <ul className="folder-list">
            {page?.children.map((child) => {
              const score = child[metric];
              const openable = canOpen(child);
              const ItemIcon = child.kind === "file" ? FileIcon : FolderIcon;
              return (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(child)}
                    aria-label={`${openable ? "Open" : "Select"} ${child.name}, ${nodeType(child)}, ${formatBytes(child.total_bytes)}, ${formatHealth(score)} ${metric === "space_health" ? "space" : "coverage"} health`}
                  >
                    <span className={`folder-row-name is-${child.kind}`}><ItemIcon /><strong title={child.name}>{child.name}</strong></span>
                    <span>{nodeType(child)}</span>
                    <span>{formatBytes(child.total_bytes)}</span>
                    <strong className="folder-row-score" style={{ color: healthColor(score) }}>{formatHealth(score)}</strong>
                    <ChevronIcon className={openable ? "" : "is-hidden"} />
                  </button>
                </li>
              );
            })}
          </ul>
          {error && <div className="folder-load-error" role="alert">{error} <button type="button" onClick={onLoadMore}>Try again</button></div>}
          {hasMore && (
            <button className="ghost-button folder-load-more" type="button" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? "Loading…" : `Load more · ${page!.total_children - shown} remaining`}
            </button>
          )}
        </>
      )}
    </section>
  );
}
