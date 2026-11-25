import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { ContentActions } from "./analysis/ContentActions";
import { ReviewDrawer } from "./analysis/ReviewDrawer";
import { AtlasInspector, type InspectorView } from "./AtlasInspector";
import { AtlasToolbar, type MapMode } from "./AtlasToolbar";
import { CoverageFooter } from "./CoverageFooter";
import { DirectoryContents } from "./DirectoryContents";
import { RadialAtlas } from "./RadialAtlas";
import { SiteRail } from "./SiteRail";
import { SourceLibrary } from "./SourceLibrary";
import { StorageDetails } from "./StorageDetails";
import { useDashboard } from "../hooks/useDashboard";
import { useDirectorySearch } from "./useDirectorySearch";
import type { useWorkspace } from "../hooks/useWorkspace";
import { siteAnalysisReady, spaceHealthNotice } from "../lib/analysis";
import { healthColor } from "../lib/format";
import { nodeHealthPresentation, siteCompleteness } from "../lib/health";
import type { DirectorySort, FileContentMatch, FolderSimilarityMatch, HealthMetric, StorageNode } from "../lib/types";

interface ContentsVisit {
  view: InspectorView;
  contentsKey: string;
  fileId: string;
  revealRevision: number;
}

type InspectorPane = InspectorView | ContentsVisit;

function directoryKey(
  workspace: string | undefined, site: string | undefined, target: string | null | undefined, folder: string | undefined,
  sort: DirectorySort, anchor: number,
) {
  return JSON.stringify([workspace, site, target, folder, sort.field, sort.direction, anchor]);
}

function EmptyOrbit({ label }: { label: string }) {
  return <div className="atlas-empty-orbit" role="status"><span>{label}</span></div>;
}

function HealthScale() {
  return (
    <div className="atlas-health-key" role="group" aria-label="Health scale runs from 0 to 100. Gray indicates pending or unavailable data.">
      <span>0</span>
      <i aria-hidden="true" style={{ background: `linear-gradient(90deg, ${healthColor(0)}, ${healthColor(50)}, ${healthColor(100)})` }} />
      <span>100</span>
      <span>Gray: pending or unavailable</span>
    </div>
  );
}

interface WorkspaceAtlasProps {
  workspace: ReturnType<typeof useWorkspace>;
  siteListRevision: number;
  onAddSite: (event: MouseEvent<HTMLButtonElement>, workspaceName: string) => void;
  toolbarExtension?: ReactNode;
}

