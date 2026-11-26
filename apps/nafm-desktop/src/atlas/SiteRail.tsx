import { useId, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { formatBytes, formatCount, percent } from "../lib/format";
import { scanRecovery, scanPhaseLabel, siteHasInventory } from "../lib/scanView";
import type { ScanInterruption, ScanProgressView, SiteOverview } from "../lib/types";
import { CloseIcon, DriveIcon, NetworkIcon, PlusIcon, RefreshIcon } from "../management/Icons";
import { restoreAtlasPanelFocus, revealInCompactAtlas } from "./compactAtlasScroll";
import { ScanActionButton } from "./ScanActionButton";
import { useAddedSiteRow, type AddedSiteRow } from "./useAddedSiteRow";
import "./site-rail.css";

interface SiteRailProps {
  open: boolean;
  sites: SiteOverview[];
  activeId: string | null;
  openingSiteId?: string;
  addedSite?: AddedSiteRow;
  switchRecovery?: { siteId: string; origin: HTMLButtonElement; content: ReactNode };
  startingSiteIds?: ReadonlySet<string>;
  scanRequests: ReadonlyMap<string, number>;
  blockedIds: ReadonlySet<string>;
  scanAllRequests: ReadonlySet<number>;
  cancellingRequests: ReadonlySet<number>;
  progressBySite: ReadonlyMap<string, ScanProgressView>;
  scanInterruptions: ReadonlyMap<string, ScanInterruption>;
  onOpen: () => void;
  onClose: () => void;
  onSelect: (id: string, origin: HTMLButtonElement) => void;
  onScan: (id: string) => void;
  onCancel: (requestId: number) => void;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  onManage: (id: string) => void;
}

function inventoryStatus(site: SiteOverview) {
  if (site.scan_state === "failed") return "Scan failed";
  if (site.connection_state === "offline") return "Offline";
  if (site.pending_hash_count > 0) {
    return `${formatCount(site.pending_hash_count)} ${site.pending_hash_count === 1 ? "hash" : "hashes"} pending`;
  }
  if (site.hash_status === "pending") return "Finalization pending";
  return site.hash_status === "ready" ? "Indexed" : "Awaiting scan";
}

function scanProgressValue(progress: ScanProgressView | undefined) {
  if (!progress) return undefined;
  if (progress.phase === "finalizing") return 100;
  if (progress.phase !== "hashing" || !progress.total_files) return undefined;
  return percent(progress.processed_files, progress.total_files);
}

export function SiteRail({
  open,
  sites,
  activeId,
  openingSiteId,
  addedSite,
  switchRecovery,
  startingSiteIds,
  scanRequests,
  blockedIds,
  scanAllRequests,
  cancellingRequests,
  progressBySite,
  scanInterruptions,
  onOpen,
  onClose,
  onSelect,
  onScan,
  onCancel,
  onAdd,
  onManage,
}: SiteRailProps) {
  const titleId = useId();
  const addedStatusId = useId();
  const rail = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const recoveryPanel = useRef<HTMLDivElement>(null);
  const wasOpen = useRef(open);

  useLayoutEffect(() => {
    if (open && !wasOpen.current) {
      const current = list.current?.querySelector<HTMLButtonElement>(".atlas-site-rail-select[aria-current]")
        ?? list.current?.querySelector<HTMLButtonElement>(".atlas-site-rail-select");
      revealInCompactAtlas(rail.current);
      (current ?? closeButton.current)?.focus();
    } else if (!open && wasOpen.current && document.activeElement === document.body) {
      restoreAtlasPanelFocus(trigger.current);
    }
    wasOpen.current = open;
  }, [open]);

  const addedButton = useAddedSiteRow(addedSite);

  const recoveryOrigin = switchRecovery?.origin;
  useLayoutEffect(() => {
    if (!open || !recoveryOrigin || document.activeElement !== recoveryOrigin) return;
    const next = recoveryPanel.current?.querySelector<HTMLButtonElement>(".atlas-location-retry, .atlas-location-dismiss");
    next?.focus({ preventScroll: true });
    next?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [open, recoveryOrigin]);

  function moveSite(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const buttons = list.current?.querySelectorAll<HTMLButtonElement>(".atlas-site-rail-select");
    if (!buttons?.length) return;
    let next: number;
    switch (event.key) {
      case "ArrowUp": next = Math.max(0, index - 1); break;
      case "ArrowDown": next = Math.min(index + 1, buttons.length - 1); break;
      case "Home": next = 0; break;
      case "End": next = buttons.length - 1; break;
      default: return;
    }
    event.preventDefault();
    buttons[next].focus();
  }

  if (!open) {
    return (
      <button
        className="atlas-sites-trigger"
        type="button"
        ref={trigger}
        aria-expanded={false}
        onClick={onOpen}
      >
        <DriveIcon />
        Sites
        <span aria-hidden="true">{formatCount(sites.length)}</span>
      </button>
    );
  }

  return (
    <aside className="atlas-site-rail" ref={rail} data-atlas-panel="sites" aria-labelledby={titleId}>
      <header className="atlas-site-rail-header">
        <h2 id={titleId}>Sites</h2>
        <span className="atlas-site-rail-count" aria-label={`${sites.length} sites`}>{formatCount(sites.length)}</span>
        <button
          className="atlas-site-rail-add"
          type="button"
          aria-label="Add site"
          aria-haspopup="dialog"
          title={blockedIds.size ? "Finish active scans to add a site" : "Add site"}
          disabled={!onAdd}
          onClick={onAdd}
        >
          <PlusIcon />
        </button>
        <button
          className="atlas-site-rail-close"
          type="button"
          ref={closeButton}
          aria-label="Close sites"
          onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onClose();
          }}
        >
          <CloseIcon />
        </button>
      </header>
      {sites.length === 0 ? <p className="atlas-site-rail-empty">No sites configured</p> : (
        <ul className="atlas-site-rail-list" ref={list}>
          {sites.map((site, index) => {
            const starting = startingSiteIds?.has(site.id) ?? false;
            const requestId = starting ? undefined : scanRequests.get(site.id);
            const scanning = requestId !== undefined;
            const stopping = scanning && cancellingRequests.has(requestId);
            const scanAll = scanning && scanAllRequests.has(requestId);
            const previousProgress = progressBySite.get(site.id);
            const progress = scanning && previousProgress?.request_id === requestId ? previousProgress : undefined;
            const progressValue = scanProgressValue(progress);
            const interruption = scanInterruptions.get(site.id);
            const kind = interruption?.kind ?? (site.scan_state === "failed" ? "failed" : undefined);
            const recovery = scanRecovery(kind === "cancelled" && interruption?.has_inventory ? undefined : kind);
            const hasInventory = siteHasInventory(site);
            const resuming = !recovery && hasInventory && site.hash_status === "pending";
            const scanUnavailable = starting || stopping || (!scanning && blockedIds.has(site.id));
            const status = starting ? "Starting scan…" : stopping ? "Stopping…" : progress ? scanPhaseLabel(progress.phase)
              : scanning ? "Starting scan…" : recovery?.status ?? inventoryStatus(site);
            const scanLabel = scanning
              ? scanAll ? "Stop all" : "Stop"
              : recovery?.shortAction ?? (resuming ? "Resume" : site.latest_inventory_at ? "Rescan" : "Scan");
            const scanActionLabel = stopping ? `Scan is stopping for ${site.name}`
              : scanning ? scanAll ? `Stop remaining scans from ${site.name}` : `Stop scan of ${site.name}`
                : recovery ? `${recovery.action} of ${site.name}`
                  : resuming ? `Resume verification of ${site.name}` : `Scan ${site.name}`;
            const justAdded = addedSite?.id === site.id;
            const showAdded = justAdded && !hasInventory && !starting && !scanning && !recovery && site.scan_state === "idle";
            const selected = activeId === site.id;
            const opening = openingSiteId === site.id;
            const openingId = `${titleId}-opening-${site.id}`;
            const siteRecovery = switchRecovery?.siteId === site.id ? switchRecovery.content : null;
            const recoveryId = `${titleId}-recovery-${site.id}`;
            const scanStartId = `${titleId}-scan-start-${site.id}`;
            const showOpening = opening && !siteRecovery;
            const DeviceIcon = site.kind === "smb" ? NetworkIcon : DriveIcon;

            return (
              <li key={site.id} className="atlas-site-rail-item" data-site-id={site.id} data-active={selected || undefined} data-added={showAdded || undefined}>
                <button
                  ref={justAdded ? addedButton : undefined}
                  className="atlas-site-rail-select"
                  type="button"
                  aria-current={selected || undefined}
                  aria-label={`Open ${site.name} in Atlas`}
                  aria-busy={opening || undefined}
                  aria-disabled={opening || undefined}
                  aria-describedby={[showAdded ? addedStatusId : null, showOpening ? openingId : null, siteRecovery ? recoveryId : null].filter(Boolean).join(" ") || undefined}
                  onKeyDown={(event) => moveSite(event, index)}
                  onClick={(event) => {
                    event.currentTarget.focus({ preventScroll: true });
                    if (!opening) onSelect(site.id, event.currentTarget);
                  }}
                >
                  <span className="atlas-site-rail-device"><DeviceIcon /></span>
                  <span className="atlas-site-rail-identity">
                    <strong title={site.name}>{site.name}</strong>
                    <span title={site.location}>{site.location}</span>
                  </span>
                </button>
                {showOpening && (
                  <p id={openingId} className="atlas-site-rail-opening" role="status" aria-label={`Opening ${site.name} in Atlas…`}>
                    Opening in Atlas…
                  </p>
                )}
                {siteRecovery && (
                  <div className="atlas-site-rail-recovery" id={recoveryId} ref={recoveryPanel}>{siteRecovery}</div>
                )}
                {hasInventory && (
                  <p className="atlas-site-rail-stats">
                    <span>{formatCount(site.total_files)} {site.total_files === 1 ? "file" : "files"}</span>
                    <span className="atlas-site-rail-divider" aria-hidden="true">·</span>
                    <span>{formatBytes(site.total_bytes)}</span>
                  </p>
                )}
                {scanning && (
                  <div className="atlas-site-rail-progress">
                    <progress
                      max={100}
                      value={progressValue}
                      aria-label={`Scan progress for ${site.name}`}
                      aria-valuetext={status}
                    />
                    {progress && (
                      <span title={progress.current_path ?? undefined}>
                        {formatCount(progress.processed_files)}
                        {progress.total_files !== null ? ` / ${formatCount(progress.total_files)}` : ""}
                        {" files"}
                      </span>
                    )}
                  </div>
                )}
                <div className="atlas-site-rail-footer">
                  <div className="atlas-site-rail-status" data-scanning={starting || scanning || undefined}>
                    {showAdded && <span id={addedStatusId} className="atlas-site-rail-added" role="status">Site added</span>}
                    <span id={starting ? scanStartId : undefined} role={starting ? "status" : undefined}
                      aria-label={starting ? `Starting scan of ${site.name}…` : undefined}
                      title={starting || scanning ? status : interruption?.message ?? status}>{status}</span>
                  </div>
                  <div className="atlas-site-rail-actions">
                    <ScanActionButton
                      className="atlas-site-rail-scan"
                      aria-label={scanActionLabel}
                      title={scanActionLabel}
                      aria-busy={starting || undefined}
                      unavailable={scanUnavailable}
                      aria-describedby={starting ? scanStartId : undefined}
                      onActivate={() => {
                        if (requestId === undefined) onScan(site.id);
                        else onCancel(requestId);
                      }}
                    >
                      {scanning ? <span className="atlas-site-rail-stop" aria-hidden="true" /> : <RefreshIcon />}
                      {scanLabel}
                    </ScanActionButton>
                    <button
                      className="atlas-site-rail-manage"
                      type="button"
                      aria-label={`Manage ${site.name}`}
                      title={`Manage ${site.name}`}
                      onClick={(event) => {
                        event.currentTarget.focus({ preventScroll: true });
                        onManage(site.id);
                      }}
                    >
                      <span aria-hidden="true">⋯</span>
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
