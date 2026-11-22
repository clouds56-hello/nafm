import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
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

interface ContentsVisit {
  view: InspectorView;
  pageKey: string;
  fileId: string;
  revealRevision: number;
}

function EmptyOrbit({ label }: { label: string }) {
  return <div className="atlas-empty-orbit" role="status"><span>{label}</span></div>;
}

// The empty-state launcher disappears when the first site arrives.
function focusSitesOnRemoval(button: HTMLButtonElement | null) {
  if (!button) return;
  return () => {
    if (document.activeElement !== button) return;
    button.closest("main")?.querySelector<HTMLButtonElement>(".atlas-sites-trigger, .atlas-site-rail-add")
      ?.focus({ preventScroll: true });
  };
}

interface WorkspaceAtlasProps {
  workspace: ReturnType<typeof useWorkspace>;
  siteListRevision: number;
  onAddSite: (event: MouseEvent<HTMLButtonElement>, workspaceName: string) => void;
  toolbarExtension?: ReactNode;
}

export function WorkspaceAtlas({ workspace, siteListRevision, onAddSite, toolbarExtension }: WorkspaceAtlasProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [pane, setPane] = useState<"sites" | InspectorView | ContentsVisit | null>(null);
  const visit = typeof pane === "object" ? pane : null;
  const activePane = typeof pane === "string" ? pane : visit?.view ?? null;
  const returnFocus = useRef(true);
  const inspectorOrigin = useRef<SVGGElement | null>(null);
  const inspectorView = activePane === "sites" ? null : activePane;
  const [mapMode, setMapMode] = useState<MapMode>("size");
  const state = useDashboard(workspace.management?.active_workspace.name ?? null, siteListRevision);
  const { dashboard, activeSite: site, location, selectedNode, coverageTargetSite: target } = state;
  const openAddSite = dashboard && state.activeTaskCount === 0
    ? (event: MouseEvent<HTMLButtonElement>) => onAddSite(event, dashboard.workspace_name)
    : undefined;

  const folder = location?.root;
  const selected = selectedNode?.id === folder?.id ? null : selectedNode;
  const pageKey = JSON.stringify([dashboard?.workspace_name, site?.id, target?.id, folder?.id, state.childrenPage?.offset]);
  const currentVisit = visit?.pageKey === pageKey && visit.fileId === selected?.id
    && visit.revealRevision === state.duplicateJumpRevision ? visit : null;
  // A new location or an exact-copy jump ends this list's local Back/Forward step.
  useEffect(() => {
    if (visit && !currentVisit) {
      setPane(visit.view === "details" && selected?.kind === "file" ? "details" : "contents");
    }
  }, [visit, currentVisit, selected?.kind]);
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

  const closePane = useCallback(() => {
    returnFocus.current = true;
    setPane(null);
  }, []);
  function dismissPane() {
    returnFocus.current = false;
    setPane(null);
  }

  const { goUp, canGoUp, goBack: backLocation, goForward: forwardLocation } = state;
  const fileOpen = currentVisit?.view === "details";
  const canGoBack = fileOpen || state.canGoBack;
  const canGoForward = currentVisit?.view === "contents" || state.canGoForward;
  const goBack = useCallback(() => {
    if (currentVisit?.view === "details") setPane({ ...currentVisit, view: "contents" });
    else backLocation();
  }, [currentVisit, backLocation]);
  const goForward = useCallback(() => {
    if (currentVisit?.view === "contents") setPane({ ...currentVisit, view: "details" });
    else forwardLocation();
  }, [currentVisit, forwardLocation]);
  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape" && activePane) {
        event.preventDefault();
        if (fileOpen) goBack();
        else closePane();
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
  }, [activePane, canGoBack, canGoForward, canGoUp, closePane, fileOpen, goBack, goForward, goUp]);

  function changeMode(mode: MapMode) {
    setMapMode(mode);
    state.setHealthMetric(mode === "coverage_health" ? "coverage_health" : "space_health");
  }

  function activateNode(node: StorageNode, origin?: SVGGElement) {
    state.selectNode(node);
    if (node.kind === "file" && !origin) {
      setPane({ view: "details", fileId: node.id, pageKey, revealRevision: state.duplicateJumpRevision });
    } else if (node.kind === "file" || node.kind === "smaller_items") {
      if (origin) inspectorOrigin.current = origin;
      setPane(node.kind === "file" ? "details" : "contents");
    } else if (origin && activePane === "sites") {
      dismissPane();
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
          onSources: () => setSourcesOpen(true),
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
            restoreFocus={activePane === null && returnFocus.current}
            onOpen={() => setPane("sites")}
            onClose={closePane}
            onSelect={(id) => { void state.selectSite(id); closePane(); }}
            onScan={(id) => void state.scan(id)}
            onCancel={(id) => void state.cancel(id)}
            onAdd={openAddSite}
            onManage={(id) => workspace.openManagement("sites", id)}
          />
          <div
            className="atlas-chart-well"
            aria-busy={state.childrenLoading || state.treeLoading || undefined}
            onClick={(event) => {
              if (activePane && event.target instanceof Element && !event.target.closest("button, [role=button], .atlas-sector-preview")) dismissPane();
            }}
          >
            {folder ? (
              <RadialAtlas
                root={folder}
                parentName={breadcrumbs.at(-2)?.name}
                canGoUp={canGoUp}
                onTouchPreview={dismissPane}
                onGoUp={goUp}
                selectedId={selected?.id ?? null}
                metric={metric}
                targetCompleteness={targetCompleteness}
                onSelect={activateNode}
              />
            ) : (
              <EmptyOrbit label={state.treeError || state.error ? "Map unavailable" : state.loading || state.treeLoading ? "Reading inventory" : "No source selected"} />
            )}
            {folder && (state.childrenLoading || state.treeLoading) && (
              <span className="atlas-location-progress" role="status">Reading inventory…</span>
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
                <button
                  ref={focusSitesOnRemoval}
                  className="atlas-text-button"
                  type="button"
                  aria-haspopup="dialog"
                  disabled={!openAddSite}
                  onClick={openAddSite}
                >Add site</button>
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
              key={site.id}
              detailsKey={selected?.id ?? folder?.id ?? null}
              contentsKey={pageKey}
              contentsFileId={currentVisit?.fileId ?? null}
              folderName={folder?.name}
              view={inspectorView}
              initialView={selected?.kind === "file" ? "details" : "contents"}
              restoreFocus={activePane === null && returnFocus.current}
              origin={inspectorOrigin}
              onViewChange={setPane}
              onBackToContents={goBack}
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
                    onGoUp={goUp}
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
          sites={dashboard?.sites ?? []}
          workspaceName={dashboard?.workspace_name ?? null}
          activeId={site?.id ?? null}
          onSelect={(id) => { void state.selectSite(id); setSourcesOpen(false); }}
          onClose={() => setSourcesOpen(false)}
          onAdd={openAddSite}
          scanRequests={state.scanRequestBySite}
          blockedIds={state.scanBlockedSiteIds}
          scanAllRequests={state.scanAllRequestIds}
          cancellingRequests={state.cancellingRequestIds}
          progressBySite={state.progressBySite}
          onScan={(id) => void state.scan(id)}
          onCancelScan={(id) => void state.cancel(id)}
          onManage={(id) => { setSourcesOpen(false); workspace.openManagement("sites", id); }}
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
