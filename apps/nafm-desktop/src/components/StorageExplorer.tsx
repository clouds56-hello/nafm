import { useCallback, useEffect, useState } from "react";
import { formatHealth, healthColor } from "../lib/format";
import type { HealthMetric, SiteOverview, StorageChildrenPage, StorageNode, StorageTree } from "../lib/types";
import { FolderInspector } from "./FolderInspector";
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
  childrenPage: StorageChildrenPage | null;
  childrenLoading: boolean;
  childrenLoadingMore: boolean;
  childrenError: string | null;
  canGoBack: boolean;
  onMetricChange: (metric: HealthMetric) => void;
  onTargetChange: (siteId: string) => void;
  onSwap: () => void;
  onScanTarget: () => void;
  onSelectNode: (node: StorageNode) => void;
  onBack: () => void;
  onRetryChildren: () => void;
  onLoadMoreChildren: () => void;
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
  childrenPage,
  childrenLoading,
  childrenLoadingMore,
  childrenError,
  canGoBack,
  onMetricChange,
  onTargetChange,
  onSwap,
  onScanTarget,
  onSelectNode,
  onBack,
  onRetryChildren,
  onLoadMoreChildren,
  onStage,
  onUnstage,
}: StorageExplorerProps) {
  const [previewNode, setPreviewNode] = useState<StorageNode | null>(null);
  const score = tree.root[metric];
  const coverageWithoutTarget = metric === "coverage_health" && !target;
  const visibleNode = previewNode ?? node;

  useEffect(() => setPreviewNode(null), [tree, node.id]);
  const preview = useCallback((next: StorageNode | null) => setPreviewNode(next), []);

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
          <strong style={{ color: healthColor(score) }}>{formatHealth(score)}</strong>
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
              onPreviewNode={preview}
              onSelectNode={onSelectNode}
            />
            <NodeDetails
              node={visibleNode}
              metric={metric}
              coverageTargetName={target?.name ?? null}
              previewing={previewNode !== null}
              staged={staged}
              busy={stagingBusy}
              onStage={onStage}
              onUnstage={onUnstage}
            />
          </div>
          <FolderInspector
            page={childrenPage}
            metric={metric}
            loading={childrenLoading}
            loadingMore={childrenLoadingMore}
            error={childrenError}
            canGoBack={canGoBack}
            onBack={onBack}
            onSelect={onSelectNode}
            onRetry={onRetryChildren}
            onLoadMore={onLoadMoreChildren}
          />
        </>
      )}
    </section>
  );
}
