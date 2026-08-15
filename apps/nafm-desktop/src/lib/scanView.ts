import type {
  ScanCompletionView,
  ScanProgressView,
  ScanState,
  ScanTaskEvent,
  SiteOverview,
} from "./types";

export function isActiveScanState(scanState: ScanState): boolean {
  return ["queued", "discovering", "hashing", "finalizing"].includes(scanState);
}

export function initialScanProgress(requestId: number, siteId: string): ScanProgressView {
  return {
    request_id: requestId,
    site_id: siteId,
    phase: "discovering",
    processed_files: 0,
    total_files: 0,
    hashed_files: 0,
    reused_files: 0,
    current_path: null,
  };
}

export function scanProgressFromEvent(event: ScanTaskEvent): ScanProgressView | null {
  if (!event.site_id || (event.kind !== "started" && event.kind !== "progress")) return null;
  return {
    request_id: event.request_id,
    site_id: event.site_id,
    phase: event.phase ?? (event.kind === "started" ? "discovering" : "hashing"),
    processed_files: event.processed_files ?? 0,
    total_files: event.total_files ?? 0,
    hashed_files: event.hashed_files ?? 0,
    reused_files: event.reused_files ?? 0,
    current_path: event.current_path ?? null,
  };
}

export function scanCompletionFromEvent(event: ScanTaskEvent): ScanCompletionView | null {
  if (!event.site_id || event.kind !== "completed") return null;
  return {
    request_id: event.request_id,
    site_id: event.site_id,
    source: "event",
    should_announce: true,
    total_files: event.summary?.files_seen ?? event.total_files ?? event.processed_files ?? 0,
    hashed_files: event.summary?.files_hashed ?? event.hashed_files ?? 0,
    reused_files: event.summary?.files_reused ?? event.reused_files ?? 0,
  };
}

export function snapshotScanCompletion(site: SiteOverview): ScanCompletionView | null {
  if (!site.last_scanned_at) return null;
  return {
    request_id: null,
    site_id: site.id,
    source: "snapshot",
    should_announce: false,
    total_files: site.total_files,
    hashed_files: null,
    reused_files: null,
  };
}

export function silenceScanCompletions(
  current: Map<string, ScanCompletionView>,
  siteIds: string[],
  requestId: number,
): Map<string, ScanCompletionView> {
  let next = current;
  for (const siteId of siteIds) {
    const completion = next.get(siteId);
    if (!completion?.should_announce || completion.request_id === requestId) continue;
    if (next === current) next = new Map(current);
    next.set(siteId, { ...completion, should_announce: false });
  }
  return next;
}

export function reconcileScanCompletions(
  current: Map<string, ScanCompletionView>,
  sites: SiteOverview[],
): Map<string, ScanCompletionView> {
  const next = new Map<string, ScanCompletionView>();
  for (const site of sites) {
    const existing = current.get(site.id);
    const snapshot = snapshotScanCompletion(site);
    if (existing && (snapshot || isActiveScanState(site.scan_state))) {
      next.set(site.id, existing);
    } else if (snapshot) {
      next.set(site.id, snapshot);
    }
  }
  return next;
}

export function setCurrentScanProgress(
  current: Map<string, ScanProgressView>,
  progress: ScanProgressView,
): Map<string, ScanProgressView> {
  const existing = current.get(progress.site_id);
  if (existing && existing.request_id > progress.request_id) return current;
  return new Map(current).set(progress.site_id, progress);
}

export function clearScanProgressForSite(
  current: Map<string, ScanProgressView>,
  siteId: string,
  requestId: number,
): Map<string, ScanProgressView> {
  if (current.get(siteId)?.request_id !== requestId) return current;
  const next = new Map(current);
  next.delete(siteId);
  return next;
}

export function clearScanProgressForRequest(
  current: Map<string, ScanProgressView>,
  requestId: number,
): Map<string, ScanProgressView> {
  const next = new Map(
    [...current].filter(([, progress]) => progress.request_id !== requestId),
  );
  return next.size === current.size ? current : next;
}
