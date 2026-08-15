import { formatBytes, formatCount, formatRelativeTime, percent } from "../lib/format";
import { isActiveScanState } from "../lib/scanView";
import type { ScanCompletionView, ScanProgressView, SiteOverview } from "../lib/types";
import { CheckIcon, ChevronIcon, DriveIcon, MoreIcon, NetworkIcon, ScanIcon } from "./Icons";

interface SiteCardProps {
  site: SiteOverview;
  progress?: ScanProgressView;
  completion?: ScanCompletionView;
  scanRequestId?: number;
  scanAll: boolean;
  cancelling: boolean;
  backendScanActive: boolean;
  scanBlocked: boolean;
  active: boolean;
  onSelect: () => void;
  onScan: () => void;
  onCancel: (requestId: number) => void;
  onManage: () => void;
}

function scanPhaseLabel(state: ScanProgressView["phase"] | SiteOverview["scan_state"] | undefined): string {
  switch (state) {
    case "discovering": return "Indexing";
    case "publishing_metadata": return "Publishing inventory";
    case "hashing": return "Hashing";
    case "finalizing": return "Finalizing";
    case "cancelling": return "Cancelling";
    case "queued": return "Queued";
    default: return "Preparing";
  }
}

export function SiteCard({
  site,
  progress,
  completion,
  scanRequestId,
  scanAll,
  cancelling,
  backendScanActive,
  scanBlocked,
  active,
  onSelect,
  onScan,
  onCancel,
  onManage,
}: SiteCardProps) {
  const backendStateActive = isActiveScanState(site.scan_state);
  const isScanning = Boolean(progress) || cancelling || (backendScanActive && backendStateActive);
  const phase = progress?.phase;
  const hashProgress = progress?.total_files
    ? percent(progress.processed_files, progress.total_files)
    : 0;
  const progressValue = !progress || phase === "discovering" || phase === "publishing_metadata"
    ? null
    : phase === "hashing" ? hashProgress : 100;
  const roundedProgressValue = progressValue === null ? null : Math.round(progressValue);
  const progressCounters = progress
    ? phase === "discovering"
      ? `${formatCount(progress.processed_files)} files found`
      : phase === "publishing_metadata"
        ? `Saving ${formatCount(progress.total_files ?? progress.processed_files)} file records`
        : `${formatCount(progress.total_files ?? progress.processed_files)} indexed · ${formatCount(progress.hashes_pending)} hashes pending`
    : "Preparing this site…";
  const phaseLabel = scanPhaseLabel(phase ?? site.scan_state);
  const progressValueText = roundedProgressValue !== null
    ? `${roundedProgressValue}% complete, ${progressCounters}${cancelling ? ", cancellation requested" : ""}`
    : `${cancelling ? "Cancellation requested" : phaseLabel}, ${progressCounters}`;
  const cancelCopy = scanAll ? "Cancel remaining" : "Cancel";
  const cancelAriaLabel = cancelling
    ? scanAll ? "Cancelling remaining sites in Scan all" : `Cancelling scan of ${site.name}`
    : scanAll ? "Cancel remaining sites in Scan all" : `Cancel scan of ${site.name}`;
  const completionCopy = completion?.status === "indexed"
    ? completion.pending_files > 0
      ? `Indexed · ${formatCount(completion.pending_files)} ${completion.pending_files === 1 ? "hash" : "hashes"} pending`
      : "Indexed · finalization pending"
    : completion?.source === "event"
      ? `${formatCount(completion.hashed_files ?? 0)} hashed · ${formatCount(completion.reused_files ?? 0)} reused`
      : completion
        ? `Indexed · ${formatCount(completion.total_files)} files`
        : null;
  const completionValue = completion?.status === "complete"
    ? 100
    : completion && completion.total_files > 0
      ? percent(completion.total_files - completion.pending_files, completion.total_files)
      : 0;
  const hashesReady = site.hash_status === "ready" && site.pending_hash_count === 0;
  const SiteIcon = site.kind === "smb" ? NetworkIcon : DriveIcon;

  return (
    <article className={`site-card ${active ? "is-active" : ""}`}>
      <button className="site-card-main" type="button" onClick={onSelect} aria-pressed={active}>
        <span className={`site-icon ${site.kind}`}><SiteIcon /></span>
        <span className="site-identity">
          <span className="site-name-row">
            <strong>{site.name}</strong>
            <span className={`connection-dot ${site.connection_state}`} aria-label={site.connection_state} />
          </span>
          <span className="site-location" title={site.location}>{site.location}</span>
        </span>
        <ChevronIcon className="chevron" />
      </button>

      {isScanning ? (
        <div className={`site-progress ${cancelling ? "is-cancelling" : ""}`} aria-live="polite">
          <div className="progress-copy">
            <span>
              <span className={cancelling ? "cancelling-dot" : "pulse-dot"} />
              {cancelling ? "Cancelling…" : phaseLabel}
            </span>
            <strong>{roundedProgressValue !== null ? `${roundedProgressValue}%` : cancelling ? "Waiting" : "Starting"}</strong>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label={`Scan progress for ${site.name}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={roundedProgressValue ?? undefined}
            aria-valuetext={progressValueText}
          >
            <span style={{ width: `${progressValue === null ? 8 : Math.max(3, progressValue)}%` }} />
          </div>
          <p>{progressCounters}</p>
        </div>
      ) : (
        <>
          <div className="site-stats">
            <span>{formatBytes(site.total_bytes)}</span>
            <span>{formatCount(site.total_files)} files</span>
            <strong className={hashesReady ? "" : "analysis-pending"}>
              {hashesReady
                ? `${formatBytes(site.duplicate_bytes)} reclaimable`
                : site.pending_hash_count > 0
                  ? `${formatCount(site.pending_hash_count)} hashes pending`
                  : "Analysis unavailable"}
            </strong>
          </div>
          {completion && completionCopy && (
            <div
              className={`site-progress site-completion ${completion.status === "indexed" ? "is-indexed" : ""}`}
              role={completion.should_announce ? "status" : undefined}
              aria-atomic={completion.should_announce ? "true" : undefined}
            >
              <div className="progress-copy">
                <span>
                  {completion.should_announce && <span className="sr-only">{`Scan of ${site.name} `}</span>}
                  <span className="completion-check">
                    {completion.status === "complete" ? <CheckIcon /> : <ScanIcon />}
                  </span>
                  {completion.status === "complete" ? "Complete" : "Indexed"}
                </span>
                <strong>
                  {completion.status === "complete"
                    ? "100%"
                    : completion.pending_files > 0 ? `${formatCount(completion.pending_files)} pending` : "Finalizing"}
                </strong>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-label={`Last scan result for ${site.name}`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(completionValue)}
                aria-valuetext={completion.status === "complete" ? `Complete, ${completionCopy}` : completionCopy}
              ><span style={{ width: `${completionValue}%` }} /></div>
              <p>{completionCopy}</p>
            </div>
          )}
        </>
      )}

      <footer className="site-card-footer">
        <span>
          {site.scan_state === "failed"
            ? "Last scan failed"
            : site.hash_status === "ready"
              ? formatRelativeTime(site.last_scanned_at)
              : site.latest_inventory_at
                ? `Indexed ${formatRelativeTime(site.latest_inventory_at)}`
                : "Not indexed yet"}
        </span>
        <span className="site-card-actions">
          <button className="site-more-button" type="button" onClick={onManage} aria-label={`Manage ${site.name}`}><MoreIcon /></button>
          <button
            className={`icon-text-button ${cancelling ? "is-cancelling" : ""}`}
            type="button"
            onClick={() => scanRequestId !== undefined ? onCancel(scanRequestId) : onScan()}
            disabled={cancelling || (scanRequestId === undefined && (isScanning || scanBlocked))}
            aria-label={isScanning ? cancelAriaLabel : `Scan ${site.name}`}
          >
            <ScanIcon /> {cancelling ? "Cancelling…" : scanRequestId !== undefined ? cancelCopy : isScanning ? "Scanning" : "Scan"}
          </button>
        </span>
      </footer>
    </article>
  );
}
