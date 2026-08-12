import { formatBytes, formatCount, formatRelativeTime, percent } from "../lib/format";
import type { ScanProgressView, SiteOverview } from "../lib/types";
import { ChevronIcon, DriveIcon, NetworkIcon, ScanIcon } from "./Icons";

interface SiteCardProps {
  site: SiteOverview;
  progress?: ScanProgressView;
  active: boolean;
  onSelect: () => void;
  onScan: () => void;
  onCancel: (requestId: number) => void;
}

export function SiteCard({ site, progress, active, onSelect, onScan, onCancel }: SiteCardProps) {
  const isScanning = Boolean(progress) || ["queued", "discovering", "hashing", "finalizing"].includes(site.scan_state);
  const progressValue = progress ? percent(progress.processed_files, progress.total_files) : 0;
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
            <strong>{progress ? `${Math.round(progressValue)}%` : "Starting"}</strong>
          </div>
          <div className="progress-track"><span style={{ width: `${progress ? Math.max(3, progressValue) : 8}%` }} /></div>
          <p>
            {progress
              ? `${formatCount(progress.hashed_files)} hashed · ${formatCount(progress.reused_files)} reused`
              : "Preparing this site…"}
          </p>
        </div>
      ) : (
        <div className="site-stats">
          <div><span>Used</span><strong>{formatBytes(site.total_bytes)}</strong></div>
          <div><span>Files</span><strong>{formatCount(site.total_files)}</strong></div>
          <div className="reclaimable"><span>Reclaimable</span><strong>{formatBytes(site.duplicate_bytes)}</strong></div>
        </div>
      )}

      <footer className="site-card-footer">
        <span>{site.scan_state === "failed" ? "Last scan failed" : formatRelativeTime(site.last_scanned_at)}</span>
        <button
          className="icon-text-button"
          type="button"
          onClick={() => progress ? onCancel(progress.request_id) : onScan()}
          disabled={isScanning && !progress}
          aria-label={progress ? `Cancel scan of ${site.name}` : `Scan ${site.name}`}
        >
          <ScanIcon /> {progress ? "Cancel" : isScanning ? "Scanning" : "Scan"}
        </button>
      </footer>
    </article>
  );
}
