import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CancelScanReport,
  CleanupPreview,
  Dashboard,
  ScanTask,
  ScanTaskEvent,
  ScanSelector,
  StageAddReport,
  StageRemoveReport,
  StorageTree,
  StorageChildrenPage,
} from "./types";

export function loadDashboard(): Promise<Dashboard> {
  return invoke<Dashboard>("load_dashboard");
}

export function getStorageTree(siteId: string, targetSiteId?: string | null): Promise<StorageTree> {
  return invoke<StorageTree>("get_storage_tree", {
    siteId,
    targetSiteId: targetSiteId ?? null,
    maxDepth: 5,
    maxChildren: 12,
  });
}

export function getStorageChildren(
  siteId: string,
  targetSiteId: string | null,
  nodeId: string,
  offset: number,
  limit: number,
): Promise<StorageChildrenPage> {
  return invoke<StorageChildrenPage>("get_storage_children", {
    siteId,
    targetSiteId,
    nodeId,
    offset,
    limit,
  });
}

export function startScan(selector: ScanSelector): Promise<ScanTask> {
  return invoke<ScanTask>("start_scan", { selector });
}

export function cancelScan(requestId: number): Promise<CancelScanReport> {
  return invoke<CancelScanReport>("cancel_scan", { requestId });
}

export function stagePath(path: string): Promise<StageAddReport> {
  return invoke<StageAddReport>("stage_path", { path });
}

export function unstagePath(path: string): Promise<StageRemoveReport> {
  return invoke<StageRemoveReport>("unstage_path", { path });
}

export function previewCleanup(): Promise<CleanupPreview> {
  return invoke<CleanupPreview>("preview_cleanup");
}

export function onScanTaskEvent(handler: (event: ScanTaskEvent) => void): Promise<UnlistenFn> {
  return listen<ScanTaskEvent>("task://scan/events", ({ payload }) => handler(payload));
}
