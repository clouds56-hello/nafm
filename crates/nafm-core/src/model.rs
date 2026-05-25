use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HiddenPolicy {
  Include,
  Skip,
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
  pub path: PathBuf,
  pub hidden_policy: HiddenPolicy,
  pub added_at: DateTime<Utc>,
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
  pub files_removed: u64,
  pub bytes_hashed: u64,
  pub duplicate_groups: u64,
  pub duplicate_files: u64,
}

#[derive(Clone, Debug)]
pub struct ScanProgress {
  pub site_id: String,
  pub site_name: String,
  pub current_path: PathBuf,
  pub files_scanned: u64,
  pub total_files: u64,
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
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageRemoveReport {
  pub removed_files: Vec<DuplicateFile>,
  pub warnings: Vec<StageWarning>,
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

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct StageCommitDryRun {
  pub staged_files: Vec<DuplicateFile>,
  pub tracked_file_count_before: u64,
  pub tracked_file_count_after: u64,
  pub duplicate_group_count_before: u64,
  pub duplicate_group_count_after: u64,
  pub duplicate_file_count_before: u64,
  pub duplicate_file_count_after: u64,
  pub db_entry_count_stable: bool,
  pub duplicate_groups_after: Vec<DuplicateGroup>,
}
