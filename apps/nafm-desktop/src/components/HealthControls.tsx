import { formatRelativeTime } from "../lib/format";
import { siteCompleteness, type HealthPresentation } from "../lib/health";
import type { HealthMetric, SiteOverview } from "../lib/types";
import { RefreshIcon } from "./Icons";

interface HealthControlsProps {
  metric: HealthMetric;
  sites: SiteOverview[];
  source: SiteOverview;
  target: SiteOverview | null;
  sourceHealth: HealthPresentation;
  coverageHealth: HealthPresentation;
  onMetricChange: (metric: HealthMetric) => void;
  onTargetChange: (siteId: string) => void;
  onSwap: () => void;
}

export function HealthControls({
  metric,
  sites,
  source,
  target,
  sourceHealth,
  coverageHealth,
  onMetricChange,
  onTargetChange,
  onSwap,
}: HealthControlsProps) {
  const targetOptions = sites.filter((site) => site.id !== source.id);
  const metricClass = (health: HealthPresentation) => (
    health.state === "exact" ? "" : health.state === "partial" ? "is-partial" : "is-unavailable"
  );
  const metricTitle = (
    label: string,
    health: HealthPresentation,
    hasContent: boolean,
    unavailableReason?: string,
  ) => {
    if (health.state === "exact") return `${label} is exact`;
    if (health.state === "partial") return `${label} is estimated from verified content`;
    if (!hasContent) return `${label} has no content to compare`;
    if (unavailableReason) return unavailableReason;
    return health.completeness > 0
      ? `${label} is unavailable because verified content is not comparable`
      : `${label} is unavailable until content is verified`;
  };
  const sourceCompleteness = siteCompleteness(source);
  const targetCompleteness = siteCompleteness(target);
  const coverageUnavailableReason = !target
    ? "Coverage health requires a target site"
    : sourceCompleteness === 0 && targetCompleteness === 0
      ? "Coverage health is unavailable until both source and target have verified content"
      : sourceCompleteness === 0
        ? `Coverage health is unavailable until ${source.name} has verified content`
        : targetCompleteness === 0
          ? `Coverage health is unavailable until ${target.name} has verified content`
          : undefined;

  return (
    <div className="health-controls">
      <div className="metric-switch" role="group" aria-label="Map health metric">
        <button
          type="button"
          className={`${metric === "space_health" ? "is-active" : ""} ${metricClass(sourceHealth)}`}
          aria-pressed={metric === "space_health"}
          title={metricTitle("Space health", sourceHealth, source.total_files > 0)}
          onClick={() => onMetricChange("space_health")}
        >
          <strong>Space health</strong>
        </button>
        <button
          type="button"
          className={`${metric === "coverage_health" ? "is-active" : ""} ${metricClass(coverageHealth)}`}
          aria-pressed={metric === "coverage_health"}
          title={metricTitle(
            "Coverage health",
            coverageHealth,
            source.total_files > 0 && Boolean(target && target.total_files > 0),
            coverageUnavailableReason,
          )}
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
            <small>
              {target
                ? target.hash_status === "ready"
                  ? formatRelativeTime(target.last_scanned_at)
                  : target.pending_hash_count > 0
                    ? `${target.pending_hash_count.toLocaleString()} hashes pending`
                    : "Not indexed"
                : "Add another site"}
            </small>
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
