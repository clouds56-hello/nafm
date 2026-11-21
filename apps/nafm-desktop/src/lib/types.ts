export type SiteKind = "local" | "smb";
export type ScanPhase = "discovering" | "publishing_metadata" | "hashing" | "finalizing";

export interface SiteOverview {
  id: string;
  name: string;
  location: string;
  kind: SiteKind;
  connection_state: "connected" | "offline" | "unknown";
  scan_state: "idle" | "queued" | ScanPhase | "cancelling" | "done" | "failed";
  hash_status: "unscanned" | "pending" | "ready";
  latest_inventory_at: string | null;
  last_scanned_at: string | null;
  total_files: number;
  total_bytes: number;
}

export interface Dashboard {
  workspace_name: string;
  sites: SiteOverview[];
  active_tasks: {
    request_id: number;
    selector: { all?: boolean };
    site_states: { site_id: string; status: "queued" | "running" | "completed" }[];
  }[];
}

export interface StorageNode {
  id: string;
  name: string;
  path: string | null;
  kind: "site" | "local_root" | "smb_root" | "directory" | "file" | "smaller_items";
  file_count: number;
  total_bytes: number;
  verified_file_count: number;
  pending_hash_count: number;
  children: StorageNode[];
}

export interface StorageViewSnapshot {
  location: { breadcrumbs: StorageNode[]; root: StorageNode };
  page: { children: StorageNode[]; total_children: number; offset: number };
}

export interface ScanTaskEvent {
  request_id: number;
  scope: "site" | "task";
  site_id: string | null;
  kind: "started" | "progress" | "cancelling" | "completed" | "failed" | "cancelled";
  phase: ScanPhase | null;
  processed_files: number | null;
  total_files: number | null;
  message: string | null;
}
