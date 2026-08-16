use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, MutexGuard};

use chrono::{DateTime, Utc};
use nafm_core::{CredentialStore, Repository, ScanPhase, WorkspaceManager};
use serde::{Deserialize, Serialize};
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
  tasks: Arc<StdMutex<BTreeMap<u64, RunningScanTask>>>,
}

impl ScanTaskRegistry {
  pub fn next_request_id(&self) -> u64 {
    self.next_request_id.fetch_add(1, Ordering::Relaxed) + 1
  }

  pub fn insert_if_available(&self, task: RunningScanTask) -> bool {
    let mut tasks = self.lock_tasks();
    if tasks
      .values()
      .any(|running| running.task.selector.conflicts_with(&task.task.selector))
    {
      return false;
    }
    tasks.insert(task.task.request_id, task);
    true
  }

  pub fn request_cancel(&self, request_id: u64, mode: ScanCancelMode) -> ScanCancelRequest {
    let mut tasks = self.lock_tasks();
    let Some(task) = tasks.get_mut(&request_id) else {
      return ScanCancelRequest::not_found();
    };

    match task.task.status {
      ScanTaskStatus::Running => {
        let effective_mode = task.control.request_cancel(mode);
        task.task.status = ScanTaskStatus::Cancelling;
        ScanCancelRequest::requested(effective_mode, task.task.site_states.clone())
      }
      ScanTaskStatus::Cancelling => ScanCancelRequest::already_requested(
        task
          .control
          .effective_cancel_mode()
          .unwrap_or_else(|| task.control.request_cancel(mode)),
        task.task.site_states.clone(),
      ),
    }
  }

  pub fn remove_with_site_states(&self, request_id: u64) -> Vec<ScanTaskSiteState> {
    self
      .lock_tasks()
      .remove(&request_id)
      .map(|running| running.task.site_states)
      .unwrap_or_default()
  }

  pub fn update_site_state(&self, request_id: u64, site_state: ScanTaskSiteState) {
    let mut tasks = self.lock_tasks();
    let Some(running) = tasks.get_mut(&request_id) else {
      return;
    };
    if let Some(existing) = running
      .task
      .site_states
      .iter_mut()
      .find(|existing| existing.site_id == site_state.site_id)
    {
      *existing = site_state;
    } else {
      running.task.site_states.push(site_state);
    }
  }

  pub fn active_tasks(&self) -> Vec<ScanTask> {
    self.lock_tasks().values().map(|task| task.task.clone()).collect()
  }

  fn lock_tasks(&self) -> MutexGuard<'_, BTreeMap<u64, RunningScanTask>> {
    self.tasks.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
  }
}

pub struct RunningScanTask {
  pub task: ScanTask,
  pub control: ScanTaskControl,
}

const CANCEL_MODE_NONE: u8 = 0;
const CANCEL_MODE_GRACEFUL: u8 = 1;

#[derive(Clone, Default)]
pub struct ScanTaskControl {
  state: Arc<ScanTaskControlState>,
}

#[derive(Default)]
struct ScanTaskControlState {
  cancel_mode: AtomicU8,
}

impl ScanTaskControl {
  pub fn request_cancel(&self, mode: ScanCancelMode) -> ScanCancelMode {
    let encoded = mode.as_u8();
    let _ = self
      .state
      .cancel_mode
      .compare_exchange(CANCEL_MODE_NONE, encoded, Ordering::AcqRel, Ordering::Acquire);
    self.effective_cancel_mode().unwrap_or(mode)
  }

  pub fn is_cancel_requested(&self) -> bool {
    self.state.cancel_mode.load(Ordering::Acquire) != CANCEL_MODE_NONE
  }

