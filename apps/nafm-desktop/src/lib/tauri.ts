import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Dashboard, ScanTaskEvent, StorageViewSnapshot } from "./types";

export function loadDashboard() {
  return invoke<Dashboard>("load_dashboard");
}

export function getStorageViewSnapshot(
  workspace: string,
  site: string,
  node: string,
  offset: number,
  limit: number,
) {
  return invoke<StorageViewSnapshot>("get_storage_view_snapshot", {
    expectedWorkspace: workspace,
    siteId: site,
    targetSiteId: null,
    nodeId: node,
    offset,
    maxDepth: 3,
    maxChildren: 16,
    limit,
  });
}

export function startScan(site: string, workspace: string) {
  return invoke("start_scan", { selector: { site_id: site }, expectedWorkspace: workspace });
}

export function cancelScan(requestId: number) {
  return invoke("cancel_scan", { requestId, mode: "graceful" });
}

export function onScanTaskEvent(handler: (event: ScanTaskEvent) => void) {
  return listen<ScanTaskEvent>("task://scan/events", ({ payload }) => handler(payload));
}

export function createSite(workspaceName: string, name: string, folderPath: string) {
  return invoke("create_site", { workspaceName, name, folderPath, hiddenPolicy: null });
}

export function connectSmb(url: string, username: string, password: string) {
  return invoke("connect_smb", { url, username, password });
}
