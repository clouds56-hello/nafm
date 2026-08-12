import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  CancelScanReport,
  CleanupPreview,
  Dashboard,
  HiddenPolicy,
  ManagementMutationResult,
  ManagementSnapshot,
  SavedConnection,
  ScanTask,
  ScanTaskEvent,
  ScanSelector,
  StageAddReport,
  StageRemoveReport,
  StorageChildrenPage,
  StorageLocation,
  StorageTree,
} from "./types";

export function loadManagement(): Promise<ManagementSnapshot> {
  return invoke<ManagementSnapshot>("load_management");
}

export function createWorkspace(name: string): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("create_workspace", { name });
}

export function switchWorkspace(name: string): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("switch_workspace", { name });
}

export function createSite(
  workspaceName: string,
  name: string,
  folderPath?: string,
  hiddenPolicy?: HiddenPolicy,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("create_site", {
    name,
    workspaceName,
    folderPath: folderPath || null,
    hiddenPolicy: hiddenPolicy ?? null,
  });
}

export function renameSite(
  workspaceName: string,
  siteId: string,
  name: string,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("rename_site", { workspaceName, siteId, name });
}

export function removeSite(workspaceName: string, siteId: string): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("remove_site", { workspaceName, siteId });
}

export function addSiteFolder(
  workspaceName: string,
  siteId: string,
  path: string,
  hiddenPolicy?: HiddenPolicy,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("add_site_folder", {
    siteId,
    workspaceName,
    path,
    hiddenPolicy: hiddenPolicy ?? null,
  });
}

export function removeSiteFolder(
  workspaceName: string,
  folderId: string,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("remove_site_folder", { workspaceName, folderId });
}

export function connectSmb(
  url: string,
  username: string,
  password: string,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("connect_smb", { url, username, password });
}

export function matchSmbConnection(url: string): Promise<SavedConnection | null> {
  return invoke<SavedConnection | null>("match_smb_connection", { url });
}

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

export function getStorageLocation(
  siteId: string,
  targetSiteId: string | null,
  nodeId: string,
): Promise<StorageLocation> {
  return invoke<StorageLocation>("get_storage_location", {
    siteId,
    targetSiteId,
    nodeId,
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

export function startScan(selector: ScanSelector, expectedWorkspace: string): Promise<ScanTask> {
  return invoke<ScanTask>("start_scan", { selector, expectedWorkspace });
}

export function cancelScan(requestId: number): Promise<CancelScanReport> {
  return invoke<CancelScanReport>("cancel_scan", { requestId });
}

export function stagePath(path: string, expectedWorkspace: string): Promise<StageAddReport> {
  return invoke<StageAddReport>("stage_path", { path, expectedWorkspace });
}

export function unstagePath(path: string, expectedWorkspace: string): Promise<StageRemoveReport> {
  return invoke<StageRemoveReport>("unstage_path", { path, expectedWorkspace });
}

export function previewCleanup(): Promise<CleanupPreview> {
  return invoke<CleanupPreview>("preview_cleanup");
}

export function onScanTaskEvent(handler: (event: ScanTaskEvent) => void): Promise<UnlistenFn> {
  return listen<ScanTaskEvent>("task://scan/events", ({ payload }) => handler(payload));
}
