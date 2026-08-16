use std::sync::Arc;

use chrono::Utc;
use nafm_core::{NafmError, ScanEvent, ScanPhase, ScanProgress, ScanStarted, ScanSummary};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::{
  AppState, RunningScanTask, ScanCancelMode, ScanCancelOutcome, ScanSelector, ScanTask, ScanTaskControl,
  ScanTaskSiteState, ScanTaskSiteStatus, ScanTaskStatus,
};

const SCAN_EVENT_NAME: &str = "task://scan/events";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ScanEventScope {
  Site,
  Task,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ScanEventKind {
  Started,
  Progress,
  Cancelling,
  Completed,
  Failed,
  Cancelled,
}

#[derive(Clone, Serialize)]
struct ScanTaskEvent {
  request_id: u64,
  scope: ScanEventScope,
  site_id: Option<String>,
  kind: ScanEventKind,
  phase: Option<ScanPhase>,
  processed_files: Option<u64>,
  total_files: Option<u64>,
  hashed_files: Option<u64>,
  reused_files: Option<u64>,
  hashes_pending: Option<u64>,
  current_path: Option<String>,
  message: Option<String>,
  summary: Option<ScanSummary>,
  site_states: Option<Vec<ScanTaskSiteState>>,
}

#[derive(Serialize)]
pub struct CancelScanReport {
  request_id: u64,
  outcome: ScanCancelOutcome,
  status: Option<ScanTaskStatus>,
  effective_mode: Option<ScanCancelMode>,
}

#[tauri::command]
pub async fn start_scan(
  app: AppHandle,
  state: State<'_, AppState>,
  selector: ScanSelector,
  expected_workspace: String,
) -> Result<ScanTask, String> {
  let selector_value = selector.value()?;
  let scans_all = selector.all;
  let request_id = state.scan_tasks.next_request_id();
  let transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&expected_workspace).await?;
  let site_states = initial_site_states(&repository, scans_all, &selector_value).await?;
  let scan_task = ScanTask {
    request_id,
    selector: selector.clone(),
    status: ScanTaskStatus::Running,
    created_at: Utc::now(),
    site_states,
  };
  let registry = state.scan_tasks.clone();
  let control = ScanTaskControl::default();
  let task_control = control.clone();
  let inserted = state.scan_tasks.insert_if_available(RunningScanTask {
    task: scan_task.clone(),
    control,
  });
  if !inserted {
    return Err("a scan is already running for this selection".to_owned());
  }
  drop(transition);

  tokio::spawn(async move {
    let scan_registry = registry.clone();
    let result = if scans_all {
      scan_all(&app, &repository, request_id, task_control, scan_registry).await
    } else {
      scan_site(
        &app,
        &repository,
        request_id,
        &selector_value,
        task_control,
        scan_registry,
      )
      .await
    };

    let terminal_site_states = registry.remove_with_site_states(request_id);
    emit_task_terminal(&app, request_id, classify_scan_result(result), terminal_site_states);
  });
  Ok(scan_task)
}

#[tauri::command]
pub async fn cancel_scan(
  app: AppHandle,
  state: State<'_, AppState>,
  request_id: u64,
  mode: ScanCancelMode,
) -> Result<CancelScanReport, String> {
  let request = state.scan_tasks.request_cancel(request_id, mode);
  if request.outcome == ScanCancelOutcome::Requested {
    emit_task_event(
      &app,
      request_id,
      ScanEventKind::Cancelling,
      None,
      request.site_states.clone(),
    );
  }
  Ok(CancelScanReport {
    request_id,
    outcome: request.outcome,
    status: request.status,
    effective_mode: request.effective_mode,
  })
}

