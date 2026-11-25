import { useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { formatBytes, formatCount, formatFileEquivalent, formatShare } from "../lib/format";
import { estimatedHealthEvidence, formatHealthScore, isPerfectHealth, nodeHealthPresentation, verificationStatus, type HealthPresentation } from "../lib/health";
import type { FolderOpenDestination, HealthMetric, StorageLocation, StorageNode } from "../lib/types";
import { FolderOpenControl } from "./FolderOpenControl";
import { CheckIcon } from "../management/Icons";
import "./inspector.css";

interface StorageDetailsProps {
  location: StorageLocation;
  entries: readonly StorageNode[];
  selected: StorageNode | null;
  fileUnavailable: boolean;
  focusRequested: boolean;
  onFocusHandled: () => void;
  metric: HealthMetric | null;
  targetCompleteness: number;
  targetName: string | null;
  onOpenFolder: (node: StorageNode, destination: FolderOpenDestination) => Promise<void>;
  returnAction?: { label: string; run: () => void };
  onShowInContents?: () => void;
  revealing: boolean;
  children?: ReactNode;
}

function findContainingFolder(folder: StorageNode, id: string): StorageNode | undefined {
  for (const item of folder.children) {
    if (item.id === id) return folder;
    const container = findContainingFolder(item, id);
    if (container) return container;
  }
}

function HealthDetail({
  label, score, evidence, active, metric, emptyLabel = "Unavailable",
}: { label: string; score: HealthPresentation; evidence: string | null; active: boolean; metric: "coverage" | "space"; emptyLabel?: string }) {
  return (
    <div className="atlas-detail-health" data-active={active || undefined}>
      <dt>{label}</dt>
      <dd>
        <span className="atlas-detail-score">
          {score.value === null ? emptyLabel : `${formatHealthScore(score)}/100`}
          {isPerfectHealth(score) && <CheckIcon className="atlas-score-check" role="img" aria-hidden={false} aria-label="Perfect score" />}
        </span>
        {evidence && score.value !== null && <span className="atlas-detail-note">{evidence}</span>}
        {score.state === "partial" && <span className="atlas-detail-note">{estimatedHealthEvidence(score, metric)}</span>}
      </dd>
    </div>
  );
}

export function StorageDetails({
  location, entries, selected, fileUnavailable, focusRequested, onFocusHandled, metric, targetCompleteness, targetName, onOpenFolder,
  returnAction, onShowInContents, revealing, children,
}: StorageDetailsProps) {
  const panelRef = useRef<HTMLElement>(null);
  const lostActionFocus = useRef(false);
  const removableAction = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    return () => {
      if (element.contains(document.activeElement)) lostActionFocus.current = true;
    };
  }, []);
  useLayoutEffect(() => {
    const lostFocus = lostActionFocus.current;
    lostActionFocus.current = false;
    const panel = panelRef.current;
    if (fileUnavailable && lostFocus && document.activeElement === document.body && panel?.getClientRects().length) {
      panel.focus({ preventScroll: true });
    }
  });
  useEffect(() => {
    if (!focusRequested) return;
    panelRef.current?.focus();
    onFocusHandled();
  }, [focusRequested, onFocusHandled]);

  const { root: folder, breadcrumbs } = location;
  const node = selected ?? folder;
  const isDirectEntry = selected && entries.some((item) => item.id === selected.id);
  const container = selected
    ? isDirectEntry ? folder : findContainingFolder(folder, selected.id)
    : breadcrumbs.at(-2);
  const verification = verificationStatus(node);
  const space = nodeHealthPresentation(node, "space_health");
  const coverage = nodeHealthPresentation(node, "coverage_health", targetCompleteness);
  const heading = node.kind === "file" ? "Selected file"
    : node.kind === "smaller_items" ? "Grouped entries"
    : node.kind === "site" ? "Current source" : "Current folder";

  return (
    <section className="atlas-readout" aria-label="Storage details" ref={panelRef} tabIndex={-1}>
      <header className="atlas-readout-heading">
        <p className="atlas-kicker">{heading}</p>
        <div className="atlas-readout-title">
          <h2>{node.name}</h2>
          <FolderOpenControl node={node} onOpen={onOpenFolder} />
        </div>
      </header>
      {fileUnavailable && <p className="atlas-inspector-status" role="status">This file is no longer in the index.</p>}
      {(returnAction || onShowInContents) && (
        <div className="atlas-detail-actions">
          {returnAction && (
            <button className="atlas-text-button atlas-detail-action" type="button" aria-haspopup="dialog" onClick={returnAction.run}>
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M13 8H3m5-5L3 8l5 5" />
              </svg>
              {returnAction.label}
            </button>
          )}
          {onShowInContents && (
            <button
              className="atlas-text-button atlas-detail-action" type="button"
              ref={removableAction}
              aria-disabled={revealing || undefined} aria-busy={revealing || undefined}
              onClick={onShowInContents}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M1.5 5.5v-2a1 1 0 0 1 1-1h3.7l1.7 2h5.6a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1zM5 9h6m-2-2 2 2-2 2" />
              </svg>
              {revealing ? "Finding file…" : "Show in Contents"}
            </button>
          )}
        </div>
      )}
      <dl className="atlas-details">
        <div className="atlas-detail-path">
          <dt>{fileUnavailable ? "Last indexed path" : "Path"}</dt>
          <dd>{node.path ? <code>{node.path}</code> : node.kind === "site" ? "Site root" : "—"}</dd>
        </div>
        {!fileUnavailable && (
          <>
            <div className="atlas-detail-metric">
              <dt>Size</dt>
              <dd>{formatBytes(node.total_bytes)}</dd>
            </div>
            {container && (
              <div className="atlas-detail-metric">
                <dt>Share of parent</dt>
                <dd title={container.total_bytes === 0 ? `${container.name} has no bytes` : container.name}>
                  {formatShare(node.total_bytes, container.total_bytes)}
                </dd>
              </div>
            )}
            <div className="atlas-detail-metric">
              <dt>Verification</dt>
              <dd className="atlas-verification" data-status={verification.status}>{verification.label}</dd>
            </div>
            <HealthDetail label="Space health" score={space} active={metric === "space_health"} metric="space"
              evidence={node.space_total_files > 0 ? `${formatFileEquivalent(node.space_healthy_file_equivalents)} of ${formatCount(node.space_total_files)} file equivalents` : null} />
            <HealthDetail label={targetName ? `Coverage → ${targetName}` : "Coverage"} score={coverage} active={metric === "coverage_health"} metric="coverage"
              emptyLabel={targetName ? "Unavailable" : "Choose a target"}
              evidence={node.coverage_total_files > 0 ? `${formatCount(node.coverage_covered_files)} of ${formatCount(node.coverage_total_files)} content groups` : null} />
          </>
        )}
      </dl>
      {children && <div ref={removableAction}>{children}</div>}
    </section>
  );
}
