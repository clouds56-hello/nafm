import { fileName, formatBytes, formatCount, formatHealth } from "../lib/format";
import type { HealthMetric, StorageNode } from "../lib/types";
import { CheckIcon, FolderIcon, LayersIcon } from "./Icons";

interface NodeDetailsProps {
  node: StorageNode;
  metric: HealthMetric;
  coverageTargetName: string | null;
  staged: boolean;
  busy: boolean;
  onStage: () => void;
  onUnstage: () => void;
}

function HealthScore({ label, value, active }: { label: string; value: number | null; active: boolean }) {
  return (
    <div className={`health-score ${active ? "is-active" : ""}`}>
      <span>{label}</span>
      <strong>{formatHealth(value)}{value === null ? "" : <small>/100</small>}</strong>
    </div>
  );
}

export function NodeDetails({
  node,
  metric,
  coverageTargetName,
  staged,
  busy,
  onStage,
  onUnstage,
}: NodeDetailsProps) {
  const stageable = Boolean(node.path) && node.duplicate_bytes > 0 && node.kind !== "smaller_items";

  return (
    <aside className="node-details" aria-label="Selection details">
      <div className="detail-icon"><FolderIcon /></div>
      <span className="eyebrow">SELECTED</span>
      <h3 title={node.name}>{node.name || (node.path ? fileName(node.path) : "Site")}</h3>
      <p className="detail-path" title={node.path ?? undefined}>{node.path ?? "Entire site"}</p>

      <div className="health-score-grid">
        <HealthScore label="Space health" value={node.space_health} active={metric === "space_health"} />
        <HealthScore
          label={coverageTargetName ? `Coverage → ${coverageTargetName}` : "Coverage health"}
          value={node.coverage_health}
          active={metric === "coverage_health"}
        />
      </div>

      <div className="detail-metrics compact-metrics">
        <div><span>Physical size</span><strong>{formatBytes(node.total_bytes)}</strong></div>
        <div><span>Files</span><strong>{formatCount(node.file_count)}</strong></div>
      </div>

      {metric === "space_health" ? (
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
