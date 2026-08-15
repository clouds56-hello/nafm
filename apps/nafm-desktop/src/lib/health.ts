import { formatHealth, healthColor } from "./format";
import type { HealthMetric, SiteOverview, StorageNode } from "./types";

export type HealthPresentationState = "unavailable" | "partial" | "exact";

export interface HealthPresentation {
  value: number | null;
  state: HealthPresentationState;
  completeness: number;
  color: string;
}

function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function verifiedCompleteness(
  verifiedBytes: number,
  totalBytes: number,
  verifiedFiles: number,
  totalFiles: number,
): number {
  if (totalBytes > 0) return clampRatio(verifiedBytes / totalBytes);
  if (totalFiles > 0) return clampRatio(verifiedFiles / totalFiles);
  return 0;
}

export function nodeCompleteness(node: StorageNode): number {
  return verifiedCompleteness(
    node.verified_bytes,
    node.total_bytes,
    node.verified_file_count,
    node.file_count,
  );
}

export function siteCompleteness(site: SiteOverview | null): number {
  if (!site) return 0;
  return verifiedCompleteness(
    site.verified_bytes,
    site.total_bytes,
    site.verified_file_count,
    site.total_files,
  );
}

export function formatCompleteness(value: number): string {
  const completeness = clampRatio(value);
  if (completeness === 0) return "0%";
  if (completeness === 1) return "100%";
  return `${Math.min(99, Math.max(1, Math.round(completeness * 100)))}%`;
}

export function healthPresentation(
  exact: number | null,
  estimate: number | null,
  completeness: number,
): HealthPresentation {
  if (exact !== null && Number.isFinite(exact)) {
    return {
      value: exact,
      state: "exact",
      completeness: 1,
      color: healthColor(exact),
    };
  }

  const verified = clampRatio(completeness);
  if (verified === 0 || estimate === null || !Number.isFinite(estimate)) {
    return {
      value: null,
      state: "unavailable",
      completeness: verified,
      color: healthColor(null),
    };
  }

  return {
    value: estimate,
    state: "partial",
    completeness: verified,
    color: healthColor(estimate, verified),
  };
}

export function nodeHealthPresentation(
  node: StorageNode,
  metric: HealthMetric,
  coverageTargetCompleteness = 0,
): HealthPresentation {
  const sourceCompleteness = nodeCompleteness(node);
  const completeness = metric === "coverage_health"
    ? Math.min(sourceCompleteness, clampRatio(coverageTargetCompleteness))
    : sourceCompleteness;
  const estimate = metric === "space_health"
    ? node.estimated_space_health
    : node.estimated_coverage_health;
  return healthPresentation(node[metric], estimate, completeness);
}

export function formatHealthForCanvas(presentation: HealthPresentation): string {
  return formatHealth(presentation.value);
}

export function healthAriaDescription(
  presentation: HealthPresentation,
  metricLabel: string,
  hasContent = true,
  unavailableReason?: string,
): string {
  if (presentation.state === "unavailable") {
    if (!hasContent) return `${metricLabel} health unavailable; no content to compare`;
    if (unavailableReason) return `${metricLabel} health unavailable; ${unavailableReason}`;
    return presentation.completeness > 0
      ? `${metricLabel} health unavailable; ${formatCompleteness(presentation.completeness)} is verified but not comparable`
      : `${metricLabel} health unavailable; no content is verified`;
  }
  if (presentation.state === "partial") {
    return `estimated ${formatHealth(presentation.value)} ${metricLabel} health, ${formatCompleteness(presentation.completeness)} verified`;
  }
  return `${formatHealth(presentation.value)} ${metricLabel} health`;
}
