import {
  fileName,
  formatBytes,
  formatCount,
  formatFileEquivalent,
  formatHealth,
  healthColor,
} from "../lib/format";
import type { HealthMetric, StorageChildrenPage, StorageNode } from "../lib/types";
import { CheckIcon, ChevronIcon, FileIcon, FolderIcon, LayersIcon, RefreshIcon } from "./Icons";

interface InspectorPanelProps {
  node: StorageNode;
  metric: HealthMetric;
  coverageTargetName: string | null;
  staged: boolean;
  stagingBusy: boolean;
  page: StorageChildrenPage | null;
  loading: boolean;
  error: string | null;
  canGoBack: boolean;
  canLoadPrevious: boolean;
  canLoadNext: boolean;
  rangeStart: number;
  rangeEnd: number;
  onBack: () => void;
  onSelect: (node: StorageNode) => void;
  onRetry: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onStage: () => void;
  onUnstage: () => void;
}

interface HealthScoreProps {
  label: string;
  value: number | null;
  numerator: number;
  total: number;
  unit: string;
  active: boolean;
}

function HealthScore({ label, value, numerator, total, unit, active }: HealthScoreProps) {
  const evidence = total > 0
    ? `${value === null ? "—" : formatFileEquivalent(numerator)} / ${formatCount(total)} ${unit}`
    : `No comparable ${unit}`;

  return (
    <div
      className={`inspector-score ${active ? "is-active" : ""}`}
      title="The score is weighted by bytes; the count is supporting context."
    >
      <span>{label}</span>
      <strong style={{ color: healthColor(value) }}>{formatHealth(value)}</strong>
      <small>{evidence}</small>
    </div>
  );
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

export function InspectorPanel({
  node,
  metric,
  coverageTargetName,
  staged,
  stagingBusy,
  page,
  loading,
  error,
  canGoBack,
  canLoadPrevious,
  canLoadNext,
  rangeStart,
  rangeEnd,
  onBack,
  onSelect,
  onRetry,
  onPrevious,
  onNext,
  onStage,
  onUnstage,
}: InspectorPanelProps) {
  const DetailIcon = node.kind === "file" ? FileIcon : FolderIcon;
  const stageable = Boolean(node.path) && node.duplicate_bytes > 0 && node.kind !== "smaller_items";
  const totalChildren = page?.total_children ?? 0;
  const contentsName = page?.parent.name || "Contents";

  return (
    <aside className="inspector-panel" aria-labelledby="inspector-title" aria-describedby="inspector-selection-status">
      <p id="inspector-selection-status" className="sr-only" aria-live="polite">
        Selected {nodeType(node)} {node.name}, {formatBytes(node.total_bytes)}, {formatCount(node.file_count)} files.
      </p>
      <header className="inspector-selection">
        <button className="compact-inspector-back" type="button" onClick={onBack} disabled={!canGoBack} aria-label="Return to previous folder">
          <ChevronIcon />
        </button>
        <span className="inspector-item-icon"><DetailIcon /></span>
        <div className="inspector-identity">
          <span className="eyebrow">SELECTED</span>
          <h2 id="inspector-title" title={node.name}>
            {node.name || (node.path ? fileName(node.path) : "Site")}
          </h2>
          <p title={node.path ?? undefined}>{node.path ?? "Entire site"}</p>
        </div>
      </header>

      <div className="inspector-scores">
        <HealthScore
          label="Space"
          value={node.space_health}
          numerator={node.space_healthy_file_equivalents}
          total={node.space_total_files}
          unit="files"
          active={metric === "space_health"}
        />
        <HealthScore
          label={coverageTargetName ? `Coverage → ${coverageTargetName}` : "Coverage"}
          value={node.coverage_health}
          numerator={node.coverage_covered_files}
          total={node.coverage_total_files}
          unit="groups"
          active={metric === "coverage_health"}
        />
      </div>

      <div className="inspector-facts">
        <span><small>Size</small><strong>{formatBytes(node.total_bytes)}</strong></span>
        <span><small>Files</small><strong>{formatCount(node.file_count)}</strong></span>
        {metric === "space_health" ? (
          staged ? (
            <button className="inspector-stage is-staged" type="button" onClick={onUnstage} disabled={stagingBusy}>
              <CheckIcon /> {stagingBusy ? "Updating…" : "Staged"}
            </button>
          ) : (
            <button className="inspector-stage" type="button" onClick={onStage} disabled={!stageable || stagingBusy}>
              <LayersIcon /> {stagingBusy ? "Adding…" : "Review"}
            </button>
          )
        ) : (
          <span className="inspector-readonly">Read-only comparison</span>
        )}
      </div>

      <section className="inspector-contents" aria-labelledby="contents-title">
        <header>
          <div>
            <span className="eyebrow">{page?.parent.id === node.id ? "CONTENTS" : "IN FOLDER"}</span>
            <h3 id="contents-title" title={contentsName}>{contentsName}</h3>
          </div>
          <small aria-live="polite">
            {totalChildren > 0 ? `${rangeStart}–${rangeEnd} of ${totalChildren}` : ""}
          </small>
        </header>

        <div className="inspector-list-heading" aria-hidden="true">
          <span>Name</span><span>Size</span><span>{metric === "space_health" ? "Space" : "Coverage"}</span><span />
        </div>

        <div className={`inspector-list-body ${loading && page ? "is-updating" : ""}`} aria-busy={loading}>
          {loading && !page ? (
            <div className="inspector-list-state" role="status"><span className="mini-spinner" /> Loading contents…</div>
          ) : error && !page ? (
            <div className="inspector-list-state is-error" role="alert">
              <p>{error}</p>
              <button className="secondary-button" type="button" onClick={onRetry}><RefreshIcon />Retry</button>
            </div>
          ) : page?.children.length === 0 ? (
            <div className="inspector-list-state">
              {page.parent.kind === "file" ? <FileIcon /> : <FolderIcon />}
              <p>{page.parent.kind === "file" ? "This file has no children." : "This selection has no direct children."}</p>
            </div>
          ) : (
            <ul className="inspector-list">
              {page?.children.map((child) => {
                const score = child[metric];
                const openable = canOpen(child);
                const ItemIcon = child.kind === "file" ? FileIcon : FolderIcon;
                return (
                  <li key={child.id}>
                    <button
                      type="button"
                      onClick={() => onSelect(child)}
                      aria-current={child.id === node.id ? "true" : undefined}
                      aria-label={`${openable ? "Open" : "Select"} ${child.name}, ${nodeType(child)}, ${formatBytes(child.total_bytes)}, ${formatHealth(score)} ${metric === "space_health" ? "space" : "coverage"} health`}
                    >
                      <span className={`inspector-row-name is-${child.kind}`}><ItemIcon /><strong title={child.name}>{child.name}</strong></span>
                      <span>{formatBytes(child.total_bytes)}</span>
                      <strong style={{ color: healthColor(score) }}>{formatHealth(score)}</strong>
                      <ChevronIcon className={openable ? "" : "is-hidden"} />
                    </button>
                  </li>
                );
              })}
              {Array.from({ length: Math.max(0, 6 - (page?.children.length ?? 0)) }, (_, index) => (
                <li className="inspector-row-placeholder" key={`placeholder-${index}`} aria-hidden="true" />
              ))}
            </ul>
          )}
          {loading && page && <span className="inspector-page-spinner mini-spinner" role="status" aria-label="Loading page" />}
        </div>

        {error && page && (
          <div className="inspector-inline-error" role="alert">{error} <button type="button" onClick={onRetry}>Try again</button></div>
        )}

        <footer className="inspector-pagination">
          <button type="button" onClick={onPrevious} disabled={!canLoadPrevious || loading}>
            <ChevronIcon /> Previous
          </button>
          <span>{totalChildren > 0 ? `${rangeStart}–${rangeEnd}` : "0"}</span>
          <button type="button" onClick={onNext} disabled={!canLoadNext || loading}>
            Next <ChevronIcon />
          </button>
        </footer>
      </section>
    </aside>
  );
}
