use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use nafm_protocol::HiddenPolicy;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SiteFolderKind {
  Local,
  Smb,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Site {
  pub id: String,
  pub name: String,
  pub added_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SiteFolder {
  pub id: String,
  pub site_id: String,
  pub kind: SiteFolderKind,
  pub path: PathBuf,
  pub hidden_policy: HiddenPolicy,
  pub added_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RemoteMachine {
  pub id: String,
  pub name: String,
  pub ssh_target: String,
  #[serde(default)]
  pub agent_installation: Option<crate::installer::AgentInstallation>,
  pub added_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RemotePathMapping {
  pub id: String,
  pub remote_machine_id: String,
  pub smb_root: String,
  pub remote_root: PathBuf,
  pub added_at: DateTime<Utc>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SiteOverview {
  pub site: Site,
  pub folders: Vec<SiteFolder>,
  pub total_file_count: u64,
  pub verified_file_count: u64,
  pub pending_hash_count: u64,
  pub total_bytes: u64,
  pub verified_bytes: u64,
  pub duplicate_file_count: u64,
  pub duplicate_bytes: u64,
  pub hash_status: SiteHashStatus,
  pub latest_inventory_at: Option<DateTime<Utc>>,
  pub latest_scan_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SiteHashStatus {
  Unscanned,
  Pending,
  Ready,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StorageNodeKind {
  Site,
  LocalRoot,
  SmbRoot,
  Directory,
  File,
  SmallerItems,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageNode {
  pub id: String,
  pub name: String,
  pub path: Option<PathBuf>,
  pub kind: StorageNodeKind,
  pub total_bytes: u64,
  /// File modification time, or the newest known descendant modification time for a container.
  pub modified_unix_millis: Option<i64>,
  pub file_count: u64,
  pub verified_file_count: u64,
  pub pending_hash_count: u64,
  pub verified_bytes: u64,
  pub duplicate_bytes: u64,
  pub duplicate_file_count: u64,
  pub space_health: Option<f64>,
  pub estimated_space_health: Option<f64>,
  pub space_healthy_file_equivalents: f64,
  pub space_total_files: u64,
  pub coverage_health: Option<f64>,
  pub estimated_coverage_health: Option<f64>,
  pub coverage_covered_files: u64,
  pub coverage_total_files: u64,
  pub children: Vec<StorageNode>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageTree {
  pub site: Site,
  pub coverage_target: Option<Site>,
  pub max_depth: u32,
  pub max_children: u32,
  pub root: StorageNode,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageLocation {
  pub site: Site,
  pub coverage_target: Option<Site>,
  pub max_depth: u32,
  pub max_children: u32,
  pub breadcrumbs: Vec<StorageNode>,
  pub root: StorageNode,
}

#[derive(Clone, Debug, Serialize)]
pub struct FolderContentSummary {
  pub site_id: String,
  pub site_name: String,
  pub node_id: String,
  pub path: PathBuf,
  pub file_count: u64,
  pub verified_file_count: u64,
  pub pending_hash_count: u64,
  pub distinct_content_count: u64,
  pub distinct_bytes: u64,
  pub extra_copy_count: u64,
  pub inventory_ready: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct FolderSimilarityMatch {
  pub folder: FolderContentSummary,
  pub similarity: f64,
  pub source_coverage: f64,
  pub target_coverage: f64,
  pub shared_content_count: u64,
  pub shared_bytes: u64,
  pub source_only_count: u64,
  pub target_only_count: u64,
  pub source_only_bytes: u64,
  pub target_only_bytes: u64,
  pub partial: bool,
  pub identical_content: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct FolderSimilarityPage {
  pub source: FolderContentSummary,
  pub matches: Vec<FolderSimilarityMatch>,
  pub total_matches: u64,
  pub offset: u64,
  pub limit: u64,
  pub workspace_pending_hash_count: u64,
  pub workspace_incomplete_site_count: u64,
  pub generated_at: DateTime<Utc>,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectorySortField {
  Size,
  Name,
  Date,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SortDirection {
  Asc,
  Desc,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct DirectorySort {
  pub field: DirectorySortField,
  pub direction: SortDirection,
}

impl Default for DirectorySort {
  fn default() -> Self {
    Self {
      field: DirectorySortField::Size,
      direction: SortDirection::Desc,
    }
  }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageChildrenPage {
  pub site: Site,
  pub coverage_target: Option<Site>,
  pub parent: StorageNode,
  pub children: Vec<StorageNode>,
  pub total_children: u64,
  pub offset: u64,
  pub limit: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageViewSnapshot {
  pub tree: StorageTree,
  pub location: StorageLocation,
  pub page: StorageChildrenPage,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub filtered_page: Option<StorageChildrenPage>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageDirectoryAnchor {
  pub child_id: String,
  pub query: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageDirectoryFilter {
  pub folder_id: String,
  pub query: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StorageFileReveal {
  pub tree: StorageTree,
  pub location: StorageLocation,
  pub page: StorageChildrenPage,
  #[serde(skip_serializing_if = "Option::is_none")]
  pub filtered_page: Option<StorageChildrenPage>,
  pub selected_file: StorageNode,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FileContentMatchStatus {
  Ready,
  NeedsVerification,
  NotHashed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileContentMatch {
  pub file_id: String,
  pub site_id: String,
  pub site_name: String,
  pub site_folder_id: String,
  pub site_folder_kind: SiteFolderKind,
  pub path: PathBuf,
  pub size_bytes: u64,
  pub is_current: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct FileContentMatchesPage {
  pub status: FileContentMatchStatus,
  pub workspace_pending_hash_count: u64,
  pub workspace_incomplete_site_count: u64,
  pub matches: Vec<FileContentMatch>,
  pub total_matches: u64,
  pub offset: u64,
  pub limit: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexedFileMatch {
  pub file_id: String,
  pub site_id: String,
  pub site_name: String,
  pub name: String,
  pub path: PathBuf,
  pub size_bytes: u64,
  pub verified: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct IndexedFileSearchPage {
  pub matches: Vec<IndexedFileMatch>,
  pub total_matches: u64,
  pub offset: u64,
  pub limit: u64,
  #[serde(default, skip_serializing_if = "Option::is_none")]
  pub anchor_index: Option<u64>,
}

#[derive(Clone, Debug)]
pub struct AddSiteFolderRequest {
  pub path: PathBuf,
  pub hidden_policy: HiddenPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScanSummary {
  pub site_id: String,
  pub site_name: String,
  pub site_folders: u64,
  pub files_seen: u64,
  pub files_hashed: u64,
  pub files_reused: u64,
  pub files_pending: u64,
  pub files_removed: u64,
  pub bytes_hashed: u64,
  pub duplicate_groups: u64,
  pub duplicate_files: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanPhase {
  Discovering,
  PublishingMetadata,
  Hashing,
  Finalizing,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScanProgress {
  pub site_id: String,
  pub site_name: String,
  pub phase: ScanPhase,
  pub current_path: Option<PathBuf>,
  pub processed_files: u64,
  pub total_files: Option<u64>,
  pub hashed_files: u64,
  pub reused_files: u64,
  pub hashes_pending: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScanStarted {
  pub site_id: String,
  pub site_name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum ScanEvent {
  Started(ScanStarted),
  Progress(ScanProgress),
  Summary(ScanSummary),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DuplicateFile {
  pub file_id: String,
  pub site_id: String,
  pub site_folder_id: String,
  pub path: PathBuf,
  pub size_bytes: u64,
  pub modified_unix_nanos: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DuplicateGroup {
  pub group_id: String,
  pub hash_algorithm: String,
  pub hash: String,
  pub size_bytes: u64,
  pub files: Vec<DuplicateFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct MissingContentGroup {
  pub group_id: String,
  pub source_site_id: String,
  pub target_site_id: String,
  pub hash_algorithm: String,
  pub hash: String,
  pub size_bytes: u64,
  pub source_files: Vec<DuplicateFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageWarning {
  pub path: PathBuf,
  pub reason: StageWarningReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageWarningReason {
  NotTracked,
  NotDuplicate,
  AlreadyStaged,
  NotStaged,
  WouldRemoveLastCopy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageAddReport {
  pub staged_files: Vec<DuplicateFile>,
  pub warnings: Vec<StageWarning>,
  #[serde(default)]
  pub stage_history: StageHistoryState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageRemoveReport {
  pub removed_files: Vec<DuplicateFile>,
  pub warnings: Vec<StageWarning>,
  #[serde(default)]
  pub stage_history: StageHistoryState,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageResetReport {
  pub removed_files: Vec<DuplicateFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageHistoryReport {
  pub applied: bool,
  pub restored_files: Vec<DuplicateFile>,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct StageHistoryState {
  pub snapshot_id: String,
  pub undo_snapshot_id: Option<String>,
  pub redo_snapshot_id: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum StageHistoryDirection {
  Undo,
  Redo,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StageHistoryRequest {
  pub direction: StageHistoryDirection,
  pub expected_snapshot_id: String,
  pub target_snapshot_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageReviewGroup {
  pub group_id: String,
  pub staged_file_ids: Vec<String>,
  pub retained_files: Vec<DuplicateFile>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct StageVerificationBlocker {
  pub site_id: String,
  pub staged_file_ids: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageCommitDryRun {
  pub staged_files: Vec<DuplicateFile>,
  pub hashes_pending: u64,
  pub cleanup_ready: bool,
  pub warnings: Vec<StageWarning>,
  #[serde(default)]
  pub stage_history: StageHistoryState,
  /// Sites to verify before checking the affected staged files again.
  #[serde(default)]
  pub verification_blockers: Vec<StageVerificationBlocker>,
  pub tracked_file_count_before: u64,
  pub tracked_file_count_after: u64,
  pub duplicate_group_count_before: u64,
  pub duplicate_group_count_after: u64,
  pub duplicate_file_count_before: u64,
  pub duplicate_file_count_after: u64,
  pub db_entry_count_stable: bool,
  pub duplicate_groups_after: Vec<DuplicateGroup>,
  /// Verified groups affected by a ready cleanup, including groups with one remaining copy.
  #[serde(default)]
  pub review_groups: Vec<StageReviewGroup>,
}
