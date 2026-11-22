import { useEffect, useRef, type ReactNode } from "react";
import { formatBytes, formatCount, formatFileEquivalent, formatHealth, formatShare } from "../lib/format";
import { formatCompleteness, nodeHealthPresentation, type HealthPresentation } from "../lib/health";
import type { HealthMetric, StorageLocation, StorageNode } from "../lib/types";
import "./inspector.css";

interface StorageDetailsProps {
  location: StorageLocation;
  entries: readonly StorageNode[];
  selected: StorageNode | null;
  focusRevision: number;
  metric: HealthMetric | null;
  targetCompleteness: number;
  targetName: string | null;
  children?: ReactNode;
}

function findContainingFolder(folder: StorageNode, id: string): StorageNode | undefined {
  for (const item of folder.children) {
    if (item.id === id) return folder;
    const container = findContainingFolder(item, id);
    if (container) return container;
  }
}

function getVerification(node: StorageNode) {
  if (node.kind === "file") {
    if (node.verified_file_count > 0) return { status: "verified", label: "Hash verified" };
    if (node.pending_hash_count > 0) return { status: "pending", label: "Hash pending" };
    return { status: "unknown", label: "Not verified" };
  }

  if (node.file_count === 0) return { status: "unknown", label: "No files to verify" };
  const label = `${formatCount(node.verified_file_count)} of ${formatCount(node.file_count)} files verified`;
  return { status: node.verified_file_count === node.file_count ? "verified" : "pending", label };
}

function HealthDetail({
  label, score, evidence, active, emptyLabel = "Unavailable",
}: { label: string; score: HealthPresentation; evidence: string | null; active: boolean; emptyLabel?: string }) {
  return (
    <div className="atlas-detail-health" data-active={active || undefined}>
      <dt>{label}</dt>
      <dd>
        <span className="atlas-detail-score">
          {score.value === null ? emptyLabel : `${score.state === "partial" ? "~" : ""}${formatHealth(score.value)}/100`}
        </span>
        {evidence && score.value !== null && <span className="atlas-detail-note">{evidence}</span>}
        {score.state === "partial" && <span className="atlas-detail-note">{formatCompleteness(score.completeness)} verified</span>}
      </dd>
    </div>
  );
}

export function StorageDetails({ location, entries, selected, focusRevision, metric, targetCompleteness, targetName, children }: StorageDetailsProps) {
  const panelRef = useRef<HTMLElement>(null);
  const previousFocusRevision = useRef(focusRevision);
  useEffect(() => {
    if (previousFocusRevision.current === focusRevision) return;
    previousFocusRevision.current = focusRevision;
    panelRef.current?.focus();
  }, [focusRevision]);

  const { root: folder, breadcrumbs } = location;
  const node = selected ?? folder;
  const isDirectEntry = selected && entries.some((item) => item.id === selected.id);
  const container = selected
    ? isDirectEntry ? folder : findContainingFolder(folder, selected.id)
    : breadcrumbs.at(-2);
  const verification = getVerification(node);
  const space = nodeHealthPresentation(node, "space_health");
  const coverage = nodeHealthPresentation(node, "coverage_health", targetCompleteness);
  const heading = node.kind === "file" ? "Selected file"
    : node.kind === "smaller_items" ? "Grouped entries"
    : node.kind === "site" ? "Current source" : "Current folder";

  return (
    <section className="atlas-readout" aria-label="Storage details" ref={panelRef} tabIndex={-1}>
      <header className="atlas-readout-heading">
        <p className="atlas-kicker">{heading}</p>
        <h2>{node.name}</h2>
      </header>
      <dl className="atlas-details">
        <div className="atlas-detail-path">
          <dt>Path</dt>
          <dd>{node.path ? <code>{node.path}</code> : node.kind === "site" ? "Site root" : "—"}</dd>
        </div>
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
        <HealthDetail label="Space health" score={space} active={metric === "space_health"}
          evidence={node.space_total_files > 0 ? `${formatFileEquivalent(node.space_healthy_file_equivalents)} of ${formatCount(node.space_total_files)} file equivalents` : null} />
        <HealthDetail label={targetName ? `Coverage → ${targetName}` : "Coverage"} score={coverage} active={metric === "coverage_health"}
          emptyLabel={targetName ? "Unavailable" : "Choose a target"}
          evidence={node.coverage_total_files > 0 ? `${formatCount(node.coverage_covered_files)} of ${formatCount(node.coverage_total_files)} content groups` : null} />
      </dl>
      {children}
    </section>
  );
}
