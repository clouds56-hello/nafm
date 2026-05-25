use std::path::PathBuf;
use std::sync::Arc;

use directories::ProjectDirs;
use serde::{Deserialize, Serialize};

use crate::error::{NafmError, Result};
use crate::hash::HashAlgorithm;
use crate::repository::{Repository, RepositoryOptions};

pub const DEFAULT_WORKSPACE_NAME: &str = "default";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct WorkspaceInfo {
  pub name: String,
  pub active: bool,
}

#[derive(Clone, Debug)]
pub struct WorkspaceManager {
  root_dir: PathBuf,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct WorkspaceConfig {
  active_workspace: Option<String>,
}

impl WorkspaceManager {
  pub fn new(root_dir: PathBuf) -> Self {
    Self { root_dir }
  }

  pub fn from_default_root() -> Result<Self> {
    Ok(Self::new(app_root_dir()?))
  }

  pub fn config_path(&self) -> PathBuf {
    self.root_dir.join("config.json")
  }

  pub fn workspaces_dir(&self) -> PathBuf {
    self.root_dir.join("workspaces")
  }

  pub fn workspace_db_path(&self, name: &str) -> Result<PathBuf> {
    let name = normalize_workspace_name(name)?;
    Ok(self.workspaces_dir().join(format!("{name}.sqlite3")))
  }

  pub fn resolve_workspace_name(&self, explicit_name: Option<&str>) -> Result<String> {
    match explicit_name {
      Some(name) => normalize_workspace_name(name),
      None => self.current_workspace_name(),
    }
  }

  pub fn current_workspace_name(&self) -> Result<String> {
    Ok(
      self
        .load_config()?
        .active_workspace
        .unwrap_or_else(|| DEFAULT_WORKSPACE_NAME.to_owned()),
    )
  }

  pub fn list_workspaces(&self) -> Result<Vec<WorkspaceInfo>> {
    let active_workspace = self.current_workspace_name()?;
    let workspaces_dir = self.workspaces_dir();
    if !workspaces_dir.is_dir() {
      return Ok(Vec::new());
    }

    let mut workspaces = std::fs::read_dir(workspaces_dir)?
      .filter_map(|entry| entry.ok())
      .filter_map(|entry| {
        let path = entry.path();
        if path.extension().is_some_and(|extension| extension == "sqlite3") {
          path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .map(|name| WorkspaceInfo {
              name: name.to_owned(),
              active: name == active_workspace,
            })
        } else {
          None
        }
      })
      .collect::<Vec<_>>();
    workspaces.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(workspaces)
  }

  pub fn workspace_exists(&self, name: &str) -> Result<bool> {
    Ok(self.workspace_db_path(name)?.is_file())
  }

  pub async fn ensure_default_workspace(&self, hash_algorithm: Option<Arc<dyn HashAlgorithm>>) -> Result<()> {
    if !self.workspace_exists(DEFAULT_WORKSPACE_NAME)? {
      self
        .create_workspace(DEFAULT_WORKSPACE_NAME, false, hash_algorithm)
        .await?;
    }
    Ok(())
  }

  pub fn activate_workspace(&self, name: &str) -> Result<()> {
    let name = normalize_workspace_name(name)?;
    if !self.workspace_exists(&name)? {
      return Err(NafmError::WorkspaceNotFound(name));
    }

    let mut config = self.load_config()?;
    config.active_workspace = Some(name);
    self.store_config(&config)
  }

  pub async fn create_workspace(
    &self,
    name: &str,
    activate: bool,
    hash_algorithm: Option<Arc<dyn HashAlgorithm>>,
  ) -> Result<PathBuf> {
    let name = normalize_workspace_name(name)?;
    let cache_path = self.workspace_db_path(&name)?;
    Repository::open(RepositoryOptions {
      cache_path: cache_path.clone(),
      hash_algorithm,
    })
    .await?;

    if activate {
      let mut config = self.load_config()?;
      config.active_workspace = Some(name);
      self.store_config(&config)?;
    }

    Ok(cache_path)
  }

  fn load_config(&self) -> Result<WorkspaceConfig> {
    let config_path = self.config_path();
    if !config_path.is_file() {
      return Ok(WorkspaceConfig { active_workspace: None });
    }
    Ok(serde_json::from_slice(&std::fs::read(config_path)?)?)
  }

  fn store_config(&self, config: &WorkspaceConfig) -> Result<()> {
    std::fs::create_dir_all(&self.root_dir)?;
    std::fs::write(self.config_path(), serde_json::to_vec_pretty(config)?)?;
    Ok(())
  }
}

pub fn app_root_dir() -> Result<PathBuf> {
  let dirs = ProjectDirs::from("dev", "nafm", "nafm").ok_or(NafmError::AppDataDirectoryUnavailable)?;
  Ok(dirs.data_dir().to_path_buf())
}

pub fn normalize_workspace_name(name: &str) -> Result<String> {
  let trimmed = name.trim();
  if trimmed.is_empty() {
    return Err(NafmError::EmptyWorkspaceName);
  }
  if trimmed
    .chars()
    .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
  {
    Ok(trimmed.to_owned())
  } else {
    Err(NafmError::InvalidWorkspaceName(trimmed.to_owned()))
  }
}
