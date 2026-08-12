import { useEffect, useRef } from "react";
import {
  fileName,
  formatBytes,
  formatCount,
  formatFileEquivalent,
  formatHealth,
  healthColor,
} from "../lib/format";
import type {
  FileContentMatch,
  FileContentMatchesPage,
  HealthMetric,
  StorageChildrenPage,
  StorageNode,
} from "../lib/types";
import {
  ArrowIcon,
  CheckIcon,
  ChevronIcon,
  DriveIcon,
  FileIcon,
  FolderIcon,
  LayersIcon,
  NetworkIcon,
  RefreshIcon,
} from "./Icons";

interface InspectorPanelProps {
  node: StorageNode;
  previewing: boolean;
  metric: HealthMetric;
  coverageTargetName: string | null;
  staged: boolean;
  stagingBusy: boolean;
  page: StorageChildrenPage | null;
  loading: boolean;
  error: string | null;
  canHaveChildren: boolean;
  canGoBack: boolean;
  canLoadPrevious: boolean;
  canLoadNext: boolean;
  rangeStart: number;
  rangeEnd: number;
  duplicatesPage: FileContentMatchesPage | null;
  duplicatesLoading: boolean;
  duplicatesError: string | null;
  canLoadPreviousDuplicates: boolean;
  canLoadNextDuplicates: boolean;
  duplicateRangeStart: number;
  duplicateRangeEnd: number;
  onBack: () => void;
  onSelect: (node: StorageNode) => void;
  onRetry: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onRetryDuplicates: () => void;
  onPreviousDuplicates: () => void;
  onNextDuplicates: () => void;
  onJumpDuplicate: (match: FileContentMatch) => void;
  focusSelectedFileRevision: number;
  onStage: () => void;
  onUnstage: () => void;
  onPointerEnter: () => void;
  onPointerLeave: () => void;
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
  previewing,
  metric,
  coverageTargetName,
  staged,
  stagingBusy,
  page,
  loading,
  error,
  canHaveChildren,
  canGoBack,
  canLoadPrevious,
  canLoadNext,
  rangeStart,
  rangeEnd,
  duplicatesPage,
  duplicatesLoading,
  duplicatesError,
  canLoadPreviousDuplicates,
  canLoadNextDuplicates,
  duplicateRangeStart,
  duplicateRangeEnd,
  onBack,
  onSelect,
  onRetry,
  onPrevious,
  onNext,
  onRetryDuplicates,
  onPreviousDuplicates,
  onNextDuplicates,
  onJumpDuplicate,
  focusSelectedFileRevision,
  onStage,
  onUnstage,
  onPointerEnter,
  onPointerLeave,
}: InspectorPanelProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const DetailIcon = node.kind === "file" ? FileIcon : FolderIcon;
  const stageable = Boolean(node.path) && node.duplicate_bytes > 0 && node.kind !== "smaller_items";
  const inspectingFile = node.kind === "file";
  const metricLabel = metric === "space_health" ? "space health" : "coverage health";

  useEffect(() => {
    if (focusSelectedFileRevision > 0 && !previewing && node.kind === "file") {
      titleRef.current?.focus({ preventScroll: true });
    }
  }, [focusSelectedFileRevision]);

  return (
    <aside
      className={`inspector-panel ${previewing ? "is-previewing" : ""}`}
      aria-labelledby="inspector-title"
      aria-describedby="inspector-selection-status"
      onPointerEnter={onPointerEnter}
      onPointerLeave={onPointerLeave}
    >
      <p id="inspector-selection-status" className="sr-only" aria-live="polite">
        {previewing ? "Previewing" : "Selected"} {nodeType(node)} {node.name}, {formatBytes(node.total_bytes)}, {formatCount(node.file_count)} files, {formatHealth(node[metric])} {metricLabel}.
      </p>
      <header className="inspector-selection">
        {previewing ? (
          <span className="inspector-preview-marker" aria-hidden="true" />
        ) : (
          <button className="compact-inspector-back" type="button" onClick={onBack} disabled={!canGoBack} aria-label="Return to previous folder">
            <ChevronIcon />
          </button>
        )}
        <span className="inspector-item-icon"><DetailIcon /></span>
        <div className="inspector-identity">
          <span className="eyebrow">{previewing ? "HOVER PREVIEW" : "SELECTED"}</span>
          <h2 id="inspector-title" ref={titleRef} tabIndex={-1} title={node.name}>
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
        {previewing ? (
          <span className="inspector-readonly">Click or press Enter</span>
        ) : metric === "space_health" ? (
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
        {inspectingFile ? (
          <DuplicateList
            previewing={previewing}
            page={duplicatesPage}
            loading={duplicatesLoading}
            error={duplicatesError}
            canLoadPrevious={canLoadPreviousDuplicates}
            canLoadNext={canLoadNextDuplicates}
            rangeStart={duplicateRangeStart}
            rangeEnd={duplicateRangeEnd}
            onRetry={onRetryDuplicates}
            onPrevious={onPreviousDuplicates}
            onNext={onNextDuplicates}
            onJumpDuplicate={onJumpDuplicate}
          />
        ) : (
          <FolderContents
            node={node}
            previewing={previewing}
            metric={metric}
            page={page}
            loading={loading}
            error={error}
            canHaveChildren={canHaveChildren}
            canLoadPrevious={canLoadPrevious}
            canLoadNext={canLoadNext}
            rangeStart={rangeStart}
            rangeEnd={rangeEnd}
            onSelect={onSelect}
            onRetry={onRetry}
            onPrevious={onPrevious}
            onNext={onNext}
          />
        )}
      </section>
    </aside>
  );
}

interface FolderContentsProps {
  node: StorageNode;
  previewing: boolean;
  metric: HealthMetric;
  page: StorageChildrenPage | null;
  loading: boolean;
  error: string | null;
  canHaveChildren: boolean;
  canLoadPrevious: boolean;
  canLoadNext: boolean;
  rangeStart: number;
  rangeEnd: number;
  onSelect: (node: StorageNode) => void;
  onRetry: () => void;
  onPrevious: () => void;
  onNext: () => void;
}

function FolderContents({
  node,
  previewing,
  metric,
  page,
  loading,
  error,
  canHaveChildren,
  canLoadPrevious,
  canLoadNext,
  rangeStart,
  rangeEnd,
  onSelect,
  onRetry,
  onPrevious,
  onNext,
}: FolderContentsProps) {
  const totalChildren = page?.total_children ?? 0;
  const contentsName = page?.parent.name || node.name || "Contents";

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">
            {previewing ? "PREVIEW CONTENTS" : page?.parent.id === node.id ? "CONTENTS" : "IN FOLDER"}
          </span>
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
        ) : !canHaveChildren || page?.children.length === 0 ? (
          <div className="inspector-list-state">
            {!canHaveChildren || page?.parent.kind === "file" ? <FileIcon /> : <FolderIcon />}
            <p>{!canHaveChildren || page?.parent.kind === "file" ? "This file has no children." : "This selection has no direct children."}</p>
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
                    disabled={previewing}
                    aria-current={child.id === node.id ? "true" : undefined}
                    aria-label={`${previewing ? "Preview" : openable ? "Open" : "Select"} ${child.name}, ${nodeType(child)}, ${formatBytes(child.total_bytes)}, ${formatHealth(score)} ${metric === "space_health" ? "space" : "coverage"} health`}
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
    </>
  );
}

