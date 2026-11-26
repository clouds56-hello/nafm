import { useCallback, useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { isTauri } from "@tauri-apps/api/core";
import type { AtlasToolbarFocus, WorkspaceSwitchFailure } from "../hooks/useWorkspace";
import { formatCount } from "../lib/format";
import type { FolderOpenDestination, SiteOverview, StorageNode, WorkspaceSummary } from "../lib/types";
import { RefreshIcon, SearchIcon, WorkspaceIcon } from "../management/Icons";
import { ToolbarDisclosure } from "./ToolbarDisclosure";
import { FolderOpenControl } from "./FolderOpenControl";
import { FolderBreadcrumbs } from "./FolderBreadcrumbs";
import { LocationRecovery } from "./LocationRecovery";
import { ScanActivity, type ScanActivityProps } from "./ScanActivity";
import { CoverageScanActions } from "./CoverageScanActions";
import { CoverageReadout, type CoverageSummary } from "./CoverageReadout";
import type { SiteVerification } from "./siteVerification";
import { VerificationScanButton } from "./VerificationScanButton";
import "./atlas-toolbar.css";

const mapModes = [
  { value: "size", title: "Size" },
  { value: "space_health", title: "Space health" },
  { value: "coverage_health", title: "Coverage" },
] as const;

export type MapMode = (typeof mapModes)[number]["value"];

export interface AtlasToolbarExtension {
  label: string;
  icon: ReactNode;
  render: (close: () => void) => ReactNode;
}

export interface AtlasToolbarProps {
  workspace: {
    name: string | null;
    options: readonly WorkspaceSummary[];
    disabled: boolean;
    pending: boolean;
    failure: WorkspaceSwitchFailure | null;
    focusRequested: AtlasToolbarFocus | null;
    onSwitch: (name: string) => void;
    onDismissFailure: () => void;
    onFocusHandled: () => void;
  };
  navigation: {
    siteName: string | null;
    breadcrumbs: readonly StorageNode[];
    canBack: boolean;
    canForward: boolean;
    canUp: boolean;
    onBack: () => void;
    onForward: () => void;
    onUp: () => void;
    onBreadcrumb: (node: StorageNode) => void;
    onOpenFolder: (node: StorageNode, destination: FolderOpenDestination) => Promise<void>;
  };
  map: {
    mode: MapMode;
    onModeChange: (mode: MapMode) => void;
    targets: readonly SiteOverview[];
    target: SiteOverview | null;
    navigationBusy: boolean;
    navigationProgress?: string;
    spaceVerification: SiteVerification | null;
    sourceVerification: SiteVerification | null;
    targetVerification: SiteVerification | null;
    coverageReadout: CoverageSummary | null;
    recovery?: ReactNode;
    onOptionsOpenChange?: (open: boolean) => void;
    onTargetChange: (id: string, origin: HTMLSelectElement) => void;
    onSwap: (origin: HTMLButtonElement) => void;
    onScanSite: (siteId: string) => Promise<void>;
  };
  actions: {
    ready: boolean;
    siteCount: number;
    activeScans: number;
    stagedCount: number;
    canFind: boolean;
    onFind: () => void;
    onScanAll: () => void;
    onReview: () => void;
    onSettings: () => void;
    onSources: () => void;
  };
  scanActivity: ScanActivityProps;
  extension?: AtlasToolbarExtension;
}

function ToolbarIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function FolderNavigation({ navigation }: Pick<AtlasToolbarProps, "navigation">) {
  const current = navigation.breadcrumbs.at(-1);
  const parent = navigation.breadcrumbs.at(-2);
  const heading = useRef<HTMLHeadingElement>(null);
  const restoreFocus = useCallback((control: HTMLElement) => {
    if (document.activeElement !== control) return;
    queueMicrotask(() => {
      if (!control.isConnected && document.activeElement === document.body) {
        heading.current?.focus({ preventScroll: true });
      }
    });
  }, []);
  const upButton = useCallback((button: HTMLButtonElement | null) => {
    if (button) return () => restoreFocus(button);
  }, [restoreFocus]);

  return (
    <nav className="atlas-toolbar-navigation" aria-label="Folder path">
      {navigation.siteName && (
        <div className="atlas-toolbar-history">
          <button className="atlas-toolbar-button" type="button" title="Previous location" aria-label="Previous location"
            aria-disabled={!navigation.canBack} tabIndex={navigation.canBack ? 0 : -1}
            onClick={() => { if (navigation.canBack) navigation.onBack(); }}>
            <ToolbarIcon><path d="M15 10H5m4-4-4 4 4 4" /></ToolbarIcon>
          </button>
          <button className="atlas-toolbar-button" type="button" title="Next location" aria-label="Next location"
            aria-disabled={!navigation.canForward} tabIndex={navigation.canForward ? 0 : -1}
            onClick={() => { if (navigation.canForward) navigation.onForward(); }}>
            <ToolbarIcon><path d="M5 10h10m-4-4 4 4-4 4" /></ToolbarIcon>
          </button>
          {parent && (
            <button ref={upButton} className="atlas-toolbar-button" type="button" title={`Up to ${parent.name}`} aria-label={`Up to ${parent.name}`}
              aria-disabled={!navigation.canUp} tabIndex={navigation.canUp ? 0 : -1}
              onClick={() => { if (navigation.canUp) navigation.onUp(); }}>
              <ToolbarIcon><path d="M10 15V5m-4 4 4-4 4 4" /></ToolbarIcon>
            </button>
          )}
        </div>
      )}
      <FolderBreadcrumbs breadcrumbs={navigation.breadcrumbs} siteName={navigation.siteName} onNavigate={navigation.onBreadcrumb}
        canBack={navigation.canBack} canForward={navigation.canForward} canUp={navigation.canUp}
        heading={heading} onTriggerRemoved={restoreFocus} />
      {current && <FolderOpenControl node={current} onOpen={navigation.onOpenFolder} />}
    </nav>
  );
}

function MapOptions({ map, sourceName }: Pick<AtlasToolbarProps, "map"> & { sourceName: string }) {
  const mode = mapModes.find(({ value }) => value === map.mode)?.title;
  const picker = useRef<HTMLSelectElement>(null);
  const spaceMetric = useRef<HTMLButtonElement>(null);
  const progressId = useId();
  const progress = map.navigationBusy ? map.navigationProgress ?? "Updating comparison…" : undefined;
  const hasReadout = Boolean(progress || map.coverageReadout);
  const canSwap = map.target !== null && !map.navigationBusy;
  return (
    <ToolbarDisclosure
      label="Map options"
      description={map.mode === "coverage_health" && map.target ? `Coverage compared with ${map.target.name}` : mode}
      summary={map.mode === "coverage_health" && map.target
        ? <>{mode}<span className="atlas-toolbar-coverage-target" title={map.target.name}>→ {map.target.name}</span></>
        : mode}
      onOpenChange={map.onOptionsOpenChange}
      icon={<ToolbarIcon><path d="M4 6h12M4 10h12M4 14h12" /><path d="M7 4v4m6 0v4m-5 0v4" /></ToolbarIcon>}
    >
      {(close) => (
        <>
          <p className="atlas-toolbar-panel-caption">Color by</p>
          <div className="atlas-toolbar-metrics" role="group" aria-label="Map metric">
            {mapModes.map(({ value, title }) => (
              <button
                key={value}
                ref={value === "space_health" ? spaceMetric : undefined}
                type="button"
                aria-pressed={map.mode === value}
                onClick={() => {
                  map.onModeChange(value);
                  if (value !== "coverage_health") close();
                }}
              >
                {title}
              </button>
            ))}
          </div>
          {map.mode === "space_health" && map.spaceVerification?.action && (
            <div className="atlas-toolbar-comparison">
              <span className="atlas-toolbar-comparison-source">{map.spaceVerification.status}</span>
              <VerificationScanButton action={map.spaceVerification.action} onScanSite={map.onScanSite}
                className="atlas-toolbar-panel-action" focusTarget={spaceMetric} />
            </div>
          )}
          {map.mode === "coverage_health" && (
            <div className="atlas-toolbar-comparison">
              <span className="atlas-toolbar-comparison-source" title={sourceName}>From {sourceName}</span>
              <label>
                <span>Compare with</span>
                <select
                  ref={picker}
                  data-coverage-control="target"
                  value={map.target?.id ?? ""}
                  disabled={map.targets.length === 0}
                  aria-describedby={hasReadout ? progressId : undefined}
                  onChange={(event) => map.onTargetChange(event.currentTarget.value, event.currentTarget)}
                >
                  {!map.target && <option value="">{map.targets.length ? "Choose a source" : "No other source"}</option>}
                  {map.targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                </select>
              </label>
              {hasReadout && <CoverageReadout summary={map.coverageReadout} progress={progress} id={progressId} />}
              <button className="atlas-toolbar-panel-action" type="button" data-coverage-control="swap"
                aria-describedby={progress ? progressId : undefined}
                aria-disabled={!canSwap || undefined} onClick={canSwap ? (event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  map.onSwap(event.currentTarget);
                } : undefined}>
                <ToolbarIcon><path d="M4 7h12m-3-3 3 3-3 3M16 13H4m3-3-3 3 3 3" /></ToolbarIcon>
                Swap source and target
              </button>
              {map.recovery}
              {map.target && (
                <CoverageScanActions
                  actions={[map.sourceVerification?.action, map.targetVerification?.action]}
                  onScanSite={map.onScanSite} focusTarget={picker}
                  className="atlas-toolbar-verification-actions" buttonClassName="atlas-toolbar-panel-action"
                />
              )}
            </div>
          )}
        </>
      )}
    </ToolbarDisclosure>
  );
}

function WorkspacePicker({ workspace, inActions, selectRef }: Pick<AtlasToolbarProps, "workspace"> & {
  inActions?: boolean;
  selectRef?: RefObject<HTMLSelectElement | null>;
}) {
  if (!workspace.name) return null;
  return (
    <label className={inActions ? "atlas-actions-workspace" : "atlas-toolbar-workspace"} title={workspace.name}>
      {inActions ? <span>Workspace</span> : <WorkspaceIcon />}
      <select ref={selectRef} aria-label="Workspace" value={workspace.name} disabled={workspace.disabled}
        onChange={(event) => workspace.onSwitch(event.target.value)}>
        {workspace.options.map((option) => <option key={option.name} value={option.name}>{option.name}</option>)}
      </select>
    </label>
  );
}

function WorkspaceActions({ actions, navigation, workspace, extension, triggerRef }:
  Pick<AtlasToolbarProps, "actions" | "navigation" | "workspace" | "extension"> & { triggerRef: RefObject<HTMLButtonElement | null> }) {
  const parent = navigation.breadcrumbs.at(-2);
  return (
    <ToolbarDisclosure
      label="Workspace actions"
      triggerRef={triggerRef}
      summary={(
        <>
          Actions
          {actions.stagedCount > 0 && <span className="atlas-toolbar-action-dot" aria-hidden="true" />}
        </>
      )}
      icon={<ToolbarIcon><circle cx="5" cy="10" r=".8" /><circle cx="10" cy="10" r=".8" /><circle cx="15" cy="10" r=".8" /></ToolbarIcon>}
    >
      {(close) => (
        <>
          <button
            className="atlas-toolbar-panel-action atlas-compact-find" type="button" disabled={!actions.canFind}
            aria-haspopup="dialog" onClick={() => { close(); actions.onFind(); }}
          >
            <SearchIcon /> Find files
          </button>
          <button className="atlas-toolbar-panel-action" type="button" disabled={!actions.siteCount || actions.activeScans > 0} onClick={() => { close(); actions.onScanAll(); }}>
            <RefreshIcon />
            <span>Scan all</span>
            {actions.activeScans > 0 && <small>{formatCount(actions.activeScans)} active</small>}
          </button>
          <button className="atlas-toolbar-panel-action" type="button" disabled={!actions.ready} aria-haspopup="dialog" onClick={() => { close(); actions.onReview(); }}>
            <ToolbarIcon><path d="M6 5h8m-8 5h8m-8 5h5" /><rect x="3" y="2" width="14" height="16" rx="2" /></ToolbarIcon>
            <span>Review</span>
            {actions.stagedCount > 0 && <small>{formatCount(actions.stagedCount)} staged</small>}
          </button>
          <button className="atlas-toolbar-panel-action" type="button" aria-haspopup="dialog" onClick={() => { close(); actions.onSettings(); }}>
            <ToolbarIcon>
              <path d="m8 3 -1 .5 .2 1.6 -1.4 .9 -1.4 -.6 -1 1.7 1.1 1.2 -.2 1.6 -1.4 .7 .5 1.9 1.7 -.1 1.1 1.1 -.1 1.6 1.9 .5 .7 -1.4 1.6 -.2 1.2 1.1 1.7 -1 -.6 -1.4 .9 -1.4 1.6 .2 .5 -1.9 -1.5 -.7 -.2 -1.6 1.1 -1.2 -1 -1.7 -1.5 .6 -1.3 -.9 .1 -1.6 -1.9 -.5Z" />
              <circle cx="9.8" cy="9.5" r="2.2" />
            </ToolbarIcon>
            Settings
          </button>
          <button className="atlas-toolbar-panel-action" type="button" disabled={!actions.ready} aria-haspopup="dialog" onClick={() => { close(); actions.onSources(); }}>
            <WorkspaceIcon />
            <span>Sources</span>
            <small>{formatCount(actions.siteCount)}</small>
          </button>
          {navigation.siteName && (
            <div className="atlas-toolbar-compact-history" role="group" aria-label="Location history">
              <button className="atlas-toolbar-panel-action" type="button" disabled={!navigation.canBack} onClick={() => { close(); navigation.onBack(); }}>Previous location</button>
              <button className="atlas-toolbar-panel-action" type="button" disabled={!navigation.canForward} onClick={() => { close(); navigation.onForward(); }}>Next location</button>
              {parent && (
                <button className="atlas-toolbar-panel-action" type="button" disabled={!navigation.canUp} onClick={() => { close(); navigation.onUp(); }}>
                  Up to {parent.name}
                </button>
              )}
            </div>
          )}
          <WorkspacePicker workspace={{ ...workspace, onSwitch: (name) => { close(); workspace.onSwitch(name); } }} inActions />
          {extension && (
            <details className="atlas-actions-extension">
              <summary>{extension.label}</summary>
              {extension.render(close)}
            </details>
          )}
        </>
      )}
    </ToolbarDisclosure>
  );
}

export function AtlasToolbar({ workspace, navigation, map, actions, scanActivity, extension }: AtlasToolbarProps) {
  const hasTrafficLights = isTauri() && /Mac/.test(navigator.platform);
  const workspacePicker = useRef<HTMLSelectElement>(null);
  const workspaceActions = useRef<HTMLButtonElement>(null);
  const workspaceRecovery = useRef<HTMLDivElement>(null);
  const { pending, failure, focusRequested, onFocusHandled } = workspace;

  useLayoutEffect(() => {
    if (pending) return;
    if (document.activeElement === document.body) {
      if (focusRequested) {
        const picker = workspacePicker.current;
        const usePicker = focusRequested === "workspace" && picker && !picker.disabled && picker.getClientRects().length;
        const control = usePicker ? picker : workspaceActions.current;
        control?.focus({ preventScroll: true });
      } else if (failure) {
        workspaceRecovery.current?.querySelector<HTMLButtonElement>('button:not([aria-disabled="true"])')?.focus({ preventScroll: true });
      }
    }
    if (focusRequested) onFocusHandled();
  }, [pending, failure, focusRequested, onFocusHandled]);

  return (
    <header className="atlas-toolbar" data-native-inset={hasTrafficLights || undefined} data-tauri-drag-region>
      <div className="atlas-toolbar-brand" data-tauri-drag-region>
        <span className="atlas-toolbar-orbit" aria-hidden="true" />
        <span className="atlas-toolbar-wordmark" data-tauri-drag-region>NAFM</span>
      </div>
      <WorkspacePicker workspace={workspace} selectRef={workspacePicker} />
      {failure && (
        <div className="atlas-toolbar-workspace-recovery" ref={workspaceRecovery}>
          <LocationRecovery
            title={`Couldn’t switch to ${failure.name}`} message={failure.message}
            retrying={pending} retryDisabled={workspace.disabled}
            onRetry={() => workspace.onSwitch(failure.name)} onDismiss={workspace.onDismissFailure}
          />
        </div>
      )}

      <FolderNavigation navigation={navigation} />

      <div className="atlas-toolbar-controls">
        <button
          className="atlas-toolbar-button atlas-find-files-trigger" type="button" disabled={!actions.canFind}
          aria-label="Find files" aria-haspopup="dialog" aria-keyshortcuts="Control+F Meta+F"
          title="Find files" onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            actions.onFind();
          }}
        >
          <SearchIcon /><span className="atlas-toolbar-label">Find</span>
        </button>
        {navigation.siteName && <MapOptions map={map} sourceName={navigation.siteName} />}
        <ScanActivity {...scanActivity} />
        <WorkspaceActions actions={actions} navigation={navigation} workspace={workspace} extension={extension} triggerRef={workspaceActions} />
        {extension && (
          <ToolbarDisclosure label={extension.label} className="atlas-toolbar-extension" icon={extension.icon} summary={extension.label}>
            {extension.render}
          </ToolbarDisclosure>
        )}
      </div>
    </header>
  );
}
