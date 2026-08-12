import { formatHealth } from "../lib/format";
import type { HealthMetric, SiteOverview, StorageNode, StorageTree } from "../lib/types";
import { HealthControls } from "./HealthControls";
import { NodeDetails } from "./NodeDetails";
import { SunburstMap } from "./SunburstMap";

interface StorageExplorerProps {
  sites: SiteOverview[];
  source: SiteOverview;
  target: SiteOverview | null;
  tree: StorageTree;
  node: StorageNode;
  metric: HealthMetric;
  staged: boolean;
  stagingBusy: boolean;
  onMetricChange: (metric: HealthMetric) => void;
  onTargetChange: (siteId: string) => void;
  onSwap: () => void;
  onScanTarget: () => void;
  onSelectNode: (node: StorageNode) => void;
  onStage: () => void;
  onUnstage: () => void;
}

export function StorageExplorer({
  sites,
  source,
  target,
  tree,
  node,
  metric,
  staged,
  stagingBusy,
  onMetricChange,
  onTargetChange,
  onSwap,
  onScanTarget,
  onSelectNode,
  onStage,
  onUnstage,
}: StorageExplorerProps) {
  const score = tree.root[metric];
  const coverageWithoutTarget = metric === "coverage_health" && !target;

  return (
    <section className="explorer-section" aria-labelledby="map-title">
      <div className="section-heading health-heading">
        <div>
          <span className="eyebrow">STORAGE HEALTH MAP</span>
          <h2 id="map-title">See the health of every folder</h2>
          <p>Arc size is physical storage. Color represents only the selected health score.</p>
        </div>
        <div className="map-total">
          <span>{metric === "space_health" ? source.name : `${source.name} → ${target?.name ?? "No target"}`}</span>
          <strong>{formatHealth(score)}{score === null ? "" : "/100"}</strong>
          <small>{metric === "space_health" ? "space health" : "coverage health"}</small>
        </div>
      </div>

      <HealthControls
        metric={metric}
        sites={sites}
        source={source}
        target={target}
        onMetricChange={onMetricChange}
        onTargetChange={onTargetChange}
        onSwap={onSwap}
      />

      {coverageWithoutTarget ? (
        <div className="map-inline-state" role="status">
          <span className="state-score">—</span>
          <h3>Coverage needs a target</h3>
          <p>Add another site, scan it, then compare this source against it.</p>
          <button className="secondary-button" type="button" onClick={() => onMetricChange("space_health")}>
            View space health
          </button>
        </div>
      ) : (
        <>
          {metric === "coverage_health" && target && !target.last_scanned_at && (
            <div className="coverage-freshness-note" role="status">
              <span><strong>Coverage is unknown.</strong> Scan {target.name} to calculate this map.</span>
              <button className="secondary-button" type="button" onClick={onScanTarget}>Scan target</button>
            </div>
          )}
          <div className="explorer-grid">
            <SunburstMap
              root={tree.root}
              metric={metric}
              selectedNodeId={node.id}
              onSelectNode={onSelectNode}
            />
            <NodeDetails
              node={node}
              metric={metric}
              coverageTargetName={target?.name ?? null}
              staged={staged}
              busy={stagingBusy}
              onStage={onStage}
              onUnstage={onUnstage}
            />
          </div>
        </>
      )}
    </section>
  );
}
