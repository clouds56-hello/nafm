import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent, type ReactNode, type RefCallback } from "react";
import { ContentActions, type ComparisonKind } from "./analysis/ContentActions";
import { FileCopiesDialog } from "./analysis/FileCopiesDialog";
import { ReviewDrawer } from "./analysis/ReviewDrawer";
import { SimilarFoldersDialog } from "./analysis/SimilarFoldersDialog";
import type { AnalysisPosition } from "./analysis/useAnalysisPage";
import { AtlasInspector, type InspectorView } from "./AtlasInspector";
import { AtlasToolbar, type AtlasToolbarExtension, type MapMode } from "./AtlasToolbar";
import { CoverageFooter } from "./CoverageFooter";
import { coverageSummary } from "./CoverageReadout";
import { siteVerification } from "./siteVerification";
import { DirectoryContents } from "./DirectoryContents";
import { FileFinder } from "./FileFinderDialog";
import { FolderOpenContext, restoreFolderOpenFocus, type FolderOpenActions } from "./FolderOpenControl";
import { folderLaunchKey, type FolderLaunches } from "./useFolderLaunches";
import { LocationOpening, LocationRecovery } from "./LocationRecovery";
import { RadialAtlas } from "./RadialAtlas";
import { SiteRail } from "./SiteRail";
import { SourceLibrary } from "./SourceLibrary";
import { SpaceHealthFooter } from "./SpaceHealthFooter";
import { StorageDetails } from "./StorageDetails";
import { isCompactAtlas, revealInCompactAtlas, watchAtlasPanelReflow } from "./compactAtlasScroll";
import { useDashboard, type AnalysisInspection, type AtlasInspection, type AtlasWorkspaceLocation, type CoverageAction, type SiteSwitchOptions } from "../hooks/useDashboard";
import { useDirectorySearch } from "./useDirectorySearch";
import { useContentsFileStep } from "./useContentsFileStep";
import { useFinderFileStep } from "./useFinderFileStep";
import type { useWorkspace } from "../hooks/useWorkspace";
import { siteAnalysisReady } from "../lib/analysis";
import { healthColor } from "../lib/format";
import { nodeHealthPresentation, siteCompleteness } from "../lib/health";
import { siteHasInventory } from "../lib/scanView";
import type {
  DirectoryAdjacentFile, DirectoryRefresh, DirectoryRefreshTarget, DirectorySort, FileContentMatchesPage, FinderPosition, FolderSimilarityPage,
  HealthMetric, ReviewPosition, StorageNode,
} from "../lib/types";
import { PlusIcon } from "../management/Icons";
import { resolveAddedSite, type AddSiteOrigin, type SiteAddition } from "../management/siteAddition";

interface ContentsVisit {
  view: InspectorView;
  contentsKey: string;
  fileId: string;
  source: "contents" | "atlas";
  searchText: string | null;
  rowIndex?: number;
}

type InspectorPane = InspectorView | ContentsVisit;

export interface AtlasWorkspaceSession {
  location?: AtlasWorkspaceLocation;
  contentsVisit?: ContentsVisit;
  revealedContentsVisit?: RevealedContentsVisit;
  revealedContentsView?: InspectorView;
  sitesOpen: boolean;
  inspectorOpen: boolean;
  inspectorBySite: Map<string, InspectorView>;
  lastOpened: "sites" | "inspector";
  folderSearches: Map<string, FolderSearch>;
  scrollPositions: Map<string, number | "end">;
  cursorPositions: Map<string, string>;
  mapMode: MapMode;
}

interface FinderSession {
  id: symbol;
  workspace: string;
  openedFrom: "atlas" | "details" | null;
  latestPosition: FinderPosition | null;
}

interface FolderSearch {
  text: string;
}

interface RevealedContentsVisit {
  id: string;
  searchViewportId?: string;
  pausedSearch?: FolderSearch;
}

type Comparison = {
  workspace: string;
  siteId: string;
  siteName: string;
  node: StorageNode;
} & (
  | { kind: "copies"; destination?: { siteId: string; path: string }; position: AnalysisPosition<FileContentMatchesPage> | null }
  | { kind: "similarity"; destination?: { siteId: string; nodeId: string }; position: AnalysisPosition<FolderSimilarityPage> | null }
);

function inAtlasViewport(control: HTMLElement) {
  const bounds = control.getBoundingClientRect();
  const toolbar = control.closest(".atlas-shell")?.querySelector(".atlas-toolbar");
  const list = control.closest(".atlas-site-rail-list")?.getBoundingClientRect();
  const top = Math.max(0, toolbar?.getBoundingClientRect().bottom ?? 0, list?.top ?? 0);
  const bottom = Math.min(window.innerHeight, list?.bottom ?? window.innerHeight);
  return bounds.height > 0 && bounds.top >= top - 1 && bounds.bottom <= bottom + 1;
}

function captureVisiblePanelFocus() {
  const active = document.activeElement;
  if (isCompactAtlas() && active instanceof HTMLElement && active.closest("[data-atlas-panel]") && inAtlasViewport(active)) {
    return active;
  }
}

function coverageActionFor(origin: HTMLElement, kind: CoverageAction["kind"]): CoverageAction {
  return {
    kind, origin, surface: origin.closest(".atlas-toolbar-panel") ? "options" : "footer",
    capturePanelFocus: captureVisiblePanelFocus,
  };
}

function directoryScope(workspace: string | undefined, site: string | undefined, folder: string | undefined) {
  return JSON.stringify([workspace, site, folder]);
}

function directoryKey(
  workspace: string | undefined, site: string | undefined, folder: string | undefined,
  sort: DirectorySort, anchor: number, query?: string,
) {
  return JSON.stringify([workspace, site, folder, sort.field, sort.direction, anchor, query]);
}

function contentsVisitKey(key: string, visitId?: string) {
  return visitId ? `${key}:${visitId}` : key;
}

function fileParent(root: StorageNode, fileId: string): StorageNode | null {
  for (const child of root.children) {
    if (child.id === fileId) return root;
    const parent = fileParent(child, fileId);
    if (parent) return parent;
  }
  return null;
}

function EmptyOrbit({ label, action, addedSite, trackFocus }: {
  label: string; action?: ReactNode; addedSite?: string; trackFocus?: RefCallback<HTMLElement>;
}) {
  return (
    <div className="atlas-empty-orbit">
      <div className="atlas-empty-orbit__center" data-action={Boolean(action || addedSite) || undefined}>
        <span role="status" className={addedSite ? "atlas-empty-orbit__site" : undefined}
          ref={addedSite ? trackFocus : undefined} tabIndex={addedSite ? -1 : undefined}>
          {addedSite && <><small>Site added</small><strong title={addedSite}>{addedSite}</strong></>}
          {label}
        </span>
        {action}
      </div>
    </div>
  );
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
  folderLaunches: FolderLaunches;
  siteAddition?: SiteAddition;
  browsingScope: string;
  onAddSite: (event: MouseEvent<HTMLButtonElement>, workspaceName: string, origin: AddSiteOrigin) => void;
  toolbarExtension?: AtlasToolbarExtension;
  sessions: Map<string, AtlasWorkspaceSession>;
}

