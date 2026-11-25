import { siteAnalysisReady } from "../lib/analysis";
import { formatCount } from "../lib/format";
import { firstScanRecovery, scanPhaseLabel } from "../lib/scanView";
import type { FirstScanInterruption, ScanProgressView, SiteOverview } from "../lib/types";

type CoverageRole = "source" | "target";

export interface CoverageScanAction {
  siteId: string;
  role: CoverageRole;
  label: string;
  shortLabel: string;
  disabled: boolean;
}

export interface CoverageSiteVerification {
  status: string;
  tone: "ready" | "active" | "pending";
  needsVerification: boolean;
  action?: CoverageScanAction;
}

interface CoverageScanState {
  running: boolean;
  stopping: boolean;
  blocked: boolean;
  progress?: ScanProgressView;
  interruption?: FirstScanInterruption;
}

function activeStatus(site: SiteOverview, scan: CoverageScanState) {
  const phase = site.scan_state;
  if (scan.stopping || phase === "cancelling") return "Stopping scan";
  if (scan.progress) {
    const { phase, total_files, processed_files } = scan.progress;
    const count = phase === "hashing" && total_files
      ? ` · ${formatCount(processed_files)}/${formatCount(total_files)}` : "";
    return scanPhaseLabel(phase) + count;
  }
  if (phase === "queued") return "Scan queued";
  if (phase === "discovering" || phase === "publishing_metadata" || phase === "hashing" || phase === "finalizing") {
    return scanPhaseLabel(phase);
  }
  return scan.running ? "Starting scan" : null;
}

export function coverageSiteVerification(site: SiteOverview, role: CoverageRole, scan: CoverageScanState): CoverageSiteVerification {
  const active = activeStatus(site, scan);
  const needsVerification = !siteAnalysisReady(site);
  const interruption = firstScanRecovery(scan.interruption?.kind ?? (site.scan_state === "failed" ? "failed" : undefined));
  let action: CoverageScanAction | undefined;
  if (needsVerification || interruption) {
    const verb = interruption?.shortAction ?? (site.hash_status === "pending" ? "Resume" : "Scan");
    const shortLabel = `${verb} ${role}`;
    const activeLabel = scan.stopping || site.scan_state === "cancelling" ? `Stopping ${role}…` : `Scanning ${role}…`;
    action = {
      siteId: site.id, role,
      label: active ? activeLabel : verb === "Scan" ? shortLabel : `${shortLabel} scan`,
      shortLabel: active ? activeLabel : shortLabel,
      disabled: Boolean(active) || scan.blocked,
    };
  }
  if (active) return { status: active, tone: "active", needsVerification, action };
  if (interruption) return { status: interruption.status, tone: "pending", needsVerification, action };
  if (!needsVerification) {
    const status = site.connection_state === "offline" ? "Verified · offline" : "Verified";
    return { status, tone: "ready", needsVerification, action };
  }
  let status = site.hash_status === "unscanned" ? "Not scanned" : "Verification pending";
  if (site.connection_state === "offline") status = "Offline";
  else if (site.pending_hash_count > 0) {
    const noun = site.pending_hash_count === 1 ? "hash" : "hashes";
    status = `${formatCount(site.pending_hash_count)} ${noun} pending`;
  }
  return { status, tone: "pending", needsVerification, action };
}
