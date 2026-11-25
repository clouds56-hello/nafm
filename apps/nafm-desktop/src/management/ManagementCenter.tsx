import { useEffect, useRef, useState, type MouseEvent } from "react";
import type { ManagementMutationResult, ManagementSnapshot } from "../lib/types";
import { ConnectionsSection } from "./ConnectionsSection";
import { CloseIcon, DriveIcon, NetworkIcon, RefreshIcon, WarningIcon, WorkspaceIcon } from "./Icons";
import { SitesSection } from "./SitesSection";
import type { SiteAddition } from "./siteAddition";
import { WorkspaceSection } from "./WorkspaceSection";
import "./management.css";

const sections = [
  { id: "workspaces", label: "Workspaces", Icon: WorkspaceIcon },
  { id: "sites", label: "Sites", Icon: DriveIcon },
  { id: "connections", label: "Connections", Icon: NetworkIcon },
] as const;

export type ManagementSection = typeof sections[number]["id"];

interface ManagementCenterProps {
  open: boolean;
  section: ManagementSection;
  selectedSiteId: string | null;
  snapshot: ManagementSnapshot | null;
  loading: boolean;
  error: string | null;
  activeTaskCount: number;
  siteAddition?: SiteAddition;
  onClose: () => void;
  onSectionChange: (section: ManagementSection) => void;
  onSelectedSiteChange: (siteId: string | null) => void;
  onAddSite: (event: MouseEvent<HTMLButtonElement>, workspaceName: string) => void;
  onBusyChange: (busy: boolean) => void;
  onMutation: (result: ManagementMutationResult, dashboardChanged: boolean) => void;
  onRetry: () => void;
}

export function ManagementCenter(props: ManagementCenterProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const { open, section, snapshot, onBusyChange } = props;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) {
      setBusy(false);
      return;
    }
    dialog.showModal();
    return () => dialog.close();
  }, [open]);

  useEffect(() => onBusyChange(open && busy), [busy, onBusyChange, open]);

  useEffect(() => {
    if (contentRef.current) contentRef.current.scrollTop = 0;
  }, [section]);

  if (!open) return null;
  const scansActive = props.activeTaskCount > 0;

  return (
    <dialog
      className="management-dialog"
      ref={dialogRef}
      aria-labelledby="management-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <div className="management-layout">
        <header className="management-header">
          <div>
            <h1 id="management-title">Settings</h1>
            {snapshot && <p title={snapshot.active_workspace.name}>{snapshot.active_workspace.name}</p>}
          </div>
          <button
            autoFocus
            className="icon-button"
            type="button"
            onClick={props.onClose}
            disabled={busy}
            aria-label="Close settings"
          >
            <CloseIcon />
          </button>
        </header>
        <nav className="management-nav" aria-label="Settings sections">
          {sections.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              aria-current={section === id ? "page" : undefined}
              onClick={() => props.onSectionChange(id)}
              disabled={busy}
            >
              <Icon />{label}
            </button>
          ))}
        </nav>
        <div className="management-content" ref={contentRef} aria-busy={props.loading || undefined}>
          {snapshot ? (
            <>
              {scansActive && section !== "connections" && (
                <p className="management-scan-note" role="status">
                  <RefreshIcon /> Finish active scans to change workspaces or sites.
                </p>
              )}
              {props.error && (
                <div className="management-banner" role="alert">
                  <WarningIcon /><span>{props.error}</span>
                  <button type="button" className="ghost-button" onClick={props.onRetry}>Refresh</button>
                </div>
              )}
              {section === "workspaces" && (
                <WorkspaceSection snapshot={snapshot} busy={busy || scansActive} setBusy={setBusy} onMutation={props.onMutation} />
              )}
              {section === "sites" && (
                <SitesSection
                  snapshot={snapshot}
                  selectedSiteId={props.selectedSiteId}
                  siteAddition={props.siteAddition}
                  busy={busy || scansActive}
                  setBusy={setBusy}
                  onSelectedSiteChange={props.onSelectedSiteChange}
                  onAddSite={props.onAddSite}
                  onMutation={props.onMutation}
                />
              )}
              {section === "connections" && (
                <ConnectionsSection
                  snapshot={snapshot}
                  busy={busy}
                  scansActive={scansActive}
                  setBusy={setBusy}
                  onMutation={props.onMutation}
                />
              )}
            </>
          ) : props.loading ? (
            <div className="management-empty" role="status"><span className="mini-spinner" /> Loading settings…</div>
          ) : props.error ? (
            <div className="management-empty is-error">
              <WarningIcon /><h2>Settings unavailable</h2><p role="alert">{props.error}</p>
              <button className="secondary-button" type="button" onClick={props.onRetry}>Try again</button>
            </div>
          ) : null}
        </div>
      </div>
    </dialog>
  );
}
