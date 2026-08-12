import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cancelScan,
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
    const requestId = treeRequestRef.current + 1;
    treeRequestRef.current = requestId;
    if (foreground) {
      setTreeLoading(true);
      setTreeError(null);
    } else {
      setTreeLoading(false);
    }
    try {
      const tree = await getStorageTree(siteId, targetSiteId);
      setTrees((current) => new Map(current).set(treeKey(siteId, targetSiteId), tree));
      if (treeRequestRef.current === requestId
        && selectedSiteRef.current === siteId
        && targetSiteRef.current === targetSiteId) {
        setSelectedNodeId((current) => findNode(tree.root, current)?.id ?? tree.root.id);
        setTreeError(null);
      }
    } catch (treeLoadError) {
      const message = errorMessage(treeLoadError);
      if (foreground && treeRequestRef.current === requestId) setTreeError(message);
      else setNotice(message);
    } finally {
      if (foreground && treeRequestRef.current === requestId) setTreeLoading(false);
    }
  }, []);

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
    setSelectedNodeId(null);
    if (trees.has(treeKey(siteId, nextTarget))) {
      setTreeLoading(false);
      setTreeError(null);
    } else {
      await refreshTree(siteId, nextTarget, true);
    }
  }, [dashboard?.sites, refreshTree, trees]);

  const selectCoverageTarget = useCallback(async (targetSiteId: string) => {
    const sourceSiteId = selectedSiteRef.current;
    if (!sourceSiteId || targetSiteId === sourceSiteId) return;
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
    setSelectedNodeId(null);
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
  const selectedNode = activeTree
    ? findNode(activeTree.root, selectedNodeId) ?? activeTree.root
    : null;

  const updateStaged = useCallback((update: DuplicateFile[] | ((files: DuplicateFile[]) => DuplicateFile[])) => {
    setDashboard((current) => current ? {
      ...current,
      staged: typeof update === "function" ? update(current.staged) : update,
    } : current);
    setPreview(null);
  }, []);

  const stageSelected = useCallback(async () => {
    if (!selectedNode?.path || healthMetric !== "space_health") return;
    setStagingBusy(true);
    setNotice(null);
    try {
      const report = await stagePath(selectedNode.path);
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
  }, [healthMetric, selectedNode, updateStaged]);

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
  const isSelectedStaged = Boolean(selectedNode?.path && dashboard?.staged.some((file) => {
    const selectedPath = selectedNode.path!;
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
    selectedNode,
    selectNode: (node: StorageNode) => setSelectedNodeId(node.id),
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
    activeTree,
    cancel,
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
    removeStaged,
    reviewError,
    reviewOpen,
    retryTree,
    runPreview,
    scan,
    selectCoverageTarget,
    selectedNode,
    selectSite,
    stageSelected,
    stagingBusy,
    swapCoverageSites,
    treeError,
    treeLoading,
  ]);
}
