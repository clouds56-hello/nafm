import { useEffect, useRef, useState } from "react";
import type { WorkspaceSummary } from "../lib/types";
import { CheckIcon, LayersIcon, PlusIcon, ScanIcon, SettingsIcon, WorkspaceIcon } from "./Icons";

interface AppHeaderProps {
  stagedCount: number;
  scanningTaskCount: number;
  cancellingTaskCount: number;
  workspaceName: string | null;
  workspaces: WorkspaceSummary[];
  managementLoading: boolean;
  workspaceSwitching: boolean;
  scanAvailable: boolean;
  reviewAvailable: boolean;
  onScanAll: () => void;
  onOpenReview: () => void;
  onSwitchWorkspace: (name: string) => void;
  onOpenManagement: () => void;
  onCreateWorkspace: () => void;
}

export function AppHeader({
  stagedCount,
  scanningTaskCount,
  cancellingTaskCount,
  workspaceName,
  workspaces,
  managementLoading,
  workspaceSwitching,
  scanAvailable,
  reviewAvailable,
  onScanAll,
  onOpenReview,
  onSwitchWorkspace,
  onOpenManagement,
  onCreateWorkspace,
}: AppHeaderProps) {
  const activeTaskCount = scanningTaskCount + cancellingTaskCount;
  const scanning = activeTaskCount > 0;
  const scanStatus = cancellingTaskCount === 0
    ? `Scanning ${scanningTaskCount}`
    : scanningTaskCount === 0
      ? cancellingTaskCount === 1 ? "Cancelling…" : `Cancelling ${cancellingTaskCount}`
      : `${scanningTaskCount} scanning · ${cancellingTaskCount} cancelling`;
  const scanStatusLabel = cancellingTaskCount === 0
    ? `${scanningTaskCount} scan ${scanningTaskCount === 1 ? "task" : "tasks"} running`
    : scanningTaskCount === 0
      ? `${cancellingTaskCount} scan ${cancellingTaskCount === 1 ? "task is" : "tasks are"} cancelling`
      : `${scanningTaskCount} scan ${scanningTaskCount === 1 ? "task" : "tasks"} running and ${cancellingTaskCount} cancelling`;
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!workspaceMenuOpen) return;
    function closeMenu(event: MouseEvent) {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) setWorkspaceMenuOpen(false);
    }
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setWorkspaceMenuOpen(false);
    }
    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeWithEscape);
    };
  }, [workspaceMenuOpen]);

  return (
    <header className="app-header">
      <div className="header-leading">
        <div className="brand" aria-label="NAFM home" data-tauri-drag-region>
          <span className="brand-mark"><span /></span>
          <span>NAFM</span>
        </div>
        <div className="workspace-switcher" ref={menuRef}>
          <button className="workspace-chip" type="button" onClick={() => setWorkspaceMenuOpen((open) => !open)} aria-haspopup="menu" aria-expanded={workspaceMenuOpen} disabled={managementLoading || workspaceSwitching}>
            <WorkspaceIcon /><span><small>Workspace</small><strong>{workspaceName ?? (managementLoading ? "Loading…" : "Unavailable")}</strong></span><span className="workspace-chip-chevron">⌄</span>
          </button>
          {workspaceMenuOpen && (
            <div className="workspace-menu" role="menu" aria-label="Switch workspace">
              <span className="workspace-menu-label">SWITCH WORKSPACE</span>
              {workspaces.map((workspace) => (
                <button key={workspace.name} type="button" role="menuitem" className={workspace.active ? "is-active" : ""} onClick={() => { setWorkspaceMenuOpen(false); onSwitchWorkspace(workspace.name); }} disabled={workspace.active || scanning}>
                  <span><strong>{workspace.name}</strong><small>{workspace.active ? "Current workspace" : workspace.path}</small></span>{workspace.active && <CheckIcon />}
                </button>
              ))}
              <button className="workspace-menu-create" type="button" role="menuitem" onClick={() => { setWorkspaceMenuOpen(false); onCreateWorkspace(); }}><PlusIcon />Create workspace</button>
            </div>
          )}
        </div>
      </div>
      <nav className="header-actions" aria-label="Workspace actions">
        <button className="ghost-button review-button" type="button" onClick={onOpenReview} disabled={!reviewAvailable}>
          <LayersIcon />
          Review
          {stagedCount > 0 && <span className="count-pill">{stagedCount}</span>}
        </button>
        <button className="icon-button header-settings" type="button" onClick={onOpenManagement} aria-label="Open Management Center"><SettingsIcon /></button>
        <button
          className="primary-button"
          type="button"
          onClick={onScanAll}
          disabled={scanning || !scanAvailable}
          aria-label={scanning ? scanStatusLabel : "Scan all sites"}
        >
          <ScanIcon />
          {scanning ? scanStatus : "Scan all"}
        </button>
      </nav>
    </header>
  );
}
