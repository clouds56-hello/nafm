use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use chrono::{DateTime, Utc};
use nafm_core::{CredentialStore, Repository, WorkspaceManager};
use serde::Serialize;
use tokio::sync::{Mutex, RwLock};

#[derive(Clone)]
pub struct AppState {
  session: Arc<RwLock<ActiveWorkspace>>,
  pub workspace_manager: WorkspaceManager,
  pub credential_store: CredentialStore,
  pub scan_tasks: ScanTaskRegistry,
  pub transition_gate: Arc<Mutex<()>>,
}

impl AppState {
  pub fn new(
    workspace_manager: WorkspaceManager,
    credential_store: CredentialStore,
    workspace_name: String,
    workspace_path: PathBuf,
    repository: Repository,
  ) -> Self {
    Self {
      session: Arc::new(RwLock::new(ActiveWorkspace {
        name: workspace_name,
        path: workspace_path,
        repository,
      })),
      workspace_manager,
      credential_store,
      scan_tasks: ScanTaskRegistry::default(),
      transition_gate: Arc::new(Mutex::new(())),
    }
  }

  pub async fn active_workspace(&self) -> ActiveWorkspace {
    self.session.read().await.clone()
  }

  pub async fn repository(&self) -> Repository {
    self.session.read().await.repository.clone()
  }

  pub async fn repository_for(&self, expected_workspace: &str) -> Result<Repository, String> {
    let active = self.session.read().await;
    if active.name == expected_workspace {
      Ok(active.repository.clone())
    } else {
      Err(format!(
        "workspace changed from {expected_workspace} to {}; retry the operation",
        active.name
      ))
    }
  }

  pub async fn replace_active_workspace(&self, workspace: ActiveWorkspace) {
    *self.session.write().await = workspace;
  }
}

#[derive(Clone)]
pub struct ActiveWorkspace {
  pub name: String,
  pub path: PathBuf,
  pub repository: Repository,
}

#[derive(Clone, Default)]
pub struct ScanTaskRegistry {
  next_request_id: Arc<AtomicU64>,
  tasks: Arc<Mutex<BTreeMap<u64, RunningScanTask>>>,
}

impl ScanTaskRegistry {
  pub fn next_request_id(&self) -> u64 {
    self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1
  }

  pub async fn insert_if_available(&self, task: RunningScanTask) -> bool {
    let mut tasks = self.tasks.lock().await;
    if tasks
      .values()
      .any(|running| running.task.selector.conflicts_with(&task.task.selector))
    {
      return false;
    }
    tasks.insert(task.task.request_id, task);
    true
  }

  pub async fn remove(&self, request_id: u64) {
    self.tasks.lock().await.remove(&request_id);
  }

  pub async fn cancel(&self, request_id: u64) -> bool {
    let tasks = self.tasks.lock().await;
    let Some(task) = tasks.get(&request_id) else {
      return false;
    };
    task.cancelled.store(true, Ordering::Release);
    true
  }

  pub async fn active_tasks(&self) -> Vec<ScanTask> {
    self.tasks.lock().await.values().map(|task| task.task.clone()).collect()
  }
}

pub struct RunningScanTask {
  pub task: ScanTask,
  pub cancelled: Arc<AtomicBool>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanTask {
  pub request_id: u64,
  pub selector: ScanSelector,
  pub status: ScanTaskStatus,
  pub created_at: DateTime<Utc>,
}

#[derive(Clone, Debug, serde::Deserialize, Serialize)]
pub struct ScanSelector {
  pub site_id: Option<String>,
  #[serde(default)]
  pub all: bool,
}

impl ScanSelector {
  pub fn value(&self) -> Result<String, String> {
    match (&self.site_id, self.all) {
      (None, true) => Ok("all".to_owned()),
      (Some(site_id), false) if !site_id.trim().is_empty() => Ok(site_id.clone()),
      _ => Err("select exactly one site or all sites".to_owned()),
    }
  }

  fn conflicts_with(&self, other: &Self) -> bool {
    self.all || other.all || self.site_id == other.site_id
  }
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanTaskStatus {
  Running,
}

#[cfg(test)]
mod tests {
  use super::{ScanSelector, ScanTask, ScanTaskRegistry, ScanTaskStatus};
  use chrono::Utc;
  use std::sync::Arc;
  use std::sync::atomic::AtomicBool;

  fn site(site_id: &str) -> ScanSelector {
    ScanSelector {
      site_id: Some(site_id.to_owned()),
      all: false,
    }
  }

  #[test]
  fn selector_requires_exactly_one_scope() {
    assert_eq!(site("photos").value().unwrap(), "photos");
    assert_eq!(
      ScanSelector {
        site_id: None,
        all: true
      }
      .value()
      .unwrap(),
      "all"
    );
    assert!(
      ScanSelector {
        site_id: None,
        all: false
      }
      .value()
      .is_err()
    );
    assert!(
      ScanSelector {
        site_id: Some("photos".to_owned()),
        all: true,
      }
      .value()
      .is_err()
    );
  }

  #[tokio::test]
  async fn registry_rejects_overlapping_scan_scopes() {
    let registry = ScanTaskRegistry::default();
    let selector = site("photos");
    assert!(
      registry
        .insert_if_available(super::RunningScanTask {
          task: ScanTask {
            request_id: 1,
            selector: selector.clone(),
            status: ScanTaskStatus::Running,
            created_at: Utc::now(),
          },
          cancelled: Arc::new(AtomicBool::new(false)),
        })
        .await
    );

    assert!(
      !registry
        .insert_if_available(super::RunningScanTask {
          task: ScanTask {
            request_id: 2,
            selector,
            status: ScanTaskStatus::Running,
            created_at: Utc::now(),
          },
          cancelled: Arc::new(AtomicBool::new(false)),
        })
        .await
    );
    assert!(
      registry
        .insert_if_available(super::RunningScanTask {
          task: ScanTask {
            request_id: 3,
            selector: site("videos"),
            status: ScanTaskStatus::Running,
            created_at: Utc::now(),
          },
          cancelled: Arc::new(AtomicBool::new(false)),
        })
        .await
    );
    assert!(
      !registry
        .insert_if_available(super::RunningScanTask {
          task: ScanTask {
            request_id: 4,
            selector: ScanSelector {
              site_id: None,
              all: true,
            },
            status: ScanTaskStatus::Running,
            created_at: Utc::now(),
          },
          cancelled: Arc::new(AtomicBool::new(false)),
        })
        .await
    );
    assert_eq!(registry.active_tasks().await.len(), 2);
  }
}
