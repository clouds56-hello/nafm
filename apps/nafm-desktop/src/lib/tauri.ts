import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  PathCompletion,
  PathCompletionRequest,
  InstallAgentRequest,
  SshPrompt,
  SshPromptReply,
  PreflightReport,
  MappingPreview,
  PathPreviewRequest,
  InstallAgentProgress,
  CancelScanReport,
  CancelScanMode,
  CleanupPreview,
  Dashboard,
  FileContentMatchesPage,
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
  StorageFileReveal,
  StorageLocation,
  StorageTree,
  StorageViewSnapshot,
} from "./types";

export function completeRemotePath(request: PathCompletionRequest): Promise<PathCompletion> {
  return invoke<PathCompletion>("complete_remote_path", { request });
}

export function installRemoteAgent(request: InstallAgentRequest): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("install_remote_agent", { request });
}

export function getSshPrompts(): Promise<SshPrompt[]> {
  return invoke<SshPrompt[]>("ssh_prompts");
}

export function replySshPrompt(request: SshPromptReply): Promise<void> {
  return invoke<void>("ssh_prompt_reply", { request });
}

export function onSshPromptsChanged(handler: () => void): Promise<UnlistenFn> {
  return listen("ssh://prompts-changed", handler);
}

export function preflightRemoteMachine(request: InstallAgentRequest): Promise<PreflightReport> {
  return invoke<PreflightReport>("preflight_remote_machine", { request });
}

export function onAgentSetupProgress(handler: (event: InstallAgentProgress) => void): Promise<UnlistenFn> {
  return listen<InstallAgentProgress>("agent://setup-progress", ({ payload }) => handler(payload));
}

export function previewRemotePathMapping(request: PathPreviewRequest): Promise<MappingPreview> {
  return invoke<MappingPreview>("preview_remote_path_mapping", { request });
}

export function onAgentInstallProgress(handler: (event: InstallAgentProgress) => void): Promise<UnlistenFn> {
  return listen<InstallAgentProgress>("agent://install-progress", ({ payload }) => handler(payload));
}

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

export function addRemoteMachine(
  workspaceName: string,
  name: string,
  sshTarget: string,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("add_remote_machine", { workspaceName, name, sshTarget });
}

export function removeRemoteMachine(
  workspaceName: string,
  machineId: string,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("remove_remote_machine", { workspaceName, machineId });
}

export function probeRemoteMachine(workspaceName: string, machineId: string): Promise<void> {
  return invoke<void>("probe_remote_machine", { workspaceName, machineId });
}

export function addRemotePathMapping(
  workspaceName: string,
  machineId: string,
  smbRoot: string,
  remoteRoot: string,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("add_remote_path_mapping", {
    workspaceName,
    machineId,
    smbRoot,
    remoteRoot,
  });
}

export function removeRemotePathMapping(
  workspaceName: string,
  mappingId: string,
): Promise<ManagementMutationResult> {
  return invoke<ManagementMutationResult>("remove_remote_path_mapping", { workspaceName, mappingId });
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

export function getStorageViewSnapshot(
  expectedWorkspace: string,
  siteId: string,
  targetSiteId: string | null,
  nodeId: string,
  offset: number,
  maxDepth = 5,
  maxChildren = 12,
  limit = 6,
): Promise<StorageViewSnapshot> {
  return invoke<StorageViewSnapshot>("get_storage_view_snapshot", {
    expectedWorkspace,
    siteId,
    targetSiteId,
    nodeId,
    offset,
    maxDepth,
    maxChildren,
    limit,
  });
}

export function getStorageFileReveal(
  expectedWorkspace: string,
  fileId: string,
  targetSiteId: string | null,
  maxDepth = 5,
  maxChildren = 12,
  limit = 6,
): Promise<StorageFileReveal> {
  return invoke<StorageFileReveal>("get_storage_file_reveal", {
    expectedWorkspace,
    fileId,
    targetSiteId,
    maxDepth,
    maxChildren,
    limit,
  });
}

export function getFileContentMatches(
  siteId: string,
  path: string,
  offset: number,
  limit: number,
  expectedWorkspace: string,
): Promise<FileContentMatchesPage> {
  return invoke<FileContentMatchesPage>("get_file_content_matches", {
    siteId,
    path,
    offset,
    limit,
    expectedWorkspace,
  });
}

export function startScan(selector: ScanSelector, expectedWorkspace: string): Promise<ScanTask> {
  return invoke<ScanTask>("start_scan", { selector, expectedWorkspace });
}

export function cancelScan(
  requestId: number,
  mode: CancelScanMode = "graceful",
): Promise<CancelScanReport> {
  return invoke<CancelScanReport>("cancel_scan", { requestId, mode });
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
