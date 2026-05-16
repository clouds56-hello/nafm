use std::path::PathBuf;

use thiserror::Error;

pub type Result<T> = std::result::Result<T, NafmError>;

#[derive(Debug, Error)]
pub enum NafmError {
  #[error("folder not found: {0}")]
  FolderNotFound(String),
  #[error("duplicate group not found: {0}")]
  DuplicateGroupNotFound(String),
  #[error("file is not part of duplicate group: {0}")]
  FileNotInDuplicateGroup(String),
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
  #[error("trash error: {0}")]
  Trash(String),
}
