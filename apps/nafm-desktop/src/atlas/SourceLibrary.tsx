import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { formatBytes, formatCount } from "../lib/format";
import { scanRecovery, scanPhaseLabel, siteHasInventory } from "../lib/scanView";
import type { ScanInterruption, ScanProgressView, SiteOverview } from "../lib/types";
import { useAddedSiteRow, type AddedSiteRow } from "./useAddedSiteRow";
import "./sources.css";

interface SourceLibraryProps {
  sites: SiteOverview[];
  workspaceName: string | null;
  activeId: string | null;
  openingSiteId?: string;
  addedSite?: AddedSiteRow;
  onSelect: (id: string) => void;
  onClose: () => void;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  onScan: (site_id: string) => void;
  scanRequests: ReadonlyMap<string, number>;
  blockedIds: ReadonlySet<string>;
  scanAllRequests: ReadonlySet<number>;
  cancellingRequests: ReadonlySet<number>;
  progressBySite: ReadonlyMap<string, ScanProgressView>;
  scanInterruptions: ReadonlyMap<string, ScanInterruption>;
  onCancelScan: (requestId: number) => void;
  onManage: (site_id: string) => void;
  error?: string | null;
  errorAction?: { label: string; run: () => void };
  recovery?: ReactNode;
}

function inventoryLabel(site: SiteOverview, scanning: boolean): string {
  if (site.scan_state === "cancelling") return "Stopping";
  if (scanning) return "Scanning";
  if (site.connection_state === "offline") return "Offline";
  if (site.scan_state === "failed") return "Scan failed";
  if (site.hash_status === "pending") return "Hashes pending";
  if (site.hash_status === "ready") return "Indexed";
  return "Awaiting scan";
}

