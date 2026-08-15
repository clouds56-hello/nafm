import type { HealthMetric, SiteOverview } from "./types";

export interface AnalysisAvailability {
  available: boolean;
  pending_hash_count: number;
  message: string | null;
}

export function siteAnalysisReady(site: SiteOverview | null): boolean {
  return Boolean(site && site.hash_status === "ready" && site.pending_hash_count === 0);
}

export function metricAnalysisAvailability(
  metric: HealthMetric,
  source: SiteOverview,
  target: SiteOverview | null,
): AnalysisAvailability {
  if (!siteAnalysisReady(source)) {
    const pending = source.pending_hash_count;
    return {
      available: false,
      pending_hash_count: pending,
      message: pending > 0
        ? `${pending.toLocaleString()} hashes are pending in ${source.name}. Inventory and size remain available while analysis is suspended.`
        : source.hash_status === "pending"
          ? `Finish or rescan ${source.name} to finalize analysis.`
          : `Index and hash ${source.name} to enable health, duplicates, and cleanup.`,
    };
  }
  if (metric === "coverage_health" && target && !siteAnalysisReady(target)) {
    const pending = target.pending_hash_count;
    return {
      available: false,
      pending_hash_count: pending,
      message: pending > 0
        ? `${pending.toLocaleString()} hashes are pending in ${target.name}. Coverage will resume when the target is ready.`
        : target.hash_status === "pending"
          ? `Finish or rescan ${target.name} to finalize coverage analysis.`
          : `Index and hash ${target.name} to calculate coverage.`,
    };
  }
  return { available: true, pending_hash_count: 0, message: null };
}
