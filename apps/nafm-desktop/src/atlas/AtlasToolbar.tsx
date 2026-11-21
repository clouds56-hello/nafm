import { useLayoutEffect, useRef, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { formatCount } from "../lib/format";
import type { SiteOverview, StorageNode, WorkspaceSummary } from "../lib/types";
import { RefreshIcon, WorkspaceIcon } from "../management/Icons";
import { ToolbarDisclosure } from "./ToolbarDisclosure";
import "./atlas-toolbar.css";

const mapModes = [
  { value: "size", title: "Size" },
  { value: "space_health", title: "Space health" },
  { value: "coverage_health", title: "Coverage" },
] as const;

export type MapMode = (typeof mapModes)[number]["value"];

export interface AtlasToolbarProps {
  workspace: {
    name: string | null;
    options: readonly WorkspaceSummary[];
    disabled: boolean;
    onSwitch: (name: string) => void;
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
  };
  map: {
    mode: MapMode;
    onModeChange: (mode: MapMode) => void;
    targets: readonly SiteOverview[];
    target: SiteOverview | null;
    onTargetChange: (id: string) => void;
    onSwap: () => void;
    canScanTarget: boolean;
    onScanTarget: () => void;
  };
  actions: {
    ready: boolean;
    siteCount: number;
    activeScans: number;
    stagedCount: number;
    onScanAll: () => void;
    onReview: () => void;
    onSettings: () => void;
    onSources: () => void;
  };
  extension?: ReactNode;
}

function ToolbarIcon({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function FolderNavigation({ navigation }: Pick<AtlasToolbarProps, "navigation">) {
  const breadcrumbList = useRef<HTMLOListElement>(null);
  const current = navigation.breadcrumbs.at(-1);
  const parent = navigation.breadcrumbs.at(-2);

  useLayoutEffect(() => {
    const list = breadcrumbList.current;
    if (list) list.scrollLeft = list.scrollWidth;
  }, [current?.id]);

  return (
    <nav className="atlas-toolbar-navigation" aria-label="Folder path">
      {navigation.siteName && (
        <div className="atlas-toolbar-history">
          <button className="atlas-toolbar-button" type="button" title="Previous location" aria-label="Previous location" disabled={!navigation.canBack} onClick={navigation.onBack}>
            <ToolbarIcon><path d="M15 10H5m4-4-4 4 4 4" /></ToolbarIcon>
          </button>
          <button className="atlas-toolbar-button" type="button" title="Next location" aria-label="Next location" disabled={!navigation.canForward} onClick={navigation.onForward}>
            <ToolbarIcon><path d="M5 10h10m-4-4 4 4-4 4" /></ToolbarIcon>
          </button>
          {parent && (
            <button className="atlas-toolbar-button" type="button" title={`Up to ${parent.name}`} aria-label={`Up to ${parent.name}`} disabled={!navigation.canUp} onClick={navigation.onUp}>
              <ToolbarIcon><path d="M10 15V5m-4 4 4-4 4 4" /></ToolbarIcon>
            </button>
          )}
        </div>
      )}
      {current ? (
        <ol className="atlas-toolbar-breadcrumbs" ref={breadcrumbList}>
          {navigation.breadcrumbs.map((node, index) => {
            const name = node.name || navigation.siteName || "Storage";
            const item = node.id === current.id ? (
              <span className="atlas-toolbar-current" aria-current="location" title={name}>{name}</span>
            ) : (
              <button type="button" title={name} onClick={() => navigation.onBreadcrumb(node)}>{name}</button>
            );
            return (
              <li key={node.id}>
                {index > 0 && <span className="atlas-toolbar-separator" aria-hidden="true">/</span>}
                {index === 0 ? <h1>{item}</h1> : item}
              </li>
            );
          })}
        </ol>
      ) : (
        <h1 className="atlas-toolbar-site-fallback" title={navigation.siteName ?? undefined}>
          {navigation.siteName ?? "Explore your storage"}
        </h1>
      )}
    </nav>
  );
}

function MapOptions({ map }: Pick<AtlasToolbarProps, "map">) {
  return (
    <ToolbarDisclosure
      label="Map options"
      summary={mapModes.find(({ value }) => value === map.mode)?.title}
      icon={<ToolbarIcon><path d="M4 6h12M4 10h12M4 14h12" /><path d="M7 4v4m6 0v4m-5 0v4" /></ToolbarIcon>}
    >
      {(close) => (
        <>
          <p className="atlas-toolbar-panel-caption">Color by</p>
          <div className="atlas-toolbar-metrics" role="group" aria-label="Map metric">
            {mapModes.map(({ value, title }) => (
              <button
                key={value}
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
          {map.mode === "coverage_health" && (
            <div className="atlas-toolbar-comparison">
              <label>
                <span>Compare with</span>
                <select
                  value={map.target?.id ?? ""}
                  disabled={map.targets.length === 0}
                  onChange={(event) => map.onTargetChange(event.target.value)}
                >
                  {!map.target && <option value="">{map.targets.length ? "Choose a source" : "No other source"}</option>}
                  {map.targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}
                </select>
              </label>
              <button className="atlas-toolbar-panel-action" type="button" disabled={!map.target} onClick={map.onSwap}>
                <ToolbarIcon><path d="M4 7h12m-3-3 3 3-3 3M16 13H4m3-3-3 3 3 3" /></ToolbarIcon>
                Swap source and target
              </button>
              {map.target?.hash_status === "unscanned" && (
                <button className="atlas-toolbar-panel-action" type="button" disabled={!map.canScanTarget} onClick={map.onScanTarget}>
                  <RefreshIcon />
                  Scan target
                </button>
              )}
            </div>
          )}
        </>
      )}
    </ToolbarDisclosure>
  );
}

function WorkspaceActions({ actions, navigation }: Pick<AtlasToolbarProps, "actions" | "navigation">) {
  const parent = navigation.breadcrumbs.at(-2);
  return (
    <ToolbarDisclosure
      label="Workspace actions"
      summary={(
        <>
          Actions
          {(actions.activeScans > 0 || actions.stagedCount > 0) && <span className="atlas-toolbar-action-dot" aria-hidden="true" />}
        </>
      )}
      icon={<ToolbarIcon><circle cx="5" cy="10" r=".8" /><circle cx="10" cy="10" r=".8" /><circle cx="15" cy="10" r=".8" /></ToolbarIcon>}
    >
      {(close) => (
        <>
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
        </>
      )}
    </ToolbarDisclosure>
  );
}

export function AtlasToolbar({ workspace, navigation, map, actions, extension }: AtlasToolbarProps) {
  const hasTrafficLights = isTauri() && /Mac/.test(navigator.platform);
  return (
    <header className="atlas-toolbar" data-native-inset={hasTrafficLights || undefined} data-tauri-drag-region>
      <div className="atlas-toolbar-brand" data-tauri-drag-region>
        <span className="atlas-toolbar-orbit" aria-hidden="true" />
        <span className="atlas-toolbar-wordmark" data-tauri-drag-region>NAFM</span>
      </div>
      {workspace.name && (
        <label className="atlas-toolbar-workspace" title={workspace.name}>
          <WorkspaceIcon />
          <select aria-label="Workspace" value={workspace.name} disabled={workspace.disabled} onChange={(event) => workspace.onSwitch(event.target.value)}>
            {workspace.options.map((option) => <option key={option.name} value={option.name}>{option.name}</option>)}
          </select>
        </label>
      )}

      <FolderNavigation navigation={navigation} />

      <div className="atlas-toolbar-controls">
        {navigation.siteName && <MapOptions map={map} />}
        <WorkspaceActions actions={actions} navigation={navigation} />
        {extension}
      </div>
    </header>
  );
}
