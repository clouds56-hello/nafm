import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelScan,
  getStorageChildren,
  getStorageFileReveal,
  getStorageLocation,
  getStorageTree,
  loadDashboard,
  onScanTaskEvent,
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
  scanCompletionFromEvent,
  scanProgressFromEvent,
  setCurrentScanProgress,
  silenceScanCompletions,
} from "../lib/scanView";
import type {
  CleanupPreview,
  Dashboard,
  DuplicateFile,
  FileContentMatch,
  HealthMetric,
  ScanCompletionView,
  ScanProgressView,
  ScanTask,
  ScanTaskEvent,
  SiteOverview,
  StorageNode,
  StorageChildrenPage,
  StorageLocation,
  StorageTree,
} from "../lib/types";

const CHILDREN_PAGE_SIZE = 6;

interface NavigationEntry {
  site_id: string;
  target_site_id: string | null;
  node_id: string;
  offset: number;
  selected_node_id: string;
}

type LocationLoadResult = "loaded" | "unavailable" | "failed" | "superseded";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}

function isUnavailableLocationError(message: string): boolean {
  return message.startsWith("storage node not found:")
    || message.startsWith("storage node is not navigable:");
}

function treeKey(siteId: string, targetSiteId: string | null): string {
  return `${siteId}\u0000${targetSiteId ?? ""}`;
}

