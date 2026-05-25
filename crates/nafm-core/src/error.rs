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
  #[error("database error: {0}")]
  Database(#[from] rusqlite::Error),
  #[error("io error: {0}")]
  Io(#[from] std::io::Error),
  #[error("json error: {0}")]
  Json(#[from] serde_json::Error),
  #[error("blocking task failed: {0}")]
  Join(#[from] tokio::task::JoinError),
}