async fn initial_site_states(
  repository: &nafm_core::Repository,
  scans_all: bool,
  selector: &str,
) -> Result<Vec<ScanTaskSiteState>, String> {
  let site_ids = if scans_all {
    repository
      .site_overviews()
      .await
      .map_err(|error| error.to_string())?
      .into_iter()
      .map(|overview| overview.site.id)
      .collect()
  } else {
    vec![
      repository
        .site_overview(selector)
        .await
        .map_err(|error| error.to_string())?
        .site
        .id,
    ]
  };
  Ok(site_ids.into_iter().map(ScanTaskSiteState::queued).collect())
}

async fn scan_all(
  app: &AppHandle,
  repository: &nafm_core::Repository,
  request_id: u64,
  control: ScanTaskControl,
  registry: crate::state::ScanTaskRegistry,
) -> nafm_core::Result<()> {
  let event_app = app.clone();
  let event_registry = registry.clone();
  repository
    .scan_all_with_events_and_cancellation(
      Some(Arc::new(move |event| {
        emit_core_event(&event_app, &event_registry, request_id, event);
      })),
      Some(Arc::new(move || control.is_cancel_requested())),
    )
    .await
    .map(|_| ())
}

async fn scan_site(
  app: &AppHandle,
  repository: &nafm_core::Repository,
  request_id: u64,
  selector: &str,
  control: ScanTaskControl,
  registry: crate::state::ScanTaskRegistry,
) -> nafm_core::Result<()> {
  let site = repository.site_overview(selector).await?;
  emit_started(
    app,
    &registry,
    request_id,
    &ScanStarted {
      site_id: site.site.id,
      site_name: site.site.name,
    },
  );
  let event_app = app.clone();
  let progress_registry = registry.clone();
  let summary = repository
    .scan_site_with_progress_and_cancellation(
      selector,
      Some(Arc::new(move |progress| {
        emit_progress(&event_app, &progress_registry, request_id, progress);
      })),
      Some(Arc::new(move || control.is_cancel_requested())),
    )
    .await?;
  emit_summary(app, &registry, request_id, &summary);
  Ok(())
}

fn emit_core_event(app: &AppHandle, registry: &crate::state::ScanTaskRegistry, request_id: u64, event: &ScanEvent) {
  match event {
    ScanEvent::Started(started) => emit_started(app, registry, request_id, started),
    ScanEvent::Progress(progress) => emit_progress(app, registry, request_id, progress),
    ScanEvent::Summary(summary) => emit_summary(app, registry, request_id, summary),
  }
}

fn emit_started(app: &AppHandle, registry: &crate::state::ScanTaskRegistry, request_id: u64, started: &ScanStarted) {
  registry.update_site_state(
    request_id,
    ScanTaskSiteState {
      site_id: started.site_id.clone(),
      status: ScanTaskSiteStatus::Running,
      phase: Some(ScanPhase::Discovering),
      processed_files: 0,
      total_files: None,
      hashed_files: 0,
      reused_files: 0,
      hashes_pending: 0,
      current_path: None,
    },
  );
  emit_event(
    app,
    ScanTaskEvent {
      request_id,
      scope: ScanEventScope::Site,
      site_id: Some(started.site_id.clone()),
      kind: ScanEventKind::Started,
      phase: Some(ScanPhase::Discovering),
      processed_files: Some(0),
      total_files: None,
      hashed_files: Some(0),
      reused_files: Some(0),
      hashes_pending: Some(0),
      current_path: None,
      message: None,
      summary: None,
      site_states: None,
    },
  );
}

fn emit_progress(app: &AppHandle, registry: &crate::state::ScanTaskRegistry, request_id: u64, progress: &ScanProgress) {
  let current_path = progress.current_path.as_ref().map(|path| path.display().to_string());
  registry.update_site_state(
    request_id,
    ScanTaskSiteState {
      site_id: progress.site_id.clone(),
      status: ScanTaskSiteStatus::Running,
      phase: Some(progress.phase),
      processed_files: progress.processed_files,
      total_files: progress.total_files,
      hashed_files: progress.hashed_files,
      reused_files: progress.reused_files,
      hashes_pending: progress.hashes_pending,
      current_path: current_path.clone(),
    },
  );
  emit_event(app, progress_event(request_id, progress, current_path));
}

