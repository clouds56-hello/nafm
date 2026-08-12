import { useCallback, useEffect, useState } from "react";
import { formatHealth, healthColor } from "../lib/format";
import type { HealthMetric, SiteOverview, StorageChildrenPage, StorageNode, StorageTree } from "../lib/types";
import { HealthControls } from "./HealthControls";
import { InspectorPanel } from "./InspectorPanel";
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
  childrenError: string | null;
  canGoBack: boolean;
  canLoadPrevious: boolean;
  canLoadNext: boolean;
  childrenRangeStart: number;
  childrenRangeEnd: number;
  onMetricChange: (metric: HealthMetric) => void;
  onTargetChange: (siteId: string) => void;
  onSwap: () => void;
  onScanTarget: () => void;
  onSelectNode: (node: StorageNode) => void;
  onBack: () => void;
  onRetryChildren: () => void;
  onLoadPreviousChildren: () => void;
  onLoadNextChildren: () => void;
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
  childrenError,
  canGoBack,
  canLoadPrevious,
  canLoadNext,
  childrenRangeStart,
  childrenRangeEnd,
  onMetricChange,
  onTargetChange,
  onSwap,
  onScanTarget,
  onSelectNode,
  onBack,
  onRetryChildren,
  onLoadPreviousChildren,
  onLoadNextChildren,
  onStage,
  onUnstage,
}: StorageExplorerProps) {
  const [previewNode, setPreviewNode] = useState<StorageNode | null>(null);
  const score = tree.root[metric];
  const coverageWithoutTarget = metric === "coverage_health" && !target;
  const inspectedNode = previewNode ?? node;
  const previewing = previewNode !== null;

  useEffect(() => setPreviewNode(null), [metric, tree, node.id]);
  const preview = useCallback((next: StorageNode | null) => setPreviewNode(next), []);
  const selectNode = useCallback((next: StorageNode) => {
    setPreviewNode(null);
    onSelectNode(next);
  }, [onSelectNode]);

  return (
    <section className="explorer-section" aria-label="Storage health workspace">
      <div className="health-toolbar">
        <div className="health-toolbar-score">
          <span>{metric === "space_health" ? source.name : `${source.name} → ${target?.name ?? "No target"}`}</span>
          <strong style={{ color: healthColor(score) }}>{formatHealth(score)}</strong>
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
      </div>

      <div className="explorer-workspace">
        <div className="map-pane">
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
              <SunburstMap
                root={tree.root}
                metric={metric}
                selectedNodeId={node.id}
                onPreviewNode={preview}
                onSelectNode={onSelectNode}
              />
              {metric === "coverage_health" && target && !target.last_scanned_at && (
                <div className="coverage-freshness-note" role="status">
                  <span><strong>Coverage unknown.</strong> Scan {target.name} to calculate this map.</span>
                  <button className="secondary-button" type="button" onClick={onScanTarget}>Scan target</button>
                </div>
              )}
            </>
          )}
        </div>
        <InspectorPanel
          node={inspectedNode}
          previewing={previewing}
          metric={metric}
          coverageTargetName={target?.name ?? null}
          staged={staged}
          stagingBusy={stagingBusy}
          page={childrenPage}
          loading={childrenLoading}
          error={childrenError}
          canGoBack={canGoBack}
          canLoadPrevious={canLoadPrevious}
          canLoadNext={canLoadNext}
          rangeStart={childrenRangeStart}
          rangeEnd={childrenRangeEnd}
          onBack={onBack}
          onSelect={selectNode}
          onRetry={onRetryChildren}
          onPrevious={onLoadPreviousChildren}
          onNext={onLoadNextChildren}
          onStage={onStage}
          onUnstage={onUnstage}
        />
      </div>
    </section>
  );
}