  fn effective_cancel_mode(&self) -> Option<ScanCancelMode> {
    ScanCancelMode::from_u8(self.state.cancel_mode.load(Ordering::Acquire))
  }
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanTask {
  pub request_id: u64,
  pub selector: ScanSelector,
  pub status: ScanTaskStatus,
  pub created_at: DateTime<Utc>,
  pub site_states: Vec<ScanTaskSiteState>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ScanTaskSiteState {
  pub site_id: String,
  pub status: ScanTaskSiteStatus,
  pub phase: Option<ScanPhase>,
  pub processed_files: u64,
  pub total_files: Option<u64>,
  pub hashed_files: u64,
  pub reused_files: u64,
  pub hashes_pending: u64,
  pub current_path: Option<String>,
}

impl ScanTaskSiteState {
  pub fn queued(site_id: String) -> Self {
    Self {
      site_id,
      status: ScanTaskSiteStatus::Queued,
      phase: None,
      processed_files: 0,
      total_files: None,
      hashed_files: 0,
      reused_files: 0,
      hashes_pending: 0,
      current_path: None,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanTaskSiteStatus {
  Queued,
  Running,
  Completed,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
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

  pub fn includes_site(&self, site_id: &str) -> bool {
    self.all || self.site_id.as_deref() == Some(site_id)
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanTaskStatus {
  Running,
  Cancelling,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanCancelMode {
  Graceful,
}

impl ScanCancelMode {
  const fn as_u8(self) -> u8 {
    match self {
      Self::Graceful => CANCEL_MODE_GRACEFUL,
    }
  }

  const fn from_u8(value: u8) -> Option<Self> {
    match value {
      CANCEL_MODE_GRACEFUL => Some(Self::Graceful),
      _ => None,
    }
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ScanCancelOutcome {
  Requested,
  AlreadyRequested,
  NotFound,
}

#[derive(Clone, Debug)]
pub struct ScanCancelRequest {
  pub outcome: ScanCancelOutcome,
  pub status: Option<ScanTaskStatus>,
  pub effective_mode: Option<ScanCancelMode>,
  pub site_states: Option<Vec<ScanTaskSiteState>>,
}

impl ScanCancelRequest {
  fn requested(effective_mode: ScanCancelMode, site_states: Vec<ScanTaskSiteState>) -> Self {
    Self {
      outcome: ScanCancelOutcome::Requested,
      status: Some(ScanTaskStatus::Cancelling),
      effective_mode: Some(effective_mode),
      site_states: Some(site_states),
    }
  }

  fn already_requested(effective_mode: ScanCancelMode, site_states: Vec<ScanTaskSiteState>) -> Self {
    Self {
      outcome: ScanCancelOutcome::AlreadyRequested,
      status: Some(ScanTaskStatus::Cancelling),
      effective_mode: Some(effective_mode),
      site_states: Some(site_states),
    }
  }

  fn not_found() -> Self {
    Self {
      outcome: ScanCancelOutcome::NotFound,
      status: None,
      effective_mode: None,
      site_states: None,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::{
    ScanCancelMode, ScanCancelOutcome, ScanSelector, ScanTask, ScanTaskControl, ScanTaskRegistry, ScanTaskSiteState,
    ScanTaskSiteStatus, ScanTaskStatus,
  };
  use chrono::Utc;
  use nafm_core::ScanPhase;
  use serde_json::json;

  fn site(site_id: &str) -> ScanSelector {
    ScanSelector {
      site_id: Some(site_id.to_owned()),
      all: false,
    }
  }

  fn running_task(request_id: u64, selector: ScanSelector) -> super::RunningScanTask {
    let site_id = selector.site_id.clone().unwrap_or_else(|| "all".to_owned());
    super::RunningScanTask {
      task: ScanTask {
        request_id,
        selector,
        status: ScanTaskStatus::Running,
        created_at: Utc::now(),
        site_states: vec![ScanTaskSiteState::queued(site_id)],
      },
      control: ScanTaskControl::default(),
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

  #[test]
  fn selector_reports_included_sites() {
    assert!(site("photos").includes_site("photos"));
    assert!(!site("photos").includes_site("videos"));
    assert!(
      ScanSelector {
        site_id: None,
        all: true
      }
      .includes_site("photos")
    );
  }

  #[test]
  fn registry_rejects_overlapping_scan_scopes() {
    let registry = ScanTaskRegistry::default();
    let selector = site("photos");
    assert!(registry.insert_if_available(running_task(1, selector.clone())));

    assert!(!registry.insert_if_available(running_task(2, selector)));
    assert!(registry.insert_if_available(running_task(3, site("videos"))));
    assert!(!registry.insert_if_available(running_task(
      4,
      ScanSelector {
        site_id: None,
        all: true,
      },
    )));
    assert_eq!(registry.active_tasks().len(), 2);
  }

  #[test]
  fn registry_transitions_running_task_to_cancelling_once() {
    let registry = ScanTaskRegistry::default();
    let task = running_task(1, site("photos"));
    let control = task.control.clone();
    assert!(registry.insert_if_available(task));

    let first = registry.request_cancel(1, ScanCancelMode::Graceful);
    assert_eq!(first.outcome, ScanCancelOutcome::Requested);
    assert_eq!(first.status, Some(ScanTaskStatus::Cancelling));
    assert_eq!(first.effective_mode, Some(ScanCancelMode::Graceful));
    assert_eq!(first.site_states.as_ref().unwrap()[0].site_id, "photos");
    assert!(control.is_cancel_requested());

    let repeated = registry.request_cancel(1, ScanCancelMode::Graceful);
    assert_eq!(repeated.outcome, ScanCancelOutcome::AlreadyRequested);
    assert_eq!(repeated.status, Some(ScanTaskStatus::Cancelling));
    assert_eq!(repeated.effective_mode, Some(ScanCancelMode::Graceful));
    assert_eq!(repeated.site_states.as_ref().unwrap()[0].site_id, "photos");
    assert_eq!(registry.active_tasks()[0].status, ScanTaskStatus::Cancelling);
  }

  #[test]
  fn cancelling_task_still_conflicts_until_removed() {
    let registry = ScanTaskRegistry::default();
    assert!(registry.insert_if_available(running_task(1, site("photos"))));
    registry.request_cancel(1, ScanCancelMode::Graceful);

    assert!(!registry.insert_if_available(running_task(2, site("photos"))));
    registry.remove_with_site_states(1);
    assert!(registry.insert_if_available(running_task(2, site("photos"))));
  }

  #[test]
  fn cancelling_unknown_task_reports_not_found() {
    let registry = ScanTaskRegistry::default();

    let result = registry.request_cancel(42, ScanCancelMode::Graceful);

    assert_eq!(result.outcome, ScanCancelOutcome::NotFound);
    assert_eq!(result.status, None);
    assert_eq!(result.effective_mode, None);
    assert!(result.site_states.is_none());
  }

  #[test]
  fn registry_retains_serializable_per_site_progress() {
    let registry = ScanTaskRegistry::default();
    assert!(registry.insert_if_available(running_task(1, site("photos"))));
    registry.update_site_state(
      1,
      ScanTaskSiteState {
        site_id: "photos".to_owned(),
        status: ScanTaskSiteStatus::Running,
        phase: Some(ScanPhase::PublishingMetadata),
        processed_files: 0,
        total_files: Some(12),
        hashed_files: 0,
        reused_files: 0,
        hashes_pending: 12,
        current_path: None,
      },
    );

    let task = registry.active_tasks().pop().unwrap();
    assert_eq!(
      serde_json::to_value(task.site_states).unwrap(),
      json!([{
        "site_id": "photos",
        "status": "running",
        "phase": "publishing_metadata",
        "processed_files": 0,
        "total_files": 12,
        "hashed_files": 0,
        "reused_files": 0,
        "hashes_pending": 12,
        "current_path": null
      }])
    );
    let terminal_states = registry.remove_with_site_states(1);
    assert_eq!(terminal_states.len(), 1);
    assert_eq!(terminal_states[0].phase, Some(ScanPhase::PublishingMetadata));
    assert!(registry.active_tasks().is_empty());
  }

  #[test]
  fn cancellation_types_serialize_as_snake_case() {
    assert_eq!(serde_json::to_value(ScanCancelMode::Graceful).unwrap(), "graceful");
    assert_eq!(
      serde_json::to_value(ScanCancelOutcome::AlreadyRequested).unwrap(),
      "already_requested"
    );
    assert_eq!(serde_json::to_value(ScanTaskStatus::Cancelling).unwrap(), "cancelling");
    assert_eq!(
      serde_json::from_str::<ScanCancelMode>("\"graceful\"").unwrap(),
      ScanCancelMode::Graceful
    );
  }
}
