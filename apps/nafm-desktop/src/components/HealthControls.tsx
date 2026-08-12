import { formatRelativeTime } from "../lib/format";
import type { HealthMetric, SiteOverview } from "../lib/types";
import { RefreshIcon } from "./Icons";

interface HealthControlsProps {
  metric: HealthMetric;
  sites: SiteOverview[];
  source: SiteOverview;
  target: SiteOverview | null;
  onMetricChange: (metric: HealthMetric) => void;
  onTargetChange: (siteId: string) => void;
  onSwap: () => void;
}

export function HealthControls({
  metric,
  sites,
  source,
  target,
  onMetricChange,
  onTargetChange,
  onSwap,
}: HealthControlsProps) {
  const targetOptions = sites.filter((site) => site.id !== source.id);

  return (
    <div className="health-controls">
      <div className="metric-switch" role="group" aria-label="Map health metric">
        <button
          type="button"
          className={metric === "space_health" ? "is-active" : ""}
          aria-pressed={metric === "space_health"}
          onClick={() => onMetricChange("space_health")}
        >
          <strong>Space health</strong>
        </button>
        <button
          type="button"
          className={metric === "coverage_health" ? "is-active" : ""}
          aria-pressed={metric === "coverage_health"}
          onClick={() => onMetricChange("coverage_health")}
        >
          <strong>Coverage health</strong>
        </button>
      </div>

      {metric === "coverage_health" && (
        <div className="coverage-direction" aria-label="Coverage comparison direction">
          <div className="direction-site">
            <span>Source</span>
            <strong title={source.location}>{source.name}</strong>
          </div>
          <div className="direction-arrow" aria-hidden="true">→</div>
          <label className="direction-site direction-target">
            <span>Target</span>
            {targetOptions.length > 0 ? (
              <select
                value={target?.id ?? ""}
                onChange={(event) => onTargetChange(event.target.value)}
                aria-label="Coverage target site"
              >
                {targetOptions.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
            ) : (
              <strong>No other site</strong>
            )}
            <small>{target ? formatRelativeTime(target.last_scanned_at) : "Add another site"}</small>
          </label>
          <button
            className="swap-button"
            type="button"
            onClick={onSwap}
            disabled={!target}
            aria-label={target ? `Swap source and target: ${target.name} to ${source.name}` : "No target to swap"}
          >
            <RefreshIcon />
            Swap
          </button>
        </div>
      )}
    </div>
  );
}
