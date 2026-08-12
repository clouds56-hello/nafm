use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, NafmError>;

#[derive(Debug, Error)]
pub enum NafmError {
  #[error("workspace not found: {0}")]
  WorkspaceNotFound(String),
  #[error("workspace name cannot be empty")]
  EmptyWorkspaceName,
  #[error("invalid workspace name: {0}")]
  InvalidWorkspaceName(String),
  #[error("site not found: {0}")]
  SiteNotFound(String),
  #[error("site folder not found: {0}")]
  SiteFolderNotFound(String),
  #[error("storage node not found: {0}")]
  StorageNodeNotFound(String),
  #[error("no tracked file or folder found at path: {0}")]
  TrackedPathNotFound(PathBuf),
  #[error("no stage history available for {0}")]
  StageHistoryUnavailable(&'static str),
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
  #[error("scan cancelled")]
  ScanCancelled,
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
