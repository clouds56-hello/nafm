import { fileName, formatBytes, formatCount, formatFileEquivalent, formatHealth, healthColor } from "../lib/format";
import type { HealthMetric, StorageNode } from "../lib/types";
import { CheckIcon, FileIcon, FolderIcon, LayersIcon } from "./Icons";

interface NodeDetailsProps {
  node: StorageNode;
  metric: HealthMetric;
  coverageTargetName: string | null;
  previewing: boolean;
  staged: boolean;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
}

interface HealthScoreProps {
  label: string;
  value: number | null;
  numerator: number;
  total: number;
  unitLabel: string;
  evidenceLabel: string;
  active: boolean;
}

function HealthScore({ label, value, numerator, total, unitLabel, evidenceLabel, active }: HealthScoreProps) {
  const hasEvidence = total > 0 && value !== null;
  const evidence = total > 0
    ? hasEvidence
      ? `${formatFileEquivalent(numerator)} / ${formatCount(total)} ${unitLabel}`
      : `— / ${formatCount(total)} ${unitLabel}`
    : `No comparable ${unitLabel}`;
  return (
    <div
      className={`health-score ${active ? "is-active" : ""}`}
      title="The health score is weighted by bytes; the displayed counts provide supporting context."
    >
      <span>{label}</span>
      <strong style={{ color: healthColor(value) }}>{formatHealth(value)}</strong>
      <small>{evidence}</small>
      {hasEvidence && <em>{evidenceLabel} · byte-weighted score</em>}
    </div>
  );
}

export function NodeDetails({
  node,
  metric,
  coverageTargetName,
  previewing,
  staged,
  busy,
  onStage,
  onUnstage,
}: NodeDetailsProps) {
  const stageable = Boolean(node.path) && node.duplicate_bytes > 0 && node.kind !== "smaller_items";
  const DetailIcon = node.kind === "file" ? FileIcon : FolderIcon;

  return (
    <aside
      className={`node-details ${previewing ? "is-previewing" : ""}`}
      aria-label={previewing ? "Hover preview details" : "Selection details"}
    >
      <div className="detail-icon"><DetailIcon /></div>
      <span className="eyebrow">{previewing ? "HOVER PREVIEW" : "SELECTED"}</span>
      <h3 title={node.name}>{node.name || (node.path ? fileName(node.path) : "Site")}</h3>
      <p className="detail-path" title={node.path ?? undefined}>{node.path ?? "Entire site"}</p>

      <div className="health-score-grid">
        <HealthScore
          label="Space health"
          value={node.space_health}
          numerator={node.space_healthy_file_equivalents}
          total={node.space_total_files}
          unitLabel="files"
          evidenceLabel="healthy equivalents"
          active={metric === "space_health"}
        />
        <HealthScore
          label={coverageTargetName ? `Coverage → ${coverageTargetName}` : "Coverage health"}
          value={node.coverage_health}
          numerator={node.coverage_covered_files}
          total={node.coverage_total_files}
          unitLabel="content groups"
          evidenceLabel="covered content"
          active={metric === "coverage_health"}
        />
      </div>

      <div className="detail-metrics compact-metrics">
        <div><span>Physical size</span><strong>{formatBytes(node.total_bytes)}</strong></div>
        <div><span>Files</span><strong>{formatCount(node.file_count)}</strong></div>
      </div>

      {previewing ? (
        <p className="detail-help preview-help">
          Move away to return to the selected item. Click to {node.kind === "file" ? "select this file" : "select and open this folder"}.
        </p>
      ) : metric === "space_health" ? (
        <>
          <p className="detail-help">
            {stageable
              ? `${formatBytes(node.duplicate_bytes)} can be reviewed safely. NAFM preserves at least one copy.`
              : "This selection has no safely reclaimable duplicate data."}
          </p>
          {staged ? (
            <button className="secondary-button full-width" type="button" onClick={onUnstage} disabled={busy}>
              <CheckIcon /> {busy ? "Updating…" : "Staged · Remove"}
            </button>
          ) : (
            <button className="primary-button full-width" type="button" onClick={onStage} disabled={!stageable || busy}>
              <LayersIcon /> {busy ? "Adding…" : "Add to review"}
            </button>
          )}
        </>
      ) : (
        <p className="detail-help coverage-help">
          Coverage is read-only. A high score means this content is present on the selected target site.
        </p>
      )}
    </aside>
  );
}
