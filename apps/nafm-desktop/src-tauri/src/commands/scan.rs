use std::sync::Arc;

use chrono::Utc;
use nafm_core::{NafmError, ScanEvent, ScanProgress, ScanStarted, ScanSummary};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::{
  AppState, RunningScanTask, ScanCancelMode, ScanCancelOutcome, ScanSelector, ScanTask, ScanTaskControl, ScanTaskStatus,
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

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ScanPhase {
  Discovering,
  Hashing,
  Finalizing,
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
  current_path: Option<String>,
  message: Option<String>,
  summary: Option<ScanSummary>,
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
  let request_id = state.scan_tasks.next_request_id();
  let scan_task = ScanTask {
    request_id,
    selector: selector.clone(),
    status: ScanTaskStatus::Running,
    created_at: Utc::now(),
  };
  let transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&expected_workspace).await?;
  let registry = state.scan_tasks.clone();
  let control = ScanTaskControl::default();
  let task_control = control.clone();
  let inserted = state
    .scan_tasks
    .insert_if_available(RunningScanTask {
      task: scan_task.clone(),
      control,
    })
    .await;
  if !inserted {
    return Err("a scan is already running for this selection".to_owned());
  }
  drop(transition);

  tokio::spawn(async move {
    let result = if selector_value == "all" {
      scan_all(&app, &repository, request_id, task_control).await
    } else {
      scan_site(&app, &repository, request_id, &selector_value, task_control).await
    };

    registry.remove(request_id).await;
    emit_task_terminal(&app, request_id, classify_scan_result(result));
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
  let request = state.scan_tasks.request_cancel(request_id, mode).await;
  if request.outcome == ScanCancelOutcome::Requested {
    emit_task_event(&app, request_id, ScanEventKind::Cancelling, None);
  }
  Ok(CancelScanReport {
    request_id,
    outcome: request.outcome,
    status: request.status,
    effective_mode: request.effective_mode,
  })
}

async fn scan_all(
  app: &AppHandle,
  repository: &nafm_core::Repository,
  request_id: u64,
  control: ScanTaskControl,
) -> nafm_core::Result<()> {
  let event_app = app.clone();
  repository
    .scan_all_with_events_and_cancellation(
      Some(Arc::new(move |event| {
        emit_core_event(&event_app, request_id, event);
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
) -> nafm_core::Result<()> {
  let site = repository.site_overview(selector).await?;
  emit_started(
    app,
    request_id,
    &ScanStarted {
      site_id: site.site.id,
      site_name: site.site.name,
    },
  );
  let event_app = app.clone();
  let summary = repository
    .scan_site_with_progress_and_cancellation(
      selector,
      Some(Arc::new(move |progress| {
        emit_progress(&event_app, request_id, progress);
      })),
      Some(Arc::new(move || control.is_cancel_requested())),
    )
    .await?;
  emit_summary(app, request_id, &summary);
  Ok(())
}

fn emit_core_event(app: &AppHandle, request_id: u64, event: &ScanEvent) {
  match event {
    ScanEvent::Started(started) => emit_started(app, request_id, started),
    ScanEvent::Progress(progress) => emit_progress(app, request_id, progress),
    ScanEvent::Summary(summary) => emit_summary(app, request_id, summary),
  }
}

fn emit_started(app: &AppHandle, request_id: u64, started: &ScanStarted) {
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
      current_path: None,
      message: None,
      summary: None,
    },
  );
}

fn emit_progress(app: &AppHandle, request_id: u64, progress: &ScanProgress) {
  emit_event(
    app,
    ScanTaskEvent {
      request_id,
      scope: ScanEventScope::Site,
      site_id: Some(progress.site_id.clone()),
      kind: ScanEventKind::Progress,
      phase: Some(ScanPhase::Hashing),
      processed_files: Some(progress.files_scanned.saturating_add(progress.files_reused)),
      total_files: Some(progress.total_files),
      hashed_files: Some(progress.files_scanned),
      reused_files: Some(progress.files_reused),
      current_path: Some(progress.current_path.display().to_string()),
      message: None,
      summary: None,
    },
  );
}

fn emit_summary(app: &AppHandle, request_id: u64, summary: &ScanSummary) {
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
      current_path: None,
      message: None,
      summary: Some(summary.clone()),
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

fn emit_task_terminal(app: &AppHandle, request_id: u64, terminal: ScanTerminal) {
  match terminal {
    ScanTerminal::Completed => emit_task_event(app, request_id, ScanEventKind::Completed, None),
    ScanTerminal::Cancelled => emit_task_event(app, request_id, ScanEventKind::Cancelled, None),
    ScanTerminal::Failed(message) => emit_task_event(app, request_id, ScanEventKind::Failed, Some(message)),
  }
}

fn emit_task_event(app: &AppHandle, request_id: u64, kind: ScanEventKind, message: Option<String>) {
  emit_event(
    app,
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
      current_path: None,
      message,
      summary: None,
    },
  );
}

fn emit_event(app: &AppHandle, event: ScanTaskEvent) {
  let _ = app.emit(SCAN_EVENT_NAME, event);
}

#[cfg(test)]
mod tests {
  use nafm_core::NafmError;
  use serde_json::json;

  use super::{CancelScanReport, ScanTerminal, classify_scan_result};
  use crate::state::{ScanCancelMode, ScanCancelOutcome, ScanTaskControl, ScanTaskStatus};

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
