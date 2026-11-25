import type { SiteOverview } from "./types";

export function siteAnalysisReady(site: SiteOverview | null): boolean {
  return Boolean(site && site.hash_status === "ready" && site.pending_hash_count === 0);
}
