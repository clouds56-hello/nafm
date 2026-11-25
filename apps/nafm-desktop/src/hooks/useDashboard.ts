import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { siteAnalysisReady } from "../lib/analysis";
import { readAtlasBrowsing, rememberAtlasFolder } from "../lib/atlasBrowsing";
import { formatCount } from "../lib/format";
import { readSiteDirectorySort, writeSiteDirectorySort } from "../lib/siteDirectorySort";
import {
  cancelScan,
  getStorageChildren,
  getStorageFileReveal,
  getStorageNodeReveal,
  getStorageViewSnapshot,
  loadDashboard,
  moveStageHistory,
  onScanTaskEvent,
  openFolderIn,
  previewCleanup,
  stagePath,
  startScan,
  unstagePath,
} from "../lib/tauri";
import {
  clearScanProgressForRequest,
  clearScanProgressForSite,
  initialScanProgress,
  reconcileScanCompletions,
  retainedScanCompletionFromSiteState,
  scanCompletionFromEvent,
  scanProgressFromEvent,
  scanSitePublishedInventory,
  setCurrentScanProgress,
  silenceScanCompletions,
  siteHasInventory,
} from "../lib/scanView";
import type {
  CleanupPreview,
  CancelScanMode,
  Dashboard,
  DirectoryRefreshTarget,
  DirectorySort,
  DuplicateFile,
  FileContentMatch,
  FinderPosition,
  FirstScanInterruption,
  FolderOpenDestination,
  FolderSimilarityMatch,
  HealthMetric,
  ScanActivityResult,
  ScanCompletionView,
  ScanProgressView,
  ScanTask,
  ScanTaskEvent,
  SiteOverview,
  StageHistoryRequest,
  StageHistoryState,
  StorageNode,
  StorageChildrenPage,
  StorageDirectoryAnchor,
  StorageDirectoryFilter,
  StorageLocation,
  StorageTree,
  StorageViewSnapshot,
} from "../lib/types";
import { DEFAULT_DIRECTORY_SORT } from "../lib/types";

const CHILDREN_PAGE_SIZE = 6;
const CHILDREN_PREFETCH_ROWS = 40;
const MAX_CHILDREN_BATCH = 200;
const ANALYSIS_REFRESH_DELAY_MS = 650;
const FINAL_ANALYSIS_REFRESH_DELAY_MS = 75;
const FINAL_ANALYSIS_REFRESH_RETRY_MS = 150;

interface NavigationEntry {
  site_id: string;
  target_site_id: string | null;
  node_id: string;
  offset: number;
  limit: number;
  anchor_offset: number;
  selected_node_id: string;
  sort: DirectorySort;
  finder_position?: FinderPosition | null;
}

interface AtlasSelection {
  node: StorageNode;
  finderPosition: FinderPosition | null;
}

interface DirectoryWindow extends StorageChildrenPage {
  anchor_offset: number;
  sort: DirectorySort;
}

interface RowRange {
  start: number;
  end: number; // Exclusive.
}

type LocationLoadResult = "loaded" | "unavailable" | "failed" | "superseded";

interface LocationAction {
  title: string;
  sourceSwitch?: boolean;
  retry?: () => Promise<boolean>;
}

interface LocationFailure {
  workspace: string;
  title: string;
  message: string;
  sourceSwitch?: boolean;
  retry: (() => Promise<boolean>) | null;
}

interface LocationLoadOptions {
  silent?: boolean;
  signal?: AbortSignal;
  onError?: (message: string) => void;
  action?: LocationAction;
  retrying?: boolean;
  anchor?: DirectoryAnchorLoad;
}

interface DirectoryAnchorLoad {
  request: StorageDirectoryAnchor;
  onArrival: (location: StorageLocation, page: DirectoryWindow, filteredPage?: StorageChildrenPage | null) => boolean | void;
}

type FileRevealDestination =
  | { kind: "node"; siteId: string; id: string; filter?: StorageDirectoryFilter; shouldApply?: () => boolean }
  | { kind: "match"; siteId: string; id: string; signal: AbortSignal; finderPosition?: FinderPosition };

type FileRevealLocation = Pick<NavigationEntry, "site_id" | "target_site_id" | "node_id" | "sort" | "anchor_offset">
  & { filtered_page?: StorageChildrenPage | null };
type FileRevealResult = { location: FileRevealLocation; error: null } | { location: null; error: string };

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}

function isUnavailableLocationError(message: string): boolean {
  return message.startsWith("storage node not found:")
    || message.startsWith("storage node is not navigable:")
    || message.toLowerCase().startsWith("site not found:");
}

function siteRootEntry(siteId: string, targetSiteId: string | null, sort: DirectorySort): NavigationEntry {
  const rootId = `site:${siteId}`;
  return {
    site_id: siteId, target_site_id: targetSiteId, node_id: rootId,
    offset: 0, limit: CHILDREN_PAGE_SIZE, anchor_offset: 0, selected_node_id: rootId, sort,
  };
}

function rememberedSiteEntry(
  scope: string, workspace: string | null, siteId: string, targetSiteId: string | null, sort: DirectorySort,
): NavigationEntry {
  const root = siteRootEntry(siteId, targetSiteId, sort);
  const folder = workspace ? readAtlasBrowsing(scope, workspace).site_folders.find((saved) => saved.site_id === siteId) : null;
  return folder ? { ...root, node_id: folder.node_id, selected_node_id: folder.node_id } : root;
}

function sameSort(left: DirectorySort, right: DirectorySort) {
  return left.field === right.field && left.direction === right.direction;
}

function withDirectorySort(entry: NavigationEntry, sort: DirectorySort): NavigationEntry {
  // Offsets and grouped-arc anchors only have meaning in the order that produced them.
  return sameSort(entry.sort, sort) ? entry : { ...entry, sort, offset: 0, anchor_offset: 0, limit: CHILDREN_PAGE_SIZE };
}

function sameNavigationEntry(left: NavigationEntry, right: NavigationEntry): boolean {
  const previousSearch = left.finder_position;
  const nextSearch = right.finder_position;
  return left.site_id === right.site_id
    && left.target_site_id === right.target_site_id
    && left.node_id === right.node_id
    && left.anchor_offset === right.anchor_offset
    && sameSort(left.sort, right.sort)
    && left.selected_node_id === right.selected_node_id
    && previousSearch?.session === nextSearch?.session
    && previousSearch?.query === nextSearch?.query
    && previousSearch?.file_id === nextSearch?.file_id;
}

function findNode(root: StorageNode, nodeId: string | null): StorageNode | null {
  if (!nodeId || root.id === nodeId) return nodeId ? root : null;
  for (const child of root.children) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
  return null;
}

function validTarget(
  sites: SiteOverview[],
  sourceSiteId: string | null,
  requestedTargetSiteId: string | null,
): string | null {
  if (requestedTargetSiteId && requestedTargetSiteId !== sourceSiteId
    && sites.some((site) => site.id === requestedTargetSiteId)) {
    return requestedTargetSiteId;
  }
  return sites.find((site) => site.id !== sourceSiteId)?.id ?? null;
}

