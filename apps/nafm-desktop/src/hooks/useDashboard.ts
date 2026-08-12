import { useCallback, useEffect, useRef, useState } from "react";
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
  ScanProgressView,
  ScanTaskEvent,
  StorageNode,
  StorageTree,
} from "../lib/types";

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "An unexpected error occurred.";
}

export function useDashboard() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [activeSiteId, setActiveSiteId] = useState<string | null>(null);
  const [trees, setTrees] = useState<Map<string, StorageTree>>(new Map());
  const [treeLoading, setTreeLoading] = useState(false);
  const [selectedNode, setSelectedNode] = useState<StorageNode | null>(null);
  const [progressBySite, setProgressBySite] = useState<Map<string, ScanProgressView>>(new Map());
  const [activeRequestIds, setActiveRequestIds] = useState<Set<number>>(new Set());
  const [stagingBusy, setStagingBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [preview, setPreview] = useState<CleanupPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const selectedSiteRef = useRef<string | null>(null);

  useEffect(() => {
    selectedSiteRef.current = activeSiteId;
  }, [activeSiteId]);

  const refreshTree = useCallback(async (siteId: string, foreground = false) => {
    if (foreground) setTreeLoading(true);
    try {
      const tree = await getStorageTree(siteId);
      setTrees((current) => new Map(current).set(siteId, tree));
      if (selectedSiteRef.current === siteId) setSelectedNode(tree.root);
    } catch (treeError) {
      if (foreground) setNotice(errorMessage(treeError));
    } finally {
      if (foreground) setTreeLoading(false);
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
      const nextSite = next.sites.some((site) => site.id === requestedSite) ? requestedSite : next.sites[0]?.id ?? null;
      setActiveSiteId(nextSite);
      selectedSiteRef.current = nextSite;
      if (nextSite) await refreshTree(nextSite, false);
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
        if (event.kind === "completed") void refreshTree(event.site_id, false);
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
      void loadDashboard().then((next) => {
        setDashboard(next);
      }).catch(() => undefined);
      if (event.kind === "failed") setNotice(event.message ?? "The scan failed.");
      if (event.kind === "cancelled") {
        setNotice("Scan cancelled. Completed hashes remain cached.");
        if (selectedSiteRef.current) void refreshTree(selectedSiteRef.current, false);
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
    setActiveSiteId(siteId);
    selectedSiteRef.current = siteId;
    const cached = trees.get(siteId);
    if (cached) setSelectedNode(cached.root);
    else await refreshTree(siteId, true);
  }, [refreshTree, trees]);

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

  const updateStaged = useCallback((update: DuplicateFile[] | ((files: DuplicateFile[]) => DuplicateFile[])) => {
    setDashboard((current) => current ? {
      ...current,
      staged: typeof update === "function" ? update(current.staged) : update,
    } : current);
    setPreview(null);
  }, []);

  const stageSelected = useCallback(async () => {
    if (!selectedNode?.path) return;
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
      if (report.warnings.length > 0) setNotice("Some copies could not be staged because they were unsafe or unavailable.");
    } catch (stageError) {
      setNotice(errorMessage(stageError));
    } finally {
      setStagingBusy(false);
    }
  }, [selectedNode, updateStaged]);

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
  const activeTree = activeSiteId ? trees.get(activeSiteId) ?? null : null;
  const isSelectedStaged = Boolean(selectedNode?.path && dashboard?.staged.some((file) => {
    const selectedPath = selectedNode.path!;
    const normalized = selectedPath.endsWith("/") ? selectedPath : `${selectedPath}/`;
    return file.path === selectedPath || file.path.startsWith(normalized);
  }));

  return {
    dashboard,
    loading,
    error,
    notice,
    clearNotice: () => setNotice(null),
    refresh,
    activeSite,
    activeTree,
    activeSiteId,
    selectedNode: selectedNode ?? activeTree?.root ?? null,
    selectNode: setSelectedNode,
    selectSite,
    treeLoading,
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
  };
}
