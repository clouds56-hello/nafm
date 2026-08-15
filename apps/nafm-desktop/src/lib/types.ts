export type SiteKind = "local" | "smb";
export type ConnectionState = "connected" | "offline" | "unknown";
export type ScanState = "idle" | "queued" | "discovering" | "publishing_metadata" | "hashing" | "finalizing" | "cancelling" | "done" | "failed";
export type ScanPhase = "discovering" | "publishing_metadata" | "hashing" | "finalizing";
export type ScanTaskStatus = "queued" | "running" | "cancelling" | "completed" | "failed" | "cancelled";
export type CancelScanMode = "graceful";
export type CancelScanOutcome = "requested" | "already_requested" | "not_found";
export type HealthMetric = "space_health" | "coverage_health";
export type HiddenPolicy = "include" | "skip";
export type SiteHashStatus = "unscanned" | "pending" | "ready";

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
  hash_status: SiteHashStatus;
  verified_file_count: number;
  verified_bytes: number;
  pending_hash_count: number;
  latest_inventory_at: string | null;
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
  hash_status: SiteHashStatus;
  verified_file_count: number;
  verified_bytes: number;
  pending_hash_count: number;
  latest_inventory_at: string | null;
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
  staged_hashes_pending: number;
  staged_cleanup_ready: boolean;
  staged_warnings: StageWarning[];
  last_updated_at: string;
}

export interface StorageNode {
  id: string;
  name: string;
  path: string | null;
  kind: "site" | "local_root" | "smb_root" | "directory" | "file" | "smaller_items";
  file_count: number;
  verified_file_count: number;
  verified_bytes: number;
  pending_hash_count: number;
  total_bytes: number;
  duplicate_bytes: number;
  duplicate_file_count: number;
  space_health: number | null;
  coverage_health: number | null;
  estimated_space_health: number | null;
  estimated_coverage_health: number | null;
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

export interface StorageLocation {
  site_id: string;
  coverage_target: {
    id: string;
    name: string;
    added_at: string;
  } | null;
  breadcrumbs: StorageNode[];
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

export interface StorageViewSnapshot {
  tree: StorageTree;
  location: StorageLocation;
  page: StorageChildrenPage;
}

export interface StorageFileReveal {
  tree: StorageTree;
  location: StorageLocation;
  page: StorageChildrenPage;
  selected_file: StorageNode;
}

export type FileContentMatchStatus = "ready" | "not_hashed" | "needs_verification";

export interface FileContentMatch {
  file_id: string;
  site_id: string;
  site_name: string;
  site_folder_id: string;
  site_folder_kind: SiteKind;
  path: string;
  size_bytes: number;
  is_current: boolean;
}

export interface FileContentMatchesPage {
  status: FileContentMatchStatus;
  workspace_pending_hash_count: number;
  workspace_incomplete_site_count: number;
  matches: FileContentMatch[];
  total_matches: number;
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
  site_states: ScanTaskSiteState[];
}

export interface ScanTaskSiteState {
  site_id: string;
  status: "queued" | "running" | "completed";
  phase: ScanPhase | null;
  processed_files: number;
  total_files: number | null;
  hashed_files: number;
  reused_files: number;
  hashes_pending: number;
  current_path: string | null;
}

export interface CancelScanReport {
  request_id: number;
  outcome: CancelScanOutcome;
  status: "cancelling" | null;
  effective_mode: CancelScanMode | null;
}

export interface ScanSummary {
  site_id: string;
  site_name: string;
  files_seen: number;
  files_hashed: number;
  files_reused: number;
  files_pending: number;
  files_removed: number;
  bytes_hashed: number;
  duplicate_groups: number;
  duplicate_files: number;
}

export interface ScanTaskEvent {
  request_id: number;
  scope: "site" | "task";
  site_id: string | null;
  kind: "started" | "progress" | "cancelling" | "completed" | "failed" | "cancelled";
  phase: ScanPhase | null;
  processed_files: number | null;
  total_files: number | null;
  hashed_files: number | null;
  reused_files: number | null;
  hashes_pending: number | null;
  current_path: string | null;
  site_states: ScanTaskSiteState[] | null;
  summary: ScanSummary | null;
  message: string | null;
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
  hashes_pending: number;
  cleanup_ready: boolean;
  warnings: StageWarning[];
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
  total_files: number | null;
  hashed_files: number;
  reused_files: number;
  hashes_pending: number;
  current_path: string | null;
}

export interface ScanCompletionView {
  request_id: number | null;
  site_id: string;
  source: "event" | "snapshot";
  status: "indexed" | "complete";
  should_announce: boolean;
  total_files: number;
  pending_files: number;
  hashed_files: number | null;
  reused_files: number | null;
}