export function useDashboard(
  expectedWorkspace: string | null,
  siteListRevision: number,
  browsingScope: string,
  directoryRefresh: RefObject<DirectoryRefreshTarget | null>,
) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locationFailure, setLocationFailure] = useState<LocationFailure | null>(null);
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  const [coverageTargetSiteId, setCoverageTargetSiteId] = useState<string | null>(null);
  const [healthMetric, setHealthMetric] = useState<HealthMetric>("space_health");
  const [activeTree, setActiveTree] = useState<StorageTree | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [location, setLocation] = useState<StorageLocation | null>(null);
  const [selection, setSelection] = useState<AtlasSelection | null>(null);
  const [backHistory, setBackHistory] = useState<NavigationEntry[]>([]);
  const [forwardHistory, setForwardHistory] = useState<NavigationEntry[]>([]);
  const [childrenPage, setChildrenPage] = useState<DirectoryWindow | null>(null);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [loadingMoreChildren, setLoadingMoreChildren] = useState(false);
  const [childrenError, setChildrenError] = useState<string | null>(null);
  const [progressBySite, setProgressBySite] = useState<Map<string, ScanProgressView>>(new Map());
  const [completionBySite, setCompletionBySite] = useState<Map<string, ScanCompletionView>>(new Map());
  const [activeRequestIds, setActiveRequestIds] = useState<Set<number>>(new Set());
  const [activeScanTasks, setActiveScanTasks] = useState<Map<number, ScanTask>>(new Map());
  const [lastScanResult, setLastScanResult] = useState<ScanActivityResult | null>(null);
  const [firstScanInterruptions, setFirstScanInterruptions] = useState<ReadonlyMap<string, FirstScanInterruption>>(new Map());
  const [cancellingRequestIds, setCancellingRequestIds] = useState<Set<number>>(new Set());
  const [stagingBusy, setStagingBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [contentRevision, setContentRevision] = useState(0);
  const [duplicateJumpRevision, setDuplicateJumpRevision] = useState(0);
  const selectedSiteRef = useRef<string | null>(null);
  const targetSiteRef = useRef<string | null>(null);

  const locationRequestRef = useRef(0);
  const locationRef = useRef<StorageLocation | null>(null);
  const navigationInProgressRef = useRef(false);
  const navigationOperationRef = useRef(0);
  const childrenRequestRef = useRef(0);
  const childrenLoadingRef = useRef(false);
  const pendingRangeRef = useRef<RowRange | null>(null);
  const childrenRetryRef = useRef<RowRange | null>(null);
  const selectionRef = useRef<AtlasSelection | null>(null);
  const lastLocationBySite = useRef(new Map<string, NavigationEntry>());
  const backHistoryRef = useRef<NavigationEntry[]>([]);
  const forwardHistoryRef = useRef<NavigationEntry[]>([]);
  const childrenPageRef = useRef<DirectoryWindow | null>(null);
  const dashboardRef = useRef<Dashboard | null>(null);
  const completionBySiteRef = useRef<Map<string, ScanCompletionView>>(new Map());
  const currentSiteIdsRef = useRef<Set<string>>(new Set());
  const terminalRequestIdsRef = useRef<Set<number>>(new Set());
  const cancelRequestsInFlightRef = useRef<Set<number>>(new Set());
  const publishedInventoryKeysRef = useRef<Set<string>>(new Set());
  const analysisRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const analysisRefreshSitesRef = useRef<Map<string, number>>(new Map());
  const analysisRefreshInFlightRef = useRef(false);
  const analysisRefreshGenerationRef = useRef(0);
  const finalAnalysisRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const finalAnalysisRefreshSitesRef = useRef<Set<string>>(new Set());
  const cleanupPreviewRequestRef = useRef(0);
  const stagingInProgress = useRef(false);
  const dashboardRequestRef = useRef(0);
  const workspaceNameRef = useRef(expectedWorkspace);

  const updateCompletionBySite = useCallback((
    update: (current: Map<string, ScanCompletionView>) => Map<string, ScanCompletionView>,
  ) => {
    setCompletionBySite((current) => {
      const next = update(current);
      completionBySiteRef.current = next;
      return next;
    });
  }, []);

  const invalidateCleanupPreview = useCallback(() => {
    cleanupPreviewRequestRef.current += 1;
    setPreview(null);
    setPreviewLoading(false);
  }, []);

  const clearAnalysisRefreshes = useCallback(() => {
    analysisRefreshGenerationRef.current += 1;
    if (analysisRefreshTimerRef.current !== null) {
      clearTimeout(analysisRefreshTimerRef.current);
      analysisRefreshTimerRef.current = null;
    }
    if (finalAnalysisRefreshTimerRef.current !== null) {
      clearTimeout(finalAnalysisRefreshTimerRef.current);
      finalAnalysisRefreshTimerRef.current = null;
    }
    analysisRefreshSitesRef.current.clear();
    finalAnalysisRefreshSitesRef.current.clear();
  }, []);

  const clearAnalysisRefreshRequest = useCallback((requestId: number, siteId?: string) => {
    for (const [pendingSiteId, pendingRequestId] of analysisRefreshSitesRef.current) {
      if (pendingRequestId === requestId && (!siteId || pendingSiteId === siteId)) {
        analysisRefreshSitesRef.current.delete(pendingSiteId);
      }
    }
    if (analysisRefreshSitesRef.current.size === 0 && analysisRefreshTimerRef.current !== null) {
      clearTimeout(analysisRefreshTimerRef.current);
      analysisRefreshTimerRef.current = null;
    }
  }, []);

  const selectLocationNode = useCallback((node: StorageNode | null, finderPosition: FinderPosition | null = null) => {
    const next = node ? { node, finderPosition } : null;
    selectionRef.current = next;
    setSelection(next);
  }, []);

  const clearLocation = useCallback(() => {
    locationRequestRef.current += 1;
    childrenRequestRef.current += 1;
    navigationOperationRef.current += 1;
    navigationInProgressRef.current = false;
    childrenLoadingRef.current = false;
    pendingRangeRef.current = null;
    childrenRetryRef.current = null;
    locationRef.current = null;
    childrenPageRef.current = null;
    backHistoryRef.current = [];
    forwardHistoryRef.current = [];
    setActiveTree(null);
    setLocation(null);
    selectLocationNode(null);
    setChildrenPage(null);
    setTreeError(null);
    setLocationFailure(null);
    setChildrenError(null);
    setChildrenLoading(false);
    setLoadingMoreChildren(false);
    setBackHistory([]);
    setForwardHistory([]);
  }, [selectLocationNode]);

  useEffect(() => {
    if (workspaceNameRef.current !== expectedWorkspace) {
      const dashboardMatchesWorkspace = dashboardRef.current?.workspace_name === expectedWorkspace;
      clearAnalysisRefreshes();
      clearLocation();
      lastLocationBySite.current.clear();
      if (!dashboardMatchesWorkspace) {
        setProgressBySite(new Map());
        updateCompletionBySite(() => new Map());
        setActiveRequestIds(new Set());
        setActiveScanTasks(new Map());
        setLastScanResult(null);
        setFirstScanInterruptions(new Map());
        setCancellingRequestIds(new Set());
        currentSiteIdsRef.current = new Set();
        terminalRequestIdsRef.current.clear();
        cancelRequestsInFlightRef.current.clear();
        publishedInventoryKeysRef.current.clear();
      }
    }
    workspaceNameRef.current = expectedWorkspace;
  }, [clearAnalysisRefreshes, clearLocation, expectedWorkspace, updateCompletionBySite]);

  const workspaceName = dashboard?.workspace_name;
  const locationSite = location?.site_id;
  const folderId = location?.root.id;
  useLayoutEffect(() => {
    if (!workspaceName || (expectedWorkspace && workspaceName !== expectedWorkspace)
      || !locationSite || activeSiteId !== locationSite || !folderId || !currentSiteIdsRef.current.has(locationSite)) return;
    // Persist the location that actually rendered, including jumps from file search and analysis.
    rememberAtlasFolder(browsingScope, workspaceName, locationSite, folderId, currentSiteIdsRef.current);
  }, [activeSiteId, browsingScope, expectedWorkspace, folderId, locationSite, workspaceName]);

  const currentNavigationEntry = useCallback((): NavigationEntry | null => {
    const siteId = selectedSiteRef.current;
    const currentLocation = locationRef.current;
    if (!siteId || currentLocation?.site_id !== siteId) return null;
    const currentPage = childrenPageRef.current;
    const selected = selectionRef.current;
    return {
      site_id: siteId,
      target_site_id: targetSiteRef.current,
      node_id: currentLocation.root.id,
      offset: currentPage?.parent.id === currentLocation.root.id ? currentPage.offset : 0,
      limit: Math.max(CHILDREN_PAGE_SIZE, currentPage?.children.length ?? 0),
      anchor_offset: currentPage?.anchor_offset ?? 0,
      sort: currentPage?.sort ?? DEFAULT_DIRECTORY_SORT,
      selected_node_id: selected?.node.id ?? currentLocation.root.id,
      finder_position: selected?.finderPosition,
    };
  }, []);

  const loadFolderLocation = useCallback(async function loadFolderLocation(
    entry: NavigationEntry,
    historyAction: "push" | "switch" | "back" | "forward" | "reset" | "preserve",
    { silent = false, signal, onError, action, retrying = false, anchor }: LocationLoadOptions = {},
  ): Promise<LocationLoadResult> {
    const workspace = workspaceNameRef.current;
    if (!workspace) return "failed";
    if (signal?.aborted) return "superseded";
    const requestId = ++locationRequestRef.current;
    const childrenRequestId = ++childrenRequestRef.current;
    pendingRangeRef.current = null;
    setLoadingMoreChildren(false);
    const previousEntry = currentNavigationEntry();
    const ownsRequest = () => locationRequestRef.current === requestId
      && childrenRequestRef.current === childrenRequestId
      && workspaceNameRef.current === workspace;
    const isCurrent = () => ownsRequest() && !signal?.aborted;
    const finish = () => {
      if (!silent && ownsRequest()) {
        childrenLoadingRef.current = false;
        setChildrenLoading(false);
      }
    };
    signal?.addEventListener("abort", finish, { once: true });
    if (!silent) {
      if (historyAction !== "back" && historyAction !== "forward") {
        navigationOperationRef.current += 1;
        navigationInProgressRef.current = false;
      }
      childrenLoadingRef.current = true;
      childrenRetryRef.current = null;
      setChildrenLoading(true);
      setChildrenError(null);
      setTreeError(null);
      if (!retrying) setLocationFailure(null);
      if (!onError) setNotice(null);
    }

    const read = (destination: NavigationEntry) => getStorageViewSnapshot(
      workspace, destination.site_id, destination.target_site_id, destination.node_id,
      destination.offset, 5, 12, Math.min(destination.limit, MAX_CHILDREN_BATCH), destination.sort,
      destination.node_id === entry.node_id ? anchor?.request : undefined,
    );

    try {
      let snapshot: StorageViewSnapshot;
      try {
        snapshot = await read(entry);
      } catch (loadError) {
        if (!isCurrent()) return "superseded";
        const root = siteRootEntry(entry.site_id, entry.target_site_id, entry.sort);
        const canReopenRoot = historyAction === "preserve" || historyAction === "switch" || historyAction === "reset";
        if (!canReopenRoot || root.node_id === entry.node_id
          || !isUnavailableLocationError(errorMessage(loadError))) throw loadError;
        // A rescan can remove the folder while this site is in the background.
        snapshot = await read(root);
      }
      if (!isCurrent()) return "superseded";

      const { location: nextLocation, tree } = snapshot;
      const sameFolder = nextLocation.root.id === entry.node_id;
      const page: DirectoryWindow = {
        ...snapshot.page,
        sort: entry.sort,
        anchor_offset: sameFolder && ((silent && anchor) || entry.anchor_offset < snapshot.page.total_children)
          ? entry.anchor_offset : snapshot.page.offset,
      };
      const preserved = historyAction === "preserve" ? selectionRef.current : null;
      const selectedId = preserved?.node.id ?? entry.selected_node_id;
      const finderPosition = preserved ? preserved.finderPosition : entry.finder_position ?? null;
      const selection = findNode(nextLocation.root, selectedId)
        ?? page.children.find((child) => child.id === selectedId)
        ?? nextLocation.root;

      if (sameFolder && anchor?.onArrival(nextLocation, page, snapshot.filtered_page) === false) return "superseded";
      if (previousEntry && previousEntry.site_id !== entry.site_id) {
        lastLocationBySite.current.set(previousEntry.site_id, previousEntry);
      }
      locationRef.current = nextLocation;
      childrenPageRef.current = page;
      selectedSiteRef.current = entry.site_id;
      targetSiteRef.current = entry.target_site_id;
      childrenRetryRef.current = null;
      setActiveTree(tree);
      setActiveSiteId(entry.site_id);
      setCoverageTargetSiteId(entry.target_site_id);
      setLocation(nextLocation);
      setChildrenPage(page);
      selectLocationNode(selection, selection.id === selectedId ? finderPosition : null);
      setChildrenError(null);
      setTreeError(null);
      if (!silent || previousEntry?.site_id !== entry.site_id
        || previousEntry.node_id !== nextLocation.root.id || previousEntry.target_site_id !== entry.target_site_id) {
        setLocationFailure(null);
      }

      if (historyAction === "reset" || (historyAction === "preserve" && nextLocation.root.id !== entry.node_id)) {
        backHistoryRef.current = [];
        forwardHistoryRef.current = [];
      } else if ((historyAction === "push" || historyAction === "switch") && previousEntry
        && !sameNavigationEntry(previousEntry, { ...entry, offset: page.offset, selected_node_id: selection.id })) {
        backHistoryRef.current = [...backHistoryRef.current, previousEntry];
        forwardHistoryRef.current = [];
      } else if (historyAction === "back" && previousEntry) {
        backHistoryRef.current = backHistoryRef.current.slice(0, -1);
        forwardHistoryRef.current = [...forwardHistoryRef.current, previousEntry];
      } else if (historyAction === "forward" && previousEntry) {
        forwardHistoryRef.current = forwardHistoryRef.current.slice(0, -1);
        backHistoryRef.current = [...backHistoryRef.current, previousEntry];
      }
      setBackHistory(backHistoryRef.current);
      setForwardHistory(forwardHistoryRef.current);
      return "loaded";
    } catch (locationError) {
      if (!isCurrent()) return "superseded";
      const message = errorMessage(locationError);
      const unavailable = isUnavailableLocationError(message);
      if (onError) {
        onError(message);
      } else if (!silent) {
        const skipUnavailable = unavailable && (historyAction === "back" || historyAction === "forward");
        if (action && !skipUnavailable) {
          setLocationFailure({
            workspace,
            title: action.title,
            sourceSwitch: action.sourceSwitch,
            message: unavailable ? "This location is no longer available in the index." : message,
            retry: unavailable ? null : action.retry ?? (async () =>
              (await loadFolderLocation(entry, historyAction, { action, retrying: true, anchor })) === "loaded"),
          });
        } else if (!previousEntry) {
          setTreeError(message);
        } else if (!skipUnavailable) {
          setNotice(message);
        }
      }
      return unavailable ? "unavailable" : "failed";
    } finally {
      signal?.removeEventListener("abort", finish);
      finish();
    }
  }, [currentNavigationEntry, selectLocationNode]);

  const retryLocation = useCallback(async () => {
    if (!locationFailure?.retry || locationFailure.workspace !== workspaceNameRef.current
      || childrenLoadingRef.current || navigationInProgressRef.current) return false;
    return locationFailure.retry();
  }, [locationFailure]);

  const setDirectorySort = useCallback(async (sort: DirectorySort) => {
    const workspace = workspaceNameRef.current;
    const current = currentNavigationEntry();
    if (!workspace || !current) return;
    writeSiteDirectorySort(workspace, current.site_id, sort);
    const destination = withDirectorySort(current, sort);
    if (destination !== current || childrenLoadingRef.current) {
      await loadFolderLocation(destination, "preserve", { action: { title: "Couldn’t change the Contents order" } });
    }
  }, [currentNavigationEntry, loadFolderLocation]);

  const refreshTree = useCallback(async (
    siteId: string,
    targetSiteId: string | null,
    foreground = false,
  ) => {
    if (!foreground && (navigationInProgressRef.current || childrenLoadingRef.current || pendingRangeRef.current)) return false;
    const current = currentNavigationEntry();
    const preserve = current?.site_id === siteId;
    const workspace = workspaceNameRef.current;
    const entry = preserve
      ? { ...current, target_site_id: targetSiteId }
      : rememberedSiteEntry(browsingScope, foreground ? workspace : null, siteId, targetSiteId,
        readSiteDirectorySort(workspace, siteId));
    const positionForFolder = (target: DirectoryRefreshTarget | null) => {
      const position = target?.getUnfilteredPosition();
      return position?.siteId === entry.site_id && position.targetSiteId === entry.target_site_id
        && position.nodeId === entry.node_id ? position : null;
    };
    const position = !foreground && preserve ? positionForFolder(directoryRefresh.current) : null;
    const anchor: DirectoryAnchorLoad | undefined = position ? {
      request: { child_id: position.childId, query: null },
      onArrival: (_location, page) => {
        const target = directoryRefresh.current;
        const latest = positionForFolder(target);
        if (!latest) return;
        // A movement inside the loaded window does not start a new directory read.
        if (latest.childId !== position.childId || latest.index !== position.index) return false;
        const match = page.children.findIndex((entry) => entry.id === position.childId);
        return target?.receive({
          page,
          previousIndex: position.index,
          index: match < 0 ? Math.min(position.index, Math.max(0, page.total_children - 1)) : page.offset + match,
          previousTotal: position.total,
          missingEntry: match < 0,
        });
      },
    } : undefined;
    const result = await loadFolderLocation(entry, preserve ? "preserve" : "reset", { silent: !foreground, anchor });
    return result === "loaded";
  }, [browsingScope, currentNavigationEntry, directoryRefresh, loadFolderLocation]);

  const acceptDashboard = useCallback((next: Dashboard) => {
    const workspaceChanged = dashboardRef.current !== null
      && dashboardRef.current.workspace_name !== next.workspace_name;
    if (workspaceChanged) {
      clearAnalysisRefreshes();
      lastLocationBySite.current.clear();
      terminalRequestIdsRef.current.clear();
      cancelRequestsInFlightRef.current.clear();
      publishedInventoryKeysRef.current.clear();
      setProgressBySite(new Map());
      setLastScanResult(null);
    }
    const activeTasks = next.active_tasks.filter(
      (task) => !terminalRequestIdsRef.current.has(task.request_id),
    );
    const activeIds = new Set(activeTasks.map((task) => task.request_id));
    dashboardRef.current = next;
    currentSiteIdsRef.current = new Set(next.sites.map((site) => site.id));
    for (const siteId of lastLocationBySite.current.keys()) {
      if (!currentSiteIdsRef.current.has(siteId)) lastLocationBySite.current.delete(siteId);
    }
    workspaceNameRef.current = next.workspace_name;
    setDashboard(next);
    setFirstScanInterruptions((current) => {
      if (current.size === 0) return current;
      if (workspaceChanged) return new Map();
      const retain = new Map<string, FirstScanInterruption>();
      for (const site of next.sites) {
        const interruption = current.get(site.id);
        if (interruption && !siteHasInventory(site)) retain.set(site.id, interruption);
      }
      return retain.size === current.size ? current : retain;
    });
    invalidateCleanupPreview();
    setActiveRequestIds(activeIds);
    setActiveScanTasks(new Map(activeTasks.map((task) => [task.request_id, task])));
    setCancellingRequestIds((current) => {
      const nextCancelling = new Set(
        activeTasks
          .filter((task) => task.status === "cancelling")
          .map((task) => task.request_id),
      );
      for (const requestId of current) {
        if (activeIds.has(requestId)) nextCancelling.add(requestId);
      }
      return nextCancelling;
    });
    updateCompletionBySite((current) => reconcileScanCompletions(
      workspaceChanged ? new Map() : current,
      next.sites,
      activeTasks,
    ));
  }, [clearAnalysisRefreshes, invalidateCleanupPreview, updateCompletionBySite]);

  const refresh = useCallback(async () => {
    const requestId = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = requestId;
    const locationGeneration = locationRequestRef.current;
    const requestedWorkspace = workspaceNameRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadDashboard();
      if (dashboardRequestRef.current !== requestId
        || (requestedWorkspace && next.workspace_name !== requestedWorkspace)) return;
      acceptDashboard(next);
      const requestedSite = selectedSiteRef.current;
      const savedSite = readAtlasBrowsing(browsingScope, next.workspace_name).active_site_id;
      const nextSite = [requestedSite, savedSite].find((id) => id !== null && currentSiteIdsRef.current.has(id))
        ?? next.sites[0]?.id ?? null;
      const nextTarget = validTarget(next.sites, nextSite, targetSiteRef.current);
      // A background change to the site list must not replace a newer location request.
      if (nextSite && requestedSite === nextSite
        && (childrenLoadingRef.current || locationGeneration !== locationRequestRef.current)) return;
      if (!nextSite || (locationRef.current && locationRef.current.site_id !== nextSite)) clearLocation();
      if (!locationRef.current) {
        setActiveSiteId(nextSite);
        setCoverageTargetSiteId(nextTarget);
        selectedSiteRef.current = nextSite;
        targetSiteRef.current = nextTarget;
      }
      if (nextSite) await refreshTree(nextSite, nextTarget, true);
    } catch (loadError) {
      if (dashboardRequestRef.current === requestId) setError(errorMessage(loadError));
    } finally {
      if (dashboardRequestRef.current === requestId) setLoading(false);
    }
  }, [acceptDashboard, browsingScope, clearLocation, refreshTree]);

  const reloadDashboard = useCallback(async () => {
    if (!dashboardRef.current) {
      await refresh();
      const refreshedDashboard = dashboardRef.current as Dashboard | null;
      return refreshedDashboard?.workspace_name === workspaceNameRef.current;
    }
    const requestId = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = requestId;
    const requestedWorkspace = workspaceNameRef.current;
    try {
      const next = await loadDashboard();
      if (dashboardRequestRef.current !== requestId
        || (requestedWorkspace && next.workspace_name !== requestedWorkspace)) return false;
      acceptDashboard(next);
      return true;
    } catch {
      // Scan completion already has enough event data to stay useful if this refresh fails.
      return false;
    } finally {
      if (dashboardRequestRef.current === requestId) setLoading(false);
    }
  }, [acceptDashboard, refresh]);

  const scheduleAnalysisRefresh = useCallback((requestId: number, siteId: string) => {
    analysisRefreshSitesRef.current.set(siteId, requestId);
    if (analysisRefreshTimerRef.current !== null) return;
    const generation = analysisRefreshGenerationRef.current;

    const flush = () => {
      if (analysisRefreshGenerationRef.current !== generation) {
        analysisRefreshTimerRef.current = null;
        return;
      }
      if (analysisRefreshInFlightRef.current) {
        analysisRefreshTimerRef.current = setTimeout(flush, ANALYSIS_REFRESH_DELAY_MS);
        return;
      }

      const sites = new Map(analysisRefreshSitesRef.current);
      analysisRefreshSitesRef.current.clear();
      analysisRefreshTimerRef.current = null;
      if (sites.size === 0) return;

      const requestedWorkspace = workspaceNameRef.current;
      analysisRefreshInFlightRef.current = true;
      void reloadDashboard().then(async (dashboardFresh) => {
        if (analysisRefreshGenerationRef.current !== generation
          || workspaceNameRef.current !== requestedWorkspace) return;
        const sourceSiteId = selectedSiteRef.current;
        const targetSiteId = targetSiteRef.current;
        let viewFresh = true;
        if (sourceSiteId && (sites.has(sourceSiteId) || Boolean(targetSiteId && sites.has(targetSiteId)))) {
          viewFresh = await refreshTree(sourceSiteId, targetSiteId, false);
        }
        if ((!dashboardFresh || !viewFresh)
          && analysisRefreshGenerationRef.current === generation
          && workspaceNameRef.current === requestedWorkspace) {
          for (const [pendingSiteId, pendingRequestId] of sites) {
            if (terminalRequestIdsRef.current.has(pendingRequestId)) continue;
            const currentRequestId = analysisRefreshSitesRef.current.get(pendingSiteId);
            if (currentRequestId === undefined || currentRequestId < pendingRequestId) {
              analysisRefreshSitesRef.current.set(pendingSiteId, pendingRequestId);
            }
          }
          if (analysisRefreshSitesRef.current.size > 0
            && analysisRefreshTimerRef.current === null) {
            analysisRefreshTimerRef.current = setTimeout(flush, ANALYSIS_REFRESH_DELAY_MS);
          }
        }
      }).finally(() => {
        analysisRefreshInFlightRef.current = false;
      });
    };

    analysisRefreshTimerRef.current = setTimeout(flush, ANALYSIS_REFRESH_DELAY_MS);
  }, [refreshTree, reloadDashboard]);

  const scheduleFinalAnalysisRefresh = useCallback((siteIds: Iterable<string>) => {
    for (const siteId of siteIds) finalAnalysisRefreshSitesRef.current.add(siteId);
    if (finalAnalysisRefreshTimerRef.current !== null) return;
    const generation = analysisRefreshGenerationRef.current;

    const flush = async (retry = 0) => {
      finalAnalysisRefreshTimerRef.current = null;
      if (analysisRefreshGenerationRef.current !== generation) return;
      const sites = new Set(finalAnalysisRefreshSitesRef.current);
      finalAnalysisRefreshSitesRef.current.clear();
      const requestedWorkspace = workspaceNameRef.current;
      const dashboardFresh = await reloadDashboard();
      if (analysisRefreshGenerationRef.current !== generation
        || workspaceNameRef.current !== requestedWorkspace) return;

      const sourceSiteId = selectedSiteRef.current;
      const targetSiteId = targetSiteRef.current;
      const activeSiteAffected = sites.size === 0
        || Boolean(sourceSiteId && sites.has(sourceSiteId))
        || Boolean(targetSiteId && sites.has(targetSiteId));
      const viewFresh = !sourceSiteId || !activeSiteAffected
        ? true
        : await refreshTree(sourceSiteId, targetSiteId, false);
      if ((!dashboardFresh || !viewFresh)
        && analysisRefreshGenerationRef.current === generation
        && workspaceNameRef.current === requestedWorkspace) {
        for (const siteId of sites) finalAnalysisRefreshSitesRef.current.add(siteId);
        if (finalAnalysisRefreshTimerRef.current === null) {
          finalAnalysisRefreshTimerRef.current = setTimeout(
            () => void flush(retry + 1),
            Math.min(2_000, FINAL_ANALYSIS_REFRESH_RETRY_MS * 2 ** Math.min(retry, 4)),
          );
        }
      }
    };

    finalAnalysisRefreshTimerRef.current = setTimeout(
      () => void flush(),
      FINAL_ANALYSIS_REFRESH_DELAY_MS,
    );
  }, [refreshTree, reloadDashboard]);

  useEffect(() => {
    void refresh();
  }, [refresh, siteListRevision]);

  const handleScanEvent = useCallback((event: ScanTaskEvent) => {
    if (event.scope === "task" && event.kind === "cancelling"
      && !terminalRequestIdsRef.current.has(event.request_id)) {
      setActiveRequestIds((current) => new Set(current).add(event.request_id));
      setCancellingRequestIds((current) => new Set(current).add(event.request_id));
      setActiveScanTasks((current) => {
        const task = current.get(event.request_id);
        if (!task || (task.status === "cancelling" && !event.site_states)) return current;
        return new Map(current).set(event.request_id, {
          ...task,
          status: "cancelling",
          site_states: event.site_states ?? task.site_states,
        });
      });
    }
    if (event.scope === "site" && event.site_id
      && currentSiteIdsRef.current.has(event.site_id)
      && !terminalRequestIdsRef.current.has(event.request_id)) {
      setActiveRequestIds((current) => new Set(current).add(event.request_id));
      if (event.kind === "started" || event.kind === "progress") {
        const progress = scanProgressFromEvent(event);
        if (progress) {
          updateCompletionBySite((current) => silenceScanCompletions(
            current,
            [progress.site_id],
            progress.request_id,
          ));
          setProgressBySite((current) => setCurrentScanProgress(current, progress));
          if (progress.phase === "hashing" || progress.phase === "finalizing") {
            const inventoryKey = `${progress.request_id}\u0000${progress.site_id}`;
            if (!publishedInventoryKeysRef.current.has(inventoryKey)) {
              publishedInventoryKeysRef.current.add(inventoryKey);
              setContentRevision((current) => current + 1);
              void reloadDashboard().then(() => {
                const sourceSiteId = selectedSiteRef.current;
                const targetSiteId = targetSiteRef.current;
                if (sourceSiteId
                  && (progress.site_id === sourceSiteId || progress.site_id === targetSiteId)) {
                  void refreshTree(sourceSiteId, targetSiteId, false);
                }
              });
            }
            if (progress.phase === "hashing") {
              scheduleAnalysisRefresh(progress.request_id, progress.site_id);
            }
          }
        }
      } else if (["completed", "failed", "cancelled"].includes(event.kind)) {
        clearAnalysisRefreshRequest(event.request_id, event.site_id);
        setProgressBySite((current) => clearScanProgressForSite(
          current,
          event.site_id!,
          event.request_id,
        ));
        if (event.kind === "completed") {
          const completion = scanCompletionFromEvent(event);
          if (completion) {
            updateCompletionBySite((current) => {
              const existing = current.get(completion.site_id);
              if (existing?.request_id != null
                && existing.request_id > event.request_id) return current;
              return new Map(current).set(completion.site_id, completion);
            });
          }
        }
        setContentRevision((current) => current + 1);
        scheduleFinalAnalysisRefresh([event.site_id]);
        if (event.kind === "failed") setNotice(event.message ?? "A site scan failed.");
      }
    }
    if (event.scope === "task" && (event.kind === "completed" || event.kind === "failed" || event.kind === "cancelled")) {
      if (terminalRequestIdsRef.current.has(event.request_id)) return;
      const kind = event.kind;
      const siteStates = event.site_states?.filter((site) => currentSiteIdsRef.current.has(site.site_id)) ?? [];
      const indexedSites = new Set(dashboardRef.current?.sites.filter(siteHasInventory).map((site) => site.id));
      const hasInventory = (site: (typeof siteStates)[number]) => indexedSites.has(site.site_id) || scanSitePublishedInventory(site);
      const stoppedBeforeStart = kind === "cancelled" && siteStates.length === 1;
      const beforeInventory = siteStates.filter((site) => (
        site.status === "running" || (stoppedBeforeStart && site.status === "queued")
      ) && !hasInventory(site));
      if (siteStates.length > 0) {
        setLastScanResult({
          request_id: event.request_id,
          kind,
          site_states: siteStates,
          message: event.message,
        });
        const interrupted = kind === "completed" ? new Set<string>() : new Set(beforeInventory.map((site) => site.site_id));
        setFirstScanInterruptions((current) => {
          const next = new Map(current);
          for (const site of siteStates) {
            if ((current.get(site.site_id)?.request_id ?? 0) > event.request_id) continue;
            if (kind !== "completed" && interrupted.has(site.site_id)) {
              next.set(site.site_id, { request_id: event.request_id, kind });
            } else if (site.status !== "queued") {
              next.delete(site.site_id);
            }
          }
          if (next.size === 0 && current.size === 0) return current;
          return next;
        });
      }
      clearAnalysisRefreshRequest(event.request_id);
      const retainedCompletions = (event.site_states ?? [])
        .map((state) => retainedScanCompletionFromSiteState(event.request_id, state))
        .filter((completion): completion is ScanCompletionView => completion !== null);
      if (retainedCompletions.length > 0) {
        updateCompletionBySite((current) => {
          const next = new Map(current);
          for (const completion of retainedCompletions) {
            const existing = next.get(completion.site_id);
            if (existing?.source === "event" && existing.request_id === event.request_id) continue;
            if (existing?.request_id != null && existing.request_id > event.request_id) continue;
            next.set(completion.site_id, completion);
          }
          return next;
        });
      }
      terminalRequestIdsRef.current.add(event.request_id);
      setActiveRequestIds((current) => {
        const next = new Set(current);
        next.delete(event.request_id);
        return next;
      });
      setActiveScanTasks((current) => {
        if (!current.has(event.request_id)) return current;
        const next = new Map(current);
        next.delete(event.request_id);
        return next;
      });
      setCancellingRequestIds((current) => {
        if (!current.has(event.request_id)) return current;
        const next = new Set(current);
        next.delete(event.request_id);
        return next;
      });
      setProgressBySite((current) => clearScanProgressForRequest(current, event.request_id));
      publishedInventoryKeysRef.current.forEach((key) => {
        if (key.startsWith(`${event.request_id}\u0000`)) publishedInventoryKeysRef.current.delete(key);
      });
      if (event.kind !== "completed") setContentRevision((current) => current + 1);
      scheduleFinalAnalysisRefresh((event.site_states ?? []).map((state) => state.site_id));
      if (event.kind === "failed") setNotice(event.message ?? "The scan failed.");
      if (event.kind === "cancelled") {
        const message = siteStates.some(hasInventory) ? "Scan stopped. Indexed files remain available."
          : beforeInventory.length > 0 ? "Scan stopped before inventory was saved." : "Scan stopped.";
        setNotice(message);
      }
    }
  }, [
    clearAnalysisRefreshRequest,
    refreshTree,
    reloadDashboard,
    scheduleAnalysisRefresh,
    scheduleFinalAnalysisRefresh,
    updateCompletionBySite,
  ]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onScanTaskEvent(handleScanEvent).then((cleanup) => {
      if (disposed) cleanup();
      else unlisten = cleanup;
    }).catch((listenError) => setNotice(errorMessage(listenError)));
    return () => {
      disposed = true;
      unlisten?.();
      clearAnalysisRefreshes();
    };
  }, [clearAnalysisRefreshes, handleScanEvent]);

  useEffect(() => {
    const activeTasks = dashboard?.active_tasks ?? [];
    if (activeTasks.length === 0) return;
    const allSiteIds = dashboard?.sites.map((site) => site.id) ?? [];
    setProgressBySite((current) => {
      const next = new Map(current);
      for (const task of activeTasks) {
        if (terminalRequestIdsRef.current.has(task.request_id)) continue;
        const stateBySite = new Map(task.site_states.map((state) => [state.site_id, state]));
        const siteIds = task.site_states.length > 0
          ? task.site_states.map((state) => state.site_id)
          : task.selector.all ? allSiteIds : task.selector.site_id ? [task.selector.site_id] : [];
        for (const siteId of siteIds) {
          const siteState = stateBySite.get(siteId);
          if (siteState?.status === "completed") {
            if (next.get(siteId)?.request_id === task.request_id) next.delete(siteId);
            continue;
          }
          if (completionBySite.get(siteId)?.request_id === task.request_id) {
            if (next.get(siteId)?.request_id === task.request_id) next.delete(siteId);
            continue;
          }
          if (siteState?.status === "queued") continue;
          const existing = next.get(siteId);
          if (!existing || existing.request_id < task.request_id) {
            next.set(siteId, siteState?.status === "running" ? {
              request_id: task.request_id,
              site_id: siteId,
              phase: siteState.phase ?? "discovering",
              processed_files: siteState.processed_files,
              total_files: siteState.total_files,
              hashed_files: siteState.hashed_files,
              reused_files: siteState.reused_files,
              hashes_pending: siteState.hashes_pending,
              current_path: siteState.current_path,
            } : initialScanProgress(task.request_id, siteId));
          }
        }
      }
      return next;
    });
  }, [completionBySite, dashboard?.active_tasks, dashboard?.sites]);

  const selectSite = useCallback(async (siteId: string, targetSiteId = targetSiteRef.current) => {
    const sites = dashboardRef.current?.sites ?? [];
    const target = validTarget(sites, siteId, targetSiteId);
    const current = currentNavigationEntry();
    const workspace = workspaceNameRef.current;
    const sort = readSiteDirectorySort(workspace, siteId);
    const action = { title: `Couldn’t open ${sites.find((site) => site.id === siteId)?.name ?? "this source"}`, sourceSwitch: true };
    if (current?.site_id === siteId) {
      if (childrenLoadingRef.current) {
        return (await loadFolderLocation(withDirectorySort(current, sort), "preserve", { action })) === "loaded";
      }
      setLocationFailure(null);
      return true;
    }
    const previous = lastLocationBySite.current.get(siteId);
    const destination = previous
      ? { ...withDirectorySort(previous, sort), target_site_id: target }
      : rememberedSiteEntry(browsingScope, workspace, siteId, target, sort);
    return (await loadFolderLocation(destination, "switch", { action })) === "loaded";
  }, [browsingScope, currentNavigationEntry, loadFolderLocation]);

  const selectCoverageTarget = useCallback(async (targetSiteId: string) => {
    const current = currentNavigationEntry();
    if (!current || current.site_id === targetSiteId
      || (current.target_site_id === targetSiteId && !childrenLoadingRef.current)) return;
    const targetName = dashboardRef.current?.sites.find((site) => site.id === targetSiteId)?.name;
    await loadFolderLocation({ ...current, target_site_id: targetSiteId }, "push", {
      action: { title: targetName ? `Couldn’t compare with ${targetName}` : "Couldn’t change the comparison target" },
    });
  }, [currentNavigationEntry, loadFolderLocation]);

  const retryTree = useCallback(async () => {
    const siteId = selectedSiteRef.current;
    if (siteId) await refreshTree(siteId, targetSiteRef.current, true);
  }, [refreshTree]);

  const scan = useCallback(async (siteId?: string, onError?: (message: string) => void) => {
    setNotice(null);
    try {
      const workspaceName = workspaceNameRef.current;
      if (!workspaceName) throw new Error("Workspace is still loading.");
      const task = await startScan(
        siteId ? { site_id: siteId } : { all: true },
        workspaceName,
      );
      if (workspaceNameRef.current !== workspaceName || terminalRequestIdsRef.current.has(task.request_id)) return;
      dashboardRequestRef.current += 1;
      setActiveRequestIds((current) => new Set(current).add(task.request_id));
      setActiveScanTasks((current) => current.has(task.request_id) ? current : new Map(current).set(task.request_id, task));
      invalidateCleanupPreview();
      const siteIds = siteId
        ? [siteId]
        : dashboardRef.current?.sites.map((site) => site.id) ?? [];
      updateCompletionBySite((current) => silenceScanCompletions(
        current,
        siteIds,
        task.request_id,
      ));
      const siteStates = new Map(task.site_states.map((state) => [state.site_id, state.status]));
      setProgressBySite((current) => {
        let next = current;
        for (const currentSiteId of siteIds) {
          if (completionBySiteRef.current.get(currentSiteId)?.request_id === task.request_id
            || current.get(currentSiteId)?.request_id === task.request_id
            || siteStates.get(currentSiteId) === "queued") continue;
          next = setCurrentScanProgress(
            next,
            initialScanProgress(task.request_id, currentSiteId),
          );
        }
        return next;
      });
    } catch (scanError) {
      const message = errorMessage(scanError);
      setNotice(message);
      onError?.(message);
    }
  }, [invalidateCleanupPreview, updateCompletionBySite]);

  const cancel = useCallback(async (
    requestId: number,
    mode: CancelScanMode = "graceful",
  ) => {
    if (terminalRequestIdsRef.current.has(requestId)
      || cancelRequestsInFlightRef.current.has(requestId)) return;
    const requestedWorkspace = workspaceNameRef.current;
    cancelRequestsInFlightRef.current.add(requestId);
    setCancellingRequestIds((current) => new Set(current).add(requestId));
    try {
      const report = await cancelScan(requestId, mode);
      if (workspaceNameRef.current !== requestedWorkspace
        || terminalRequestIdsRef.current.has(requestId)) return;
      if (report.outcome === "not_found") {
        setCancellingRequestIds((current) => {
          if (!current.has(requestId)) return current;
          const next = new Set(current);
          next.delete(requestId);
          return next;
        });
        setNotice("That scan has already finished.");
        void reloadDashboard();
      }
    } catch (cancelError) {
      if (workspaceNameRef.current === requestedWorkspace
        && !terminalRequestIdsRef.current.has(requestId)) {
        setCancellingRequestIds((current) => {
          if (!current.has(requestId)) return current;
          const next = new Set(current);
          next.delete(requestId);
          return next;
        });
        setNotice(errorMessage(cancelError));
        void reloadDashboard();
      }
    } finally {
      cancelRequestsInFlightRef.current.delete(requestId);
    }
  }, [reloadDashboard]);

  const activeSelectedNode = selection?.node ?? location?.root ?? null;

  const openFolderExternally = useCallback(async (node: StorageNode, destination: FolderOpenDestination) => {
    const workspace = workspaceNameRef.current;
    const siteId = locationRef.current?.site_id;
    if (!workspace || !siteId) return;
    setNotice(null);
    let message: string | null;
    try {
      message = await openFolderIn({ workspace_name: workspace, site_id: siteId, node_id: node.id, destination });
    } catch (error) {
      message = errorMessage(error);
    }
    if (message && workspace === workspaceNameRef.current && siteId === locationRef.current?.site_id) {
      setNotice(message);
    }
  }, []);

  const selectNode = useCallback((node: StorageNode) => {
    const siteId = selectedSiteRef.current;
    if (!siteId) return;
    if (node.kind === "file") {
      setLocationFailure(null);
      if (pendingRangeRef.current) {
        // Keep this row's data available for Back while its details are open.
        childrenRequestRef.current += 1;
        pendingRangeRef.current = null;
        setLoadingMoreChildren(false);
      }
      if (childrenLoadingRef.current) {
        // A file in the displayed folder can still be selected while another location is opening.
        locationRequestRef.current += 1;
        childrenRequestRef.current += 1;
        navigationOperationRef.current += 1;
        navigationInProgressRef.current = false;
        childrenLoadingRef.current = false;
        setChildrenLoading(false);
      }
      selectLocationNode(node);
      return;
    }
    const group = node.kind === "smaller_items" ? /^smaller_items:(\d+):(.+)$/.exec(node.id) : null;
    if (node.kind === "smaller_items" && !group) return;
    if (!group && locationRef.current?.root.id === node.id) return;
    const folderId = group?.[2] ?? node.id;
    const offset = group ? Number(group[1]) : 0;
    void loadFolderLocation({
      site_id: siteId,
      target_site_id: targetSiteRef.current,
      node_id: folderId,
      offset,
      limit: CHILDREN_PAGE_SIZE,
      anchor_offset: offset,
      selected_node_id: folderId,
      // The atlas group offset counts entries in descending size order.
      sort: group ? DEFAULT_DIRECTORY_SORT : readSiteDirectorySort(workspaceNameRef.current, siteId),
    }, "push", { action: { title: `Couldn’t open ${node.name}` } });
  }, [loadFolderLocation, selectLocationNode]);

  const navigateHistory = useCallback(async function navigateHistory(
    direction: "back" | "forward", retrying = false,
  ): Promise<boolean> {
    if (!selectedSiteRef.current || childrenLoadingRef.current || navigationInProgressRef.current) return false;
    const operationId = navigationOperationRef.current + 1;
    navigationOperationRef.current = operationId;
    navigationInProgressRef.current = true;
    try {
      while (true) {
        const history = direction === "back" ? backHistoryRef.current : forwardHistoryRef.current;
        const entry = history.at(-1);
        if (!entry) return false;
        const sort = readSiteDirectorySort(workspaceNameRef.current, entry.site_id);
        const result = await loadFolderLocation(withDirectorySort(entry, sort), direction, {
          action: {
            title: direction === "back" ? "Couldn’t open the previous location" : "Couldn’t open the next location",
            retry: () => navigateHistory(direction, true),
          },
          retrying,
        });
        if (result !== "unavailable") return result === "loaded";

        const currentHistory = direction === "back" ? backHistoryRef.current : forwardHistoryRef.current;
        const currentEntry = currentHistory.at(-1);
        if (!currentEntry || !sameNavigationEntry(currentEntry, entry)) return false;
        const nextHistory = currentHistory.slice(0, -1);
        if (direction === "back") {
          backHistoryRef.current = nextHistory;
          setBackHistory(nextHistory);
        } else {
          forwardHistoryRef.current = nextHistory;
          setForwardHistory(nextHistory);
        }
        if (nextHistory.length === 0) {
          setLocationFailure(null);
          setNotice("That folder is no longer available.");
          return false;
        }
      }
    } finally {
      if (navigationOperationRef.current === operationId) {
        navigationInProgressRef.current = false;
      }
    }
  }, [loadFolderLocation]);

  const goBack = useCallback(() => navigateHistory("back"), [navigateHistory]);

  const goForward = useCallback(() => navigateHistory("forward"), [navigateHistory]);

  const navigateBreadcrumb = useCallback((node: StorageNode, anchor?: DirectoryAnchorLoad) => {
    const siteId = selectedSiteRef.current;
    if (!siteId || node.id === locationRef.current?.root.id) return;
    const targetSiteId = targetSiteRef.current;
    const previousVisit = [...backHistoryRef.current].reverse().find((entry) =>
      entry.site_id === siteId && entry.target_site_id === targetSiteId && entry.node_id === node.id);
    const sort = readSiteDirectorySort(workspaceNameRef.current, siteId);
    const resume = previousVisit && withDirectorySort(previousVisit, sort);
    void loadFolderLocation(
      {
        site_id: siteId,
        target_site_id: targetSiteId,
        node_id: node.id,
        offset: resume?.offset ?? 0,
        limit: resume?.limit ?? CHILDREN_PAGE_SIZE,
        anchor_offset: resume?.anchor_offset ?? 0,
        selected_node_id: node.id,
        sort,
      },
      "push",
      { action: { title: `Couldn’t open ${node.name}` }, anchor },
    );
  }, [loadFolderLocation]);

  const loadChildrenRange = useCallback(async (start: number, end: number) => {
    const loaded = childrenPage;
    if (!loaded || loaded !== childrenPageRef.current || childrenLoadingRef.current) return;
    const total = loaded.total_children;
    const first = Math.max(0, Math.floor(start));
    const last = Math.min(total, Math.ceil(end), first + MAX_CHILDREN_BATCH);
    if (!(first < last)) return;

    const pending = pendingRangeRef.current;
    const failed = childrenRetryRef.current;
    if (first >= loaded.offset && last <= loaded.offset + loaded.children.length) {
      // Dragging back into the current window supersedes a distant read, even when no new read is needed.
      if (pending) {
        childrenRequestRef.current += 1;
        pendingRangeRef.current = null;
        setLoadingMoreChildren(false);
      }
      if (failed) {
        childrenRetryRef.current = null;
        setChildrenError(null);
      }
      return;
    }
    if (pending && first >= pending.start && last <= pending.end) return;
    if (failed && first < failed.end && last > failed.start) return;

    // Center the viewport in a bounded buffer. A thumb drag can seek directly to any row.
    const visible = last - first;
    const limit = Math.min(total, MAX_CHILDREN_BATCH, visible + 2 * CHILDREN_PREFETCH_ROWS);
    const offset = Math.max(0, Math.min(total - limit, first - Math.floor((limit - visible) / 2)));
    const requestId = ++childrenRequestRef.current;
    pendingRangeRef.current = { start: offset, end: offset + limit };
    setLoadingMoreChildren(true);
    childrenRetryRef.current = null;
    setChildrenError(null);

    try {
      const page = await getStorageChildren(
        loaded.site.id, loaded.coverage_target?.id ?? null, loaded.parent.id, offset, limit, loaded.sort,
      );
      if (childrenRequestRef.current !== requestId) return;
      if (!page.children.length && page.offset < page.total_children) {
        throw new Error("The directory entries could not be read.");
      }
      // A rescan can shrink the folder mid-seek. Its new total clamps the scrollbar to a valid range.
      const next = { ...page, offset: Math.min(page.offset, page.total_children), anchor_offset: loaded.anchor_offset, sort: loaded.sort };
      childrenPageRef.current = next;
      setChildrenPage(next);
    } catch (loadError) {
      if (childrenRequestRef.current === requestId) {
        childrenRetryRef.current = { start: first, end: last };
        setChildrenError(errorMessage(loadError));
      }
    } finally {
      if (childrenRequestRef.current === requestId) {
        pendingRangeRef.current = null;
        setLoadingMoreChildren(false);
      }
    }
  }, [childrenPage]);

  const retryChildren = useCallback(() => {
    const failed = childrenRetryRef.current;
    childrenRetryRef.current = null;
    if (failed) void loadChildrenRange(failed.start, failed.end);
  }, [loadChildrenRange]);

  const revealFile = useCallback(async (destination: FileRevealDestination): Promise<FileRevealResult> => {
    const requestedWorkspace = workspaceNameRef.current;
    const currentSiteId = selectedSiteRef.current;
    const currentDashboard = dashboardRef.current;
    if (navigationInProgressRef.current || childrenLoadingRef.current) {
      return { location: null, error: "Wait for the current folder to finish loading, then try again." };
    }
    if (!requestedWorkspace || !currentSiteId || !currentDashboard) {
      return { location: null, error: "The workspace is unavailable." };
    }

    const currentTarget = targetSiteRef.current;
    const previousEntry = currentNavigationEntry();
    const isRequested = () => destination.kind === "match"
      ? !destination.signal.aborted
      : (selectedSiteRef.current === destination.siteId && selectionRef.current?.node.id === destination.id
        && (destination.shouldApply?.() ?? true));
    const cancelled = { location: null, error: "File navigation was cancelled." } as const;
    if (!isRequested()) return cancelled;

    const requestId = ++locationRequestRef.current;
    const operationId = ++navigationOperationRef.current;
    const canApply = () => locationRequestRef.current === requestId
      && navigationOperationRef.current === operationId
      && workspaceNameRef.current === requestedWorkspace
      && isRequested();
    const finish = () => {
      if (navigationOperationRef.current === operationId) {
        navigationInProgressRef.current = false;
      }
      if (locationRequestRef.current === requestId) {
        childrenLoadingRef.current = false;
        setChildrenLoading(false);
      }
    };
    // IPC may still finish after closing the dialog. Release navigation immediately and discard its reply.
    const signal = destination.kind === "match" ? destination.signal : undefined;
    signal?.addEventListener("abort", finish, { once: true });
    childrenRequestRef.current += 1;
    pendingRangeRef.current = null;
    childrenRetryRef.current = null;
    setLoadingMoreChildren(false);
    navigationInProgressRef.current = true;
    setChildrenLoading(true);
    childrenLoadingRef.current = true;
    setChildrenError(null);
    setLocationFailure(null);
    if (destination.kind === "node") setNotice(null);

    try {
      const savedSort = readSiteDirectorySort(requestedWorkspace, destination.siteId);
      const sort = destination.kind === "node" ? previousEntry?.sort ?? savedSort : savedSort;
      const preferredTarget = currentTarget && currentTarget !== destination.siteId ? currentTarget : currentSiteId;
      const destinationTarget = destination.kind === "node"
        ? currentTarget
        : validTarget(currentDashboard.sites, destination.siteId, preferredTarget);
      const reveal = destination.kind === "node"
        ? await getStorageNodeReveal(
          requestedWorkspace, destination.siteId, destination.id, destinationTarget, 5, 12, CHILDREN_PAGE_SIZE, sort, destination.filter,
        )
        : await getStorageFileReveal(requestedWorkspace, destination.id, destinationTarget, 5, 12, CHILDREN_PAGE_SIZE, sort);
      if (!canApply()) return cancelled;

      const selectedIndex = reveal.page.children.findIndex((child) => child.id === reveal.selected_file.id);
      if (selectedIndex < 0) throw new Error("The selected file could not be found in its directory.");
      const page: DirectoryWindow = { ...reveal.page, anchor_offset: reveal.page.offset + selectedIndex, sort };
      const finderPosition = destination.kind === "match" ? destination.finderPosition : previousEntry?.finder_position;
      const destinationEntry: NavigationEntry = {
        site_id: reveal.tree.site_id,
        target_site_id: reveal.tree.coverage_target?.id ?? null,
        node_id: reveal.location.root.id,
        offset: reveal.page.offset,
        limit: reveal.page.limit,
        anchor_offset: page.anchor_offset,
        sort,
        selected_node_id: reveal.selected_file.id,
        finder_position: finderPosition,
      };

      if (previousEntry && previousEntry.site_id !== destinationEntry.site_id) {
        lastLocationBySite.current.set(previousEntry.site_id, previousEntry);
      }
      setActiveTree(reveal.tree);
      selectedSiteRef.current = destinationEntry.site_id;
      targetSiteRef.current = destinationEntry.target_site_id;
      locationRef.current = reveal.location;
      childrenPageRef.current = page;
      childrenRequestRef.current += 1;
      childrenRetryRef.current = null;

      setActiveSiteId(destinationEntry.site_id);
      setCoverageTargetSiteId(destinationEntry.target_site_id);
      setLocation(reveal.location);
      setChildrenPage(page);
      setChildrenError(null);
      selectLocationNode(reveal.selected_file, finderPosition);
      if (destination.kind === "match") setDuplicateJumpRevision((current) => current + 1);
      setTreeError(null);

      // Showing the file in its current directory changes the inspector and scroll position only.
      if (previousEntry && (destination.kind === "match" || previousEntry.node_id !== destinationEntry.node_id)
        && !sameNavigationEntry(previousEntry, destinationEntry)) {
        backHistoryRef.current = [...backHistoryRef.current, previousEntry];
        forwardHistoryRef.current = [];
        setBackHistory(backHistoryRef.current);
        setForwardHistory([]);
      }
      return { location: { ...destinationEntry, filtered_page: reveal.filtered_page }, error: null };
    } catch (revealError) {
      if (!canApply()) return cancelled;
      const message = errorMessage(revealError);
      if (destination.kind === "node") setNotice(message);
      return { location: null, error: message };
    } finally {
      signal?.removeEventListener("abort", finish);
      finish();
    }
  }, [currentNavigationEntry, selectLocationNode]);

  const jumpToContentMatch = useCallback(async (
    match: Pick<FileContentMatch, "site_id" | "file_id">, signal: AbortSignal, finderPosition?: FinderPosition,
  ): Promise<string | null> => {
    const result = await revealFile({ kind: "match", siteId: match.site_id, id: match.file_id, signal, finderPosition });
    return result.error;
  }, [revealFile]);

  const jumpToSimilarFolder = useCallback(async (match: FolderSimilarityMatch, signal: AbortSignal): Promise<string | null> => {
    const workspace = workspaceNameRef.current;
    const currentSiteId = selectedSiteRef.current;
    const currentDashboard = dashboardRef.current;
    if (!workspace || !currentSiteId || !currentDashboard) return "The workspace is unavailable.";
    if (childrenLoadingRef.current || navigationInProgressRef.current) {
      return "Wait for the current folder to finish loading, then try again.";
    }
    const { site_id, node_id } = match.folder;
    const currentTarget = targetSiteRef.current;
    const preferredTarget = currentTarget && currentTarget !== site_id ? currentTarget : currentSiteId;
    const target = validTarget(currentDashboard.sites, site_id, preferredTarget);
    const sort = readSiteDirectorySort(workspace, site_id);
    let message = "The matched folder could not be opened.";
    const result = await loadFolderLocation({
      site_id, node_id, target_site_id: target, selected_node_id: node_id,
      offset: 0, limit: CHILDREN_PAGE_SIZE, anchor_offset: 0, sort,
    }, "push", { signal, onError: (error) => { message = error; } });
    if (result === "superseded") return "Folder navigation was cancelled.";
    if (result !== "loaded") return message;
    return null;
  }, [loadFolderLocation]);

  const revealSelectedFileInContents = useCallback(async (fileId: string, filter?: StorageDirectoryFilter, shouldApply?: () => boolean) => {
    const siteId = selectedSiteRef.current;
    if (!siteId || selectionRef.current?.node.kind !== "file" || childrenLoadingRef.current) return null;
    const result = await revealFile({ kind: "node", siteId, id: fileId, filter, shouldApply });
    return result.location;
  }, [revealFile]);

  const updateStaged = useCallback((update: (files: DuplicateFile[]) => DuplicateFile[], history: StageHistoryState) => {
    invalidateCleanupPreview();
    const current = dashboardRef.current;
    if (!current) return;
    dashboardRequestRef.current += 1;
    setLoading(false);
    const next = {
      ...current,
      staged: update(current.staged),
      stage_history: history,
    };
    dashboardRef.current = next;
    setDashboard(next);
  }, [invalidateCleanupPreview]);

  const applyStagingReport = useCallback((report: CleanupPreview) => {
    const current = dashboardRef.current;
    if (!current) return;
    const next = {
      ...current,
      staged: report.staged_files,
      staged_hashes_pending: report.hashes_pending,
      staged_cleanup_ready: report.cleanup_ready,
      staged_warnings: report.warnings,
      staged_verification_blockers: report.verification_blockers,
      stage_history: report.stage_history,
    };
    dashboardRef.current = next;
    setDashboard(next);
  }, []);

  const runStageMutation = useCallback(async (
    mutate: (workspace: string) => Promise<void>, onError: (message: string) => void,
  ) => {
    if (stagingInProgress.current) return false;
    const workspace = workspaceNameRef.current;
    if (!workspace) {
      onError("Workspace is still loading.");
      return false;
    }
    stagingInProgress.current = true;
    setStagingBusy(true);
    try {
      await mutate(workspace);
      return workspaceNameRef.current === workspace;
    } catch (error) {
      if (workspaceNameRef.current === workspace) onError(errorMessage(error));
      return false;
    } finally {
      stagingInProgress.current = false;
      setStagingBusy(false);
    }
  }, []);

  const stageSelected = useCallback(async () => {
    const path = activeSelectedNode?.path;
    if (!path || healthMetric !== "space_health") return;
    const selectedSite = dashboardRef.current?.sites.find(
      (site) => site.id === selectedSiteRef.current,
    ) ?? null;
    if (!siteAnalysisReady(selectedSite) || activeSelectedNode.pending_hash_count > 0) {
      setNotice("Hashes are pending. Duplicate staging will resume when analysis is ready.");
      return;
    }
    await runStageMutation(async (workspace) => {
      setNotice(null);
      const report = await stagePath(path, workspace);
      if (workspaceNameRef.current !== workspace) return;
      const additions = report.staged_files;
      updateStaged((current) => {
        const byId = new Map(current.map((file) => [file.file_id, file]));
        additions.forEach((file) => byId.set(file.file_id, file));
        return [...byId.values()];
      }, report.stage_history);
      if (report.warnings.length > 0) {
        const kept = report.warnings.filter((warning) => warning.reason === "would_remove_last_copy").length;
        const other = report.warnings.length - kept;
        const notes = [
          kept > 0 && `${formatCount(kept)} ${kept === 1 ? "copy was" : "copies were"} kept to preserve the last verified copy in each group.`,
          other > 0 && "Some copies were already staged or are no longer available for staging.",
        ].filter(Boolean);
        setNotice(notes.join(" "));
      }
    }, setNotice);
  }, [activeSelectedNode, healthMetric, runStageMutation, updateStaged]);

  const removeStaged = useCallback(async (path: string) => {
    await runStageMutation(async (workspace) => {
      setReviewError(null);
      const report = await unstagePath(path, workspace);
      if (workspaceNameRef.current !== workspace) return;
      const removed = new Set(report.removed_files.map((file) => file.file_id));
      updateStaged((current) => current.filter((file) => !removed.has(file.file_id)), report.stage_history);
      await reloadDashboard();
    }, setReviewError);
  }, [reloadDashboard, runStageMutation, updateStaged]);

  const stepStageHistory = useCallback((request: StageHistoryRequest) => runStageMutation(async (workspace) => {
    setReviewError(null);
    invalidateCleanupPreview();
    try {
      const report = await moveStageHistory(workspace, request);
      if (workspaceNameRef.current !== workspace) return;
      dashboardRequestRef.current += 1;
      setLoading(false);
      applyStagingReport(report);
    } catch (error) {
      if (workspaceNameRef.current === workspace) await reloadDashboard();
      throw error;
    }
  }, setReviewError), [applyStagingReport, invalidateCleanupPreview, reloadDashboard, runStageMutation]);

  const runPreview = useCallback(async () => {
    const currentDashboard = dashboardRef.current;
    const workspace = workspaceNameRef.current;
    if (!workspace || !currentDashboard?.staged.length || stagingInProgress.current) return;
    if (currentDashboard && !currentDashboard.staged_cleanup_ready) {
      setReviewError(currentDashboard.staged_hashes_pending > 0
        ? "Hashes are pending for staged copies. Finish hashing before running the cleanup safety check."
        : "Staged copies are no longer verified as a safe cleanup set. Remove affected copies or rescan first.");
      return;
    }
    const requestId = cleanupPreviewRequestRef.current + 1;
    cleanupPreviewRequestRef.current = requestId;
    setPreview(null);
    setPreviewLoading(true);
    setReviewError(null);
    try {
      const report = await previewCleanup(workspace);
      if (cleanupPreviewRequestRef.current !== requestId || workspaceNameRef.current !== workspace) return;
      setPreview(report);
      applyStagingReport(report);
    } catch (previewError) {
      if (cleanupPreviewRequestRef.current === requestId) {
        setReviewError(errorMessage(previewError));
      }
    } finally {
      if (cleanupPreviewRequestRef.current === requestId) setPreviewLoading(false);
    }
  }, [applyStagingReport]);

  const activeSite = dashboard?.sites.find((site) => site.id === activeSiteId) ?? null;
  const coverageTargetSite = dashboard?.sites.find((site) => site.id === coverageTargetSiteId) ?? null;
  const backendScanState = useMemo(() => {
    const scanning_site_ids = new Set<string>();
    const blocked_site_ids = new Set<string>();
    const request_by_site = new Map<string, number>();
    const scan_all_request_ids = new Set<number>();
    for (const task of activeScanTasks.values()) {
      if (task.selector.all) scan_all_request_ids.add(task.request_id);
      const taskSiteIds = task.site_states.length > 0
        ? task.site_states.map((state) => state.site_id)
        : task.selector.all
          ? dashboard?.sites.map((site) => site.id) ?? []
          : task.selector.site_id ? [task.selector.site_id] : [];
      const stateBySite = new Map(task.site_states.map((state) => [state.site_id, state]));
      for (const siteId of taskSiteIds) {
        blocked_site_ids.add(siteId);
        if (stateBySite.get(siteId)?.status !== "completed"
          && completionBySite.get(siteId)?.request_id !== task.request_id) {
          scanning_site_ids.add(siteId);
          const currentRequestId = request_by_site.get(siteId);
          if (currentRequestId === undefined || currentRequestId < task.request_id) {
            request_by_site.set(siteId, task.request_id);
          }
        }
      }
    }
    return { scanning_site_ids, blocked_site_ids, request_by_site, scan_all_request_ids };
  }, [activeScanTasks, completionBySite, dashboard?.sites]);
  const cancellingTaskCount = useMemo(() => (
    [...activeRequestIds].filter((requestId) => cancellingRequestIds.has(requestId)).length
  ), [activeRequestIds, cancellingRequestIds]);
  const scanningTaskCount = Math.max(0, activeRequestIds.size - cancellingTaskCount);
  const isSelectedStaged = Boolean(activeSelectedNode?.path && dashboard?.staged.some((file) => {
    const selectedPath = activeSelectedNode.path!;
    const normalized = selectedPath.endsWith("/") ? selectedPath : `${selectedPath}/`;
    return file.path === selectedPath || file.path.startsWith(normalized);
  }));

  const treeLoading = childrenLoading && !location;

  return useMemo(() => ({
    dashboard,
    loading,
    error,
    notice,
    clearNotice: () => setNotice(null),
    locationFailure,
    retryLocation,
    clearLocationFailure: () => setLocationFailure(null),
    openFolderExternally,
    refresh,
    activeSite,
    activeTree,
    activeSiteId,
    coverageTargetSite,
    coverageTargetSiteId,
    healthMetric,
    setHealthMetric,
    location,
    selectedNode: activeSelectedNode,
    finderPosition: selection?.finderPosition ?? null,
    selectNode,
    jumpToContentMatch,
    jumpToSimilarFolder,
    revealSelectedFileInContents,
    duplicateJumpRevision,
    childrenPage,
    contentsAnchorOffset: childrenPage?.anchor_offset ?? 0,
    directorySort: childrenPage?.sort ?? DEFAULT_DIRECTORY_SORT,
    setDirectorySort,
    childrenLoading,
    loadingMoreChildren,
    childrenError,
    canGoBack: !childrenLoading && backHistory.length > 0,
    canGoForward: !childrenLoading && forwardHistory.length > 0,
    canGoUp: !childrenLoading && (location?.breadcrumbs.length ?? 0) > 1,
    goBack,
    goForward,
    navigateBreadcrumb,
    retryChildren,
    loadChildrenRange,
    selectSite,
    selectCoverageTarget,
    treeLoading,
    treeError,
    retryTree,
    progressBySite,
    completionBySite,
    firstScanInterruptions,
    activeScanTasks,
    lastScanResult,
    backendScanningSiteIds: backendScanState.scanning_site_ids,
    scanBlockedSiteIds: backendScanState.blocked_site_ids,
    scanRequestBySite: backendScanState.request_by_site,
    scanAllRequestIds: backendScanState.scan_all_request_ids,
    cancellingRequestIds,
    scan,
    cancel,
    activeTaskCount: activeRequestIds.size,
    scanningTaskCount,
    cancellingTaskCount,
    contentRevision,
    stagingBusy,
    stageSelected,
    removeStaged,
    stepStageHistory,
    isSelectedStaged,
    reviewOpen,
    setReviewOpen,
    preview,
    previewLoading,
    reviewError,
    runPreview,
  }), [
    activeRequestIds.size,
    activeScanTasks,
    activeSite,
    activeSiteId,
    activeSelectedNode,
    activeTree,
    backHistory.length,
    backendScanState,
    cancel,
    childrenError,
    childrenLoading,
    loadingMoreChildren,
    childrenPage,
    completionBySite,
    firstScanInterruptions,
    cancellingRequestIds,
    cancellingTaskCount,
    coverageTargetSite,
    coverageTargetSiteId,
    contentRevision,
    dashboard,
    duplicateJumpRevision,
    error,
    healthMetric,
    isSelectedStaged,
    jumpToContentMatch,
    jumpToSimilarFolder,
    revealSelectedFileInContents,
    loading,
    lastScanResult,
    openFolderExternally,
    setDirectorySort,
    location,
    locationFailure,
    notice,
    preview,
    previewLoading,
    progressBySite,
    refresh,
    retryChildren,
    retryLocation,
    removeStaged,
    reviewError,
    reviewOpen,
    retryTree,
    runPreview,
    scan,
    scanningTaskCount,
    selection?.finderPosition,
    selectCoverageTarget,
    selectNode,
    selectSite,
    forwardHistory.length,
    stageSelected,
    stagingBusy,
    stepStageHistory,
    treeError,
    treeLoading,
    goBack,
    goForward,
    navigateBreadcrumb,
    loadChildrenRange,
  ]);
}
