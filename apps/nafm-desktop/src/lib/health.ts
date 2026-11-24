import { formatCount, formatHealth, healthColor } from "./format";
import type { HealthMetric, SiteOverview, StorageNode } from "./types";

export type HealthPresentationState = "unavailable" | "partial" | "exact";

export function verificationStatus(node: StorageNode) {
  if (node.kind === "file") {
    if (node.verified_file_count > 0) return { status: "verified", label: "Hash verified" };
    if (node.pending_hash_count > 0) return { status: "pending", label: "Hash pending" };
    return { status: "unknown", label: "Not verified" };
  }
  if (node.file_count === 0) return { status: "unknown", label: "No files to verify" };
  const label = `${formatCount(node.verified_file_count)} of ${formatCount(node.file_count)} files verified`;
  return { status: node.verified_file_count === node.file_count ? "verified" : "pending", label };
}

export interface HealthPresentation {
  value: number | null;
  state: HealthPresentationState;
  completeness: number;
  color: string;
}

export function isPerfectHealth(presentation: HealthPresentation): boolean {
  return presentation.state === "exact" && presentation.value === 100;
}

const PARTIAL_HEALTH_MIN_INTENSITY = 0.4;

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
  return `${formatHealth(Math.max(1, completeness * 100))}%`;
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
    color: healthColor(
      estimate,
      PARTIAL_HEALTH_MIN_INTENSITY + (1 - PARTIAL_HEALTH_MIN_INTENSITY) * verified,
    ),
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

export function formatHealthScore(presentation: HealthPresentation): string {
  const value = formatHealth(presentation.value);
  return presentation.state === "partial" ? `≈${value}` : value;
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
  const score = formatHealth(presentation.value).replace(/^</, "less than ");
  if (presentation.state === "partial") {
    const verified = formatCompleteness(presentation.completeness).replace(/^</, "less than ");
    return `estimated ${score} ${metricLabel} health, ${verified} verified`;
  }
  return `${score} ${metricLabel} health`;
}
