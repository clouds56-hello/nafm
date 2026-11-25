import { siteAnalysisReady } from "../lib/analysis";
import { formatCount } from "../lib/format";
import { scanRecovery, scanPhaseLabel } from "../lib/scanView";
import type { ScanInterruption, ScanProgressView, SiteOverview } from "../lib/types";

type CoverageRole = "source" | "target";

export type ScanSite = (siteId: string, onError?: (message: string) => void) => Promise<void>;

export interface SiteScanAction {
  siteId: string;
  label: string;
  shortLabel: string;
  startingLabel: string;
  startingShortLabel: string;
  disabled: boolean;
}

export interface SiteVerification {
  status: string;
  tone: "ready" | "active" | "pending";
  needsVerification: boolean;
  action?: SiteScanAction;
  failure?: string;
}

interface SiteScanState {
  running: boolean;
  stopping: boolean;
  blocked: boolean;
  progress?: ScanProgressView;
  interruption?: ScanInterruption;
  failure?: string;
  verificationRequired?: boolean;
}

function activeStatus(site: SiteOverview, scan: SiteScanState) {
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

function describeScanAction(
  site: SiteOverview, scan: SiteScanState, active: boolean,
  interruption: ReturnType<typeof scanRecovery>, role?: CoverageRole,
): SiteScanAction {
  const verb = interruption?.shortAction ?? (site.hash_status === "pending" ? "Resume" : "Scan");
  const inactiveLabel = interruption?.action ?? (verb === "Resume" ? "Resume verification" : "Scan this site");
  const roleLabel = role ? `${verb} ${role}` : inactiveLabel;
  const stopping = scan.stopping || site.scan_state === "cancelling";
  const activeLabel = stopping ? `Stopping ${role ?? "scan"}…` : role ? `Scanning ${role}…` : "Scanning…";
  return {
    siteId: site.id,
    label: active ? activeLabel : role && verb !== "Scan" ? `${roleLabel} scan` : roleLabel,
    shortLabel: active ? activeLabel : roleLabel,
    startingLabel: role ? `Starting ${role} scan…` : "Starting scan…",
    startingShortLabel: role ? `Starting ${role}…` : "Starting scan…",
    disabled: active || scan.blocked,
  };
}

export function siteVerification(site: SiteOverview, scan: SiteScanState, role?: CoverageRole): SiteVerification {
  const active = activeStatus(site, scan);
  const needsVerification = Boolean(scan.verificationRequired) || !siteAnalysisReady(site);
  const failure = scan.failure;
  const interruption = scanRecovery(scan.interruption?.kind ?? (failure || site.scan_state === "failed" ? "failed" : undefined));
  const action = needsVerification || interruption ? describeScanAction(site, scan, Boolean(active), interruption, role) : undefined;
  if (active) return { status: active, tone: "active", needsVerification, action };
  if (interruption) return { status: interruption.status, tone: "pending", needsVerification, action, failure };
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
