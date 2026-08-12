import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelScan,
  getStorageChildren,
  getStorageTree,
  loadDashboard,
  onScanTaskEvent,
  previewCleanup,
  stagePath,
  startScan,
  unstagePath,
} from "../lib/tauri";
import type {
  CleanupPreview,
  Dashboard,
  DuplicateFile,
  HealthMetric,
  ScanProgressView,
  ScanTaskEvent,
  SiteOverview,
  StorageNode,
  StorageChildrenPage,
  StorageTree,
} from "../lib/types";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}

function treeKey(siteId: string, targetSiteId: string | null): string {
  return `${siteId}\u0000${targetSiteId ?? ""}`;
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

export function useDashboard() {
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
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<StorageNode | null>(null);
  const [selectionHistory, setSelectionHistory] = useState<StorageNode[]>([]);
  const [childrenPage, setChildrenPage] = useState<StorageChildrenPage | null>(null);
  const [childrenLoading, setChildrenLoading] = useState(false);
  const [childrenLoadingMore, setChildrenLoadingMore] = useState(false);
  const [childrenError, setChildrenError] = useState<string | null>(null);
  const [progressBySite, setProgressBySite] = useState<Map<string, ScanProgressView>>(new Map());
  const [activeRequestIds, setActiveRequestIds] = useState<Set<number>>(new Set());
  const [stagingBusy, setStagingBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const selectedSiteRef = useRef<string | null>(null);
  const targetSiteRef = useRef<string | null>(null);
  const treeRequestRef = useRef(0);
  const treeRequestByKeyRef = useRef<Map<string, number>>(new Map());
  const childrenRequestRef = useRef(0);
  const selectedNodeRef = useRef<StorageNode | null>(null);
  const selectionHistoryRef = useRef<StorageNode[]>([]);
  const childrenPageRef = useRef<StorageChildrenPage | null>(null);

  useEffect(() => {
    selectedNodeRef.current = selectedNode;
  }, [selectedNode]);

  useEffect(() => {
    selectionHistoryRef.current = selectionHistory;
  }, [selectionHistory]);

  useEffect(() => {
    childrenPageRef.current = childrenPage;
  }, [childrenPage]);

  const loadChildren = useCallback(async (
    siteId: string,
    targetSiteId: string | null,
    node: StorageNode,
    offset = 0,
    preserveSelection = false,
  ) => {
    const requestId = childrenRequestRef.current + 1;
    childrenRequestRef.current = requestId;
    const loadingMore = offset > 0;
    if (loadingMore) setChildrenLoadingMore(true);
    else {
      setChildrenLoading(true);
      childrenPageRef.current = null;
      setChildrenPage(null);
    }
    setChildrenError(null);
    try {
      const page = await getStorageChildren(siteId, targetSiteId, node.id, offset, 50);
      if (childrenRequestRef.current !== requestId) return;
      const currentPage = childrenPageRef.current;
      const nextPage = loadingMore && currentPage?.parent.id === page.parent.id ? {
        ...page,
        children: [...currentPage.children, ...page.children],
        offset: 0,
      } : page;
      childrenPageRef.current = nextPage;
      setChildrenPage(nextPage);

      if (!loadingMore) {
        const currentSelection = selectedNodeRef.current;
        const refreshedSelection = currentSelection?.id === page.parent.id
          ? page.parent
          : page.children.find((child) => child.id === currentSelection?.id);
        const nextSelection = preserveSelection
          ? refreshedSelection ?? currentSelection ?? page.parent
          : refreshedSelection ?? page.parent;
        selectedNodeRef.current = nextSelection;
        setSelectedNodeId(nextSelection.id);
        setSelectedNode(nextSelection);
      }
    } catch (childrenLoadError) {
      if (childrenRequestRef.current === requestId) setChildrenError(errorMessage(childrenLoadError));
    } finally {
      if (childrenRequestRef.current === requestId) {
        setChildrenLoading(false);
        setChildrenLoadingMore(false);
      }
    }
  }, []);

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
  ) => {
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
        const currentSelection = selectedNodeRef.current;
        const currentPage = childrenPageRef.current;
        const inTreeSelection = currentSelection ? findNode(tree.root, currentSelection.id) : null;
        const pageSelection = currentSelection && (
          currentPage?.parent.id === currentSelection.id
          || currentPage?.children.some((child) => child.id === currentSelection.id)
        )
          ? currentSelection
          : null;
        const nextSelection = inTreeSelection ?? pageSelection ?? tree.root;
        selectedNodeRef.current = nextSelection;
        setSelectedNodeId(nextSelection.id);
        setSelectedNode(nextSelection);
        if (!currentSelection || nextSelection.id === tree.root.id) {
          selectionHistoryRef.current = [];
          setSelectionHistory([]);
        } else {
          const nextHistory = selectionHistoryRef.current.map(
            (historyNode) => findNode(tree.root, historyNode.id) ?? historyNode,
          );
          selectionHistoryRef.current = nextHistory;
          setSelectionHistory(nextHistory);
        }
        const folderSelection = nextSelection.kind !== "file" && nextSelection.kind !== "smaller_items"
          ? nextSelection
          : currentPage?.parent ?? selectionHistoryRef.current.at(-1) ?? tree.root;
        void loadChildren(siteId, targetSiteId, folderSelection, 0, true);
        setTreeError(null);
      }
    } catch (treeLoadError) {
      const message = errorMessage(treeLoadError);
      if (foreground && treeRequestRef.current === requestId) setTreeError(message);
      else setNotice(message);
    } finally {
      if (foreground && treeRequestRef.current === requestId) setTreeLoading(false);
    }
  }, [loadChildren]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadDashboard();
      setDashboard(next);
      setActiveRequestIds(new Set(next.active_tasks.map((task) => task.request_id)));
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
      setError(errorMessage(loadError));
    } finally {
      setLoading(false);
    }
  }, [refreshTree]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const handleScanEvent = useCallback((event: ScanTaskEvent) => {
    if (event.scope === "site" && event.site_id) {
      setActiveRequestIds((current) => new Set(current).add(event.request_id));
      if (event.kind === "started") {
        setProgressBySite((current) => new Map(current).set(event.site_id!, {
          request_id: event.request_id,
          site_id: event.site_id!,
          phase: event.phase ?? "discovering",
          processed_files: 0,
          total_files: 0,
          hashed_files: 0,
          reused_files: 0,
          current_path: null,
        }));
      } else if (event.kind === "progress") {
        setProgressBySite((current) => new Map(current).set(event.site_id!, {
          request_id: event.request_id,
          site_id: event.site_id!,
          phase: event.phase ?? "hashing",
          processed_files: event.processed_files ?? 0,
          total_files: event.total_files ?? 0,
          hashed_files: event.hashed_files ?? 0,
          reused_files: event.reused_files ?? 0,
          current_path: event.current_path ?? null,
        }));
      } else {
        setProgressBySite((current) => {
          const next = new Map(current);
          next.delete(event.site_id!);
          return next;
        });
        if (event.kind === "completed") {
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
      setActiveRequestIds((current) => {
        const next = new Set(current);
        next.delete(event.request_id);
        return next;
      });
      setProgressBySite((current) => new Map([...current].filter(([, progress]) => progress.request_id !== event.request_id)));
      void loadDashboard().then(setDashboard).catch(() => undefined);
      if (event.kind === "failed") setNotice(event.message ?? "The scan failed.");
      if (event.kind === "cancelled") {
        setNotice("Scan cancelled. Completed hashes remain cached.");
        const sourceSiteId = selectedSiteRef.current;
        if (sourceSiteId) void refreshTree(sourceSiteId, targetSiteRef.current, false);
      }
    }
  }, [refreshTree]);

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
        const siteIds = task.selector.all ? allSiteIds : task.selector.site_id ? [task.selector.site_id] : [];
        for (const siteId of siteIds) {
          if (!next.has(siteId)) {
            next.set(siteId, {
              request_id: task.request_id,
              site_id: siteId,
              phase: "discovering",
              processed_files: 0,
              total_files: 0,
              hashed_files: 0,
              reused_files: 0,
              current_path: null,
            });
          }
        }
      }
      return next;
    });
  }, [dashboard?.active_tasks, dashboard?.sites]);

  const selectSite = useCallback(async (siteId: string) => {
    const sites = dashboard?.sites ?? [];
    const nextTarget = validTarget(sites, siteId, targetSiteRef.current);
    setActiveSiteId(siteId);
    setCoverageTargetSiteId(nextTarget);
    selectedSiteRef.current = siteId;
    targetSiteRef.current = nextTarget;
    childrenRequestRef.current += 1;
    setSelectedNodeId(null);
    setSelectedNode(null);
    setSelectionHistory([]);
    setChildrenPage(null);
    setChildrenError(null);
    setChildrenLoading(false);
    setChildrenLoadingMore(false);
    selectedNodeRef.current = null;
    selectionHistoryRef.current = [];
    childrenPageRef.current = null;
    const cachedTree = trees.get(treeKey(siteId, nextTarget));
    if (cachedTree) {
      selectedNodeRef.current = cachedTree.root;
      setSelectedNodeId(cachedTree.root.id);
      setSelectedNode(cachedTree.root);
      setTreeLoading(false);
      setTreeError(null);
      await loadChildren(siteId, nextTarget, cachedTree.root);
    } else {
      await refreshTree(siteId, nextTarget, true);
    }
  }, [dashboard?.sites, loadChildren, refreshTree, trees]);

  const selectCoverageTarget = useCallback(async (targetSiteId: string) => {
    const sourceSiteId = selectedSiteRef.current;
    if (!sourceSiteId || targetSiteId === sourceSiteId) return;
    childrenRequestRef.current += 1;
    childrenPageRef.current = null;
    setChildrenPage(null);
    setChildrenError(null);
    setChildrenLoading(false);
    setChildrenLoadingMore(false);
    setCoverageTargetSiteId(targetSiteId);
    targetSiteRef.current = targetSiteId;
    await refreshTree(sourceSiteId, targetSiteId, true);
  }, [refreshTree]);

  const swapCoverageSites = useCallback(async () => {
    const previousSourceSiteId = selectedSiteRef.current;
    const previousTargetSiteId = targetSiteRef.current;
    if (!previousSourceSiteId || !previousTargetSiteId) return;
    setActiveSiteId(previousTargetSiteId);
    setCoverageTargetSiteId(previousSourceSiteId);
    selectedSiteRef.current = previousTargetSiteId;
    targetSiteRef.current = previousSourceSiteId;
    childrenRequestRef.current += 1;
    setSelectedNodeId(null);
    setSelectedNode(null);
    setSelectionHistory([]);
    setChildrenPage(null);
    setChildrenError(null);
    setChildrenLoading(false);
    setChildrenLoadingMore(false);
    selectedNodeRef.current = null;
    selectionHistoryRef.current = [];
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
      const task = await startScan(siteId ? { site_id: siteId } : { all: true });
      setActiveRequestIds((current) => new Set(current).add(task.request_id));
    } catch (scanError) {
      setNotice(errorMessage(scanError));
    }
  }, []);

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
    ? selectedNode ?? findNode(activeTree.root, selectedNodeId) ?? activeTree.root
    : null;

  const selectNode = useCallback((node: StorageNode) => {
    const siteId = selectedSiteRef.current;
    if (!siteId) return;
    const openable = node.kind !== "file" && node.kind !== "smaller_items";
    selectedNodeRef.current = node;
    setSelectedNodeId(node.id);
    setSelectedNode(node);
    if (openable) {
      const currentFolder = childrenPageRef.current?.parent;
      const currentHistory = selectionHistoryRef.current;
      const nextHistory = currentFolder?.id === node.id
        ? currentHistory
        : currentHistory.at(-1)?.id === node.id
          ? currentHistory.slice(0, -1)
          : currentFolder
            ? [...currentHistory, currentFolder]
            : currentHistory;
      selectionHistoryRef.current = nextHistory;
      setSelectionHistory(nextHistory);
      void loadChildren(siteId, targetSiteRef.current, node);
    }
  }, [loadChildren]);

  const goBack = useCallback(() => {
    const siteId = selectedSiteRef.current;
    if (!siteId) return;
    const history = selectionHistoryRef.current;
    const parent = history.at(-1);
    if (!parent) return;
    const nextHistory = history.slice(0, -1);
    selectionHistoryRef.current = nextHistory;
    selectedNodeRef.current = parent;
    setSelectionHistory(nextHistory);
    setSelectedNodeId(parent.id);
    setSelectedNode(parent);
    void loadChildren(siteId, targetSiteRef.current, parent);
  }, [loadChildren]);

  const retryChildren = useCallback(() => {
    const siteId = selectedSiteRef.current;
    const parent = childrenPage?.parent ?? activeSelectedNode;
    if (siteId && parent) void loadChildren(siteId, targetSiteRef.current, parent);
  }, [activeSelectedNode, childrenPage, loadChildren]);

  const loadMoreChildren = useCallback(() => {
    const siteId = selectedSiteRef.current;
    if (siteId && childrenPage) {
      void loadChildren(siteId, targetSiteRef.current, childrenPage.parent, childrenPage.children.length);
    }
  }, [childrenPage, loadChildren]);

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
      const report = await stagePath(activeSelectedNode.path);
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
      const report = await unstagePath(path);
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
    selectedNode: activeSelectedNode,
    selectNode,
    childrenPage,
    childrenLoading,
    childrenLoadingMore,
    childrenError,
    canGoBack: selectionHistory.length > 0,
    goBack,
    retryChildren,
    loadMoreChildren,
    selectSite,
    selectCoverageTarget,
    swapCoverageSites,
    treeLoading,
    treeError,
    retryTree,
    progressBySite,
    scan,
    cancel,
    activeTaskCount: activeRequestIds.size,
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
    cancel,
    childrenError,
    childrenLoading,
    childrenLoadingMore,
    childrenPage,
    coverageTargetSite,
    coverageTargetSiteId,
    dashboard,
    error,
    healthMetric,
    isSelectedStaged,
    loading,
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
    selectionHistory.length,
    stageSelected,
    stagingBusy,
    swapCoverageSites,
    treeError,
    treeLoading,
    goBack,
    loadMoreChildren,
  ]);
}
