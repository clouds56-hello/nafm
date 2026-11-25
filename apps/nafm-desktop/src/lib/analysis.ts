import type { SiteOverview } from "./types";

export function siteAnalysisReady(site: SiteOverview | null): boolean {
  return Boolean(site && site.hash_status === "ready" && site.pending_hash_count === 0);
}

export function spaceHealthNotice(source: SiteOverview): string | null {
  if (siteAnalysisReady(source)) return null;
  if (source.pending_hash_count > 0) {
    const pending = source.pending_hash_count.toLocaleString();
    return source.verified_file_count > 0
      ? `${pending} hashes are pending in ${source.name}. Estimated health uses verified content; duplicates and cleanup remain suspended until verification completes.`
      : `${pending} hashes are pending in ${source.name}. Health becomes available after the first content is verified.`;
  }
  return source.hash_status === "pending"
    ? `Finish or rescan ${source.name} to finalize analysis. Duplicate and cleanup actions remain suspended.`
    : `Index and hash ${source.name} to enable health, duplicates, and cleanup.`;
}
