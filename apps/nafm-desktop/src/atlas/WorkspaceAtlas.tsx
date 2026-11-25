import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { ContentActions, type ComparisonKind } from "./analysis/ContentActions";
import { FileCopiesDialog } from "./analysis/FileCopiesDialog";
import { ReviewDrawer, type ReviewPosition } from "./analysis/ReviewDrawer";
import { SimilarFoldersDialog } from "./analysis/SimilarFoldersDialog";
import type { AnalysisPosition } from "./analysis/useAnalysisPage";
import { AtlasInspector, type InspectorView } from "./AtlasInspector";
import { AtlasToolbar, type AtlasToolbarExtension, type MapMode } from "./AtlasToolbar";
import { CoverageFooter } from "./CoverageFooter";
import { siteVerification } from "./siteVerification";
import { DirectoryContents } from "./DirectoryContents";
import { FileFinder } from "./FileFinderDialog";
import { LocationRecovery } from "./LocationRecovery";
import { RadialAtlas } from "./RadialAtlas";
import { SiteRail } from "./SiteRail";
import { SourceLibrary } from "./SourceLibrary";
import { SpaceHealthFooter } from "./SpaceHealthFooter";
import { StorageDetails } from "./StorageDetails";
import { revealInCompactAtlas } from "./compactAtlasScroll";
import { useDashboard, type AtlasInspection } from "../hooks/useDashboard";
import { useDirectorySearch } from "./useDirectorySearch";
import type { useWorkspace } from "../hooks/useWorkspace";
import { siteAnalysisReady } from "../lib/analysis";
import { healthColor } from "../lib/format";
import { nodeHealthPresentation, siteCompleteness } from "../lib/health";
import { siteHasInventory } from "../lib/scanView";
import type {
  DirectoryRefresh, DirectoryRefreshTarget, DirectorySort, FileContentMatchesPage, FinderPosition, FolderSimilarityPage,
  HealthMetric, StorageNode,
} from "../lib/types";
import { resolveAddedSite, type AddSiteOrigin, type SiteAddition } from "../management/siteAddition";

interface ContentsVisit {
  view: InspectorView;
  contentsKey: string;
  fileId: string;
  source: "contents" | "atlas";
  rowIndex?: number;
}

type InspectorPane = InspectorView | ContentsVisit;

interface FinderSession {
  id: symbol;
  workspace: string;
  openedFrom: "atlas" | "details" | null;
  latestPosition: FinderPosition | null;
}

interface ReviewInspection {
  workspace: string;
  siteId: string;
  path: string;
  position: ReviewPosition;
  returning: boolean;
}

type ComparisonSession = { workspace: string; siteId: string; siteName: string; node: StorageNode; open: boolean } & (
  | { kind: "copies"; destination?: { siteId: string; path: string }; position: AnalysisPosition<FileContentMatchesPage> | null }
  | { kind: "similarity"; destination?: { siteId: string; nodeId: string }; position: AnalysisPosition<FolderSimilarityPage> | null }
);

function directoryScope(workspace: string | undefined, site: string | undefined, folder: string | undefined) {
  return JSON.stringify([workspace, site, folder]);
}

function directoryKey(
  workspace: string | undefined, site: string | undefined, folder: string | undefined,
  sort: DirectorySort, anchor: number, query?: string,
) {
  return JSON.stringify([workspace, site, folder, sort.field, sort.direction, anchor, query]);
}

function fileParent(root: StorageNode, fileId: string): StorageNode | null {
  for (const child of root.children) {
    if (child.id === fileId) return root;
    const parent = fileParent(child, fileId);
    if (parent) return parent;
  }
  return null;
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
  siteAddition?: SiteAddition;
  browsingScope: string;
  onAddSite: (event: MouseEvent<HTMLButtonElement>, workspaceName: string, origin: AddSiteOrigin) => void;
  toolbarExtension?: AtlasToolbarExtension;
}