fn progress_event(request_id: u64, progress: &ScanProgress, current_path: Option<String>) -> ScanTaskEvent {
  ScanTaskEvent {
    request_id,
    scope: ScanEventScope::Site,
    site_id: Some(progress.site_id.clone()),
    kind: ScanEventKind::Progress,
    phase: Some(progress.phase),
    processed_files: Some(progress.processed_files),
    total_files: progress.total_files,
    hashed_files: Some(progress.hashed_files),
    reused_files: Some(progress.reused_files),
    hashes_pending: Some(progress.hashes_pending),
    current_path,
    message: None,
    summary: None,
    site_states: None,
  }
}

fn emit_summary(app: &AppHandle, registry: &crate::state::ScanTaskRegistry, request_id: u64, summary: &ScanSummary) {
  registry.update_site_state(
    request_id,
    ScanTaskSiteState {
      site_id: summary.site_id.clone(),
      status: ScanTaskSiteStatus::Completed,
      phase: Some(ScanPhase::Finalizing),
      processed_files: summary.files_seen,
      total_files: Some(summary.files_seen),
      hashed_files: summary.files_hashed,
      reused_files: summary.files_reused,
      hashes_pending: summary.files_pending,
      current_path: None,
    },
  );
  emit_event(
    app,
    ScanTaskEvent {
      request_id,
      scope: ScanEventScope::Site,
      site_id: Some(summary.site_id.clone()),
      kind: ScanEventKind::Completed,
      phase: Some(ScanPhase::Finalizing),
      processed_files: Some(summary.files_seen),
      total_files: Some(summary.files_seen),
      hashed_files: Some(summary.files_hashed),
      reused_files: Some(summary.files_reused),
      hashes_pending: Some(summary.files_pending),
      current_path: None,
      message: None,
      summary: Some(summary.clone()),
      site_states: None,
    },
  );
}

#[derive(Debug, Eq, PartialEq)]
enum ScanTerminal {
  Completed,
  Cancelled,
  Failed(String),
}

fn classify_scan_result(result: nafm_core::Result<()>) -> ScanTerminal {
  match result {
    Ok(()) => ScanTerminal::Completed,
    Err(NafmError::ScanCancelled) => ScanTerminal::Cancelled,
    Err(error) => ScanTerminal::Failed(error.to_string()),
  }
}

fn emit_task_terminal(app: &AppHandle, request_id: u64, terminal: ScanTerminal, site_states: Vec<ScanTaskSiteState>) {
  match terminal {
    ScanTerminal::Completed => emit_task_event(app, request_id, ScanEventKind::Completed, None, Some(site_states)),
    ScanTerminal::Cancelled => emit_task_event(app, request_id, ScanEventKind::Cancelled, None, Some(site_states)),
    ScanTerminal::Failed(message) => {
      emit_task_event(app, request_id, ScanEventKind::Failed, Some(message), Some(site_states))
    }
  }
}

fn emit_task_event(
  app: &AppHandle,
  request_id: u64,
  kind: ScanEventKind,
  message: Option<String>,
  site_states: Option<Vec<ScanTaskSiteState>>,
) {
  emit_event(app, task_event(request_id, kind, message, site_states));
}

fn task_event(
  request_id: u64,
  kind: ScanEventKind,
  message: Option<String>,
  site_states: Option<Vec<ScanTaskSiteState>>,
) -> ScanTaskEvent {
  ScanTaskEvent {
    request_id,
    scope: ScanEventScope::Task,
    site_id: None,
    kind,
    phase: None,
    processed_files: None,
    total_files: None,
    hashed_files: None,
    reused_files: None,
    hashes_pending: None,
    current_path: None,
    message,
    summary: None,
    site_states,
  }
}

fn emit_event(app: &AppHandle, event: ScanTaskEvent) {
  let _ = app.emit(SCAN_EVENT_NAME, event);
}