export function SourceLibrary({
  sites, workspaceName, activeId, openingSiteId, addedSite, onSelect, onClose, onAdd, onScan, scanRequests, blockedIds,
  scanAllRequests, cancellingRequests, progressBySite, scanInterruptions, onCancelScan, onManage, error, errorAction, recovery,
}: SourceLibraryProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const addedButton = useAddedSiteRow(addedSite);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement;
    dialog.showModal();
    headingRef.current?.focus();
    return () => {
      const active = document.activeElement;
      dialog.close();
      if ((active === document.body || dialog.contains(active)) && opener instanceof HTMLElement && opener.isConnected) {
        opener.focus({ preventScroll: true });
      }
    };
  }, []);

  return (
    <dialog className="source-library" ref={dialogRef} aria-labelledby="source-library-title" onCancel={(event) => {
      event.preventDefault();
      onClose();
    }}>
      <div className="source-window-drag" data-tauri-drag-region aria-hidden="true" />
      <div className="source-layout">
        <div className="source-route">
          <button type="button" className="source-back" onClick={onClose}><span aria-hidden="true">←</span> Atlas</button>
          {workspaceName && <span className="source-workspace" title={workspaceName}>{workspaceName}</span>}
        </div>
        <header className="source-header">
          <h1 id="source-library-title" ref={headingRef} tabIndex={-1}>Sources</h1>
          <button
            type="button"
            className="source-primary"
            aria-haspopup="dialog"
            disabled={!onAdd}
            onClick={onAdd}
          >
            <span aria-hidden="true">+</span> Add site
          </button>
        </header>
        {recovery ?? (error && (
          <div className="source-alert" role="alert">
            <p className="source-error">{error}</p>
            {errorAction && <button type="button" className="source-action" onClick={errorAction.run}>{errorAction.label}</button>}
          </div>
        ))}
        {blockedIds.size > 0 && <p className="source-scan-note" role="status">You can add sources when all scans finish.</p>}
        {sites.length > 0 ? (
          <section className="source-directory" aria-label="Storage sources">
            <div className="source-column-labels" aria-hidden="true">
              <span>Source</span>
              <span>Inventory</span>
              <span>Size</span>
              <span>Actions</span>
            </div>
            <ul className="source-list">
              {sites.map((site) => {
                const requestId = scanRequests.get(site.id);
                const scanning = requestId !== undefined;
                const stopping = scanning && cancellingRequests.has(requestId);
                const scanAll = scanning && scanAllRequests.has(requestId);
                const previousProgress = progressBySite.get(site.id);
                const progress = scanning && previousProgress?.request_id === requestId ? previousProgress : undefined;
                const interruption = scanInterruptions.get(site.id);
                const kind = interruption?.kind ?? (site.scan_state === "failed" ? "failed" : undefined);
                const scanRecoveryAction = scanRecovery(kind === "cancelled" && interruption?.has_inventory ? undefined : kind);
                const hasInventory = siteHasInventory(site);
                const resuming = !scanRecoveryAction && hasInventory && site.hash_status === "pending";
                const scanUnavailable = stopping || (!scanning && blockedIds.has(site.id));
                const scanLabel = stopping ? "Stopping…" : scanning ? scanAll ? "Stop all" : "Stop scan"
                  : scanRecoveryAction?.shortAction ?? (resuming ? "Resume" : site.latest_inventory_at ? "Rescan" : "Scan");
                const scanActionLabel = stopping ? `Scan is stopping for ${site.name}`
                  : scanning ? scanAll ? "Stop remaining scans" : `Stop scan of ${site.name}`
                    : scanRecoveryAction ? `${scanRecoveryAction.action} of ${site.name}`
                      : resuming ? `Resume verification of ${site.name}` : `Scan ${site.name}`;
                const justAdded = addedSite?.id === site.id;
                const showAdded = justAdded && !scanning && !scanRecoveryAction && site.scan_state === "idle" && !hasInventory;
                const opening = openingSiteId === site.id;
                const openingId = `source-opening-${site.id}`;
                return (
                  <li key={site.id} className="source-row" data-added={showAdded || undefined}>
                    <button
                      ref={justAdded ? addedButton : undefined}
                      type="button"
                      className="source-open"
                      aria-current={activeId === site.id ? "true" : undefined}
                      aria-label={`Open ${site.name} in Atlas`}
                      aria-busy={opening || undefined}
                      aria-disabled={opening || undefined}
                      aria-describedby={`source-location-${site.id} source-inventory-${site.id}${opening ? ` ${openingId}` : ""}`}
                      onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        if (!opening) onSelect(site.id);
                      }}
                    >
                      <span className="source-identity">
                        <span className="source-shape" data-kind={site.kind} aria-hidden="true" />
                        <span className="source-identifiers">
                          <strong title={site.name}>{site.name}</strong>
                          <small id={`source-location-${site.id}`} title={site.location}>{site.location}</small>
                        </span>
                      </span>
                      <span id={`source-inventory-${site.id}`} className="source-inventory" data-scanning={scanning}>
                        {showAdded && <span className="source-added" role="status">Site added</span>}
                        <span title={!scanning ? interruption?.message ?? undefined : undefined}>
                          {stopping ? "Stopping" : progress ? scanPhaseLabel(progress.phase)
                            : scanning ? inventoryLabel(site, true) : scanRecoveryAction?.status ?? inventoryLabel(site, false)}
                        </span>
                        {progress ? (
                          <small title={progress.current_path ?? undefined}>
                            {formatCount(progress.processed_files)}{progress.total_files === null ? "" : ` / ${formatCount(progress.total_files)}`} files
                          </small>
                        ) : hasInventory && <small>{formatCount(site.total_files)} files</small>}
                      </span>
                      <span className="source-size">{hasInventory ? formatBytes(site.total_bytes) : "—"}</span>
                    </button>
                    <div className="source-row-actions">
                      <button className="source-action" type="button" aria-label={scanActionLabel}
                        aria-disabled={scanUnavailable || undefined} onClick={(event) => {
                          event.currentTarget.focus({ preventScroll: true });
                          if (scanUnavailable) return;
                          if (requestId === undefined) onScan(site.id);
                          else onCancelScan(requestId);
                        }}>
                        {scanLabel}
                      </button>
                      <button className="source-action" type="button" aria-label={`Manage ${site.name}`} onClick={() => onManage(site.id)}>Manage</button>
                    </div>
                    {opening && (
                      <p id={openingId} className="source-opening" role="status" aria-label={`Opening ${site.name} in Atlas…`}>
                        Opening in Atlas…
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ) : (
          <div className="source-empty">
            <h2>{workspaceName ? "No sources yet" : "Workspace unavailable"}</h2>
            <p>{workspaceName ? "Add a local folder or an SMB share to start mapping its storage." : "Atlas needs an active workspace to load sources."}</p>
          </div>
        )}
      </div>
    </dialog>
  );
}