export function WorkspaceAtlas({ workspace, siteAddition, browsingScope, onAddSite, toolbarExtension }: WorkspaceAtlasProps) {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [inspectorBySite, setInspectorBySite] = useState(() => new Map<string, InspectorView>());
  const lastOpened = useRef<"sites" | "inspector">("inspector");
  const mapRegion = useRef<HTMLElement>(null);
  const contentsPane = useRef<HTMLDivElement>(null);
  const directoryRefresh = useRef<DirectoryRefreshTarget | null>(null);
  const onSearchRefresh = useCallback((update: DirectoryRefresh) => directoryRefresh.current?.receive(update), []);
  const contentsScroll = useRef(new Map<string, number | "end">());
  const focusFirstSite = useRef(false);
  const inspectorOrigin = useRef<SVGGElement | null>(null);
  const openedFile = useRef<AtlasInspection | null>(null);
  const pendingReveal = useRef<AbortController | null>(null);
  const [revealingFileId, setRevealingFileId] = useState<string | null>(null);
  const [revealedRow, setRevealedRow] = useState<{ key: string; id: string; origin?: Element | null } | null>(null);
  const [analysisFocusRequested, setAnalysisFocusRequested] = useState(false);
  const finishAnalysisFocus = useCallback(() => setAnalysisFocusRequested(false), []);
  const [folderSearches, setFolderSearches] = useState(() => new Map<string, string>());
  const [pausedSearchScope, setPausedSearchScope] = useState<string | null>(null);
  const [contentsReveal, setContentsReveal] = useState<{ key: string; index: number; onApplied: () => void } | null>(null);
  const [historyFocusOrigin, setHistoryFocusOrigin] = useState<HTMLElement | null>(null);
  const finishHistoryFocus = useCallback(() => setHistoryFocusOrigin(null), []);
  const [historyFocusRequest, setHistoryFocusRequest] = useState<{ origin: HTMLElement; fromInspectionDetails: boolean } | null>(null);
  const [finderSession, setFinderSession] = useState<FinderSession | null>(null);
  const [inspectionViews, setInspectionViews] = useState(() => new Map<AtlasInspection, InspectorPane>());
  const [reviewInspection, setReviewInspection] = useState<ReviewInspection | null>(null);
  const [comparisonSession, setComparisonSession] = useState<ComparisonSession | null>(null);
  const [mapMode, setMapMode] = useState<MapMode>("size");
  const state = useDashboard(workspace.management?.active_workspace.name ?? null, workspace.siteListRevision, browsingScope, directoryRefresh);
  const { dashboard, activeSite: site, location, selectedNode, coverageTargetSite: target } = state;
  const findWorkspace = workspace.workspaceSwitching ? null : dashboard?.workspace_name ?? null;
  const finder = finderSession?.workspace === dashboard?.workspace_name ? finderSession : null;
  const openFileFinder = useCallback(() => {
    if (!findWorkspace) return;
    setFinderSession((session) => session?.workspace === findWorkspace ? { ...session, openedFrom: "atlas" }
      : { id: Symbol(), workspace: findWorkspace, openedFrom: "atlas", latestPosition: null });
  }, [findWorkspace]);
  const siteId = site?.id;
  const inspection = state.inspection;
  const pane = inspectorOpen && siteId
    ? inspection ? inspectionViews.get(inspection) ?? "details" : inspectorBySite.get(siteId) ?? "contents"
    : null;
  const visit = typeof pane === "object" ? pane : null;
  const inspectorView = typeof pane === "string" ? pane : visit?.view ?? null;

  const openInspector = useCallback((next: InspectorPane, entry?: AtlasInspection | null) => {
    lastOpened.current = "inspector";
    setRevealedRow(null);
    if (entry) {
      setInspectionViews((saved) => saved.get(entry) === next ? saved : new Map(saved).set(entry, next));
    } else if (siteId && typeof next === "string") {
      setInspectorBySite((saved) => saved.get(siteId) === next ? saved : new Map(saved).set(siteId, next));
    }
    setInspectorOpen(true);
  }, [siteId]);
  function changeInspectorView(next: InspectorView) {
    pendingReveal.current?.abort();
    openInspector(next, inspection);
  }
  const closeInspector = useCallback(() => {
    pendingReveal.current?.abort();
    setRevealedRow(null);
    setInspectorOpen(false);
  }, []);
  const canAddSite = dashboard !== null && state.activeTaskCount === 0;
  const addedSite = resolveAddedSite(siteAddition, dashboard?.workspace_name, dashboard?.sites ?? []);

  function addSiteLauncher(origin: AddSiteOrigin) {
    return dashboard && canAddSite
      ? (event: MouseEvent<HTMLButtonElement>) => onAddSite(event, dashboard.workspace_name, origin)
      : undefined;
  }

  const folder = location?.root;
  const searchScope = directoryScope(dashboard?.workspace_name, location?.site_id, folder?.id);
  const savedSearch = folderSearches.get(searchScope) ?? null;
  const searchPaused = pausedSearchScope === searchScope || (state.contentsGroup && Boolean(savedSearch?.trim()));
  const searchText = searchPaused ? null : savedSearch;
  const searchQuery = searchText?.trim() ?? "";
  function searchContentsKey(sort: DirectorySort, query: string) {
    return directoryKey(dashboard?.workspace_name, siteId, folder?.id, sort, 0, query);
  }
  const searchKey = searchContentsKey(state.directorySort, searchQuery);
  const returnFileId = visit?.source === "contents" && visit.fileId === selectedNode?.id && !state.selectedFileUnavailable
    && (visit.view === "details" || visit.contentsKey === searchKey) ? visit.fileId : undefined;
  const search = useDirectorySearch({
    scope: searchScope,
    siteId: location?.site_id,
    targetId: target?.id,
    folderId: folder?.id,
    query: searchQuery,
    sort: state.directorySort,
    contentRevision: state.contentRevision,
    inspectedFileId: inspectorView === "details" && selectedNode?.kind === "file" ? selectedNode.id : undefined,
    returnFileId,
    onRefresh: onSearchRefresh,
  });
  const directoryPage = search.enabled ? search.page : state.childrenPage;

  useEffect(() => {
    if (pausedSearchScope && pausedSearchScope !== searchScope) setPausedSearchScope(null);
  }, [pausedSearchScope, searchScope]);

  function saveFolderSearch(scope: string, text: string | null) {
    setFolderSearches((saved) => {
      if ((saved.get(scope) ?? null) === text) return saved;
      const next = new Map(saved);
      if (text === null) next.delete(scope);
      else next.set(scope, text);
      return next;
    });
  }
  const requestId = site ? state.scanRequestBySite.get(site.id) : undefined;
  const siteRoot = state.activeTree?.root;
  const awaitingInventory = site && !siteHasInventory(site);
  // The dashboard can publish counts before the first navigable tree reaches the view.
  const awaitingTree = Boolean(site && site.total_files > 0 && siteRoot?.file_count === 0);
  const firstScan = site && siteRoot?.children.length && (awaitingInventory || awaitingTree)
    ? {
      requestId,
      progress: state.progressBySite.get(site.id),
      stopping: requestId !== undefined && state.cancellingRequestIds.has(requestId),
      scanAll: requestId !== undefined && state.scanAllRequestIds.has(requestId),
      blocked: state.scanBlockedSiteIds.has(site.id),
      inventoryLoading: awaitingTree,
      interruption: state.firstScanInterruptions.get(site.id)?.kind ?? (site.scan_state === "failed" ? "failed" as const : undefined),
      onScan: () => state.scan(site.id),
      onCancel: (id: number) => void state.cancel(id),
    } : undefined;
  const selected = selectedNode?.id === folder?.id ? null : selectedNode;
  const finderPosition = inspection?.kind === "finder" && inspection.position.session === finder?.id ? inspection.position : null;
  const reviewed = reviewInspection?.workspace === findWorkspace ? reviewInspection : null;
  const returnToReview = !finderPosition && reviewed && selected?.kind === "file"
    && reviewed.siteId === siteId && reviewed.path === selected.path ? reviewed : null;
  const comparison = comparisonSession?.workspace === findWorkspace ? comparisonSession : null;
  const returnToComparison = comparison?.destination && comparison.destination.siteId === siteId && (comparison.kind === "copies"
    ? selected?.kind === "file" && selected.path === comparison.destination.path
    : !selected && folder?.id === comparison.destination.nodeId);

  function openComparison(kind: ComparisonKind) {
    if (!findWorkspace || !site || !selectedNode) return;
    const source = { workspace: findWorkspace, siteId: site.id, siteName: site.name, node: selectedNode, open: true };
    setComparisonSession({ ...source, kind, position: null });
  }

  function closeComparison() {
    if (comparison?.destination) setAnalysisFocusRequested(true);
    setComparisonSession(null);
  }

  function openReview() {
    setReviewInspection(null);
    state.setReviewOpen(true);
  }

  function closeReview() {
    if (reviewed?.returning) setAnalysisFocusRequested(true);
    setReviewInspection(null);
    state.setReviewOpen(false);
  }
  function contentsKeyFor(sort: DirectorySort, anchor: number) {
    return directoryKey(dashboard?.workspace_name, siteId, folder?.id, sort, anchor);
  }
  const contentsKey = search.enabled ? searchKey
    : contentsKeyFor(state.directorySort, state.contentsAnchorOffset);
  function changeSearch(text: string | null) {
    if (state.contentsGroup && text !== null) {
      void state.leaveContentsGroup().then((left) => { if (left) saveFolderSearch(searchScope, text); });
    } else {
      const query = text?.trim();
      if (query && query !== searchQuery) contentsScroll.current.delete(searchContentsKey(state.directorySort, query));
      saveFolderSearch(searchScope, text);
    }
  }
  async function restoreSearch() {
    if (await state.leaveContentsGroup()) setPausedSearchScope(null);
  }
  useLayoutEffect(() => () => pendingReveal.current?.abort(), [siteId, selected?.id, state.selectedFileUnavailable]);
  useEffect(() => {
    if (revealedRow && revealedRow.key !== contentsKey) setRevealedRow(null);
  }, [contentsKey, revealedRow]);
  function changeDirectorySort(sort: DirectorySort) {
    contentsScroll.current.delete(search.enabled ? searchContentsKey(sort, searchQuery) : contentsKeyFor(sort, 0));
    return state.setDirectorySort(sort);
  }
  const currentVisit = visit?.fileId === selected?.id && (visit?.view === "details" || visit?.contentsKey === contentsKey)
    ? visit : null;
  useEffect(() => {
    if (inspection && visit?.view === "contents" && !currentVisit) {
      setInspectionViews((saved) => saved.get(inspection) === visit ? new Map(saved).set(inspection, "contents") : saved);
    }
  }, [currentVisit, inspection, visit]);

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
  const changeCoverageTarget = (id: string) => {
    const inspectedFile = inspectorView === "details" && selected?.kind === "file" ? selected.id : undefined;
    void state.selectCoverageTarget(id, inspectedFile);
  };
  const swapCoverageSites = () => { if (site && target) void selectSite(target.id, site.id); };
  function verificationScanState(id: string) {
    const requestId = state.scanRequestBySite.get(id);
    const progress = state.progressBySite.get(id);
    const latestScan = state.lastScanResult;
    const failed = latestScan?.kind === "failed" && latestScan.site_states.some((item) => item.site_id === id && item.status === "running");
    return {
      running: requestId !== undefined,
      stopping: requestId !== undefined && state.cancellingRequestIds.has(requestId),
      blocked: state.scanBlockedSiteIds.has(id),
      progress: progress?.request_id === requestId ? progress : undefined,
      interruption: state.firstScanInterruptions.get(id),
      failure: failed ? latestScan.message ?? "The scan failed." : undefined,
    };
  }
  const currentVerification = site ? siteVerification(site, verificationScanState(site.id)) : null;
  const sourceVerification = coverage && site ? siteVerification(site, verificationScanState(site.id), "source") : null;
  const targetVerification = coverage && target ? siteVerification(target, verificationScanState(target.id), "target") : null;
  const comparisonSite = comparison?.open && dashboard?.sites.find((item) => item.id === comparison.siteId);
  const comparisonVerification = comparisonSite ? siteVerification(comparisonSite, verificationScanState(comparisonSite.id)) : undefined;

  useEffect(() => {
    workspace.handleActiveTaskCountChange(state.activeTaskCount);
  }, [state.activeTaskCount, workspace.handleActiveTaskCountChange]);

  async function selectSite(id: string, comparisonSiteId?: string) {
    if (!await state.selectSite(id, comparisonSiteId)) return;
    setSourcesOpen(false);
  }

  const recoveryInSources = sourcesOpen && state.locationFailure?.sourceSwitch;
  const recoveryOnMap = !recoveryInSources && Boolean(state.locationFailure) && !state.treeError && !state.error;
  const openingSiteId = state.locationProgress?.opening_site_id;
  const openingSiteInPanel = (sitesOpen || sourcesOpen) && dashboard?.sites.some((candidate) => candidate.id === openingSiteId);

  useLayoutEffect(() => {
    if (recoveryOnMap) revealInCompactAtlas(mapRegion.current?.querySelector(".atlas-location-recovery") ?? null);
  }, [recoveryOnMap]);

  function focusAfterRecovery(button: HTMLButtonElement) {
    if (document.activeElement !== button && document.activeElement !== document.body) return;
    const heading = button.closest("dialog")?.querySelector<HTMLElement>("h1")
      ?? mapRegion.current?.closest(".atlas-shell")?.querySelector<HTMLElement>(".atlas-toolbar-location h1");
    (heading ?? mapRegion.current)?.focus({ preventScroll: true });
  }

  const recovery = state.locationFailure && (
    <LocationRecovery
      title={state.locationFailure.title} message={state.locationFailure.message}
      retrying={state.childrenLoading}
      onRetry={state.locationFailure.retry ? async (event) => {
        const button = event.currentTarget;
        const hadFocus = document.activeElement === button;
        if (!await state.retryLocation()) return;
        if (recoveryInSources) setSourcesOpen(false);
        else if (hadFocus) focusAfterRecovery(button);
      } : undefined}
      onDismiss={(event) => {
        if (document.activeElement === event.currentTarget) focusAfterRecovery(event.currentTarget);
        state.clearLocationFailure();
      }}
    />
  );

  const { navigateBreadcrumb, canGoUp, goBack: backLocation, goForward: forwardLocation } = state;
  const navigateAncestor = useCallback((ancestor: StorageNode) => {
    const index = location?.breadcrumbs.findIndex((node) => node.id === ancestor.id) ?? -1;
    const child = index < 0 ? undefined : location?.breadcrumbs[index + 1];
    if (inspectorView !== "contents" || !location || !child) {
      navigateBreadcrumb(ancestor);
      return;
    }
    const scope = directoryScope(dashboard?.workspace_name, location.site_id, ancestor.id);
    const query = folderSearches.get(scope)?.trim() || null;
    navigateBreadcrumb(ancestor, {
      request: { child_id: child.id, query },
      onArrival: (destination, page, filteredPage) => {
        // An ancestor's search can intentionally exclude this branch.
        const visiblePage = query ? filteredPage : page;
        const childIndex = visiblePage?.children.findIndex((entry) => entry.id === child.id) ?? -1;
        if (!visiblePage || childIndex < 0) return;
        const targetId = destination.coverage_target?.id;
        if (query) search.prime({ scope, targetId, query, sort: page.sort }, visiblePage);
        const key = directoryKey(
          dashboard?.workspace_name, destination.site_id, destination.root.id,
          page.sort, query ? 0 : page.anchor_offset, query ?? undefined,
        );
        setContentsReveal({ key, index: visiblePage.offset + childIndex, onApplied: () => setContentsReveal(null) });
      },
    });
  }, [dashboard?.workspace_name, folderSearches, inspectorView, location, navigateBreadcrumb, search.prime]);
  const goUp = useCallback(() => {
    const parent = location?.breadcrumbs.at(-2);
    if (canGoUp && parent) navigateAncestor(parent);
  }, [canGoUp, location, navigateAncestor]);
  const fileOpen = currentVisit?.view === "details";
  const canGoBack = fileOpen || state.canGoBack;
  const canGoForward = currentVisit?.view === "contents" || state.canGoForward;
  const goBack = useCallback(() => {
    if (currentVisit?.view !== "details") return backLocation();
    pendingReveal.current?.abort();
    let rowIndex = currentVisit.rowIndex;
    if (currentVisit.source === "contents" && !state.selectedFileUnavailable && directoryPage) {
      const index = directoryPage.children.findIndex((node) => node.id === currentVisit.fileId);
      if (index >= 0) {
        const nextIndex = directoryPage.offset + index;
        if (nextIndex !== rowIndex || currentVisit.contentsKey !== contentsKey) {
          setContentsReveal({
            key: contentsKey, index: nextIndex, onApplied: () => setContentsReveal(null),
          });
        }
        rowIndex = nextIndex;
      }
    }
    openInspector({ ...currentVisit, view: "contents", contentsKey, rowIndex }, inspection);
  }, [currentVisit, backLocation, contentsKey, directoryPage, inspection, openInspector, state.selectedFileUnavailable]);
  const goForward = useCallback(() => {
    if (currentVisit?.view === "contents") openInspector({ ...currentVisit, view: "details" }, inspection);
    else return forwardLocation();
  }, [currentVisit, forwardLocation, inspection, openInspector]);

  useLayoutEffect(() => {
    if (!historyFocusRequest) return;
    setHistoryFocusRequest(null);
    const { origin, fromInspectionDetails } = historyFocusRequest;
    const pane = contentsPane.current;
    const focus = document.activeElement;
    if (!pane || (focus !== origin && focus !== document.body && focus !== pane)) return;
    if (inspectorView === "contents") {
      if (fromInspectionDetails) revealInCompactAtlas(pane.closest("aside"));
      setHistoryFocusOrigin(origin);
    } else if (inspectorView === "details" && inspection) {
      revealInCompactAtlas(pane.closest("aside"));
      setAnalysisFocusRequested(true);
    }
  }, [inspection, historyFocusRequest, inspectorView]);

  useEffect(() => {
    function moveHistory(move: () => Promise<boolean> | undefined, target: EventTarget | null) {
      const pane = contentsPane.current;
      const result = move();
      if (!result || !(target instanceof HTMLElement) || !pane) return;
      const fromInspectionDetails = Boolean(inspection && inspectorView === "details" && pane.closest("aside")?.contains(target));
      if (!fromInspectionDetails && !pane.contains(target)) return;
      void result.then((moved) => {
        if (moved && contentsPane.current === pane) setHistoryFocusRequest({ origin: target, fromInspectionDetails });
      });
    }

    function navigate(event: KeyboardEvent) {
      if (event.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (findWorkspace && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "f"
        && !(event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]"))) {
        event.preventDefault();
        openFileFinder();
        return;
      }
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
        moveHistory(goBack, event.target);
      } else if (((event.altKey && event.key === "ArrowRight") || (event.metaKey && event.key === "]")) && canGoForward) {
        event.preventDefault();
        moveHistory(goForward, event.target);
      } else if ((event.altKey || event.metaKey) && event.key === "ArrowUp" && canGoUp) {
        event.preventDefault();
        goUp();
      }
    }
    window.addEventListener("keydown", navigate);
    return () => window.removeEventListener("keydown", navigate);
  }, [sitesOpen, inspectorView, canGoBack, canGoForward, canGoUp, fileOpen, goBack, goForward, goUp, closeInspector, findWorkspace, inspection, openFileFinder]);

  async function showFileInContents(file: StorageNode) {
    if (!folder || (pendingReveal.current && !pendingReveal.current.signal.aborted)) return;
    const focusOrigin = document.activeElement;
    const attempt = new AbortController();
    pendingReveal.current = attempt;
    setRevealingFileId(file.id);
    try {
      const parent = fileParent(folder, file.id) ?? folder;
      const query = folderSearches.get(directoryScope(dashboard?.workspace_name, siteId, parent.id))?.trim();
      const filter = query ? { folder_id: parent.id, query } : undefined;
      const destination = await state.revealSelectedFileInContents(file.id, filter, () => !attempt.signal.aborted);
      if (!destination || attempt.signal.aborted) return;
      const scope = directoryScope(dashboard?.workspace_name, destination.site_id, destination.node_id);
      const filtered = destination.filtered_page;
      const index = filtered?.children.findIndex((child) => child.id === file.id) ?? -1;
      const match = query && filtered && index >= 0 ? { query, page: filtered, row: filtered.offset + index } : null;
      if (match) {
        search.prime({ scope, targetId: destination.target_site_id ?? undefined, query: match.query, sort: destination.sort }, match.page);
      }
      setPausedSearchScope(!match && folderSearches.get(scope)?.trim() ? scope : null);
      const key = directoryKey(
        dashboard?.workspace_name, destination.site_id, destination.node_id,
        destination.sort, match ? 0 : destination.anchor_offset, match?.query,
      );
      // A previous visit to this list may have scrolled away from the file.
      contentsScroll.current.set(key, match?.row ?? destination.anchor_offset);
      inspectorOrigin.current = null;
      openInspector("contents", inspection?.kind === "file" ? null : inspection);
      setRevealedRow({ key, id: file.id, origin: focusOrigin });
    } finally {
      if (pendingReveal.current === attempt) {
        pendingReveal.current = null;
        setRevealingFileId(null);
      }
    }
  }

  function showAnalysisDetails() {
    inspectorOrigin.current = null;
    lastOpened.current = "inspector";
    setRevealedRow(null);
    setInspectorOpen(true);
    setAnalysisFocusRequested(true);
  }

  function changeMode(mode: MapMode) {
    setMapMode(mode);
    state.setHealthMetric(mode === "coverage_health" ? "coverage_health" : "space_health");
  }

  function activateNode(node: StorageNode, origin?: SVGGElement) {
    if (node.kind === "smaller_items") {
      const focusOrigin = document.activeElement;
      state.selectNode(node, {
        onGroupArrival(destination, page) {
          const index = page.anchor_offset;
          const firstGrouped = page.children[index - page.offset];
          const key = directoryKey(
            dashboard?.workspace_name, destination.site_id, destination.root.id, page.sort, index,
          );
          inspectorOrigin.current = origin ?? null;
          openInspector("contents");
          if (inspectorView === "contents" && document.activeElement === focusOrigin) {
            const pane = contentsPane.current;
            // A nested arc can disappear as the new folder replaces the map.
            pane?.focus({ preventScroll: true });
            revealInCompactAtlas(pane?.closest("aside") ?? null);
          }
          if (firstGrouped) {
            setContentsReveal({ key, index, onApplied: () => setContentsReveal(null) });
            setRevealedRow({ key, id: firstGrouped.id, origin: focusOrigin });
          }
        },
      });
      return;
    }
    if (node.kind !== "file") {
      state.selectNode(node);
      return;
    }
    const nextInspection = { kind: "file" } as const;
    openedFile.current = nextInspection;
    state.selectNode(node, { inspection: nextInspection });
    const view = "details";
    if (origin) {
      inspectorOrigin.current = origin;
      if (inspectorView === view) {
        revealInCompactAtlas(mapRegion.current?.querySelector('[data-atlas-panel="inspector"]') ?? null);
      }
    }
    if (!origin || inspectorView === "contents" || currentVisit) {
      if (!origin) inspectorOrigin.current = null;
      const row = origin ? -1 : directoryPage?.children.findIndex((entry) => entry.id === node.id) ?? -1;
      openInspector({
        view: "details", fileId: node.id, contentsKey,
        source: origin ? "atlas" : "contents",
        rowIndex: directoryPage && row >= 0 ? directoryPage.offset + row : undefined,
      }, nextInspection);
    } else {
      openInspector(view);
    }
  }

  return (
    <div className="atlas-shell" data-overlay-open={sitesOpen || inspectorView ? "" : undefined}>
      <AtlasToolbar
        workspace={{
          name: workspace.management?.active_workspace.name ?? null,
          options: workspace.management?.workspaces ?? [],
          disabled: state.activeTaskCount > 0 || workspace.workspaceSwitching,
          pending: workspace.workspaceSwitching,
          failure: workspace.workspaceSwitchFailure,
          focusRequested: workspace.atlasToolbarFocus,
          onSwitch: (name) => void workspace.quickSwitchWorkspace(name),
          onDismissFailure: workspace.dismissWorkspaceSwitchFailure,
          onFocusHandled: workspace.finishAtlasToolbarFocus,
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
          onBreadcrumb: navigateAncestor,
          onOpenFolder: state.openFolderExternally,
        }}
        map={{
          mode: mapMode,
          onModeChange: changeMode,
          targets: targetOptions,
          target,
          navigationBusy: state.childrenLoading,
          spaceVerification: currentVerification,
          sourceVerification,
          targetVerification,
          onTargetChange: changeCoverageTarget,
          onSwap: swapCoverageSites,
          onScanSite: state.scan,
        }}
        actions={{
          ready: dashboard !== null,
          siteCount: dashboard?.sites.length ?? 0,
          activeScans: state.activeTaskCount,
          stagedCount: dashboard?.staged.length ?? 0,
          canFind: findWorkspace !== null,
          onFind: openFileFinder,
          onScanAll: () => void state.scan(),
          onReview: openReview,
          onSettings: () => workspace.openManagement("workspaces"),
          onSources: () => setSourcesOpen(true),
        }}
        scanActivity={{
          sites: dashboard?.sites ?? [],
          tasks: state.activeScanTasks,
          progressBySite: state.progressBySite,
          completionBySite: state.completionBySite,
          firstScanInterruptions: state.firstScanInterruptions,
          cancellingRequestIds: state.cancellingRequestIds,
          blockedSiteIds: state.scanBlockedSiteIds,
          lastResult: state.lastScanResult,
          onStop: (id) => void state.cancel(id),
          onScan: state.scan,
        }}
        extension={toolbarExtension}
      />

      <main className="atlas-main">
        <section
          ref={mapRegion} className="atlas-visualization" aria-label="Circular storage map" tabIndex={-1}
          data-sites-open={sitesOpen || undefined}
          data-inspector-open={Boolean(inspectorView) || undefined}
        >
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
              <EmptyOrbit label={state.loading || state.treeLoading ? "Reading inventory"
                : state.treeError || state.error || state.locationFailure ? "Map unavailable" : "No source selected"} />
            )}
            {folder && state.locationProgress && (
              <span className="atlas-location-progress" role={openingSiteInPanel ? undefined : "status"}>
                {state.locationProgress.message}
              </span>
            )}
          </div>

          <footer className="atlas-map-footer">
            {state.treeError || state.error ? (
              <div className="atlas-view-error" role="alert">
                <span>{state.treeError ?? state.error}</span>
                <button className="atlas-text-button" type="button" onClick={() => void (state.treeError ? state.retryTree() : state.refresh())}>Try again</button>
              </div>
            ) : recoveryOnMap ? recovery : dashboard && !site ? (
              <div className="atlas-map-empty-help">
                <span>Add a folder or network share to map its files.</span>
                <button
                  ref={emptyLauncherRef}
                  className="atlas-text-button"
                  type="button"
                  aria-haspopup="dialog"
                  disabled={!canAddSite}
                  onClick={addSiteLauncher("atlas")}
                >Add site</button>
              </div>
            ) : sourceVerification && site && folder ? (
              <CoverageFooter
                source={site} target={target} targets={targetOptions} coverage={folderCoverage}
                hasFolderContent={folder.file_count > 0}
                sourceVerification={sourceVerification} targetVerification={targetVerification}
                navigationBusy={state.childrenLoading}
                onTargetChange={changeCoverageTarget} onSwap={swapCoverageSites}
                onScanSite={state.scan} onAddSite={addSiteLauncher("coverage")}
                addedTarget={siteAddition?.origin === "coverage" ? addedSite : undefined}
              >
                {target && folderCoverage && folderCoverage.state !== "unavailable" && <HealthScale />}
              </CoverageFooter>
            ) : folder && !firstScan && currentVerification && metric === "space_health" && (
              <SpaceHealthFooter verification={currentVerification} onScanSite={state.scan}>
                <HealthScale />
              </SpaceHealthFooter>
            )}
          </footer>
          <div className="atlas-panels">
            <SiteRail
              sites={dashboard?.sites ?? []}
              activeId={site?.id ?? null}
              openingSiteId={openingSiteId}
              addedSite={siteAddition?.origin === "sites" ? addedSite : undefined}
              scanRequests={state.scanRequestBySite}
              blockedIds={state.scanBlockedSiteIds}
              scanAllRequests={state.scanAllRequestIds}
              cancellingRequests={state.cancellingRequestIds}
              progressBySite={state.progressBySite}
              firstScanInterruptions={state.firstScanInterruptions}
              open={sitesOpen}
              onOpen={() => { lastOpened.current = "sites"; setSitesOpen(true); }}
              onClose={() => setSitesOpen(false)}
              onSelect={(id) => void selectSite(id)}
              onScan={(id) => void state.scan(id)}
              onCancel={(id) => void state.cancel(id)}
              onAdd={addSiteLauncher("sites")}
              onManage={(id) => workspace.openManagement("sites", id)}
            />
            {site && (
              <AtlasInspector
                detailsKey={selected?.id ?? folder?.id ?? null}
                contentsPane={contentsPane}
                siteId={site.id}
                inspection={inspection}
                openedFile={openedFile}
                fileOpen={fileOpen}
                folderName={folder?.name}
                view={inspectorView}
                initialView={selected?.kind === "file" ? "details" : "contents"}
                origin={inspectorOrigin}
                onViewChange={changeInspectorView}
                onBackToContents={goBack}
                onClose={closeInspector}
                details={location ? (
                  <StorageDetails
                    location={location}
                    onOpenFolder={state.openFolderExternally}
                    entries={directoryPage?.children ?? []}
                    selected={selected}
                    fileUnavailable={state.selectedFileUnavailable}
                    focusRequested={analysisFocusRequested && inspectorView === "details"}
                    onFocusHandled={finishAnalysisFocus}
                    metric={metric}
                    targetCompleteness={targetCompleteness}
                    targetName={target?.name ?? null}
                    returnAction={returnToComparison && comparison ? {
                      label: "Back to comparison",
                      run: () => setComparisonSession({ ...comparison, open: true }),
                    } : findWorkspace && finderPosition ? {
                      label: "Back to results",
                      run: () => setFinderSession((session) => session && { ...session, openedFrom: "details" }),
                    } : returnToReview ? {
                      label: "Back to review",
                      run: () => {
                        setReviewInspection({ ...returnToReview, returning: true });
                        state.setReviewOpen(true);
                      },
                    } : undefined}
                    onShowInContents={!state.selectedFileUnavailable && selected?.kind === "file" && (!fileOpen || currentVisit?.source === "atlas")
                      ? () => void showFileInContents(selected) : undefined}
                    revealing={revealingFileId === selected?.id}
                  >
                    {dashboard && selectedNode && !state.selectedFileUnavailable && (
                      <ContentActions
                        node={selectedNode}
                        metric={state.healthMetric}
                        sourceAnalysisReady={siteAnalysisReady(site)}
                        verification={currentVerification}
                        onScanSite={state.scan}
                        staged={state.isSelectedStaged}
                        stagingBusy={state.stagingBusy}
                        onStage={() => void state.stageSelected()}
                        onUnstage={() => { if (selectedNode.path) void state.removeStaged(selectedNode.path); }}
                        onReview={returnToReview && !returnToComparison ? undefined : openReview}
                        onCompare={openComparison}
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
                      total={search.enabled ? search.total : directoryPage?.total_children ?? 0}
                      directoryTotal={state.childrenPage?.total_children ?? 0}
                      searchText={searchText}
                      onSearchChange={changeSearch}
                      onRestoreSearch={searchPaused ? () => void restoreSearch() : undefined}
                      selection={selected}
                      sort={state.directorySort}
                      onSort={changeDirectorySort}
                      metric={metric}
                      targetCompleteness={targetCompleteness}
                      scrollPane={contentsPane}
                      scrollPositions={contentsScroll.current}
                      contentsKey={contentsKey}
                      anchorIndex={search.enabled ? 0 : state.contentsAnchorOffset}
                      reveal={contentsReveal?.key === contentsKey ? contentsReveal : undefined}
                      refreshHandler={directoryRefresh}
                      returnEntryId={currentVisit?.source === "contents" && !state.selectedFileUnavailable ? currentVisit.fileId : null}
                      revealedEntry={revealedRow?.key === contentsKey ? revealedRow : undefined}
                      resumeVisibleRow={Boolean(currentVisit && (currentVisit.source === "atlas" || state.selectedFileUnavailable))}
                      historyFocusOrigin={historyFocusOrigin}
                      onHistoryFocusHandled={finishHistoryFocus}
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
      {comparison?.open && (comparison.kind === "copies" ? comparison.node.path !== null && (
        <FileCopiesDialog
          key={comparison.node.id}
          workspaceName={comparison.workspace} siteId={comparison.siteId}
          source={{ name: comparison.node.name, site: comparison.siteName, path: comparison.node.path, size: comparison.node.total_bytes }}
          verification={comparisonVerification} onScanSite={state.scan}
          contentRevision={state.contentRevision} position={comparison.position} onJump={state.jumpToContentMatch} onClose={closeComparison}
          onShown={(match, position) => {
            setComparisonSession({ ...comparison, open: false, position, destination: { siteId: match.site_id, path: match.path } });
            showAnalysisDetails();
          }}
        />
      ) : (
        <SimilarFoldersDialog
          key={comparison.node.id}
          workspaceName={comparison.workspace} siteId={comparison.siteId}
          siteName={comparison.siteName} node={comparison.node}
          verification={comparisonVerification} onScanSite={state.scan}
          contentRevision={state.contentRevision} position={comparison.position} onJump={state.jumpToSimilarFolder} onClose={closeComparison}
          onShown={(match, position) => {
            setComparisonSession({
              ...comparison, open: false, position, destination: { siteId: match.folder.site_id, nodeId: match.folder.node_id },
            });
            showAnalysisDetails();
          }}
        />
      ))}
      {finder && (
        <FileFinder
          key={finder.workspace}
          workspace={finder.workspace} contentRevision={state.contentRevision}
          session={finder.id} position={finder.openedFrom === "details" ? finderPosition : finder.latestPosition}
          open={finder.openedFrom !== null && finder.workspace === findWorkspace}
          onOpen={state.jumpToContentMatch}
          onOpened={(_, position) => {
            setFinderSession((session) => session?.id === finder.id
              ? { ...session, openedFrom: null, latestPosition: position } : session);
            showAnalysisDetails();
          }}
          onClose={() => {
            setFinderSession(null);
            if (finder.openedFrom === "details") setAnalysisFocusRequested(true);
          }}
        />
      )}

      {state.notice && !recoveryOnMap && !sourcesOpen && !state.reviewOpen && (
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
          openingSiteId={openingSiteId}
          addedSite={siteAddition?.origin === "sources" ? addedSite : undefined}
          onSelect={(id) => void selectSite(id)}
          onClose={() => setSourcesOpen(false)}
          onAdd={addSiteLauncher("sources")}
          scanRequests={state.scanRequestBySite}
          blockedIds={state.scanBlockedSiteIds}
          scanAllRequests={state.scanAllRequestIds}
          cancellingRequests={state.cancellingRequestIds}
          progressBySite={state.progressBySite}
          firstScanInterruptions={state.firstScanInterruptions}
          onScan={(id) => void state.scan(id)}
          onCancelScan={(id) => void state.cancel(id)}
          onManage={(id) => { setSourcesOpen(false); workspace.openManagement("sites", id); }}
          recovery={recoveryInSources ? recovery : null}
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
          verificationBlockers={dashboard.staged_verification_blockers}
          stageHistory={dashboard.stage_history}
          verificationForSite={(id) => {
            const blockedSite = dashboard.sites.find((item) => item.id === id);
            return blockedSite ? siteVerification(blockedSite, { ...verificationScanState(id), verificationRequired: true }) : undefined;
          }}
          onScanSite={state.scan}
          preview={state.preview}
          position={reviewed?.returning ? reviewed.position : null}
          loadingPreview={state.previewLoading}
          error={state.reviewError}
          stagingBusy={state.stagingBusy}
          onClose={closeReview}
          onPreview={() => void state.runPreview()}
          onRemove={(path) => void state.removeStaged(path)}
          onHistoryStep={state.stepStageHistory}
          onInspect={state.jumpToContentMatch}
          onInspected={(file, position) => {
            setReviewInspection({ workspace: dashboard.workspace_name, siteId: file.site_id, path: file.path, position, returning: false });
            state.setReviewOpen(false);
            showAnalysisDetails();
          }}
        />
      )}
    </div>
  );
}