export function WorkspaceAtlas({ workspace, folderLaunches, siteAddition, browsingScope, onAddSite, toolbarExtension, sessions }: WorkspaceAtlasProps) {
  const workspaceName = workspace.management?.active_workspace.name ?? null;
  const [saved] = useState(() => workspaceName ? sessions.get(workspaceName) : undefined);
  const savedInspection = saved?.location?.file?.inspection;
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [mapOptionsOpen, setMapOptionsOpen] = useState(false);
  const [sitesOpen, setSitesOpen] = useState(saved?.sitesOpen ?? false);
  const [inspectorOpen, setInspectorOpen] = useState(saved?.inspectorOpen ?? false);
  const [inspectorBySite, setInspectorBySite] = useState(() => saved?.inspectorBySite ?? new Map<string, InspectorView>());
  const lastOpened = useRef<"sites" | "inspector">(saved?.lastOpened ?? "inspector");
  const mapRegion = useRef<HTMLElement>(null);
  const folderLaunchSource = useRef<{ opener: HTMLButtonElement | null; inspector: boolean } | null>(null);
  useEffect(() => watchAtlasPanelReflow(mapRegion.current), []);
  const contentsPane = useRef<HTMLDivElement>(null);
  const directoryRefresh = useRef<DirectoryRefreshTarget | null>(null);
  const onSearchRefresh = useCallback((update: DirectoryRefresh) => directoryRefresh.current?.receive(update), []);
  const contentsScroll = useRef(saved?.scrollPositions ?? new Map<string, number | "end">());
  const contentsCursor = useRef(saved?.cursorPositions ?? new Map<string, string>());
  const focusFirstSite = useRef(false);
  const [openedFirstSite, setOpenedFirstSite] = useState<SiteAddition>();
  const inspectorOrigin = useRef<SVGGElement | null>(null);
  const openedFile = useRef<AtlasInspection | null>(null);
  const pendingReveal = useRef<AbortController | null>(null);
  const [revealingFileId, setRevealingFileId] = useState<string | null>(null);
  const [revealedRow, setRevealedRow] = useState<{ key: string; id: string; origin?: Element | null } | null>(null);
  const [analysisFocusRequested, setAnalysisFocusRequested] = useState(false);
  const finishAnalysisFocus = useCallback(() => setAnalysisFocusRequested(false), []);
  const [folderSearches, setFolderSearches] = useState(() => saved?.folderSearches ?? new Map<string, FolderSearch>());
  const [revealedContentsVisits, setRevealedContentsVisits] = useState(() => new Map<AtlasInspection, RevealedContentsVisit>(
    savedInspection && saved?.revealedContentsVisit ? [[savedInspection, saved.revealedContentsVisit]] : [],
  ));
  const contentsId = useId();
  const nextContentsVisitId = useRef(0);
  const [contentsReveal, setContentsReveal] = useState<{ key: string; index: number; onApplied: () => void } | null>(null);
  const [contentsFocusOrigin, setContentsFocusOrigin] = useState<HTMLElement | null>(null);
  const finishContentsFocus = useCallback(() => setContentsFocusOrigin(null), []);
  const [historyFocusRequest, setHistoryFocusRequest] = useState<{ origin: HTMLElement; fromInspectionDetails: boolean } | null>(null);
  const [finderSession, setFinderSession] = useState<FinderSession | null>(null);
  const [inspectionViews, setInspectionViews] = useState(() => {
    const view = saved?.contentsVisit ?? saved?.revealedContentsView;
    return new Map<AtlasInspection, InspectorPane>(savedInspection && view ? [[savedInspection, view]] : []);
  });
  const [reviewReturn, setReviewReturn] = useState<ReviewPosition | null>(null);
  const [comparisonDialog, setComparisonDialog] = useState<{ comparison: Comparison; inspection: AnalysisInspection } | null>(null);
  const [comparisonVisits, setComparisonVisits] = useState(() => new Map<AnalysisInspection, Comparison>());
  const [mapMode, setMapMode] = useState<MapMode>(saved?.mapMode ?? "size");
  const state = useDashboard(workspaceName, workspace.siteListRevision, browsingScope, directoryRefresh, folderLaunches.run, saved?.location);
  const { dashboard, activeSite: site, location, selectedNode, coverageTargetSite: target } = state;
  const folderOpen: FolderOpenActions = {
    isOpening: (node) => Boolean(workspaceName && location
      && folderLaunches.pending.has(folderLaunchKey(workspaceName, location.site_id, node.id))),
    open: (node, destination, opener) => {
      void state.openFolderExternally(node, destination, () => {
        folderLaunchSource.current = { opener, inspector: Boolean(opener?.closest(".atlas-inspector")) };
      });
    },
  };
  const findWorkspace = workspace.workspaceSwitching ? null : dashboard?.workspace_name ?? null;
  const finder = finderSession?.workspace === dashboard?.workspace_name ? finderSession : null;
  const openFileFinder = useCallback(() => {
    if (!findWorkspace) return;
    setFinderSession((session) => session?.workspace === findWorkspace ? { ...session, openedFrom: "atlas" }
      : { id: Symbol(), workspace: findWorkspace, openedFrom: "atlas", latestPosition: null });
  }, [findWorkspace]);
  const siteId = site?.id;
  const inspection = state.inspection;
  const inspectionPane = inspection ? inspectionViews.get(inspection) ?? "details" : null;
  const pane = inspectorOpen && siteId
    ? inspectionPane ?? inspectorBySite.get(siteId) ?? "contents"
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
  const savedSearch = folderSearches.get(searchScope);
  const rememberedContents = inspectionPane && typeof inspectionPane === "object" && inspectionPane.source === "contents"
    && inspectionPane.fileId === selectedNode?.id ? inspectionPane : null;
  const visitSearchText = visit === rememberedContents ? rememberedContents?.searchText : undefined;
  const revealedContentsVisit = inspection ? revealedContentsVisits.get(inspection) : undefined;
  const searchViewportId = revealedContentsVisit?.searchViewportId;
  // A reveal only pauses the search that was active when it opened.
  const searchPaused = visitSearchText == null && Boolean(savedSearch?.text.trim())
    && (state.contentsGroup || revealedContentsVisit?.pausedSearch === savedSearch);
  const searchText = visitSearchText === undefined ? (searchPaused ? null : savedSearch?.text ?? null) : visitSearchText;
  const searchQuery = searchText?.trim() ?? "";
  function searchContentsKey(sort: DirectorySort, query: string) {
    return contentsVisitKey(directoryKey(dashboard?.workspace_name, siteId, folder?.id, sort, 0, query), searchViewportId);
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

  function saveFolderSearch(scope: string, text: string | null) {
    setFolderSearches((saved) => {
      if ((saved.get(scope)?.text ?? null) === text) return saved;
      const next = new Map(saved);
      if (text === null) next.delete(scope);
      else next.set(scope, { text });
      return next;
    });
  }
  const requestId = site ? state.scanRequestBySite.get(site.id) : undefined;
  const scanProgress = site ? state.progressBySite.get(site.id) : undefined;
  const siteRoot = state.activeTree?.root;
  // Either the scan or the dashboard can publish counts before the navigable tree arrives.
  const publishedFiles = scanProgress && scanProgress.request_id === requestId
    && (scanProgress.phase === "hashing" || scanProgress.phase === "finalizing") && (scanProgress.total_files ?? 0) > 0;
  const awaitingTree = Boolean(site && (site.total_files > 0 || publishedFiles) && siteRoot?.file_count === 0);
  const firstScan = site && siteRoot?.children.length && siteRoot.file_count === 0 && (!siteHasInventory(site) || awaitingTree)
    ? {
      requestId,
      progress: scanProgress,
      starting: state.scanStarts.startingSiteIds.has(site.id),
      stopping: requestId !== undefined && state.cancellingRequestIds.has(requestId),
      scanAll: requestId !== undefined && state.scanAllRequestIds.has(requestId),
      blocked: state.scanBlockedSiteIds.has(site.id),
      inventoryLoading: awaitingTree,
      interruption: state.scanInterruptions.get(site.id)?.kind ?? (site.scan_state === "failed" ? "failed" as const : undefined),
      onScan: () => state.scan(site.id),
      onCancel: (id: number) => void state.cancel(id),
    } : undefined;
  const selected = selectedNode?.id === folder?.id ? null : selectedNode;
  // File results open in their containing folder. Contents can then scroll far beyond their row.
  const directEntry = selected && ((selected.kind === "file" && inspection && (inspection.kind !== "file" || inspection.direct_child))
    || directoryPage?.children.some((entry) => entry.id === selected.id));
  const detailsParent = selected && folder
    ? (directEntry ? folder : fileParent(folder, selected.id))
    : location?.breadcrumbs.at(-2);
  const finderPosition = inspection?.kind === "finder" && inspection.position.session === finder?.id ? inspection.position : null;
  const finderStep = useFinderFileStep(
    findWorkspace,
    inspectorView === "details" && finder?.openedFrom === null && !state.selectedFileUnavailable ? finderPosition : null,
    state.contentRevision,
    state.childrenLoading,
    (file, signal, position) => state.jumpToContentMatch(file, signal, position, true),
    (position) => setFinderSession((session) => session?.id === position.session && session.openedFrom === null
      ? { ...session, latestPosition: position } : session),
  );
  const returnToReview = inspection?.kind === "review" && selected?.kind === "file" ? inspection.position : null;
  const activeComparison = comparisonDialog?.comparison.workspace === findWorkspace ? comparisonDialog : null;
  const comparison = activeComparison?.comparison;
  const nextComparisonInspection = activeComparison?.inspection;
  const comparisonVisit = inspection?.kind === "analysis" ? comparisonVisits.get(inspection) : null;
  const returnToComparison = comparisonVisit?.workspace === findWorkspace && comparisonVisit.destination
    && comparisonVisit.destination.siteId === siteId && (comparisonVisit.kind === "copies"
      ? selected?.kind === "file" && selected.path === comparisonVisit.destination.path
      : !selected && folder?.id === comparisonVisit.destination.nodeId) ? comparisonVisit : null;

  function openComparison(kind: ComparisonKind) {
    if (!findWorkspace || !site || !selectedNode) return;
    setComparisonDialog({
      comparison: { workspace: findWorkspace, siteId: site.id, siteName: site.name, node: selectedNode, kind, position: null },
      inspection: { kind: "analysis" },
    });
  }

  function rememberComparisonVisit(marker: AnalysisInspection, next: Comparison) {
    setComparisonVisits((saved) => new Map(saved).set(marker, next));
    setComparisonDialog(null);
    showAnalysisDetails();
  }

  function closeComparison() {
    setComparisonDialog(null);
  }

  function openReview() {
    setReviewReturn(null);
    state.setReviewOpen(true);
  }

  function closeReview() {
    setReviewReturn(null);
    state.setReviewOpen(false);
  }
  function contentsKeyFor(sort: DirectorySort, anchor: number) {
    return contentsVisitKey(directoryKey(dashboard?.workspace_name, siteId, folder?.id, sort, anchor), revealedContentsVisit?.id);
  }
  const contentsKey = search.enabled ? searchKey
    : contentsKeyFor(state.directorySort, state.contentsAnchorOffset);
  function updateVisitSearch(text: string | null) {
    if (!inspection || visit !== rememberedContents || visit?.view !== "contents") return;
    const next = searchQuery === (text?.trim() ?? "") ? { ...visit, searchText: text } : "contents";
    setInspectionViews((saved) => saved.get(inspection) === visit ? new Map(saved).set(inspection, next) : saved);
  }
  function changeSearch(text: string | null) {
    const apply = () => {
      updateVisitSearch(text);
      saveFolderSearch(searchScope, text);
    };
    if (state.contentsGroup && text !== null) {
      void state.leaveContentsGroup().then((left) => { if (left) apply(); });
    } else {
      const query = text?.trim();
      if (query && query !== searchQuery) {
        contentsScroll.current.delete(searchContentsKey(state.directorySort, query));
        const pendingSort = state.locationProgress?.contents_sort;
        if (pendingSort) contentsScroll.current.delete(searchContentsKey(pendingSort, query));
      }
      apply();
    }
  }
  async function restoreSearch() {
    if (!await state.leaveContentsGroup()) return;
    updateVisitSearch(savedSearch?.text ?? null);
    if (inspection && revealedContentsVisit?.pausedSearch) {
      setRevealedContentsVisits((saved) => saved.get(inspection) === revealedContentsVisit
        ? new Map(saved).set(inspection, { ...revealedContentsVisit, pausedSearch: undefined }) : saved);
    }
  }
  useLayoutEffect(() => () => pendingReveal.current?.abort(), [siteId, selected?.id, state.selectedFileUnavailable]);
  useEffect(() => {
    if (revealedRow && revealedRow.key !== contentsKey) setRevealedRow(null);
  }, [contentsKey, revealedRow]);
  function preserveFocusedContentsRow() {
    const focus = document.activeElement;
    if (focus instanceof HTMLElement && focus.closest(".atlas-directory-list") && contentsPane.current?.contains(focus)) {
      setContentsFocusOrigin(focus);
    }
  }
  function changeDirectorySort(sort: DirectorySort) {
    contentsScroll.current.delete(search.enabled ? searchContentsKey(sort, searchQuery) : contentsKeyFor(sort, 0));
    return state.setDirectorySort(sort, preserveFocusedContentsRow);
  }
  const rememberedQuery = rememberedContents?.searchText?.trim();
  const resumableContentsKey = !inspectorOpen && rememberedContents
    ? (rememberedQuery ? searchContentsKey(state.directorySort, rememberedQuery) : contentsKeyFor(state.directorySort, state.contentsAnchorOffset))
    : contentsKey;
  const resumableVisit = inspectionPane && typeof inspectionPane === "object" && inspectionPane.fileId === selected?.id
    && (inspectionPane.view === "details" || inspectionPane.contentsKey === resumableContentsKey) ? inspectionPane : null;
  const currentVisit = inspectorOpen ? resumableVisit : null;
  const revealedEntry = revealedRow?.key === contentsKey ? revealedRow : undefined;
  const positionPage = currentVisit?.source === "contents" && currentVisit.view === "details"
    && !state.selectedFileUnavailable && !state.childrenLoading && !(search.enabled && search.refreshing) ? directoryPage : null;
  const positionIndex = positionPage?.children.findIndex((entry) => entry.id === currentVisit?.fileId) ?? -1;
  const listPosition = finderStep?.rank ? {
    index: finderStep.rank.row_index, total: finderStep.rank.result_count, label: "Result" as const, site: site?.name,
  } : positionPage && positionIndex >= 0 ? {
    index: positionPage.offset + positionIndex,
    total: positionPage.total_children,
    label: search.enabled ? "Match" as const : "Item" as const,
  } : undefined;
  const fileStep = useContentsFileStep(
    currentVisit?.source === "contents" && currentVisit.view === "details" && findWorkspace && siteId && folder && inspection
      ? {
        owner: inspection,
        revision: state.contentRevision,
        request: {
          workspace_name: findWorkspace, site_id: siteId, target_site_id: target?.id ?? null,
          folder_id: folder.id, child_id: currentVisit.fileId, sort: state.directorySort,
          query: search.enabled ? searchQuery : undefined,
        },
      } : null,
    search.loading || search.loadingMore ? null : directoryPage,
    state.childrenLoading || state.selectedFileUnavailable,
    (result) => {
      const node = result.page.children[result.index - result.page.offset];
      if (node?.kind !== "file") throw new Error("The adjacent file is missing from its Contents window.");
      if (search.enabled && result.page !== directoryPage) {
        search.prime({ scope: searchScope, targetId: target?.id, query: searchQuery, sort: state.directorySort }, result.page);
      }
      activateNode(node, undefined, result);
    },
  );
  useLayoutEffect(() => {
    if (!workspaceName || dashboard?.workspace_name !== workspaceName || (!location && dashboard.sites.length)) return;
    const canResumeFile = selected?.kind === "file" && !state.selectedFileUnavailable;
    const contentsVisit = canResumeFile && resumableVisit?.source === "contents" ? resumableVisit : undefined;
    const revealedVisit = canResumeFile ? revealedContentsVisit : undefined;
    const file = (contentsVisit || revealedVisit) && inspection && selected ? { id: selected.id, inspection } : undefined;
    sessions.set(workspaceName, {
      location: location ? {
        site_id: location.site_id, node_id: location.root.id, target_site_id: target?.id ?? null,
        anchor_offset: state.contentsAnchorOffset, atlas_group: state.contentsGroup, file,
      } : undefined,
      contentsVisit,
      revealedContentsVisit: revealedVisit,
      revealedContentsView: revealedVisit ? (typeof inspectionPane === "string" ? inspectionPane : "contents") : undefined,
      sitesOpen,
      inspectorOpen,
      inspectorBySite: file && siteId ? new Map(inspectorBySite).set(siteId, "contents") : inspectorBySite,
      lastOpened: lastOpened.current,
      folderSearches,
      scrollPositions: contentsScroll.current,
      cursorPositions: contentsCursor.current,
      mapMode,
    });
  }, [dashboard, folderSearches, inspection, inspectionPane, inspectorBySite, inspectorOpen, location, mapMode, resumableVisit,
    revealedContentsVisit, selected, sessions, siteId, sitesOpen, state.contentsAnchorOffset, state.contentsGroup, state.selectedFileUnavailable, target, workspaceName]);
  const { setHealthMetric } = state;
  useLayoutEffect(() => {
    setHealthMetric(mapMode === "coverage_health" ? "coverage_health" : "space_health");
  }, [mapMode, setHealthMetric]);
  useEffect(() => {
    if (inspection && visit?.view === "contents" && !currentVisit) {
      setInspectionViews((saved) => saved.get(inspection) === visit ? new Map(saved).set(inspection, "contents") : saved);
    }
  }, [currentVisit, inspection, visit]);

  const firstAddition = siteAddition?.origin === "atlas" && siteAddition.workspaceName === workspaceName
    && siteAddition !== openedFirstSite ? siteAddition : undefined;
  const trackFirstSiteFocus = useCallback((element: HTMLElement | null) => {
    if (element) return () => { if (document.activeElement === element) focusFirstSite.current = true; };
  }, []);
  useLayoutEffect(() => {
    // The successful dialog can close after its original Add site button has been replaced.
    if (firstAddition && (document.activeElement === document.body || document.activeElement === firstAddition.opener)) {
      focusFirstSite.current = true;
    }
  }, [firstAddition]);
  useLayoutEffect(() => {
    if (firstAddition && folder) setOpenedFirstSite(firstAddition);
    const waiting = mapRegion.current?.querySelector<HTMLElement>(".atlas-empty-orbit__site");
    const active = document.activeElement;
    const ownsFocus = active === waiting || (focusFirstSite.current && active === document.body);
    if (!ownsFocus) {
      if (active !== document.body) focusFirstSite.current = false;
      return;
    }
    const next = state.error || state.treeError ? mapRegion.current?.querySelector<HTMLButtonElement>(".atlas-view-error button")
      : waiting ?? (folder ? mapRegion.current?.querySelector<HTMLElement>(".radial-atlas__scan-action, .atlas-site-rail-add, .atlas-sites-trigger") : null);
    if (next) {
      focusFirstSite.current = false;
      if (next !== active) next.focus({ preventScroll: true });
    }
  }, [folder, firstAddition, state.error, state.treeError]);
  const breadcrumbs = location?.breadcrumbs ?? [];
  const metric: HealthMetric | null = mapMode === "size" ? null : mapMode;
  const targetCompleteness = siteCompleteness(target);
  const targetOptions = dashboard?.sites.filter((candidate) => candidate.id !== site?.id) ?? [];
  const coverage = mapMode === "coverage_health";
  const folderCoverage = folder && coverage ? nodeHealthPresentation(folder, "coverage_health", targetCompleteness) : null;
  const changeCoverageTarget = (id: string, origin?: HTMLElement) => {
    void state.selectCoverageTarget(id, inspectorView !== "details", () => {
      if (document.activeElement?.matches(".atlas-directory-entry, .atlas-directory-list")) preserveFocusedContentsRow();
    }, origin ? coverageActionFor(origin, "target") : undefined);
  };
  const swapCoverageSites = (origin: HTMLButtonElement) => {
    if (site && target) void selectSite(target.id, site.id, { coverageAction: coverageActionFor(origin, "swap") });
  };
  function verificationScanState(id: string) {
    const requestId = state.scanRequestBySite.get(id);
    const progress = state.progressBySite.get(id);
    const interruption = state.scanInterruptions.get(id);
    return {
      starting: state.scanStarts.startingSiteIds.has(id),
      running: requestId !== undefined,
      stopping: requestId !== undefined && state.cancellingRequestIds.has(requestId),
      blocked: state.scanBlockedSiteIds.has(id),
      progress: progress?.request_id === requestId ? progress : undefined,
      interruption,
      failure: interruption?.kind === "failed" ? interruption.message ?? "The scan failed." : undefined,
    };
  }
  const currentVerification = site ? siteVerification(site, verificationScanState(site.id)) : null;
  const sourceVerification = coverage && site ? siteVerification(site, verificationScanState(site.id), "source") : null;
  const targetVerification = coverage && target ? siteVerification(target, verificationScanState(target.id), "target") : null;
  const coverageReadout = folder && sourceVerification
    ? coverageSummary(folder, folderCoverage, sourceVerification, targetVerification) : null;
  const comparisonSite = comparison && dashboard?.sites.find((item) => item.id === comparison.siteId);
  const comparisonVerification = comparisonSite ? siteVerification(comparisonSite, verificationScanState(comparisonSite.id)) : undefined;

  useEffect(() => {
    workspace.handleActiveTaskCountChange(state.activeTaskCount);
  }, [state.activeTaskCount, workspace.handleActiveTaskCountChange]);

  async function selectSite(id: string, comparisonSiteId?: string, options?: SiteSwitchOptions) {
    if (!await state.selectSite(id, comparisonSiteId, options)) return;
    setSourcesOpen(false);
  }

  const coverageFailure = state.locationFailure?.coverageAction;
  const siteRailFailure = state.locationFailure?.siteRail;
  const recoveryInSites = siteRailFailure && sitesOpen && dashboard?.sites.some((candidate) => candidate.id === siteRailFailure.siteId);
  const recoveryInSources = !coverageFailure && !siteRailFailure && sourcesOpen && state.locationFailure?.sourceSwitch;
  const recoveryInContents = state.locationFailure?.contentsSort;
  const recoveryInOptions = coverageFailure?.surface === "options" && coverage && mapOptionsOpen;
  const recoveryOnMap = !recoveryInSources && !recoveryInSites && !recoveryInContents && !coverageFailure
    && Boolean(state.locationFailure) && !state.treeError && !state.error;
  const openingSiteId = state.locationProgress?.opening_site_id;
  const openingSiteInPanel = (sitesOpen || sourcesOpen) && dashboard?.sites.some((candidate) => candidate.id === openingSiteId);
  const sortingInContents = inspectorView === "contents" && Boolean(state.locationProgress?.contents_sort);
  const coverageFooterVisible = sourceVerification && folder && !state.treeError && !state.error && !recoveryOnMap;
  const folderOpening = state.locationProgress?.cancelOpening;
  const openingInContents = inspectorView === "contents" && Boolean(folderOpening?.origin?.closest(".atlas-directory"));
  const atlasNotice = state.notice ?? state.folderLaunchFeedback;

  function cancelFolderOpening(event: MouseEvent<HTMLButtonElement>) {
    const active = document.activeElement;
    if (!folderOpening?.cancel() || (active !== event.currentTarget && active !== document.body)) return;
    const fromContents = event.currentTarget.closest(".atlas-directory");
    const pane = contentsPane.current;
    const cursor = fromContents ? pane?.querySelector<HTMLButtonElement>('[data-entry-id][tabindex="0"]') : null;
    const origin = folderOpening.origin;
    const connectedOrigin = (origin instanceof HTMLElement || origin instanceof SVGElement)
      && origin !== document.body && origin.isConnected && origin.getClientRects().length ? origin : null;
    const heading = mapRegion.current?.closest(".atlas-shell")?.querySelector<HTMLElement>(".atlas-toolbar-navigation h1");
    (cursor ?? connectedOrigin ?? (fromContents ? pane : heading))?.focus({ preventScroll: true });
  }

  useLayoutEffect(() => {
    const focus = state.locationFailure?.visiblePanelFocus;
    if (focus && !recoveryInOptions && document.activeElement === focus && !inAtlasViewport(focus)) {
      // An inline error can displace a control that was visible when the request failed.
      revealInCompactAtlas(focus);
    }
  }, [recoveryInOptions, recoveryInSites, state.locationFailure]);

  const contentsUpOrigin = state.locationFailure?.contentsUpOrigin;
  useLayoutEffect(() => {
    if (!recoveryOnMap || siteRailFailure || !isCompactAtlas()) return;
    const active = document.activeElement;
    if (contentsUpOrigin && active !== contentsUpOrigin) {
      // The newly inserted alert can push the user's focused control out of the viewport.
      revealInCompactAtlas(active?.closest("[data-atlas-panel]") ?? null);
      return;
    }
    const recovery = mapRegion.current?.querySelector(".atlas-location-recovery");
    revealInCompactAtlas(recovery ?? null);
    if (contentsUpOrigin) {
      const control = recovery?.querySelector<HTMLButtonElement>(".atlas-location-retry")
        ?? recovery?.querySelector<HTMLButtonElement>(".atlas-location-dismiss");
      control?.focus({ preventScroll: true });
    }
  }, [contentsUpOrigin, recoveryOnMap, siteRailFailure]);

  function recoveryButtonOwnsFocus(button: HTMLButtonElement) {
    const focus = document.activeElement;
    // WebKit can focus the map container before dispatching a tap's click.
    if (recoveryInSites && (focus === document.body || focus === mapRegion.current
      || button.closest(".atlas-site-rail-item")?.contains(focus))) {
      button.focus({ preventScroll: true });
    }
    return document.activeElement === button;
  }

  function focusAfterRecovery(button: HTMLButtonElement, source?: Element | null) {
    if (document.activeElement !== button && document.activeElement !== document.body) return;
    if (recoveryInSites && siteRailFailure) {
      const control = mapRegion.current?.querySelector<HTMLButtonElement>(
        `[data-site-id="${CSS.escape(siteRailFailure.siteId)}"] .atlas-site-rail-select`,
      );
      if (control) {
        control.focus({ preventScroll: true });
        control.scrollIntoView({ block: "nearest", inline: "nearest" });
        return;
      }
    }
    if (recoveryInContents) {
      const sort = contentsPane.current?.querySelector<HTMLButtonElement>(".atlas-directory-sort");
      if (sort?.getClientRects().length) {
        revealInCompactAtlas(sort.closest("[data-atlas-panel]"));
        sort.focus({ preventScroll: true });
      }
      return;
    }
    if (coverageFailure) {
      const { kind, origin } = coverageFailure;
      const selector = `[data-coverage-control="${kind}"]`;
      const control = (source?.isConnected ? source.querySelector<HTMLElement>(selector) : null)
        ?? (origin.isConnected ? origin : mapRegion.current?.querySelector<HTMLElement>(selector));
      if (control?.getClientRects().length) {
        revealInCompactAtlas(control);
        control.focus({ preventScroll: true });
        return;
      }
    }
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
        const source = coverageFailure && button.closest(".atlas-coverage-footer, .atlas-toolbar-panel");
        const hadFocus = recoveryButtonOwnsFocus(button);
        if (!await state.retryLocation()) return;
        if (recoveryInSources) setSourcesOpen(false);
        else if (hadFocus) focusAfterRecovery(button, source);
      } : undefined}
      onDismiss={(event) => {
        const button = event.currentTarget;
        if (recoveryButtonOwnsFocus(button)) {
          focusAfterRecovery(button, coverageFailure && button.closest(".atlas-coverage-footer, .atlas-toolbar-panel"));
        }
        state.clearLocationFailure();
      }}
    />
  );

  const { navigateBreadcrumb, canGoUp, goBack: backLocation, goForward: forwardLocation } = state;
  const navigateAncestor = useCallback((ancestor: StorageNode, contentsUpOrigin?: HTMLElement) => {
    const index = location?.breadcrumbs.findIndex((node) => node.id === ancestor.id) ?? -1;
    const child = index < 0 ? undefined : location?.breadcrumbs[index + 1];
    if (inspectorView !== "contents" || !location || !child) {
      navigateBreadcrumb(ancestor, undefined, contentsUpOrigin);
      return;
    }
    const scope = directoryScope(dashboard?.workspace_name, location.site_id, ancestor.id);
    const query = folderSearches.get(scope)?.text.trim() || null;
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
    }, contentsUpOrigin);
  }, [dashboard?.workspace_name, folderSearches, inspectorView, location, navigateBreadcrumb, search.prime]);
  const goUpFromContents = useCallback((origin?: HTMLElement) => {
    const parent = location?.breadcrumbs.at(-2);
    if (canGoUp && parent) navigateAncestor(parent, origin);
  }, [canGoUp, location, navigateAncestor]);
  const goUp = useCallback(() => goUpFromContents(), [goUpFromContents]);
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
      setContentsFocusOrigin(origin);
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
    finderStep?.cancel();
    const focusOrigin = document.activeElement;
    const attempt = new AbortController();
    pendingReveal.current = attempt;
    setRevealingFileId(file.id);
    try {
      // Keep the source Details entry intact if this reveal opens another folder.
      const revealInspection = inspection && inspection.kind !== "file" ? inspection : { kind: "file", direct_child: true } as const;
      const parent = detailsParent ?? folder;
      const query = folderSearches.get(directoryScope(dashboard?.workspace_name, siteId, parent.id))?.text.trim();
      const filter = query ? { folder_id: parent.id, query } : undefined;
      await state.revealSelectedFileInContents({
        id: file.id, inspection: revealInspection, filter, signal: attempt.signal,
        onArrival(destination) {
          const scope = directoryScope(dashboard?.workspace_name, destination.site_id, destination.node_id);
          const filtered = destination.filtered_page;
          const index = filtered?.children.findIndex((child) => child.id === file.id) ?? -1;
          const match = query && filtered && index >= 0 ? { query, page: filtered, row: filtered.offset + index } : null;
          if (match) {
            search.prime({ scope, targetId: destination.target_site_id ?? undefined, query: match.query, sort: destination.sort }, match.page);
          }
          const visitId = revealedContentsVisits.get(revealInspection)?.id ?? `${contentsId}-${++nextContentsVisitId.current}`;
          // Matching reveals get their own viewport. A paused search keeps the viewport it left.
          const nextVisit: RevealedContentsVisit = {
            id: visitId,
            searchViewportId: match ? visitId : scope === searchScope ? searchViewportId : undefined,
            pausedSearch: match ? undefined : folderSearches.get(scope),
          };
          setRevealedContentsVisits((saved) => new Map(saved).set(revealInspection, nextVisit));
          const key = contentsVisitKey(directoryKey(
            dashboard?.workspace_name, destination.site_id, destination.node_id,
            destination.sort, match ? 0 : destination.anchor_offset, match?.query,
          ), visitId);
          // A previous visit to this list may have scrolled away from the file.
          contentsScroll.current.set(key, match?.row ?? destination.anchor_offset);
          if (inspectorOrigin.current?.dataset.nodeId !== file.id) inspectorOrigin.current = null;
          if (siteId && revealInspection.kind === "file") {
            setInspectorBySite((saved) => saved.get(siteId) === "contents" ? saved : new Map(saved).set(siteId, "contents"));
          }
          openInspector("contents", revealInspection);
          setRevealedRow({ key, id: file.id, origin: focusOrigin });
        },
      });
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
  }

  function activateNode(node: StorageNode, origin?: SVGGElement, step?: DirectoryAdjacentFile) {
    if (node.kind === "smaller_items") {
      origin?.focus({ preventScroll: true });
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
    const nextInspection = {
      kind: "file",
      direct_child: !origin || Boolean(folder?.children.some((child) => child.id === node.id)),
    } as const;
    if (revealedContentsVisit && (!origin || inspectorView === "contents" || currentVisit)) {
      setRevealedContentsVisits((saved) => new Map(saved).set(nextInspection, revealedContentsVisit));
    }
    openedFile.current = nextInspection;
    state.selectNode(node, { inspection: nextInspection, directoryPage: search.enabled ? undefined : step?.page });
    const view = "details";
    if (origin) inspectorOrigin.current = origin;
    if (!origin || inspectorView === "contents" || currentVisit) {
      if (!origin) inspectorOrigin.current = null;
      const row = origin ? -1 : directoryPage?.children.findIndex((entry) => entry.id === node.id) ?? -1;
      openInspector({
        view: "details", fileId: node.id, contentsKey,
        source: origin ? "atlas" : "contents",
        searchText,
        rowIndex: step?.index ?? (directoryPage && row >= 0 ? directoryPage.offset + row : undefined),
      }, nextInspection);
    } else {
      openInspector(view);
    }
  }

  function dismissFolderLaunchFeedback() {
    const source = folderLaunchSource.current;
    folderLaunchSource.current = null;
    state.clearFolderLaunchFeedback();
    if (source?.opener?.isConnected) {
      restoreFolderOpenFocus(source.opener);
      return;
    }
    const pane = source?.inspector ? mapRegion.current?.querySelector<HTMLElement>(".atlas-inspector-pane:not([hidden])") : null;
    const heading = mapRegion.current?.closest(".atlas-shell")?.querySelector<HTMLElement>(".atlas-toolbar-navigation h1");
    (pane ?? heading)?.focus({ preventScroll: true });
  }

  const inlineLaunchFeedback = !state.notice && Boolean(inspectorView && folderLaunchSource.current?.inspector);
  const notice = atlasNotice && !recoveryOnMap && !sourcesOpen && !state.reviewOpen ? (
    <div className={inlineLaunchFeedback ? "atlas-alert atlas-inspector-launch-feedback" : "atlas-alert"} role="status">
      <span>{atlasNotice}</span>
      <button className="atlas-text-button" type="button"
        onClick={state.notice ? state.clearNotice : dismissFolderLaunchFeedback}>Dismiss</button>
    </div>
  ) : null;

  const atlas = (
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
        }}
        map={{
          mode: mapMode,
          onModeChange: changeMode,
          targets: targetOptions,
          target,
          navigationBusy: state.childrenLoading,
          navigationProgress: state.locationProgress?.message,
          spaceVerification: currentVerification,
          sourceVerification,
          targetVerification,
          coverageReadout,
          recovery: recoveryInOptions ? recovery : undefined,
          onOptionsOpenChange: setMapOptionsOpen,
          onTargetChange: changeCoverageTarget,
          onSwap: swapCoverageSites,
          onScanSite: state.scan,
        }}
        actions={{
          ready: dashboard !== null,
          siteCount: dashboard?.sites.length ?? 0,
          activeScans: state.activeScanTasks.size,
          scanStarting: state.scanStarts.startingAll || state.scanStarts.startingSiteIds.size > 0,
          scanStartingAll: state.scanStarts.startingAll,
          stagedCount: dashboard?.staged.length ?? 0,
          canFind: findWorkspace !== null,
          onFind: openFileFinder,
          onScanAll: () => state.scan(),
          onReview: openReview,
          onSettings: () => workspace.openManagement("workspaces"),
          onSources: () => setSourcesOpen(true),
        }}
        scanActivity={{
          sites: dashboard?.sites ?? [],
          tasks: state.activeScanTasks,
          startingAll: state.scanStarts.startingAll,
          startingSiteIds: state.scanStarts.startingSiteIds,
          progressBySite: state.progressBySite,
          completionBySite: state.completionBySite,
          scanInterruptions: state.scanInterruptions,
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
            aria-busy={(state.childrenLoading && !folderOpening) || state.treeLoading || undefined}
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
              <EmptyOrbit
                addedSite={firstAddition?.name} trackFocus={trackFirstSiteFocus}
                label={firstAddition ? (state.error || state.treeError ? "Map unavailable" : "Opening site…")
                  : state.loading || state.treeLoading ? "Reading inventory"
                  : state.treeError || state.error || state.locationFailure ? "Map unavailable" : "No source selected"}
                action={!firstAddition && dashboard && !site && !state.error && !state.treeError && !recoveryOnMap ? (
                  <button
                    ref={trackFirstSiteFocus}
                    className="atlas-empty-orbit__add"
                    type="button"
                    aria-haspopup="dialog"
                    disabled={!canAddSite}
                    onClick={addSiteLauncher("atlas")}
                  ><PlusIcon />Add site</button>
                ) : undefined}
              />
            )}
            {folder && state.locationProgress && !sortingInContents && (
              <div className="atlas-location-progress" data-contents-opening={openingInContents || undefined}>
                <LocationOpening message={state.locationProgress.message}
                  announce={!openingSiteInPanel && !coverageFooterVisible} onCancel={folderOpening ? cancelFolderOpening : undefined} />
              </div>
            )}
          </div>

          <footer className="atlas-map-footer">
            {state.treeError || state.error ? (
              <div className="atlas-view-error" role="alert">
                <span>{state.treeError ?? state.error}</span>
                <button className="atlas-text-button" type="button" ref={firstAddition ? trackFirstSiteFocus : undefined}
                  onClick={(event) => {
                    if (firstAddition) event.currentTarget.focus({ preventScroll: true });
                    void (state.treeError ? state.retryTree() : state.refresh());
                  }}>Try again</button>
              </div>
            ) : recoveryOnMap ? recovery : sourceVerification && site && folder ? (
              <CoverageFooter
                source={site} target={target} targets={targetOptions} summary={coverageReadout}
                sourceVerification={sourceVerification} targetVerification={targetVerification}
                navigationBusy={state.childrenLoading}
                navigationProgress={state.locationProgress?.message}
                announceProgress={!sortingInContents}
                onTargetChange={changeCoverageTarget} onSwap={swapCoverageSites}
                onScanSite={state.scan} onAddSite={addSiteLauncher("coverage")}
                addedTarget={siteAddition?.origin === "coverage" ? addedSite : undefined}
                recovery={coverageFailure && !recoveryInOptions ? recovery : undefined}
              >
                {target && folderCoverage && folderCoverage.state !== "unavailable" && <HealthScale />}
              </CoverageFooter>
            ) : folder && !firstScan && currentVerification && metric === "space_health" && (
              <SpaceHealthFooter verification={currentVerification} onScanSite={state.scan}>
                <HealthScale />
              </SpaceHealthFooter>
            )}
            {coverageFailure && !recoveryInOptions && !coverageFooterVisible && recovery}
          </footer>
          <div className="atlas-panels">
            <SiteRail
              sites={dashboard?.sites ?? []}
              activeId={site?.id ?? null}
              openingSiteId={openingSiteId}
              switchRecovery={recoveryInSites && siteRailFailure ? { ...siteRailFailure, content: recovery } : undefined}
              addedSite={siteAddition?.origin === "sites" ? addedSite : undefined}
              startingSiteIds={state.scanStarts.startingSiteIds}
              scanRequests={state.scanRequestBySite}
              blockedIds={state.scanBlockedSiteIds}
              scanAllRequests={state.scanAllRequestIds}
              cancellingRequests={state.cancellingRequestIds}
              progressBySite={state.progressBySite}
              scanInterruptions={state.scanInterruptions}
              open={sitesOpen}
              onOpen={() => { lastOpened.current = "sites"; setSitesOpen(true); }}
              onClose={() => setSitesOpen(false)}
              onSelect={(id, origin) => void selectSite(id, undefined, {
                railAction: { origin, capturePanelFocus: captureVisiblePanelFocus },
              })}
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
                fileStep={finderStep ?? fileStep}
                stepSource={finderStep ? "finder" : undefined}
                folderName={folder?.name}
                view={inspectorView}
                initialView={selected?.kind === "file" && inspectionPane !== "contents" ? "details" : "contents"}
                origin={inspectorOrigin}
                onOpen={(fallback) => openInspector(typeof inspectionPane === "string" ? inspectionPane : resumableVisit ?? fallback, inspection)}
                onViewChange={changeInspectorView}
                onEnterContents={setContentsFocusOrigin}
                contentsRevealOrigin={revealedEntry?.origin}
                onBackToContents={goBack}
                onClose={closeInspector}
                folderLaunchFeedback={inlineLaunchFeedback ? notice : null}
                details={location ? (
                  <StorageDetails
                    node={selected ?? location.root}
                    parent={detailsParent}
                    revealFolderName={selected?.kind === "file" && detailsParent?.id !== folder?.id ? detailsParent?.name : undefined}
                    fileUnavailable={state.selectedFileUnavailable}
                    announceFileChange={Boolean(finderStep ?? fileStep)}
                    listPosition={listPosition}
                    focusRequested={analysisFocusRequested && inspectorView === "details"}
                    onFocusHandled={finishAnalysisFocus}
                    metric={metric}
                    targetCompleteness={targetCompleteness}
                    targetName={target?.name ?? null}
                    returnAction={returnToComparison ? {
                      label: "Back to comparison",
                      run: () => setComparisonDialog({
                        comparison: returnToComparison, inspection: { kind: "analysis" },
                      }),
                    } : findWorkspace && finderPosition ? {
                      label: "Back to results",
                      shortLabel: "Results",
                      run: () => setFinderSession((session) => session && { ...session, openedFrom: "details" }),
                    } : returnToReview ? {
                      label: "Back to review",
                      run: () => {
                        setReviewReturn(returnToReview);
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
                        onReview={returnToReview ? undefined : openReview}
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
                      onGoUp={goUpFromContents}
                      location={location}
                      page={directoryPage}
                      total={search.enabled ? search.total : directoryPage?.total_children ?? 0}
                      directoryTotal={state.childrenPage?.total_children ?? 0}
                      searchText={searchText}
                      onSearchChange={changeSearch}
                      onRestoreSearch={searchPaused ? () => void restoreSearch() : undefined}
                      selection={selected}
                      sort={state.directorySort}
                      pendingSort={state.locationProgress?.contents_sort}
                      folderOpening={folderOpening && state.locationProgress ? {
                        message: state.locationProgress.message, announce: !coverageFooterVisible, onCancel: cancelFolderOpening,
                        inline: openingInContents,
                      } : undefined}
                      onSort={changeDirectorySort}
                      sortRecovery={recoveryInContents ? recovery : undefined}
                      metric={metric}
                      targetCompleteness={targetCompleteness}
                      scrollPane={contentsPane}
                      scrollPositions={contentsScroll.current}
                      cursorPositions={contentsCursor.current}
                      contentsKey={contentsKey}
                      anchorIndex={search.enabled ? 0 : state.contentsAnchorOffset}
                      reveal={contentsReveal?.key === contentsKey ? contentsReveal : undefined}
                      refreshHandler={directoryRefresh}
                      returnEntryId={currentVisit?.source === "contents" && !state.selectedFileUnavailable ? currentVisit.fileId : null}
                      revealedEntry={revealedEntry}
                      resumeVisibleRow={Boolean(currentVisit && (currentVisit.source === "atlas" || state.selectedFileUnavailable))}
                      contentsFocusOrigin={contentsFocusOrigin}
                      onContentsFocusHandled={finishContentsFocus}
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
      {comparison && nextComparisonInspection && (comparison.kind === "copies" ? comparison.node.path !== null && (
        <FileCopiesDialog
          key={comparison.node.id}
          workspaceName={comparison.workspace} siteId={comparison.siteId}
          source={{ name: comparison.node.name, site: comparison.siteName, path: comparison.node.path, size: comparison.node.total_bytes }}
          verification={comparisonVerification} onScanSite={state.scan}
          contentRevision={state.contentRevision} position={comparison.position}
          onJump={(match, signal) => state.jumpToContentMatch(match, signal, nextComparisonInspection)} onClose={closeComparison}
          onShown={(match, position) => {
            rememberComparisonVisit(nextComparisonInspection, {
              ...comparison, position, destination: { siteId: match.site_id, path: match.path },
            });
          }}
        />
      ) : (
        <SimilarFoldersDialog
          key={comparison.node.id}
          workspaceName={comparison.workspace} siteId={comparison.siteId}
          siteName={comparison.siteName} node={comparison.node}
          verification={comparisonVerification} onScanSite={state.scan}
          contentRevision={state.contentRevision} position={comparison.position}
          onJump={(match, signal) => state.jumpToSimilarFolder(match, signal, nextComparisonInspection)} onClose={closeComparison}
          onShown={(match, position) => {
            rememberComparisonVisit(nextComparisonInspection, {
              ...comparison, position,
              destination: { siteId: match.folder.site_id, nodeId: match.folder.node_id },
            });
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
            setFinderSession((session) => {
              if (session?.id !== finder.id) return session;
              return session.latestPosition ? { ...session, openedFrom: null } : null;
            });
          }}
        />
      )}

      {!inlineLaunchFeedback && notice}

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
          startingSiteIds={state.scanStarts.startingSiteIds}
          scanRequests={state.scanRequestBySite}
          blockedIds={state.scanBlockedSiteIds}
          scanAllRequests={state.scanAllRequestIds}
          cancellingRequests={state.cancellingRequestIds}
          progressBySite={state.progressBySite}
          scanInterruptions={state.scanInterruptions}
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
          previewInvalidation={state.previewInvalidation}
          position={reviewReturn}
          loadingPreview={state.previewLoading}
          error={state.reviewError}
          stagingBusy={state.stagingBusy}
          onClose={closeReview}
          onPreview={() => void state.runPreview()}
          onRemove={(path) => void state.removeStaged(path)}
          onHistoryStep={state.stepStageHistory}
          onInspect={(file, signal, position) => state.jumpToContentMatch(file, signal, { kind: "review", position })}
          onInspected={() => {
            setReviewReturn(null);
            state.setReviewOpen(false);
            showAnalysisDetails();
          }}
        />
      )}
    </div>
  );
  return <FolderOpenContext value={folderOpen}>{atlas}</FolderOpenContext>;
}
