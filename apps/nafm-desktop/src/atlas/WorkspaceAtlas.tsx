import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { ContentActions } from "./analysis/ContentActions";
import { ReviewDrawer } from "./analysis/ReviewDrawer";
import { DirectoryContents } from "./DirectoryContents";
import { RadialAtlas } from "./RadialAtlas";
import { SiteRail } from "./SiteRail";
import { SourceLibrary } from "./SourceLibrary";
import { StorageDetails } from "./StorageDetails";
import { useDashboard } from "../hooks/useDashboard";
import type { useWorkspace } from "../hooks/useWorkspace";
import { metricAnalysisAvailability, siteAnalysisReady } from "../lib/analysis";
import { formatCount, healthColor } from "../lib/format";
import { siteCompleteness } from "../lib/health";
import type { HealthMetric } from "../lib/types";

const mapModes = [
  { value: "size", title: "Size" },
  { value: "space_health", title: "Space health" },
  { value: "coverage_health", title: "Coverage" },
] as const;

type MapMode = (typeof mapModes)[number]["value"];

function EmptyOrbit({ label }: { label: string }) {
  return <div className="atlas-empty-orbit" role="status"><span>{label}</span></div>;
}

export function WorkspaceAtlas({ workspace }: { workspace: ReturnType<typeof useWorkspace> }) {
  const [sourcesView, setSourcesView] = useState<"browse" | "add" | null>(null);
  const sourcesOpen = sourcesView !== null;
  const [mapMode, setMapMode] = useState<MapMode>("size");
  const state = useDashboard(workspace.management?.active_workspace.name ?? null);
  const { dashboard, activeSite: site, location, selectedNode, coverageTargetSite: target } = state;
  const folder = location?.root;
  const selected = selectedNode?.id === folder?.id ? null : selectedNode;
  const breadcrumbs = location?.breadcrumbs ?? [];
  const parent = breadcrumbs.at(-2);
  const hasTrafficLights = isTauri() && /Mac/.test(navigator.platform);
  const metric: HealthMetric | null = mapMode === "size" ? null : mapMode;
  const targetCompleteness = siteCompleteness(target);
  const targetOptions = dashboard?.sites.filter((candidate) => candidate.id !== site?.id) ?? [];
  const coverage = mapMode === "coverage_health";
  const analysis = site && metric ? metricAnalysisAvailability(metric, site, target) : null;

  useEffect(() => {
    workspace.handleActiveTaskCountChange(state.activeTaskCount);
  }, [state.activeTaskCount, workspace.handleActiveTaskCountChange]);

  const { goBack, goForward, goUp, canGoBack, canGoForward, canGoUp } = state;
  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (event.defaultPrevented || sourcesOpen || state.reviewOpen || workspace.managementOpen) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, dialog, [contenteditable]")) return;
      if (((event.altKey && event.key === "ArrowLeft") || (event.metaKey && event.key === "[")) && canGoBack) {
        event.preventDefault();
        goBack();
      } else if (((event.altKey && event.key === "ArrowRight") || (event.metaKey && event.key === "]")) && canGoForward) {
        event.preventDefault();
        goForward();
      } else if ((event.altKey || event.metaKey) && event.key === "ArrowUp" && canGoUp) {
        event.preventDefault();
        goUp();
      }
    }
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [canGoBack, canGoForward, canGoUp, goBack, goForward, goUp, sourcesOpen, state.reviewOpen, workspace.managementOpen]);

  function changeMode(mode: MapMode) {
    setMapMode(mode);
    state.setHealthMetric(mode === "coverage_health" ? "coverage_health" : "space_health");
  }

  return (
    <div className="atlas-shell">
      <header className={`atlas-topbar${hasTrafficLights ? " atlas-native-inset" : ""}`} data-tauri-drag-region>
        <div className="atlas-brand" data-tauri-drag-region>
          <span className="atlas-brand-symbol" aria-hidden="true" />
          <span data-tauri-drag-region>NAFM</span>
        </div>
        <span className="atlas-topbar-rule" aria-hidden="true" />
        {workspace.management && (
          <select
            className="atlas-workspace-switch"
            aria-label="Workspace"
            value={workspace.management.active_workspace.name}
            disabled={state.activeTaskCount > 0 || workspace.workspaceSwitching}
            onChange={(event) => void workspace.quickSwitchWorkspace(event.target.value)}
          >
            {workspace.management.workspaces.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}
          </select>
        )}
        <div className="atlas-drag-space" data-tauri-drag-region />
        <div className="atlas-top-actions">
          <button className="atlas-top-action" type="button" onClick={() => void state.scan()} disabled={!dashboard?.sites.length || state.activeTaskCount > 0}>
            Scan all<span className="atlas-top-action-status">{state.activeTaskCount > 0 ? ` · ${state.activeTaskCount} active` : ""}</span>
          </button>
          <button className="atlas-top-action" type="button" onClick={() => state.setReviewOpen(true)} disabled={!dashboard} aria-haspopup="dialog">
            Review{Boolean(dashboard?.staged.length) && <span> · {dashboard?.staged.length}</span>}
          </button>
          <button className="atlas-top-action" type="button" onClick={() => workspace.openManagement("workspaces")} aria-haspopup="dialog">Settings</button>
          <button
            className="atlas-sources-button"
            type="button"
            onClick={() => setSourcesView("browse")}
            disabled={!dashboard}
            aria-haspopup="dialog"
            aria-expanded={sourcesOpen}
          >
            <span className="atlas-source-glyph" aria-hidden="true"><i /><i /><i /></span>
            Sources
            {dashboard && <span className="atlas-source-count">{formatCount(dashboard.sites.length)}</span>}
          </button>
        </div>
      </header>

      <main className="atlas-main">
        <SiteRail
          sites={dashboard?.sites ?? []}
          activeId={site?.id ?? null}
          scanRequests={state.scanRequestBySite}
          blockedIds={state.scanBlockedSiteIds}
          scanAllRequests={state.scanAllRequestIds}
          cancellingRequests={state.cancellingRequestIds}
          progressBySite={state.progressBySite}
          onSelect={(id) => void state.selectSite(id)}
          onScan={(id) => void state.scan(id)}
          onCancel={(id) => void state.cancel(id)}
          onAdd={() => setSourcesView("add")}
          onManage={(id) => workspace.openManagement("sites", id)}
        />

        <div className="atlas-workspace" data-inspecting={site ? "" : undefined}>
          <header className="atlas-heading">
            <div className="atlas-heading-identity">
              <p className="atlas-kicker">Storage map</p>
              <h1 id="atlas-site-heading" title={site?.name}>{site?.name ?? "Explore your storage"}</h1>
            </div>
            {site && (
              <div className="atlas-map-controls">
                <div className="atlas-map-modes" role="group" aria-label="Map metric">
                  {mapModes.map(({ value, title }) => (
                    <button key={value} type="button" aria-pressed={mapMode === value} onClick={() => changeMode(value)}>
                      {title}
                    </button>
                  ))}
                </div>
                {coverage && (
                  <div className="atlas-coverage-controls">
                    <label>
                      <span>Compare with</span>
                      <select
                        value={target?.id ?? ""}
                        disabled={targetOptions.length === 0}
                        onChange={(event) => void state.selectCoverageTarget(event.target.value)}
                      >
                        {(!target || targetOptions.length === 0) && <option value="">No other source</option>}
                        {targetOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
                      </select>
                    </label>
                    <button className="atlas-text-button" type="button" disabled={!target} onClick={() => void state.swapCoverageSites()}>
                      Swap source and target
                    </button>
                    {target?.hash_status === "unscanned" && (
                      <button className="atlas-text-button" type="button" disabled={state.scanBlockedSiteIds.has(target.id)} onClick={() => void state.scan(target.id)}>
                        Scan target
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </header>

          <section className="atlas-visualization" aria-label="Circular storage map">
            <div className="atlas-map-top">
              {folder && (
                <nav className="atlas-crumbs" aria-label="Folder path">
                  <div className="atlas-history">
                    <button type="button" aria-label="Previous location" disabled={!canGoBack} onClick={goBack}>←</button>
                    <button type="button" aria-label="Next location" disabled={!canGoForward} onClick={goForward}>→</button>
                    {parent && <button type="button" aria-label={`Up to ${parent.name}`} disabled={!canGoUp} onClick={goUp}>↑</button>}
                  </div>
                  <ol>
                    {breadcrumbs.map((crumb, index) => (
                      <li key={crumb.id}>
                        {index > 0 && <span className="atlas-crumb-divider" aria-hidden="true">/</span>}
                        {index === breadcrumbs.length - 1 ? (
                          <span className="atlas-crumb-current" aria-current="location" title={crumb.name}>{crumb.name}</span>
                        ) : (
                          <button type="button" onClick={() => state.navigateBreadcrumb(crumb)} title={crumb.name}>{crumb.name}</button>
                        )}
                      </li>
                    ))}
                  </ol>
                </nav>
              )}
              {(analysis?.message || (coverage && !target)) && (
                <p className="atlas-map-notice" role="status">{analysis?.message ?? "Add another source to compare coverage."}</p>
              )}
            </div>

            <div className="atlas-chart-well">
              {folder ? (
                <RadialAtlas
                  root={folder}
                  selectedId={selected?.id ?? null}
                  metric={metric}
                  targetCompleteness={targetCompleteness}
                  onSelect={state.selectNode}
                />
              ) : (
                <EmptyOrbit label={state.treeError || state.error ? "Map unavailable" : state.loading || state.treeLoading ? "Reading inventory" : "No source selected"} />
              )}
            </div>

            <footer className="atlas-map-footer">
              {state.treeError || state.error ? (
                <div className="atlas-view-error" role="alert">
                  <span>{state.treeError ?? state.error}</span>
                  <button className="atlas-text-button" type="button" onClick={() => void (state.treeError ? state.retryTree() : state.refresh())}>Try again</button>
                </div>
              ) : dashboard && !site ? (
                <div className="atlas-map-empty-help">
                  <span>Add a folder or network share to map its files.</span>
                  <button className="atlas-text-button" type="button" onClick={() => setSourcesView("add")}>Add a source</button>
                </div>
              ) : folder && (
                <>
                  <p className="atlas-map-guide">
                    {folder.total_bytes > 0 ? "Arc length shows size." : "Arc length shows file count."} Each ring goes one level deeper.
                  </p>
                  {metric && (
                    <div className="atlas-health-key" role="group" aria-label="Health scale runs from 0 to 100. Gray indicates pending or unavailable data.">
                      <span>0</span>
                      <i aria-hidden="true" style={{ background: `linear-gradient(90deg, ${healthColor(0)}, ${healthColor(50)}, ${healthColor(100)})` }} />
                      <span>100</span>
                      <span>Gray: pending or unavailable</span>
                    </div>
                  )}
                </>
              )}
            </footer>
          </section>

          {site && (
            <aside className="atlas-inspector" aria-label="Inspector">
              {location ? (
                <StorageDetails
                  location={location}
                  entries={state.childrenPage?.children ?? []}
                  selected={selected}
                  focusRevision={state.duplicateJumpRevision}
                  metric={metric}
                  targetCompleteness={targetCompleteness}
                  targetName={target?.name ?? null}
                >
                  {dashboard && selectedNode && (
                    <ContentActions
                      workspaceName={dashboard.workspace_name}
                      siteId={site.id}
                      contentRevision={state.contentRevision}
                      node={selectedNode}
                      metric={state.healthMetric}
                      sourceAnalysisReady={siteAnalysisReady(site)}
                      staged={state.isSelectedStaged}
                      stagingBusy={state.stagingBusy}
                      onStage={() => void state.stageSelected()}
                      onUnstage={() => { if (selectedNode.path) void state.removeStaged(selectedNode.path); }}
                      onJumpDuplicate={(match) => void state.jumpToContentMatch(match)}
                    />
                  )}
                </StorageDetails>
              ) : (
                <p className="atlas-inspector-status" role="status">{state.treeError ? "Folder details are unavailable." : "Loading folder details…"}</p>
              )}
              <DirectoryContents
                location={location}
                page={state.childrenPage}
                selection={selected}
                loading={state.childrenLoading}
                error={state.childrenError}
                onSelect={state.selectNode}
                onPrevious={state.loadPreviousChildren}
                onNext={state.loadNextChildren}
                onRetry={state.retryChildren}
              />
            </aside>
          )}
        </div>
      </main>


      {state.notice && !sourcesOpen && !state.reviewOpen && (
        <div className="atlas-alert" role="status">
          <span>{state.notice}</span>
          <button className="atlas-text-button" type="button" onClick={state.clearNotice}>Dismiss</button>
        </div>
      )}

      {sourcesOpen && (
        <SourceLibrary
          initiallyAdding={sourcesView === "add"}
          sites={dashboard?.sites ?? []}
          workspaceName={dashboard?.workspace_name ?? null}
          activeId={site?.id ?? null}
          onSelect={(id) => { void state.selectSite(id); setSourcesView(null); }}
          onClose={() => setSourcesView(null)}
          onChanges={() => { void state.refresh(); void workspace.refreshManagement(true); }}
          scanRequests={state.scanRequestBySite}
          blockedIds={state.scanBlockedSiteIds}
          scanAllRequests={state.scanAllRequestIds}
          cancellingRequests={state.cancellingRequestIds}
          progressBySite={state.progressBySite}
          onScan={(id) => void state.scan(id)}
          onCancelScan={(id) => void state.cancel(id)}
          onManage={(id) => { setSourcesView(null); workspace.openManagement("sites", id); }}
          error={state.notice ?? state.error}
          errorAction={state.notice
            ? { label: "Dismiss", run: state.clearNotice }
            : { label: "Retry", run: () => void state.refresh() }}
        />
      )}
      {dashboard && (
        <ReviewDrawer
          open={state.reviewOpen}
          staged={dashboard.staged}
          hashesPending={dashboard.staged_hashes_pending}
          cleanupReady={dashboard.staged_cleanup_ready}
          warnings={dashboard.staged_warnings}
          preview={state.preview}
          loadingPreview={state.previewLoading}
          error={state.reviewError}
          stagingBusy={state.stagingBusy}
          onClose={() => state.setReviewOpen(false)}
          onPreview={() => void state.runPreview()}
          onRemove={(path) => void state.removeStaged(path)}
        />
      )}
    </div>
  );
}
