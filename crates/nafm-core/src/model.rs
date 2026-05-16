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
pub struct Folder {
  pub id: String,
  pub path: PathBuf,
  pub alias: Option<String>,
  pub hidden_policy: HiddenPolicy,
  pub added_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct AddFolderRequest {
  pub path: PathBuf,
  pub alias: Option<String>,
  pub hidden_policy: HiddenPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScanSummary {
  pub folder_id: String,
  pub files_seen: u64,
  pub files_hashed: u64,
  pub files_reused: u64,
  pub files_removed: u64,
  pub bytes_hashed: u64,
  pub duplicate_groups: u64,
  pub duplicate_files: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DuplicateFile {
  pub file_id: String,
  pub folder_id: String,
  pub path: PathBuf,
  pub size_bytes: u64,
  pub modified_unix_nanos: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DuplicateGroup {
  pub group_id: String,
  pub hash: String,
  pub size_bytes: u64,
  pub files: Vec<DuplicateFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TrashPlan {
  pub group_id: String,
  pub kept_file_id: String,
  pub trashed_files: Vec<DuplicateFile>,
  pub dry_run: bool,
}
