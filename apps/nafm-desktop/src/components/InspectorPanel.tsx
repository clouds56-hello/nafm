import { useEffect, useRef } from "react";
import {
  fileName,
  formatBytes,
  formatCount,
  formatFileEquivalent,
  formatHealth,
} from "../lib/format";
import {
  formatCompleteness,
  healthAriaDescription,
  nodeCompleteness,
  nodeHealthPresentation,
  type HealthPresentation,
} from "../lib/health";
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
  ScanIcon,
} from "./Icons";

interface InspectorPanelProps {
  node: StorageNode;
  previewing: boolean;
  metric: HealthMetric;
  coverageTargetName: string | null;
  coverageTargetCompleteness: number;
  sourceAnalysisReady: boolean;
  analysisMessage: string | null;
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
  presentation: HealthPresentation;
  numerator: number;
  total: number;
  unit: string;
  hasContent: boolean;
  active: boolean;
  partialEvidence: string;
  unavailableEvidence?: string;
}

function HealthScore({
  label,
  presentation,
  numerator,
  total,
  unit,
  hasContent,
  active,
  partialEvidence,
  unavailableEvidence,
}: HealthScoreProps) {
  let evidence: string;
  if (presentation.state === "unavailable") {
    evidence = !hasContent
      ? "No content to compare"
      : unavailableEvidence
        ?? (presentation.completeness > 0 ? "No comparable content" : "No verified content");
  } else if (presentation.state === "partial") {
    evidence = `PARTIAL · ${partialEvidence}`;
  } else {
    evidence = total > 0
      ? `${formatFileEquivalent(numerator)} / ${formatCount(total)} ${unit}`
      : `No comparable ${unit}`;
  }

  return (
    <div
      className={`inspector-score ${active ? "is-active" : ""} is-${presentation.state}`}
      title="The score is weighted by bytes; the count is supporting context."
    >
      <span>{label}</span>
      <strong style={{ color: presentation.color }}>
        {formatHealth(presentation.value)}
        {presentation.state === "partial" && <em>EST</em>}
      </strong>
      <small title={evidence}>{evidence}</small>
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
  coverageTargetCompleteness,
  sourceAnalysisReady,
  analysisMessage,
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
  const nodeAnalysisReady = sourceAnalysisReady && node.pending_hash_count === 0;
  const spacePresentation = nodeHealthPresentation(node, "space_health");
  const coveragePresentation = nodeHealthPresentation(
    node,
    "coverage_health",
    coverageTargetCompleteness,
  );
  const metricPresentation = metric === "space_health"
    ? spacePresentation
    : coveragePresentation;
  const sourceCompleteness = nodeCompleteness(node);
  const coverageUnavailableReason = coveragePresentation.state === "unavailable"
    && (sourceCompleteness === 0 || coverageTargetCompleteness === 0)
    ? "no verified comparison is available"
    : undefined;
  const stageable = nodeAnalysisReady
    && Boolean(node.path)
    && node.duplicate_bytes > 0
    && node.kind !== "smaller_items";
  const inspectingFile = node.kind === "file";

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
      <p id="inspector-selection-status" className="sr-only">
        {previewing ? "Previewing" : "Selected"} {nodeType(node)} {node.name}, {formatBytes(node.total_bytes)}, {formatCount(node.file_count)} files, {healthAriaDescription(metricPresentation, metric === "space_health" ? "space" : "coverage", node.file_count > 0, metric === "coverage_health" ? coverageUnavailableReason : undefined)}.
      </p>
      <p className="sr-only" aria-live="polite">
        {previewing ? "Previewing" : "Selected"} {nodeType(node)} {node.name}.
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
          presentation={spacePresentation}
          numerator={node.space_healthy_file_equivalents}
          total={node.space_total_files}
          unit="files"
          hasContent={node.file_count > 0}
          active={metric === "space_health"}
          partialEvidence={`${formatCompleteness(sourceCompleteness)} verified`}
        />
        <HealthScore
          label={coverageTargetName ? `Coverage → ${coverageTargetName}` : "Coverage"}
          presentation={coveragePresentation}
          numerator={node.coverage_covered_files}
          total={node.coverage_total_files}
          unit="groups"
          hasContent={node.file_count > 0}
          active={metric === "coverage_health"}
          partialEvidence={`source ${formatCompleteness(sourceCompleteness)} · target ${formatCompleteness(coverageTargetCompleteness)}`}
          unavailableEvidence={coverageUnavailableReason ? "No verified comparison" : undefined}
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
          ) : !nodeAnalysisReady ? (
            <span className="inspector-readonly analysis-suspended" title={analysisMessage ?? undefined}>Hashes pending</span>
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
            available={nodeAnalysisReady}
            unavailableMessage={analysisMessage}
          />
        ) : (
          <FolderContents
            node={node}
            previewing={previewing}
            metric={metric}
            coverageTargetCompleteness={coverageTargetCompleteness}
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
  coverageTargetCompleteness: number;
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
  coverageTargetCompleteness,
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
              const presentation = nodeHealthPresentation(
                child,
                metric,
                coverageTargetCompleteness,
              );
              const openable = canOpen(child);
              const ItemIcon = child.kind === "file" ? FileIcon : FolderIcon;
              const childCoverageUnavailableReason = metric === "coverage_health"
                && presentation.state === "unavailable"
                && (nodeCompleteness(child) === 0 || coverageTargetCompleteness === 0)
                ? "no verified comparison is available"
                : undefined;
              return (
                <li key={child.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(child)}
                    disabled={previewing}
                    aria-current={child.id === node.id ? "true" : undefined}
                    aria-label={`${previewing ? "Preview" : openable ? "Open" : "Select"} ${child.name}, ${nodeType(child)}, ${formatBytes(child.total_bytes)}, ${healthAriaDescription(presentation, metric === "space_health" ? "space" : "coverage", child.file_count > 0, childCoverageUnavailableReason)}`}
                  >
                    <span className={`inspector-row-name is-${child.kind}`}><ItemIcon /><strong title={child.name}>{child.name}</strong></span>
                    <span>{formatBytes(child.total_bytes)}</span>
                    <strong className="inspector-row-health" style={{ color: presentation.color }}>
                      {formatHealth(presentation.value)}
                      {presentation.state === "partial" && <em>EST</em>}
                    </strong>
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
  available: boolean;
  unavailableMessage: string | null;
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
  available,
  unavailableMessage,
}: DuplicateListProps) {
  const totalMatches = page?.total_matches ?? 0;
  const rowCapacity = page?.status !== "ready" ? 5 : 6;
  const workspaceIncompleteCopy = page
    ? [
        page.workspace_pending_hash_count > 0
          ? `${formatCount(page.workspace_pending_hash_count)} workspace ${page.workspace_pending_hash_count === 1 ? "hash" : "hashes"} pending`
          : null,
        page.workspace_incomplete_site_count > 0
          ? `${formatCount(page.workspace_incomplete_site_count)} ${page.workspace_incomplete_site_count === 1 ? "site is" : "sites are"} not fully indexed`
          : null,
      ].filter((part): part is string => part !== null).join(" · ")
    : "";

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
        {!available ? (
          <div className="inspector-list-state analysis-suspended" role="status">
            <ScanIcon />
            <p>{unavailableMessage ?? "Hashes are pending. Duplicate analysis will resume when hashing completes."}</p>
          </div>
        ) : loading && !page ? (
          <div className="inspector-list-state" role="status"><span className="mini-spinner" /> Finding duplicates…</div>
        ) : error && !page ? (
          <div className="inspector-list-state is-error" role="alert">
            <p>{error}</p>
            <button className="secondary-button" type="button" onClick={onRetry}><RefreshIcon />Retry</button>
          </div>
        ) : page && page.matches.length === 0 ? (
          <div className="inspector-list-state">
            {page.status === "ready" ? <FileIcon /> : <ScanIcon />}
            <p>
              {page.status === "not_hashed"
                ? "This file is not hashed yet. Scan the site to discover copies."
                : page.status === "needs_verification"
                  ? `This content must be reverified before copy results are available.${workspaceIncompleteCopy ? ` ${workspaceIncompleteCopy}.` : ""}`
                  : workspaceIncompleteCopy
                    ? `No verified copy is available yet. Results may be incomplete: ${workspaceIncompleteCopy}.`
                    : "No indexed copy is available on this page."}
            </p>
          </div>
        ) : (
          <>
            {page?.status === "not_hashed" && (
              <p className="duplicate-unhashed-note" role="status">
                Not hashed yet. Scan this site to discover content copies.
              </p>
            )}
            {page && workspaceIncompleteCopy && page.status !== "not_hashed" && (
              <p className="duplicate-unhashed-note" role="status">
                {page.status === "needs_verification"
                  ? `${workspaceIncompleteCopy}. This content must be reverified before copy results are complete.`
                  : `Results may be incomplete · ${workspaceIncompleteCopy}.`}
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
        <button type="button" onClick={onPrevious} disabled={!available || !canLoadPrevious || loading}>
          <ChevronIcon /> Previous
        </button>
        <span>{totalMatches > 0 ? `${rangeStart}–${rangeEnd}` : "0"}</span>
        <button type="button" onClick={onNext} disabled={!available || !canLoadNext || loading}>
          Next <ChevronIcon />
        </button>
      </footer>
    </>
  );
}