function sameNavigationEntry(left: NavigationEntry, right: NavigationEntry): boolean {
  return left.site_id === right.site_id
    && left.target_site_id === right.target_site_id
    && left.node_id === right.node_id
    && left.offset === right.offset
    && left.selected_node_id === right.selected_node_id;
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

export function useDashboard(expectedWorkspace: string | null) {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  const [coverageTargetSiteId, setCoverageTargetSiteId] = useState<string | null>(null);
  const [healthMetric, setHealthMetric] = useState<HealthMetric>("space_health");
  const [trees, setTrees] = useState<Map<string, StorageTree>>(new Map());
  const [treeLoading, setTreeLoading] = useState(false);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [location, setLocation] = useState<StorageLocation | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<StorageNode | null>(null);
  const [backHistory, setBackHistory] = useState<NavigationEntry[]>([]);
  const [forwardHistory, setForwardHistory] = useState<NavigationEntry[]>([]);
  const [childrenPage, setChildrenPage] = useState<StorageChildrenPage | null>(null);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [childrenError, setChildrenError] = useState<string | null>(null);
  const [progressBySite, setProgressBySite] = useState<Map<string, ScanProgressView>>(new Map());
  const [completionBySite, setCompletionBySite] = useState<Map<string, ScanCompletionView>>(new Map());
  const [activeRequestIds, setActiveRequestIds] = useState<Set<number>>(new Set());
  const [activeScanTasks, setActiveScanTasks] = useState<Map<number, ScanTask>>(new Map());
  const [stagingBusy, setStagingBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [contentRevision, setContentRevision] = useState(0);
  const [duplicateJumpRevision, setDuplicateJumpRevision] = useState(0);
  const selectedSiteRef = useRef<string | null>(null);
  const targetSiteRef = useRef<string | null>(null);
  const treeRequestRef = useRef(0);
  const treeRequestByKeyRef = useRef<Map<string, number>>(new Map());
  const treesRef = useRef<Map<string, StorageTree>>(new Map());
  const locationRequestRef = useRef(0);
  const locationRef = useRef<StorageLocation | null>(null);
  const navigationInProgressRef = useRef(false);
  const navigationOperationRef = useRef(0);
  const childrenRequestRef = useRef(0);
  const childrenLoadingRef = useRef(false);
  const childrenRetryRef = useRef<{ node: StorageNode; offset: number } | null>(null);
  const selectedNodeRef = useRef<StorageNode | null>(null);
  const backHistoryRef = useRef<NavigationEntry[]>([]);
  const forwardHistoryRef = useRef<NavigationEntry[]>([]);
  const childrenPageRef = useRef<StorageChildrenPage | null>(null);
  const dashboardRef = useRef<Dashboard | null>(null);
  const completionBySiteRef = useRef<Map<string, ScanCompletionView>>(new Map());
  const currentSiteIdsRef = useRef<Set<string>>(new Set());
  const terminalRequestIdsRef = useRef<Set<number>>(new Set());
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

  useEffect(() => {
    if (workspaceNameRef.current !== expectedWorkspace) {
      const dashboardMatchesWorkspace = dashboardRef.current?.workspace_name === expectedWorkspace;
      locationRequestRef.current += 1;
      childrenRequestRef.current += 1;
      navigationOperationRef.current += 1;
      treeRequestRef.current += 1;
      treeRequestByKeyRef.current.clear();
      treesRef.current = new Map();
      locationRef.current = null;
      selectedNodeRef.current = null;
      childrenPageRef.current = null;
      backHistoryRef.current = [];
      forwardHistoryRef.current = [];
      setTrees(new Map());
      setLocation(null);
      setSelectedNodeId(null);
      setSelectedNode(null);
      setChildrenPage(null);
      setChildrenLoading(false);
      setBackHistory([]);
      setForwardHistory([]);
      if (!dashboardMatchesWorkspace) {
        setProgressBySite(new Map());
        updateCompletionBySite(() => new Map());
        setActiveRequestIds(new Set());
        setActiveScanTasks(new Map());
        currentSiteIdsRef.current = new Set();
        terminalRequestIdsRef.current.clear();
      }
      navigationInProgressRef.current = false;
      childrenLoadingRef.current = false;
    }
    workspaceNameRef.current = expectedWorkspace;
  }, [expectedWorkspace, updateCompletionBySite]);

  useEffect(() => {
    selectedNodeRef.current = selectedNode;
  }, [selectedNode]);

  useEffect(() => {
    childrenPageRef.current = childrenPage;
  }, [childrenPage]);

  useEffect(() => {
    treesRef.current = trees;
  }, [trees]);

  const currentNavigationEntry = useCallback((): NavigationEntry | null => {
    const siteId = selectedSiteRef.current;
    const currentLocation = locationRef.current;
    if (!siteId || !currentLocation) return null;
    const currentPage = childrenPageRef.current;
    const selected = selectedNodeRef.current;
    return {
      site_id: siteId,
      target_site_id: targetSiteRef.current,
      node_id: currentLocation.root.id,
      offset: currentPage?.parent.id === currentLocation.root.id ? currentPage.offset : 0,
      selected_node_id: selected?.id ?? currentLocation.root.id,
    };
  }, []);

  const loadChildren = useCallback(async (
    siteId: string,
    targetSiteId: string | null,
    node: StorageNode,
    offset = 0,
    preserveSelection = false,
    keepPage = false,
  ) => {
    const requestId = childrenRequestRef.current + 1;
    childrenRequestRef.current = requestId;
    childrenLoadingRef.current = true;
    setChildrenLoading(true);
    if (!keepPage) {
      childrenPageRef.current = null;
      setChildrenPage(null);
    }
    childrenRetryRef.current = null;
    setChildrenError(null);
    try {
      let page = await getStorageChildren(
        siteId,
        targetSiteId,
        node.id,
        offset,
        CHILDREN_PAGE_SIZE,
      );
      if (childrenRequestRef.current !== requestId) return;

      if (page.total_children > 0 && page.offset >= page.total_children) {
        const lastOffset = Math.floor((page.total_children - 1) / CHILDREN_PAGE_SIZE)
          * CHILDREN_PAGE_SIZE;
        page = await getStorageChildren(
          siteId,
          targetSiteId,
          node.id,
          lastOffset,
          CHILDREN_PAGE_SIZE,
        );
        if (childrenRequestRef.current !== requestId) return;
      }

      childrenPageRef.current = page;
      childrenRetryRef.current = null;
      setChildrenPage(page);

      const currentSelection = selectedNodeRef.current;
      const refreshedSelection = currentSelection?.id === page.parent.id
        ? page.parent
        : page.children.find((child) => child.id === currentSelection?.id);
      const nextSelection = preserveSelection
        ? refreshedSelection ?? currentSelection ?? page.parent
        : page.parent;
      selectedNodeRef.current = nextSelection;
      setSelectedNodeId(nextSelection.id);
      setSelectedNode(nextSelection);
    } catch (childrenLoadError) {
      if (childrenRequestRef.current === requestId) {
        childrenRetryRef.current = { node, offset };
        setChildrenError(errorMessage(childrenLoadError));
      }
    } finally {
      if (childrenRequestRef.current === requestId) {
        childrenLoadingRef.current = false;
        setChildrenLoading(false);
      }
    }
  }, []);

  const loadFolderLocation = useCallback(async (
    entry: NavigationEntry,
    historyAction: "push" | "back" | "forward" | "reset" | "preserve",
    preserveSelection = false,
  ): Promise<LocationLoadResult> => {
    const requestId = locationRequestRef.current + 1;
    locationRequestRef.current = requestId;
    childrenRequestRef.current += 1;
    const previousLocation = locationRef.current;
    const previousEntry = currentNavigationEntry();
    const requestedWorkspace = workspaceNameRef.current;
    setChildrenLoading(true);
    childrenLoadingRef.current = true;
    setChildrenError(null);
    childrenRetryRef.current = null;

    try {
      const [nextLocation, initialPage] = await Promise.all([
        getStorageLocation(entry.site_id, entry.target_site_id, entry.node_id),
        getStorageChildren(
          entry.site_id,
          entry.target_site_id,
          entry.node_id,
          entry.offset,
          CHILDREN_PAGE_SIZE,
        ),
      ]);
      if (locationRequestRef.current !== requestId
        || workspaceNameRef.current !== requestedWorkspace) {
        return "superseded";
      }

      let page = initialPage;
      let resolvedEntry = entry;
      if (page.total_children > 0 && page.offset >= page.total_children) {
        const lastOffset = Math.floor((page.total_children - 1) / CHILDREN_PAGE_SIZE)
          * CHILDREN_PAGE_SIZE;
        page = await getStorageChildren(
          entry.site_id,
          entry.target_site_id,
          entry.node_id,
          lastOffset,
          CHILDREN_PAGE_SIZE,
        );
        if (locationRequestRef.current !== requestId
          || workspaceNameRef.current !== requestedWorkspace) {
          return "superseded";
        }
        resolvedEntry = { ...entry, offset: page.offset };
      }

      locationRef.current = nextLocation;
      childrenPageRef.current = page;
      selectedSiteRef.current = entry.site_id;
      targetSiteRef.current = entry.target_site_id;
      setActiveSiteId(entry.site_id);
      setCoverageTargetSiteId(entry.target_site_id);
      setLocation(nextLocation);
      setChildrenPage(page);

      const currentSelection = selectedNodeRef.current;
      const selectionId = preserveSelection
        ? entry.selected_node_id || currentSelection?.id
        : entry.selected_node_id;
      const refreshedSelection = selectionId
        ? findNode(nextLocation.root, selectionId)
          ?? page.children.find((child) => child.id === selectionId)
        : null;
      const nextSelection = refreshedSelection ?? nextLocation.root;
      selectedNodeRef.current = nextSelection;
      setSelectedNodeId(nextSelection.id);
      setSelectedNode(nextSelection);

      if (historyAction === "reset") {
        backHistoryRef.current = [];
        forwardHistoryRef.current = [];
      } else if (historyAction === "push" && previousEntry
        && !sameNavigationEntry(previousEntry, resolvedEntry)) {
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
      const message = errorMessage(locationError);
      const unavailable = isUnavailableLocationError(message);
      if (locationRequestRef.current === requestId
        && workspaceNameRef.current === requestedWorkspace) {
        if (previousLocation && !(unavailable && (historyAction === "back" || historyAction === "forward"))) {
          setNotice(message);
          setChildrenError(null);
        } else if (!previousLocation) {
          setChildrenError(message);
          setTreeError(message);
        }
      }
      if (locationRequestRef.current !== requestId
        || workspaceNameRef.current !== requestedWorkspace) {
        return "superseded";
      }
      return unavailable ? "unavailable" : "failed";
    } finally {
      if (locationRequestRef.current === requestId
        && workspaceNameRef.current === requestedWorkspace) {
        childrenLoadingRef.current = false;
        setChildrenLoading(false);
      }
    }
  }, [currentNavigationEntry]);

  useEffect(() => {
    selectedSiteRef.current = activeSiteId;
  }, [activeSiteId]);

  useEffect(() => {
    targetSiteRef.current = coverageTargetSiteId;
  }, [coverageTargetSiteId]);

  const refreshTree = useCallback(async (
    siteId: string,
    targetSiteId: string | null,
    foreground = false,
    resetChildrenPage = false,
  ) => {
    navigationOperationRef.current += 1;
    navigationInProgressRef.current = false;
    locationRequestRef.current += 1;
    const requestKey = treeKey(siteId, targetSiteId);
    const requestId = treeRequestRef.current + 1;
    treeRequestRef.current = requestId;
    treeRequestByKeyRef.current.set(requestKey, requestId);
    if (foreground) {
      setTreeLoading(true);
      setTreeError(null);
    } else {
      setTreeLoading(false);
    }
    try {
      const tree = await getStorageTree(siteId, targetSiteId);
      if (treeRequestByKeyRef.current.get(requestKey) !== requestId) return;
      const isCurrentRequest = treeRequestRef.current === requestId;
      const isActiveRequest = selectedSiteRef.current === siteId && targetSiteRef.current === targetSiteId;
      setTrees((current) => new Map(current).set(requestKey, tree));
      if (isCurrentRequest && isActiveRequest) {
        const currentLocation = locationRef.current;
        const currentPage = childrenPageRef.current;
        const nodeId = !resetChildrenPage && currentLocation?.site_id === siteId
          ? currentLocation.root.id
          : tree.root.id;
        const pageOffset = !resetChildrenPage && currentPage?.parent.id === nodeId
          ? currentPage.offset
          : 0;
        const locationRequestId = locationRequestRef.current + 1;
        let locationResult = await loadFolderLocation(
          {
            site_id: siteId,
            target_site_id: targetSiteId,
            node_id: nodeId,
            offset: pageOffset,
            selected_node_id: selectedNodeRef.current?.id ?? nodeId,
          },
          currentLocation && !resetChildrenPage ? "preserve" : "reset",
          Boolean(currentLocation && !resetChildrenPage),
        );
        if (locationResult === "unavailable" && locationRequestRef.current === locationRequestId
          && nodeId !== tree.root.id
          && selectedSiteRef.current === siteId && targetSiteRef.current === targetSiteId) {
          locationResult = await loadFolderLocation(
            {
              site_id: siteId,
              target_site_id: targetSiteId,
              node_id: tree.root.id,
              offset: 0,
              selected_node_id: tree.root.id,
            },
            "reset",
          );
        }
        if (locationResult === "loaded") setTreeError(null);
      }
    } catch (treeLoadError) {
      const message = errorMessage(treeLoadError);
      if (foreground && treeRequestRef.current === requestId) setTreeError(message);
      else setNotice(message);
    } finally {
      if (foreground && treeRequestRef.current === requestId) setTreeLoading(false);
    }
  }, [loadFolderLocation]);

  const acceptDashboard = useCallback((next: Dashboard) => {
    const activeTasks = next.active_tasks.filter(
      (task) => !terminalRequestIdsRef.current.has(task.request_id),
    );
    dashboardRef.current = next;
    currentSiteIdsRef.current = new Set(next.sites.map((site) => site.id));
    workspaceNameRef.current = next.workspace_name;
    setDashboard(next);
    setActiveRequestIds(new Set(activeTasks.map((task) => task.request_id)));
    setActiveScanTasks(new Map(activeTasks.map((task) => [task.request_id, task])));
    updateCompletionBySite((current) => reconcileScanCompletions(current, next.sites));
  }, [updateCompletionBySite]);

  const refresh = useCallback(async () => {
    const requestId = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = requestId;
    const requestedWorkspace = workspaceNameRef.current;
    setLoading(true);
    setError(null);
    try {
      const next = await loadDashboard();
      if (dashboardRequestRef.current !== requestId
        || (requestedWorkspace && next.workspace_name !== requestedWorkspace)) return;
      acceptDashboard(next);
      const requestedSite = selectedSiteRef.current;
      const nextSite = next.sites.some((site) => site.id === requestedSite)
        ? requestedSite
        : next.sites[0]?.id ?? null;
      const nextTarget = validTarget(next.sites, nextSite, targetSiteRef.current);
      setActiveSiteId(nextSite);
      setCoverageTargetSiteId(nextTarget);
      selectedSiteRef.current = nextSite;
      targetSiteRef.current = nextTarget;
      if (nextSite) await refreshTree(nextSite, nextTarget, true);
    } catch (loadError) {
      if (dashboardRequestRef.current === requestId) setError(errorMessage(loadError));
    } finally {
      if (dashboardRequestRef.current === requestId) setLoading(false);
    }
  }, [acceptDashboard, refreshTree]);

  const reloadDashboard = useCallback(async () => {
    if (!dashboardRef.current) {
      void refresh();
      return;
    }
    const requestId = dashboardRequestRef.current + 1;
    dashboardRequestRef.current = requestId;
    const requestedWorkspace = workspaceNameRef.current;
    try {
      const next = await loadDashboard();
      if (dashboardRequestRef.current !== requestId
        || (requestedWorkspace && next.workspace_name !== requestedWorkspace)) return;
      acceptDashboard(next);
    } catch {
      // Scan completion already has enough event data to stay useful if this refresh fails.
    } finally {
      if (dashboardRequestRef.current === requestId) setLoading(false);
    }
  }, [acceptDashboard, refresh]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleScanEvent = useCallback((event: ScanTaskEvent) => {
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
        }
      } else {
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
          setContentRevision((current) => current + 1);
          const sourceSiteId = selectedSiteRef.current;
          const targetSiteId = targetSiteRef.current;
          if (sourceSiteId && (event.site_id === sourceSiteId || event.site_id === targetSiteId)) {
            void refreshTree(sourceSiteId, targetSiteId, false);
          }
        }
        if (event.kind === "failed") setNotice(event.message ?? "A site scan failed.");
      }
    }
    if (event.scope === "task" && ["completed", "failed", "cancelled"].includes(event.kind)) {
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
      setProgressBySite((current) => clearScanProgressForRequest(current, event.request_id));
      void reloadDashboard();
      if (event.kind === "failed") setNotice(event.message ?? "The scan failed.");
      if (event.kind === "cancelled") {
        setNotice("Scan cancelled. Completed hashes remain cached.");
        const sourceSiteId = selectedSiteRef.current;
        if (sourceSiteId) void refreshTree(sourceSiteId, targetSiteRef.current, false);
      }
    }
  }, [refreshTree, reloadDashboard, updateCompletionBySite]);

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
    };
  }, [handleScanEvent]);

  useEffect(() => {
    const activeTasks = dashboard?.active_tasks ?? [];
    if (activeTasks.length === 0) return;
    const allSiteIds = dashboard?.sites.map((site) => site.id) ?? [];
    setProgressBySite((current) => {
      const next = new Map(current);
      for (const task of activeTasks) {
        if (terminalRequestIdsRef.current.has(task.request_id)) continue;
        const siteIds = task.selector.all ? allSiteIds : task.selector.site_id ? [task.selector.site_id] : [];
        for (const siteId of siteIds) {
          if (completionBySite.get(siteId)?.request_id === task.request_id) continue;
          const existing = next.get(siteId);
          if (!existing || existing.request_id < task.request_id) {
            next.set(siteId, initialScanProgress(task.request_id, siteId));
          }
        }
      }
      return next;
    });
  }, [completionBySite, dashboard?.active_tasks, dashboard?.sites]);

  const selectSite = useCallback(async (siteId: string) => {
    const sites = dashboard?.sites ?? [];
    const nextTarget = validTarget(sites, siteId, targetSiteRef.current);
    setActiveSiteId(siteId);
    setCoverageTargetSiteId(nextTarget);
    selectedSiteRef.current = siteId;
    targetSiteRef.current = nextTarget;
    locationRequestRef.current += 1;
    childrenRequestRef.current += 1;
    navigationOperationRef.current += 1;
    navigationInProgressRef.current = false;
    childrenRetryRef.current = null;
    setSelectedNodeId(null);
    setSelectedNode(null);
    setLocation(null);
    setBackHistory([]);
    setForwardHistory([]);
    setChildrenPage(null);
    setChildrenError(null);
    setChildrenLoading(false);
    childrenLoadingRef.current = false;
    selectedNodeRef.current = null;
    locationRef.current = null;
    backHistoryRef.current = [];
    forwardHistoryRef.current = [];
    childrenPageRef.current = null;
    const cachedTree = trees.get(treeKey(siteId, nextTarget));
    if (cachedTree) {
      selectedNodeRef.current = cachedTree.root;
      setSelectedNodeId(cachedTree.root.id);
      setSelectedNode(cachedTree.root);
      setTreeLoading(true);
      setTreeError(null);
      const locationResult = await loadFolderLocation(
        {
          site_id: siteId,
          target_site_id: nextTarget,
          node_id: cachedTree.root.id,
          offset: 0,
          selected_node_id: cachedTree.root.id,
        },
        "reset",
      );
      if (selectedSiteRef.current === siteId && targetSiteRef.current === nextTarget) {
        if (locationResult === "loaded") setTreeError(null);
        setTreeLoading(false);
      }
    } else {
      await refreshTree(siteId, nextTarget, true);
    }
  }, [dashboard?.sites, loadFolderLocation, refreshTree, trees]);

  const selectCoverageTarget = useCallback(async (targetSiteId: string) => {
    const sourceSiteId = selectedSiteRef.current;
    if (!sourceSiteId || targetSiteId === sourceSiteId) return;
    locationRequestRef.current += 1;
    childrenRequestRef.current += 1;
    navigationOperationRef.current += 1;
    navigationInProgressRef.current = false;
    childrenRetryRef.current = null;
    setChildrenError(null);
    setChildrenLoading(false);
    childrenLoadingRef.current = false;
    locationRef.current = null;
    backHistoryRef.current = [];
    forwardHistoryRef.current = [];
    setLocation(null);
    setBackHistory([]);
    setForwardHistory([]);
    setCoverageTargetSiteId(targetSiteId);
    targetSiteRef.current = targetSiteId;
    await refreshTree(sourceSiteId, targetSiteId, true, true);
  }, [refreshTree]);

  const swapCoverageSites = useCallback(async () => {
    const previousSourceSiteId = selectedSiteRef.current;
    const previousTargetSiteId = targetSiteRef.current;
    if (!previousSourceSiteId || !previousTargetSiteId) return;
    setActiveSiteId(previousTargetSiteId);
    setCoverageTargetSiteId(previousSourceSiteId);
    selectedSiteRef.current = previousTargetSiteId;
    targetSiteRef.current = previousSourceSiteId;
    locationRequestRef.current += 1;
    childrenRequestRef.current += 1;
    navigationOperationRef.current += 1;
    navigationInProgressRef.current = false;
    childrenRetryRef.current = null;
    setSelectedNodeId(null);
    setSelectedNode(null);
    setLocation(null);
    setBackHistory([]);
    setForwardHistory([]);
    setChildrenPage(null);
    setChildrenError(null);
    setChildrenLoading(false);
    childrenLoadingRef.current = false;
    selectedNodeRef.current = null;
    locationRef.current = null;
    backHistoryRef.current = [];
    forwardHistoryRef.current = [];
    childrenPageRef.current = null;
    await refreshTree(previousTargetSiteId, previousSourceSiteId, true);
  }, [refreshTree]);

  const retryTree = useCallback(async () => {
    const siteId = selectedSiteRef.current;
    if (siteId) await refreshTree(siteId, targetSiteRef.current, true);
  }, [refreshTree]);

  const scan = useCallback(async (siteId?: string) => {
    setNotice(null);
    try {
      const workspaceName = workspaceNameRef.current;
      if (!workspaceName) throw new Error("Workspace is still loading.");
      const task = await startScan(
        siteId ? { site_id: siteId } : { all: true },
        workspaceName,
      );
      if (terminalRequestIdsRef.current.has(task.request_id)) return;
      dashboardRequestRef.current += 1;
      setActiveRequestIds((current) => new Set(current).add(task.request_id));
      setActiveScanTasks((current) => new Map(current).set(task.request_id, task));
      const siteIds = siteId
        ? [siteId]
        : dashboardRef.current?.sites.map((site) => site.id) ?? [];
      updateCompletionBySite((current) => silenceScanCompletions(
        current,
        siteIds,
        task.request_id,
      ));
      setProgressBySite((current) => {
        let next = current;
        for (const currentSiteId of siteIds) {
          if (completionBySiteRef.current.get(currentSiteId)?.request_id === task.request_id) continue;
          next = setCurrentScanProgress(
            next,
            initialScanProgress(task.request_id, currentSiteId),
          );
        }
        return next;
      });
    } catch (scanError) {
      setNotice(errorMessage(scanError));
    }
  }, [updateCompletionBySite]);

  const cancel = useCallback(async (requestId: number) => {
    try {
      const report = await cancelScan(requestId);
      if (!report.cancelled) setNotice("That scan has already finished.");
    } catch (cancelError) {
      setNotice(errorMessage(cancelError));
    }
  }, []);

  const activeTree = activeSiteId
    ? trees.get(treeKey(activeSiteId, coverageTargetSiteId)) ?? null
    : null;
  const activeSelectedNode = activeTree
    ? selectedNode ?? findNode(location?.root ?? activeTree.root, selectedNodeId) ?? location?.root ?? activeTree.root
    : null;

  const selectNode = useCallback((node: StorageNode) => {
    const siteId = selectedSiteRef.current;
    if (!siteId) return;
    const openable = node.kind !== "file" && node.kind !== "smaller_items";
    if (openable) {
      if (childrenLoadingRef.current || locationRef.current?.root.id === node.id) return;
      void loadFolderLocation(
        {
          site_id: siteId,
          target_site_id: targetSiteRef.current,
          node_id: node.id,
          offset: 0,
          selected_node_id: node.id,
        },
        "push",
      );
    } else {
      selectedNodeRef.current = node;
      setSelectedNodeId(node.id);
      setSelectedNode(node);
    }
  }, [loadFolderLocation]);

  const navigateHistory = useCallback(async (direction: "back" | "forward") => {
    if (!selectedSiteRef.current || childrenLoadingRef.current || navigationInProgressRef.current) return;
    const operationId = navigationOperationRef.current + 1;
    navigationOperationRef.current = operationId;
    navigationInProgressRef.current = true;
    try {
      while (true) {
        const history = direction === "back" ? backHistoryRef.current : forwardHistoryRef.current;
        const entry = history.at(-1);
        if (!entry) return;
        const result = await loadFolderLocation(entry, direction);
        if (result !== "unavailable") return;

        const currentHistory = direction === "back" ? backHistoryRef.current : forwardHistoryRef.current;
        const currentEntry = currentHistory.at(-1);
        if (!currentEntry || !sameNavigationEntry(currentEntry, entry)) return;
        const nextHistory = currentHistory.slice(0, -1);
        if (direction === "back") {
          backHistoryRef.current = nextHistory;
          setBackHistory(nextHistory);
        } else {
          forwardHistoryRef.current = nextHistory;
          setForwardHistory(nextHistory);
        }
        if (nextHistory.length === 0) {
          setNotice("That folder is no longer available.");
          return;
        }
      }
    } finally {
      if (navigationOperationRef.current === operationId) {
        navigationInProgressRef.current = false;
      }
    }
  }, [loadFolderLocation]);

  const goBack = useCallback(() => {
    void navigateHistory("back");
  }, [navigateHistory]);

  const goForward = useCallback(() => {
    void navigateHistory("forward");
  }, [navigateHistory]);

  const navigateBreadcrumb = useCallback((node: StorageNode) => {
    const siteId = selectedSiteRef.current;
    if (!siteId || childrenLoadingRef.current || node.id === locationRef.current?.root.id) return;
    void loadFolderLocation(
      {
        site_id: siteId,
        target_site_id: targetSiteRef.current,
        node_id: node.id,
        offset: 0,
        selected_node_id: node.id,
      },
      "push",
    );
  }, [loadFolderLocation]);

  const goUp = useCallback(() => {
    const breadcrumbs = locationRef.current?.breadcrumbs ?? [];
    const parent = breadcrumbs.at(-2);
    if (parent) navigateBreadcrumb(parent);
  }, [navigateBreadcrumb]);

  const retryChildren = useCallback(() => {
    const siteId = selectedSiteRef.current;
    const failedRequest = childrenRetryRef.current;
    const parent = failedRequest?.node ?? childrenPage?.parent ?? activeSelectedNode;
    if (siteId && parent) {
      void loadChildren(
        siteId,
        targetSiteRef.current,
        parent,
        failedRequest?.offset ?? childrenPage?.offset ?? 0,
        true,
        Boolean(childrenPage),
      );
    }
  }, [activeSelectedNode, childrenPage, loadChildren]);

  const loadPreviousChildren = useCallback(() => {
    const siteId = selectedSiteRef.current;
    if (!siteId || !childrenPage || childrenLoadingRef.current || childrenPage.offset <= 0) return;
    const previousOffset = Math.max(0, childrenPage.offset - childrenPage.limit);
    void loadChildren(
      siteId,
      targetSiteRef.current,
      childrenPage.parent,
      previousOffset,
      true,
      true,
    );
  }, [childrenPage, loadChildren]);

  const loadNextChildren = useCallback(() => {
    const siteId = selectedSiteRef.current;
    if (!siteId || !childrenPage || childrenLoadingRef.current) return;
    const nextOffset = childrenPage.offset + childrenPage.limit;
    if (nextOffset >= childrenPage.total_children) return;
    void loadChildren(
      siteId,
      targetSiteRef.current,
      childrenPage.parent,
      nextOffset,
      true,
      true,
    );
  }, [childrenPage, loadChildren]);

  const jumpToContentMatch = useCallback(async (match: FileContentMatch) => {
    const workspaceName = workspaceNameRef.current;
    const currentSiteId = selectedSiteRef.current;
    const currentDashboard = dashboard;
    if (!workspaceName || !currentSiteId || !currentDashboard || navigationInProgressRef.current) return;

    const currentTarget = targetSiteRef.current;
    const preferredTarget = currentTarget && currentTarget !== match.site_id
      ? currentTarget
      : currentSiteId !== match.site_id
        ? currentSiteId
        : null;
    const destinationTarget = preferredTarget
      ?? currentDashboard.sites.find((site) => site.id !== match.site_id)?.id
      ?? null;
    const previousEntry = currentNavigationEntry();
    const requestId = locationRequestRef.current + 1;
    const operationId = navigationOperationRef.current + 1;
    const requestedWorkspace = workspaceName;
    locationRequestRef.current = requestId;
    childrenRequestRef.current += 1;
    navigationOperationRef.current = operationId;
    navigationInProgressRef.current = true;
    setChildrenLoading(true);
    childrenLoadingRef.current = true;
    setNotice(null);

    try {
      const reveal = await getStorageFileReveal(
        requestedWorkspace,
        match.file_id,
        destinationTarget,
      );
      if (locationRequestRef.current !== requestId
        || navigationOperationRef.current !== operationId
        || workspaceNameRef.current !== requestedWorkspace) return;

      const destinationEntry: NavigationEntry = {
        site_id: reveal.tree.site_id,
        target_site_id: reveal.tree.coverage_target?.id ?? null,
        node_id: reveal.location.root.id,
        offset: reveal.page.offset,
        selected_node_id: reveal.selected_file.id,
      };

      treesRef.current = new Map(treesRef.current).set(
        treeKey(destinationEntry.site_id, destinationEntry.target_site_id),
        reveal.tree,
      );
      setTrees(treesRef.current);
      selectedSiteRef.current = destinationEntry.site_id;
      targetSiteRef.current = destinationEntry.target_site_id;
      locationRef.current = reveal.location;
      childrenPageRef.current = reveal.page;
      selectedNodeRef.current = reveal.selected_file;
      childrenRequestRef.current += 1;
      childrenRetryRef.current = null;

      setActiveSiteId(destinationEntry.site_id);
      setCoverageTargetSiteId(destinationEntry.target_site_id);
      setTreeLoading(false);
      setLocation(reveal.location);
      setChildrenPage(reveal.page);
      setChildrenError(null);
      setSelectedNodeId(reveal.selected_file.id);
      setSelectedNode(reveal.selected_file);
      setDuplicateJumpRevision((current) => current + 1);
      setTreeError(null);

      if (previousEntry && !sameNavigationEntry(previousEntry, destinationEntry)) {
        backHistoryRef.current = [...backHistoryRef.current, previousEntry];
      }
      forwardHistoryRef.current = [];
      setBackHistory(backHistoryRef.current);
      setForwardHistory([]);
    } catch (revealError) {
      if (locationRequestRef.current === requestId
        && workspaceNameRef.current === requestedWorkspace) {
        setNotice(errorMessage(revealError));
      }
    } finally {
      if (navigationOperationRef.current === operationId) {
        navigationInProgressRef.current = false;
      }
      if (locationRequestRef.current === requestId) {
        childrenLoadingRef.current = false;
        setChildrenLoading(false);
      }
    }
  }, [currentNavigationEntry, dashboard]);

  const updateStaged = useCallback((update: DuplicateFile[] | ((files: DuplicateFile[]) => DuplicateFile[])) => {
    setDashboard((current) => current ? {
      ...current,
      staged: typeof update === "function" ? update(current.staged) : update,
    } : current);
    setPreview(null);
  }, []);

  const stageSelected = useCallback(async () => {
    if (!activeSelectedNode?.path || healthMetric !== "space_health") return;
    setStagingBusy(true);
    setNotice(null);
    try {
      const workspaceName = workspaceNameRef.current;
      if (!workspaceName) throw new Error("Workspace is still loading.");
      const report = await stagePath(activeSelectedNode.path, workspaceName);
      const additions = report.staged_files;
      updateStaged((current) => {
        const byId = new Map(current.map((file) => [file.file_id, file]));
        additions.forEach((file) => byId.set(file.file_id, file));
        return [...byId.values()];
      });
      if (report.warnings.length > 0) {
        setNotice("Some copies could not be staged because they were unsafe or unavailable.");
      }
    } catch (stageError) {
      setNotice(errorMessage(stageError));
    } finally {
      setStagingBusy(false);
    }
  }, [activeSelectedNode, healthMetric, updateStaged]);

  const removeStaged = useCallback(async (path: string) => {
    setStagingBusy(true);
    setReviewError(null);
    try {
      const workspaceName = workspaceNameRef.current;
      if (!workspaceName) throw new Error("Workspace is still loading.");
      const report = await unstagePath(path, workspaceName);
      const removed = new Set(report.removed_files.map((file) => file.file_id));
      updateStaged((current) => current.filter((file) => !removed.has(file.file_id)));
    } catch (unstageError) {
      setReviewError(errorMessage(unstageError));
    } finally {
      setStagingBusy(false);
    }
  }, [updateStaged]);

  const runPreview = useCallback(async () => {
    setPreviewLoading(true);
    setReviewError(null);
    try {
      setPreview(await previewCleanup());
    } catch (previewError) {
      setReviewError(errorMessage(previewError));
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  const activeSite = dashboard?.sites.find((site) => site.id === activeSiteId) ?? null;
  const coverageTargetSite = dashboard?.sites.find((site) => site.id === coverageTargetSiteId) ?? null;
  const backendScanState = useMemo(() => {
    const scanning_site_ids = new Set<string>();
    const blocked_site_ids = new Set<string>();
    for (const task of activeScanTasks.values()) {
      const taskSiteIds = task.selector.all
        ? dashboard?.sites.map((site) => site.id) ?? []
        : task.selector.site_id ? [task.selector.site_id] : [];
      for (const siteId of taskSiteIds) {
        blocked_site_ids.add(siteId);
        if (completionBySite.get(siteId)?.request_id !== task.request_id) {
          scanning_site_ids.add(siteId);
        }
      }
    }
    return { scanning_site_ids, blocked_site_ids };
  }, [activeScanTasks, completionBySite, dashboard?.sites]);
  const isSelectedStaged = Boolean(activeSelectedNode?.path && dashboard?.staged.some((file) => {
    const selectedPath = activeSelectedNode.path!;
    const normalized = selectedPath.endsWith("/") ? selectedPath : `${selectedPath}/`;
    return file.path === selectedPath || file.path.startsWith(normalized);
  }));

  return useMemo(() => ({
    dashboard,
    loading,
    error,
    notice,
    clearNotice: () => setNotice(null),
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
    selectNode,
    jumpToContentMatch,
    duplicateJumpRevision,
    childrenPage,
    childrenLoading,
    childrenError,
    childrenRangeStart: childrenPage && childrenPage.total_children > 0
      ? childrenPage.offset + 1
      : 0,
    childrenRangeEnd: childrenPage
      ? Math.min(childrenPage.offset + childrenPage.children.length, childrenPage.total_children)
      : 0,
    canLoadPrevious: Boolean(childrenPage && !childrenLoading && childrenPage.offset > 0),
    canLoadNext: Boolean(childrenPage && !childrenLoading
      && childrenPage.offset + childrenPage.limit < childrenPage.total_children),
    canGoBack: !childrenLoading && backHistory.length > 0,
    canGoForward: !childrenLoading && forwardHistory.length > 0,
    canGoUp: !childrenLoading && (location?.breadcrumbs.length ?? 0) > 1,
    goBack,
    goForward,
    goUp,
    navigateBreadcrumb,
    retryChildren,
    loadPreviousChildren,
    loadNextChildren,
    selectSite,
    selectCoverageTarget,
    swapCoverageSites,
    treeLoading,
    treeError,
    retryTree,
    progressBySite,
    completionBySite,
    backendScanningSiteIds: backendScanState.scanning_site_ids,
    scanBlockedSiteIds: backendScanState.blocked_site_ids,
    scan,
    cancel,
    activeTaskCount: activeRequestIds.size,
    contentRevision,
    stagingBusy,
    stageSelected,
    removeStaged,
    isSelectedStaged,
    reviewOpen,
    setReviewOpen,
    preview,
    previewLoading,
    reviewError,
    runPreview,
  }), [
    activeRequestIds.size,
    activeSite,
    activeSiteId,
    activeSelectedNode,
    activeTree,
    backHistory.length,
    backendScanState,
    cancel,
    childrenError,
    childrenLoading,
    childrenPage,
    completionBySite,
    coverageTargetSite,
    coverageTargetSiteId,
    contentRevision,
    dashboard,
    duplicateJumpRevision,
    error,
    healthMetric,
    isSelectedStaged,
    jumpToContentMatch,
    loading,
    location,
    notice,
    preview,
    previewLoading,
    progressBySite,
    refresh,
    retryChildren,
    removeStaged,
    reviewError,
    reviewOpen,
    retryTree,
    runPreview,
    scan,
    selectCoverageTarget,
    selectNode,
    selectSite,
    forwardHistory.length,
    stageSelected,
    stagingBusy,
    swapCoverageSites,
    treeError,
    treeLoading,
    goBack,
    goForward,
    goUp,
    navigateBreadcrumb,
    loadPreviousChildren,
    loadNextChildren,
  ]);
}
