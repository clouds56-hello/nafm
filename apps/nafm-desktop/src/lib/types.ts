export type SiteKind = "local" | "smb";
export type ConnectionState = "connected" | "offline" | "unknown";
export type ScanState = "idle" | "queued" | "discovering" | "hashing" | "finalizing" | "done" | "failed";
export type ScanPhase = "discovering" | "hashing" | "finalizing";
export type ScanTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type HealthMetric = "space_health" | "coverage_health";
export type HiddenPolicy = "include" | "skip";

export interface WorkspaceSummary {
  name: string;
  path: string;
  active: boolean;
}

export interface ManagedSiteFolder {
  id: string;
  site_id: string;
  kind: SiteKind;
  path: string;
  hidden_policy: HiddenPolicy;
  added_at: string;
}

export interface ManagedSite {
  id: string;
  name: string;
  added_at: string;
  folders: ManagedSiteFolder[];
  last_scanned_at: string | null;
  total_files: number;
  total_bytes: number;
}

export interface SavedConnection {
  url: string;
  username: string;
}

export interface ManagementSnapshot {
  active_workspace: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
  sites: ManagedSite[];
  connections: SavedConnection[];
}

export interface ManagementMutationResult {
  snapshot: ManagementSnapshot | null;
  active_workspace: WorkspaceSummary;
  refresh_error: string | null;
}

export interface SiteOverview {
  id: string;
  name: string;
  location: string;
  kind: SiteKind;
  connection_state: ConnectionState;
  scan_state: ScanState;
  last_scanned_at: string | null;
  total_files: number;
  total_bytes: number;
  duplicate_files: number;
  duplicate_bytes: number;
}

export interface Dashboard {
  workspace_name: string;
  workspace_path: string;
  sites: SiteOverview[];
  active_tasks: ScanTask[];
  staged: DuplicateFile[];
  last_updated_at: string;
}

export interface StorageNode {
  id: string;
  name: string;
  path: string | null;
  kind: "site" | "local_root" | "smb_root" | "directory" | "file" | "smaller_items";
  file_count: number;
  total_bytes: number;
  duplicate_bytes: number;
  duplicate_file_count: number;
  space_health: number | null;
  coverage_health: number | null;
  space_healthy_file_equivalents: number;
  space_total_files: number;
  coverage_covered_files: number;
  coverage_total_files: number;
  children: StorageNode[];
}

export interface StorageTree {
  site_id: string;
  coverage_target: {
    id: string;
    name: string;
    added_at: string;
  } | null;
  root: StorageNode;
}

export interface StorageChildrenPage {
  site: {
    id: string;
    name: string;
    added_at: string;
  };
  coverage_target: {
    id: string;
    name: string;
    added_at: string;
  } | null;
  parent: StorageNode;
  children: StorageNode[];
  total_children: number;
  offset: number;
  limit: number;
}

export interface ScanSelector {
  site_id?: string;
  all?: boolean;
}

export interface ScanTask {
  request_id: number;
  selector: ScanSelector;
  status: ScanTaskStatus;
  created_at: string;
}

export interface CancelScanReport {
  request_id: number;
  cancelled: boolean;
}

export interface ScanSummary {
  site_id: string;
  site_name: string;
  files_seen: number;
  files_hashed: number;
  files_reused: number;
  files_removed: number;
  bytes_hashed: number;
  duplicate_groups: number;
  duplicate_files: number;
}

export interface ScanTaskEvent {
  request_id: number;
  scope: "site" | "task";
  site_id: string | null;
  kind: "started" | "progress" | "completed" | "failed" | "cancelled";
  phase?: ScanPhase;
  processed_files?: number;
  total_files?: number;
  hashed_files?: number;
  reused_files?: number;
  current_path?: string | null;
  summary?: ScanSummary;
  message?: string;
}

export interface DuplicateFile {
  file_id: string;
  site_id: string;
  site_folder_id: string;
  path: string;
  size_bytes: number;
  modified_unix_nanos: number;
}

export type StageWarningReason =
  | "not_tracked"
  | "not_duplicate"
  | "already_staged"
  | "not_staged"
  | "would_remove_last_copy";

export interface StageWarning {
  path: string;
  reason: StageWarningReason;
}

export interface StageAddReport {
  staged_files: DuplicateFile[];
  warnings: StageWarning[];
}

export interface StageRemoveReport {
  removed_files: DuplicateFile[];
  warnings: StageWarning[];
}

export interface CleanupPreview {
  staged_files: DuplicateFile[];
  tracked_file_count_before: number;
  tracked_file_count_after: number;
  duplicate_group_count_before: number;
  duplicate_group_count_after: number;
  duplicate_file_count_before: number;
  duplicate_file_count_after: number;
  db_entry_count_stable: boolean;
  duplicate_groups_after: Array<{
    group_id: string;
    size_bytes: number;
    files: DuplicateFile[];
  }>;
}

export interface ScanProgressView {
  request_id: number;
  site_id: string;
  phase: ScanPhase;
  processed_files: number;
  total_files: number;
  hashed_files: number;
  reused_files: number;
  current_path: string | null;
}
