import { formatBytes, formatCount, formatRelativeTime, percent } from "../lib/format";
import { isActiveScanState } from "../lib/scanView";
import type { ScanCompletionView, ScanProgressView, SiteOverview } from "../lib/types";
import { CheckIcon, ChevronIcon, DriveIcon, MoreIcon, NetworkIcon, ScanIcon } from "./Icons";

interface SiteCardProps {
  site: SiteOverview;
  progress?: ScanProgressView;
  completion?: ScanCompletionView;
  backendScanActive: boolean;
  scanBlocked: boolean;
  active: boolean;
  onSelect: () => void;
  onScan: () => void;
  onCancel: (requestId: number) => void;
  onManage: () => void;
}

export function SiteCard({
  site,
  progress,
  completion,
  backendScanActive,
  scanBlocked,
  active,
  onSelect,
  onScan,
  onCancel,
  onManage,
}: SiteCardProps) {
  const backendStateActive = isActiveScanState(site.scan_state);
  const isScanning = Boolean(progress) || (backendScanActive && backendStateActive);
  const progressValue = progress ? percent(progress.processed_files, progress.total_files) : 0;
  const completionCopy = completion?.source === "event"
    ? `${formatCount(completion.hashed_files ?? 0)} hashed · ${formatCount(completion.reused_files ?? 0)} reused`
    : completion
      ? `Indexed · ${formatCount(completion.total_files)} files`
      : null;
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
        <div className="site-progress" aria-live="polite">
          <div className="progress-copy">
            <span><span className="pulse-dot" />{progress?.phase ?? site.scan_state}</span>
            <strong>{progress && progress.total_files > 0 ? `${Math.round(progressValue)}%` : "Starting"}</strong>
          </div>
          <div className="progress-track"><span style={{ width: `${progress ? Math.max(3, progressValue) : 8}%` }} /></div>
          <p>
            {progress
              ? `${formatCount(progress.hashed_files)} hashed · ${formatCount(progress.reused_files)} reused`
              : "Preparing this site…"}
          </p>
        </div>
      ) : (
        <>
          <div className="site-stats">
            <span>{formatBytes(site.total_bytes)}</span>
            <span>{formatCount(site.total_files)} files</span>
            <strong>{formatBytes(site.duplicate_bytes)} reclaimable</strong>
          </div>
          {completion && completionCopy && (
            <div
              className="site-progress site-completion"
              role={completion.should_announce ? "status" : undefined}
              aria-atomic={completion.should_announce ? "true" : undefined}
            >
              <div className="progress-copy">
                <span>
                  {completion.should_announce && <span className="sr-only">{`Scan of ${site.name} `}</span>}
                  <span className="completion-check"><CheckIcon /></span>Complete
                </span>
                <strong>100%</strong>
              </div>
              <div className="progress-track"><span /></div>
              <p>{completionCopy}</p>
            </div>
          )}
        </>
      )}

      <footer className="site-card-footer">
        <span>{site.scan_state === "failed" ? "Last scan failed" : formatRelativeTime(site.last_scanned_at)}</span>
        <span className="site-card-actions">
          <button className="site-more-button" type="button" onClick={onManage} aria-label={`Manage ${site.name}`}><MoreIcon /></button>
          <button
            className="icon-text-button"
            type="button"
            onClick={() => progress ? onCancel(progress.request_id) : onScan()}
            disabled={!progress && (isScanning || scanBlocked)}
            aria-label={progress ? `Cancel scan of ${site.name}` : `Scan ${site.name}`}
          >
            <ScanIcon /> {progress ? "Cancel" : isScanning ? "Scanning" : "Scan"}
          </button>
        </span>
      </footer>
    </article>
  );
}