#[cfg(test)]
mod tests {
  use nafm_core::{NafmError, ScanPhase, ScanProgress};
  use serde_json::json;

  use super::{CancelScanReport, ScanEventKind, ScanTerminal, classify_scan_result, progress_event, task_event};
  use crate::state::{
    ScanCancelMode, ScanCancelOutcome, ScanTaskControl, ScanTaskSiteState, ScanTaskSiteStatus, ScanTaskStatus,
  };

  #[test]
  fn cancel_report_serializes_stable_snake_case_contract() {
    let report = CancelScanReport {
      request_id: 7,
      outcome: ScanCancelOutcome::AlreadyRequested,
      status: Some(ScanTaskStatus::Cancelling),
      effective_mode: Some(ScanCancelMode::Graceful),
    };

    assert_eq!(
      serde_json::to_value(report).unwrap(),
      json!({
        "request_id": 7,
        "outcome": "already_requested",
        "status": "cancelling",
        "effective_mode": "graceful"
      })
    );

    let not_found = CancelScanReport {
      request_id: 8,
      outcome: ScanCancelOutcome::NotFound,
      status: None,
      effective_mode: None,
    };
    assert_eq!(
      serde_json::to_value(not_found).unwrap(),
      json!({
        "request_id": 8,
        "outcome": "not_found",
        "status": null,
        "effective_mode": null
      })
    );
  }

  #[test]
  fn progress_event_preserves_two_pass_phase_and_durable_counts() {
    let progress = ScanProgress {
      site_id: "photos".to_owned(),
      site_name: "Photos".to_owned(),
      phase: ScanPhase::PublishingMetadata,
      current_path: None,
      processed_files: 0,
      total_files: Some(12),
      hashed_files: 0,
      reused_files: 0,
      hashes_pending: 12,
    };

    assert_eq!(
      serde_json::to_value(progress_event(3, &progress, None)).unwrap(),
      json!({
        "request_id": 3,
        "scope": "site",
        "site_id": "photos",
        "kind": "progress",
        "phase": "publishing_metadata",
        "processed_files": 0,
        "total_files": 12,
        "hashed_files": 0,
        "reused_files": 0,
        "hashes_pending": 12,
        "current_path": null,
        "message": null,
        "summary": null,
        "site_states": null
      })
    );
  }

  #[test]
  fn task_terminal_event_carries_last_per_site_snapshot() {
    let site_states = vec![ScanTaskSiteState {
      site_id: "photos".to_owned(),
      status: ScanTaskSiteStatus::Running,
      phase: Some(ScanPhase::Hashing),
      processed_files: 7,
      total_files: Some(12),
      hashed_files: 3,
      reused_files: 4,
      hashes_pending: 5,
      current_path: Some("/photos/current.jpg".to_owned()),
    }];
    let json = serde_json::to_value(task_event(3, ScanEventKind::Cancelled, None, Some(site_states))).unwrap();

    assert_eq!(json["scope"], "task");
    assert_eq!(json["kind"], "cancelled");
    assert_eq!(json["site_states"][0]["site_id"], "photos");
    assert_eq!(json["site_states"][0]["phase"], "hashing");
    assert_eq!(json["site_states"][0]["hashes_pending"], 5);
  }

  #[test]
  fn terminal_classification_depends_on_core_result_not_cancel_flag() {
    let control = ScanTaskControl::default();
    control.request_cancel(ScanCancelMode::Graceful);
    assert!(control.is_cancel_requested());

    assert_eq!(classify_scan_result(Ok(())), ScanTerminal::Completed);
    assert_eq!(
      classify_scan_result(Err(NafmError::ScanCancelled)),
      ScanTerminal::Cancelled
    );
    assert_eq!(
      classify_scan_result(Err(NafmError::SiteNotFound("photos".to_owned()))),
      ScanTerminal::Failed("site not found: photos".to_owned())
    );
  }
}