export function WorkspaceAtlas({ workspace, siteListRevision, onAddSite, toolbarExtension }: WorkspaceAtlasProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorBySite, setInspectorBySite] = useState(() => new Map<string, InspectorPane>());
  const lastOpened = useRef<"sites" | "inspector">("inspector");
  const mapRegion = useRef<HTMLElement>(null);
  const contentsPane = useRef<HTMLDivElement>(null);
  const contentsScroll = useRef(new Map<string, number | "end">());
  const focusFirstSite = useRef(false);
  const inspectorOrigin = useRef<SVGGElement | null>(null);
  const pendingReveal = useRef<AbortController | null>(null);
  const [revealingFileId, setRevealingFileId] = useState<string | null>(null);
  const [revealedRow, setRevealedRow] = useState<{ key: string; id: string } | null>(null);
  const [analysisFocusRevision, setAnalysisFocusRevision] = useState(0);
  const [folderSearch, setFolderSearch] = useState<{ scope: string; text: string } | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>("size");
  const state = useDashboard(workspace.management?.active_workspace.name ?? null, siteListRevision);
  const { dashboard, activeSite: site, location, selectedNode, coverageTargetSite: target } = state;
  const siteId = site?.id;
  const pane = inspectorOpen && siteId ? inspectorBySite.get(siteId) ?? "contents" : null;
  const visit = typeof pane === "object" ? pane : null;
  const inspectorView = typeof pane === "string" ? pane : visit?.view ?? null;

  const rememberPane = useCallback((next: InspectorPane) => {
    if (!siteId) return;
    setInspectorBySite((saved) => saved.get(siteId) === next ? saved : new Map(saved).set(siteId, next));
  }, [siteId]);
  const openInspector = useCallback((next: InspectorPane) => {
    lastOpened.current = "inspector";
    setRevealedRow(null);
    rememberPane(next);
    setInspectorOpen(true);
  }, [rememberPane]);
  const closeInspector = useCallback(() => {
    pendingReveal.current?.abort();
    setRevealedRow(null);
    setInspectorOpen(false);
  }, []);
  const openAddSite = dashboard && state.activeTaskCount === 0
    ? (event: MouseEvent<HTMLButtonElement>) => onAddSite(event, dashboard.workspace_name)
    : undefined;

  const folder = location?.root;
  const searchScope = JSON.stringify([dashboard?.workspace_name, location?.site_id, folder?.id]);
  const searchText = folderSearch?.scope === searchScope ? folderSearch.text : null;
  const searchQuery = searchText?.trim() ?? "";
  const search = useDirectorySearch({
    scope: searchScope,
    siteId: location?.site_id,
    targetId: target?.id,
    folderId: folder?.id,
    query: searchQuery,
    sort: state.directorySort,
    contentRevision: state.contentRevision,
  });
  const directoryPage = search.enabled ? search.page : state.childrenPage;

  useEffect(() => {
    if (folderSearch && folderSearch.scope !== searchScope) setFolderSearch(null);
  }, [folderSearch, searchScope]);
  const requestId = site ? state.scanRequestBySite.get(site.id) : undefined;
  const siteRoot = state.activeTree?.root;
  const awaitingInventory = site && site.hash_status === "unscanned" && !site.latest_inventory_at
    && !site.last_scanned_at && site.total_files === 0;
  // The dashboard can publish counts before the first navigable tree reaches the view.
  const awaitingTree = site && requestId !== undefined && site.total_files > 0 && siteRoot?.file_count === 0;
  const firstScan = site && siteRoot?.children.length && (awaitingInventory || awaitingTree)
    ? {
      requestId,
      progress: state.progressBySite.get(site.id),
      stopping: requestId !== undefined && state.cancellingRequestIds.has(requestId),
      scanAll: requestId !== undefined && state.scanAllRequestIds.has(requestId),
      blocked: state.scanBlockedSiteIds.has(site.id),
      failed: site.scan_state === "failed",
      onScan: () => state.scan(site.id),
      onCancel: (id: number) => void state.cancel(id),
    } : undefined;
  const selected = selectedNode?.id === folder?.id ? null : selectedNode;
  function contentsKeyFor(sort: DirectorySort, anchor: number) {
    return directoryKey(dashboard?.workspace_name, siteId, target?.id, folder?.id, sort, anchor);
  }
  const baseContentsKey = contentsKeyFor(state.directorySort, state.contentsAnchorOffset);
  const contentsKey = search.enabled ? JSON.stringify([baseContentsKey, searchQuery]) : baseContentsKey;
  function changeSearch(text: string | null) {
    const query = text?.trim();
    if (query && query !== searchQuery) contentsScroll.current.delete(JSON.stringify([baseContentsKey, query]));
    setFolderSearch(text === null ? null : { scope: searchScope, text });
  }
  useLayoutEffect(() => () => pendingReveal.current?.abort(), [inspectorView, siteId, selected?.id]);
  useEffect(() => {
    if (revealedRow && revealedRow.key !== contentsKey) setRevealedRow(null);
  }, [contentsKey, revealedRow]);
  function changeDirectorySort(sort: DirectorySort) {
    contentsScroll.current.delete(contentsKeyFor(sort, 0));
    return state.setDirectorySort(sort);
  }
  const currentVisit = visit?.contentsKey === contentsKey && visit.fileId === selected?.id
    && visit.revealRevision === state.duplicateJumpRevision ? visit : null;
  // A new location or an exact-copy jump ends this list's local Back/Forward step.
  useEffect(() => {
    if (visit && !currentVisit) {
      const view = visit.view === "details" && selected?.kind === "file" ? "details" : "contents";
      rememberPane(view);
    }
  }, [visit, currentVisit, selected?.kind, rememberPane]);

  const emptyLauncherRef = useCallback((button: HTMLButtonElement | null) => {
    if (button) return () => { focusFirstSite.current = document.activeElement === button; };
  }, []);

  useLayoutEffect(() => {
    // The empty-state launcher can disappear a render before the first site's map arrives.
    if (!focusFirstSite.current || (!folder && !state.error && !state.treeError)) return;
    focusFirstSite.current = false;
    if (document.activeElement !== document.body) return;
    const next = mapRegion.current?.querySelector<HTMLButtonElement>(".atlas-site-rail-add, .radial-atlas__scan-action, .atlas-view-error button")
      ?? mapRegion.current?.querySelector<HTMLButtonElement>(".atlas-sites-trigger");
    next?.focus({ preventScroll: true });
  }, [folder, state.error, state.treeError]);
  const breadcrumbs = location?.breadcrumbs ?? [];
  const metric: HealthMetric | null = mapMode === "size" ? null : mapMode;
  const targetCompleteness = siteCompleteness(target);
  const targetOptions = dashboard?.sites.filter((candidate) => candidate.id !== site?.id) ?? [];
  const coverage = mapMode === "coverage_health";
  const folderCoverage = folder && coverage ? nodeHealthPresentation(folder, "coverage_health", targetCompleteness) : null;
  const analysisNotice = site && metric === "space_health" ? spaceHealthNotice(site) : null;
  const targetScanning = Boolean(target && state.scanRequestBySite.has(target.id));
  const canScanTarget = Boolean(target && !state.scanBlockedSiteIds.has(target.id));
  const changeCoverageTarget = (id: string) => void state.selectCoverageTarget(id);
  const swapCoverageSites = () => { if (site && target) void selectSite(target.id, site.id); };
  const scanCoverageTarget = () => { if (target) void state.scan(target.id); };
  function coverageScan(id: string) {
    const progress = state.progressBySite.get(id);
    return progress?.request_id === state.scanRequestBySite.get(id) ? progress : undefined;
  }

  useEffect(() => {
    workspace.handleActiveTaskCountChange(state.activeTaskCount);
  }, [state.activeTaskCount, workspace.handleActiveTaskCountChange]);

  async function selectSite(id: string, comparisonSiteId?: string) {
    if (!await state.selectSite(id, comparisonSiteId)) return;
    setSourcesOpen(false);
  }

  const { goUp, canGoUp, goBack: backLocation, goForward: forwardLocation } = state;
  const fileOpen = currentVisit?.view === "details";
  const canGoBack = fileOpen || state.canGoBack;
  const canGoForward = currentVisit?.view === "contents" || state.canGoForward;
  const goBack = useCallback(() => {
    if (currentVisit?.view === "details") openInspector({ ...currentVisit, view: "contents" });
    else backLocation();
  }, [currentVisit, backLocation, openInspector]);
  const goForward = useCallback(() => {
    if (currentVisit?.view === "contents") openInspector({ ...currentVisit, view: "details" });
    else forwardLocation();
  }, [currentVisit, forwardLocation, openInspector]);
  useEffect(() => {
    function navigate(event: KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (event.key === "Escape" && (sitesOpen || inspectorView)) {
        event.preventDefault();
        const panel = event.target instanceof Element ? event.target.closest("[data-atlas-panel]") : null;
        const active = panel?.getAttribute("data-atlas-panel") ?? lastOpened.current;
        if (sitesOpen && (active === "sites" || !inspectorView)) setSitesOpen(false);
        else if (fileOpen) goBack();
        else closeInspector();
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
  }, [sitesOpen, inspectorView, canGoBack, canGoForward, canGoUp, fileOpen, goBack, goForward, goUp, closeInspector]);

  async function showFileInContents(file: StorageNode) {
    if (pendingReveal.current && !pendingReveal.current.signal.aborted) return;
    const attempt = new AbortController();
    pendingReveal.current = attempt;
    setRevealingFileId(file.id);
    try {
      const destination = await state.revealSelectedFileInContents(file.id, () => !attempt.signal.aborted);
      if (!destination || attempt.signal.aborted) return;
      const key = directoryKey(
        dashboard?.workspace_name, destination.site_id, destination.target_site_id, destination.node_id,
        destination.sort, destination.anchor_offset,
      );
      // A previous visit to this directory may have scrolled away from the file.
      contentsScroll.current.set(key, destination.anchor_offset);
      setFolderSearch(null);
      inspectorOrigin.current = null;
      openInspector("contents");
      setRevealedRow({ key, id: file.id });
    } finally {
      if (pendingReveal.current === attempt) {
        pendingReveal.current = null;
        setRevealingFileId(null);
      }
    }
  }

  function showAnalysisDetails(siteId: string) {
    inspectorOrigin.current = null;
    lastOpened.current = "inspector";
    setRevealedRow(null);
    setInspectorBySite((saved) => new Map(saved).set(siteId, "details"));
    setInspectorOpen(true);
    setAnalysisFocusRevision((revision) => revision + 1);
  }

  async function showCopyInAtlas(match: FileContentMatch, signal: AbortSignal) {
    const error = await state.jumpToContentMatch(match, signal);
    if (error === null) showAnalysisDetails(match.site_id);
    return error;
  }

  async function showSimilarFolderInAtlas(match: FolderSimilarityMatch, signal: AbortSignal) {
    const error = await state.jumpToSimilarFolder(match, signal);
    if (error === null) showAnalysisDetails(match.folder.site_id);
    return error;
  }

  function changeMode(mode: MapMode) {
    setMapMode(mode);
    state.setHealthMetric(mode === "coverage_health" ? "coverage_health" : "space_health");
  }

  function activateNode(node: StorageNode, origin?: SVGGElement) {
    state.selectNode(node);
    if (node.kind === "file" && !origin) {
      openInspector({ view: "details", fileId: node.id, contentsKey, revealRevision: state.duplicateJumpRevision });
    } else if (node.kind === "file" || node.kind === "smaller_items") {
      if (origin) inspectorOrigin.current = origin;
      openInspector(node.kind === "file" ? "details" : "contents");
    }
  }

  return (
    <div className="atlas-shell" data-overlay-open={sitesOpen || inspectorView ? "" : undefined}>
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
          onOpenFolder: state.openFolderExternally,
        }}
        map={{
          mode: mapMode,
          onModeChange: changeMode,
          targets: targetOptions,
          target,
          navigationBusy: state.childrenLoading,
          targetScanning,
          onTargetChange: changeCoverageTarget,
          onSwap: swapCoverageSites,
          canScanTarget,
          onScanTarget: scanCoverageTarget,
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
        <section ref={mapRegion} className="atlas-visualization" aria-label="Circular storage map" data-both-panels={sitesOpen && inspectorView ? "" : undefined}>
          <div
            className="atlas-chart-well"
            aria-busy={state.childrenLoading || state.treeLoading || undefined}
          >
            {folder ? (
              <RadialAtlas
                root={folder}
                firstScan={firstScan}
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
                  ref={emptyLauncherRef}
                  className="atlas-text-button"
                  type="button"
                  aria-haspopup="dialog"
                  disabled={!openAddSite}
                  onClick={openAddSite}
                >Add site</button>
              </div>
            ) : coverage && site && folder ? (
              <CoverageFooter
                source={site} target={target} targets={targetOptions} coverage={folderCoverage}
                hasFolderContent={folder.file_count > 0}
                sourceScan={coverageScan(site.id)} targetScan={target ? coverageScan(target.id) : undefined}
                navigationBusy={state.childrenLoading}
                canScanTarget={canScanTarget} onTargetChange={changeCoverageTarget} onSwap={swapCoverageSites}
                onScanTarget={scanCoverageTarget} onAddSite={openAddSite}
              >
                {target && <HealthScale />}
              </CoverageFooter>
            ) : folder && !firstScan && metric === "space_health" && (
              <>
                {analysisNotice && <p className="atlas-map-notice" role="status">{analysisNotice}</p>}
                <HealthScale />
              </>
            )}
          </footer>
          <div className="atlas-panels">
            <SiteRail
              sites={dashboard?.sites ?? []}
              activeId={site?.id ?? null}
              scanRequests={state.scanRequestBySite}
              blockedIds={state.scanBlockedSiteIds}
              scanAllRequests={state.scanAllRequestIds}
              cancellingRequests={state.cancellingRequestIds}
              progressBySite={state.progressBySite}
              open={sitesOpen}
              onOpen={() => { lastOpened.current = "sites"; setSitesOpen(true); }}
              onClose={() => setSitesOpen(false)}
              onSelect={(id) => void selectSite(id)}
              onScan={(id) => void state.scan(id)}
              onCancel={(id) => void state.cancel(id)}
              onAdd={openAddSite}
              onManage={(id) => workspace.openManagement("sites", id)}
            />
            {site && (
              <AtlasInspector
                detailsKey={selected?.id ?? folder?.id ?? null}
                contentsPane={contentsPane}
                siteId={site.id}
                contentsFileId={currentVisit?.fileId ?? null}
                folderName={folder?.name}
                view={inspectorView}
                initialView={selected?.kind === "file" ? "details" : "contents"}
                origin={inspectorOrigin}
                onViewChange={openInspector}
                onBackToContents={goBack}
                onClose={closeInspector}
                details={location ? (
                  <StorageDetails
                    location={location}
                    onOpenFolder={state.openFolderExternally}
                    entries={directoryPage?.children ?? []}
                    selected={selected}
                    focusRevision={analysisFocusRevision}
                    metric={metric}
                    targetCompleteness={targetCompleteness}
                    targetName={target?.name ?? null}
                    onShowInContents={selected?.kind === "file" && !fileOpen
                      ? () => void showFileInContents(selected) : undefined}
                    revealing={revealingFileId === selected?.id}
                  >
                    {dashboard && selectedNode && (
                      <ContentActions
                        workspaceName={dashboard.workspace_name}
                        siteId={site.id}
                        siteName={site.name}
                        contentRevision={state.contentRevision}
                        node={selectedNode}
                        metric={state.healthMetric}
                        sourceAnalysisReady={siteAnalysisReady(site)}
                        staged={state.isSelectedStaged}
                        stagingBusy={state.stagingBusy}
                        onStage={() => void state.stageSelected()}
                        onUnstage={() => { if (selectedNode.path) void state.removeStaged(selectedNode.path); }}
                        onReview={() => state.setReviewOpen(true)}
                        onJumpDuplicate={showCopyInAtlas}
                        onJumpFolder={showSimilarFolderInAtlas}
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
                      onOpenFolder={state.openFolderExternally}
                      location={location}
                      page={directoryPage}
                      directoryTotal={state.childrenPage?.total_children ?? 0}
                      searchText={searchText}
                      onSearchChange={changeSearch}
                      selection={selected}
                      sort={state.directorySort}
                      onSort={changeDirectorySort}
                      metric={metric}
                      targetCompleteness={targetCompleteness}
                      scrollPane={contentsPane}
                      scrollPositions={contentsScroll.current}
                      contentsKey={contentsKey}
                      anchorIndex={search.enabled ? 0 : state.contentsAnchorOffset}
                      returnFileId={currentVisit?.fileId ?? (revealedRow?.key === contentsKey ? revealedRow.id : null)}
                      active={inspectorView === "contents"}
                      loading={state.childrenLoading || search.loading}
                      loadingMore={search.enabled ? search.loadingMore : state.loadingMoreChildren}
                      error={search.enabled ? search.error : state.childrenError}
                      awaitingInventory={Boolean(firstScan)}
                      onSelect={activateNode}
                      onLoadRange={search.enabled ? search.loadRange : state.loadChildrenRange}
                      onRetry={search.enabled ? search.retry : state.retryChildren}
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
          </div>
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
          onSelect={(id) => void selectSite(id)}
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
          sites={dashboard.sites}
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
