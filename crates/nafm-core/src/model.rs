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