interface DuplicateListProps {
  previewing: boolean;
  page: FileContentMatchesPage | null;
  loading: boolean;
  error: string | null;
  canLoadPrevious: boolean;
  canLoadNext: boolean;
  rangeStart: number;
  rangeEnd: number;
  onRetry: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onJumpDuplicate: (match: FileContentMatch) => void;
}

function DuplicateList({
  previewing,
  page,
  loading,
  error,
  canLoadPrevious,
  canLoadNext,
  rangeStart,
  rangeEnd,
  onRetry,
  onPrevious,
  onNext,
  onJumpDuplicate,
}: DuplicateListProps) {
  const totalMatches = page?.total_matches ?? 0;
  const rowCapacity = page?.status === "not_hashed" ? 5 : 6;

  return (
    <>
      <header>
        <div>
          <span className="eyebrow">{previewing ? "PREVIEW DUPLICATES" : "DUPLICATES"}</span>
          <h3 id="contents-title">Copies in this workspace</h3>
        </div>
        <small aria-live="polite">
          {totalMatches > 0 ? `${rangeStart}–${rangeEnd} of ${totalMatches}` : ""}
        </small>
      </header>

      <div className="inspector-list-heading duplicate-list-heading" aria-hidden="true">
        <span>Location</span><span>Site</span><span />
      </div>

      <div className={`inspector-list-body ${loading && page ? "is-updating" : ""}`} aria-busy={loading}>
        {loading && !page ? (
          <div className="inspector-list-state" role="status"><span className="mini-spinner" /> Finding duplicates…</div>
        ) : error && !page ? (
          <div className="inspector-list-state is-error" role="alert">
            <p>{error}</p>
            <button className="secondary-button" type="button" onClick={onRetry}><RefreshIcon />Retry</button>
          </div>
        ) : page && page.matches.length === 0 ? (
          <div className="inspector-list-state">
            <FileIcon />
            <p>No indexed copy is available on this page.</p>
          </div>
        ) : (
          <>
            {page?.status === "not_hashed" && (
              <p className="duplicate-unhashed-note" role="status">
                Not hashed yet. Scan this site to discover content copies.
              </p>
            )}
            <ul className="inspector-list duplicate-list">
              {page?.matches.map((match) => {
                const LocationIcon = match.site_folder_kind === "smb" ? NetworkIcon : DriveIcon;
                return (
                  <li key={match.file_id} aria-current={match.is_current ? "location" : undefined}>
                    <span
                      className={`duplicate-row ${match.is_current ? "is-current" : ""}`}
                      title={match.path}
                    >
                      <span className="duplicate-row-path">
                        <LocationIcon />
                        <span><strong>{fileName(match.path)}</strong><small>{match.path}</small></span>
                      </span>
                      <span className="duplicate-site-cell">
                        <span className="duplicate-site-name" title={match.site_name}>{match.site_name}</span>
                        {match.is_current && (
                          <small className="duplicate-current-badge">{previewing ? "Previewed" : "Current"}</small>
                        )}
                      </span>
                      {match.is_current ? (
                        <span className="duplicate-jump-spacer" aria-hidden="true" />
                      ) : (
                        <button
                          className="duplicate-jump"
                          type="button"
                          onClick={() => onJumpDuplicate(match)}
                          aria-label={`Show ${fileName(match.path)} in ${match.site_name} site`}
                          title={`Show ${fileName(match.path)} in ${match.site_name}`}
                        >
                          <ArrowIcon />
                        </button>
                      )}
                    </span>
                  </li>
                );
              })}
              {Array.from({ length: Math.max(0, rowCapacity - (page?.matches.length ?? 0)) }, (_, index) => (
                <li className="inspector-row-placeholder" key={`duplicate-placeholder-${index}`} aria-hidden="true" />
              ))}
            </ul>
          </>
        )}
        {loading && page && <span className="inspector-page-spinner mini-spinner" role="status" aria-label="Loading duplicate page" />}
      </div>

      {error && page && (
        <div className="inspector-inline-error" role="alert">{error} <button type="button" onClick={onRetry}>Try again</button></div>
      )}

      <footer className="inspector-pagination">
        <button type="button" onClick={onPrevious} disabled={!canLoadPrevious || loading}>
          <ChevronIcon /> Previous
        </button>
        <span>{totalMatches > 0 ? `${rangeStart}–${rangeEnd}` : "0"}</span>
        <button type="button" onClick={onNext} disabled={!canLoadNext || loading}>
          Next <ChevronIcon />
        </button>
      </footer>
    </>
  );
}
