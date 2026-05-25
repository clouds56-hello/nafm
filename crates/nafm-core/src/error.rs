use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, NafmError>;

#[derive(Debug, Error)]
pub enum NafmError {
  #[error("site not found: {0}")]
  SiteNotFound(String),
  #[error("site folder not found: {0}")]
  SiteFolderNotFound(String),
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
  #[error("blocking task failed: {0}")]
  Join(#[from] tokio::task::JoinError),
}
