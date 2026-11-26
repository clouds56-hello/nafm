use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, NafmError>;

#[derive(Debug, Error)]
pub enum NafmError {
  #[error("Folder similarity exceeded its analysis budget; use a smaller workspace")]
  FolderSimilarityLimit,
  #[error("workspace not found: {0}")]
  WorkspaceNotFound(String),
  #[error("workspace already exists: {0}")]
  WorkspaceAlreadyExists(String),
  #[error("workspace name cannot be empty")]
  EmptyWorkspaceName,
  #[error("invalid workspace name: {0}")]
  InvalidWorkspaceName(String),
  #[error("site not found: {0}")]
  SiteNotFound(String),
  #[error("site already exists: {0}")]
  SiteAlreadyExists(String),
  #[error("site folder not found: {0}")]
  SiteFolderNotFound(String),
  #[error("Cannot add {path} because it overlaps {existing_path} in site {site_name}.")]
  SiteFolderOverlap {
    path: PathBuf,
    existing_path: PathBuf,
    site_name: String,
  },
  #[error("storage node not found: {0}")]
  StorageNodeNotFound(String),
  #[error("storage node is not navigable: {0}")]
  StorageNodeNotNavigable(String),
  #[error("The selected file is no longer in these Contents results.")]
  DirectoryFileUnavailable,
  #[error("no tracked file or folder found at path: {0}")]
  TrackedPathNotFound(PathBuf),
  #[error("tracked file not found: {0}")]
  TrackedFileNotFound(String),
  #[error("no stage history available for {0}")]
  StageHistoryUnavailable(&'static str),
  #[error("The staged list changed. Review the updated list before using Undo or Redo.")]
  StageHistoryChanged,
  #[error("site name cannot be empty")]
  EmptySiteName,
  #[error("cache path has no parent directory: {0}")]
  CachePathHasNoParent(PathBuf),
  #[error("unable to resolve app data directory")]
  AppDataDirectoryUnavailable,
  #[error("invalid SMB URL: {0}")]
  InvalidSmbUrl(String),
  #[error("SMB username cannot be empty")]
  EmptySmbUsername,
  #[error("SMB password cannot be empty")]
  EmptySmbPassword,
  #[error("no saved credentials for SMB location: {0}")]
  SmbCredentialNotFound(String),
  #[error("SMB file changed while it was being scanned: {0}")]
  SmbFileChanged(PathBuf),
  #[error("file changed while it was being scanned: {0}")]
  FileChanged(PathBuf),
  #[error("scan was superseded by a newer inventory for site: {0}")]
  ScanSuperseded(String),
  #[error(
    "Cannot scan {site_name} because {path} is already indexed by {owner_name}. Remove the overlap between these sites and try again."
  )]
  ScanInventoryOwnershipConflict {
    path: PathBuf,
    site_name: String,
    owner_name: String,
  },
  #[error("site analysis is not ready ({pending_hashes} file hashes pending verification): {site_id}")]
  SiteHashesPending { site_id: String, pending_hashes: u64 },
  #[error("scan cancelled")]
  ScanCancelled,
  #[error("remote machine not found: {0}")]
  RemoteMachineNotFound(String),
  #[error("remote path mapping not found: {0}")]
  RemotePathMappingNotFound(String),
  #[error("remote machine name cannot be empty")]
  EmptyRemoteMachineName,
  #[error("invalid SSH target: {0}")]
  InvalidSshTarget(String),
  #[error("remote agent error: {0}")]
  RemoteAgent(String),
  #[error("SSH connection error: {0}")]
  SshConnection(String),
  #[error("unsupported site location scheme: {0}")]
  UnsupportedLocationScheme(String),
  #[error("credentials path is not a regular file or directory: {0}")]
  InvalidCredentialsPath(PathBuf),
  #[error("unsupported credentials schema version: {0}")]
  UnsupportedCredentialsSchema(u32),
  #[error("database error: {0}")]
  Database(#[from] rusqlite::Error),
  #[error("SMB error: {0}")]
  Smb(#[from] smb2::Error),
  #[error("io error: {0}")]
  Io(#[from] std::io::Error),
  #[error("json error: {0}")]
  Json(#[from] serde_json::Error),
  #[error("blocking task failed: {0}")]
  Join(#[from] tokio::task::JoinError),
}
