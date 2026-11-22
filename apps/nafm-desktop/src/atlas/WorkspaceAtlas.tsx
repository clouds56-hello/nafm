import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ContentActions } from "./analysis/ContentActions";
import { ReviewDrawer } from "./analysis/ReviewDrawer";
import { AtlasInspector, type InspectorView } from "./AtlasInspector";
import { AtlasToolbar, type MapMode } from "./AtlasToolbar";
import { DirectoryContents } from "./DirectoryContents";
import { RadialAtlas } from "./RadialAtlas";
import { SiteRail } from "./SiteRail";
import { SourceLibrary } from "./SourceLibrary";
import { StorageDetails } from "./StorageDetails";
import { useDashboard } from "../hooks/useDashboard";
import type { useWorkspace } from "../hooks/useWorkspace";
import { metricAnalysisAvailability, siteAnalysisReady } from "../lib/analysis";
import { healthColor } from "../lib/format";
import { siteCompleteness } from "../lib/health";
import type { HealthMetric, StorageNode } from "../lib/types";

function EmptyOrbit({ label }: { label: string }) {
  return <div className="atlas-empty-orbit" role="status"><span>{label}</span></div>;
}

export function WorkspaceAtlas({
  workspace, toolbarExtension,
}: { workspace: ReturnType<typeof useWorkspace>; toolbarExtension?: ReactNode }) {
  const [sourcesView, setSourcesView] = useState<"browse" | "add" | null>(null);
  const [activePane, setActivePane] = useState<"sites" | InspectorView | null>(null);
  const inspectorOrigin = useRef<SVGGElement | null>(null);
  const inspectorView = activePane === "sites" ? null : activePane;
  const sourcesOpen = sourcesView !== null;
  const [mapMode, setMapMode] = useState<MapMode>("size");
  const state = useDashboard(workspace.management?.active_workspace.name ?? null);
  const { dashboard, activeSite: site, location, selectedNode, coverageTargetSite: target } = state;
  const folder = location?.root;
  const selected = selectedNode?.id === folder?.id ? null : selectedNode;
  const breadcrumbs = location?.breadcrumbs ?? [];
  const metric: HealthMetric | null = mapMode === "size" ? null : mapMode;
  const targetCompleteness = siteCompleteness(target);
  const targetOptions = dashboard?.sites.filter((candidate) => candidate.id !== site?.id) ?? [];
  const coverage = mapMode === "coverage_health";
  const analysis = site && metric ? metricAnalysisAvailability(metric, site, target) : null;
  const analysisNotice = analysis?.message ?? (coverage && !target ? "Add another source to compare coverage." : null);

  useEffect(() => {
    workspace.handleActiveTaskCountChange(state.activeTaskCount);
  }, [state.activeTaskCount, workspace.handleActiveTaskCountChange]);

  const closePane = useCallback(() => setActivePane(null), []);

  const { goBack, goForward, goUp, canGoBack, canGoForward, canGoUp } = state;
  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (event.defaultPrevented || sourcesOpen || state.reviewOpen || workspace.managementOpen) return;
      if (event.key === "Escape" && activePane && !document.querySelector("dialog[open]")) {
        event.preventDefault();
        closePane();
        return;
      }
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
  }, [activePane, canGoBack, canGoForward, canGoUp, closePane, goBack, goForward, goUp, sourcesOpen, state.reviewOpen, workspace.managementOpen]);

  function changeMode(mode: MapMode) {
    setMapMode(mode);
    state.setHealthMetric(mode === "coverage_health" ? "coverage_health" : "space_health");
  }

  function activateNode(node: StorageNode, origin?: SVGGElement) {
    state.selectNode(node);
    if (node.kind === "file" || (node.kind === "smaller_items" && !state.childrenLoading)) {
      if (origin) inspectorOrigin.current = origin;
      setActivePane(node.kind === "file" ? "details" : "contents");
    }
  }

  return (
    <div className="atlas-shell" data-overlay-open={activePane ? "" : undefined}>
      <AtlasToolbar
        workspace={{
          name: workspace.management?.active_workspace.name ?? null,
          options: workspace.management?.workspaces ?? [],
          disabled: state.activeTaskCount > 0 || workspace.workspaceSwitching,
          onSwitch: (name) => void workspace.quickSwitchWorkspace(name),
        }}
        navigation={{
          siteName: site?.name ?? null,
          breadcrumbs,
          canBack: canGoBack,
          canForward: canGoForward,
          canUp: canGoUp,
          onBack: goBack,
          onForward: goForward,
          onUp: goUp,
          onBreadcrumb: state.navigateBreadcrumb,
        }}
        map={{
          mode: mapMode,
          onModeChange: changeMode,
          targets: targetOptions,
          target,
          onTargetChange: (id) => void state.selectCoverageTarget(id),
          onSwap: () => void state.swapCoverageSites(),
          canScanTarget: Boolean(target && !state.scanBlockedSiteIds.has(target.id)),
          onScanTarget: () => { if (target) void state.scan(target.id); },
        }}
        actions={{
          ready: dashboard !== null,
          siteCount: dashboard?.sites.length ?? 0,
          activeScans: state.activeTaskCount,
          stagedCount: dashboard?.staged.length ?? 0,
          onScanAll: () => void state.scan(),
          onReview: () => state.setReviewOpen(true),
          onSettings: () => workspace.openManagement("workspaces"),
          onSources: () => setSourcesView("browse"),
        }}
        extension={toolbarExtension}
      />

      <main className="atlas-main">
        <section className="atlas-visualization" aria-label="Circular storage map">
          <SiteRail
            sites={dashboard?.sites ?? []}
            activeId={site?.id ?? null}
            scanRequests={state.scanRequestBySite}
            blockedIds={state.scanBlockedSiteIds}
            scanAllRequests={state.scanAllRequestIds}
            cancellingRequests={state.cancellingRequestIds}
            progressBySite={state.progressBySite}
            open={activePane === "sites"}
            restoreFocus={activePane === null}
            onOpen={() => setActivePane("sites")}
            onClose={closePane}
            onSelect={(id) => { void state.selectSite(id); closePane(); }}
            onScan={(id) => void state.scan(id)}
            onCancel={(id) => void state.cancel(id)}
            onAdd={() => setSourcesView("add")}
            onManage={(id) => workspace.openManagement("sites", id)}
          />
          <div className="atlas-chart-well">
            {folder ? (
              <RadialAtlas
                root={folder}
                parentName={breadcrumbs.at(-2)?.name}
                canGoUp={canGoUp}
                onGoUp={goUp}
                selectedId={selected?.id ?? null}
                metric={metric}
                targetCompleteness={targetCompleteness}
                onSelect={activateNode}
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
            ) : folder && (analysisNotice || metric) && (
              <>
                {analysisNotice && <p className="atlas-map-notice" role="status">{analysisNotice}</p>}
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
          {site && (
            <AtlasInspector
              view={inspectorView}
              initialView={selected?.kind === "file" ? "details" : "contents"}
              restoreFocus={activePane === null}
              origin={inspectorOrigin}
              onViewChange={setActivePane}
              onClose={closePane}
              details={location ? (
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
                <p className="atlas-inspector-status" role="status">
                  {state.treeError ? "Folder details are unavailable." : "Loading folder details…"}
                </p>
              )}
              contents={(
                <>
                  <DirectoryContents
                    location={location}
                    page={state.childrenPage}
                    selection={selected}
                    loading={state.childrenLoading}
                    error={state.childrenError}
                    onSelect={activateNode}
                    onPrevious={state.loadPreviousChildren}
                    onNext={state.loadNextChildren}
                    onRetry={state.retryChildren}
                  />
                  {!location && (
                    <p className="atlas-inspector-status" role="status">
                      {state.treeError ? "Folder contents are unavailable." : "Loading folder contents…"}
                    </p>
                  )}
                </>
              )}
            />
          )}
        </section>
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
