use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use chrono::Utc;
use nafm_core::{ScanEvent, ScanProgress, ScanStarted, ScanSummary};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::{AppState, RunningScanTask, ScanSelector, ScanTask, ScanTaskStatus};

const SCAN_EVENT_NAME: &str = "task://scan/events";

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ScanEventScope {
  Site,
  Task,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ScanEventKind {
  Started,
  Progress,
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
  cancelled: bool,
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
  let cancelled = Arc::new(AtomicBool::new(false));
  let cancelled_for_task = cancelled.clone();
  let task_cancellation = cancelled.clone();
  let inserted = state
    .scan_tasks
    .insert_if_available(RunningScanTask {
      task: scan_task.clone(),
      cancelled,
    })
    .await;
  if !inserted {
    return Err("a scan is already running for this selection".to_owned());
  }
  drop(transition);

  tokio::spawn(async move {
    let result = if selector_value == "all" {
      scan_all(&app, &repository, request_id, task_cancellation).await
    } else {
      scan_site(&app, &repository, request_id, &selector_value, task_cancellation).await
    };

    registry.remove(request_id).await;
    if cancelled_for_task.load(Ordering::Acquire) {
      emit_task_terminal(&app, request_id, ScanEventKind::Cancelled);
    } else if let Err(message) = result {
      emit_event(
        &app,
        ScanTaskEvent {
          request_id,
          scope: ScanEventScope::Task,
          site_id: None,
          kind: ScanEventKind::Failed,
          phase: None,
          processed_files: None,
          total_files: None,
          hashed_files: None,
          reused_files: None,
          current_path: None,
          message: Some(message),
          summary: None,
        },
      );
    } else {
      emit_task_terminal(&app, request_id, ScanEventKind::Completed);
    }
  });
  Ok(scan_task)
}

#[tauri::command]
pub async fn cancel_scan(state: State<'_, AppState>, request_id: u64) -> Result<CancelScanReport, String> {
  let cancelled = state.scan_tasks.cancel(request_id).await;
  Ok(CancelScanReport { request_id, cancelled })
}

async fn scan_all(
  app: &AppHandle,
  repository: &nafm_core::Repository,
  request_id: u64,
  cancellation: Arc<AtomicBool>,
) -> Result<(), String> {
  let event_app = app.clone();
  repository
    .scan_all_with_events_and_cancellation(
      Some(Arc::new(move |event| {
        emit_core_event(&event_app, request_id, event);
      })),
      Some(Arc::new(move || cancellation.load(Ordering::Acquire))),
    )
    .await
    .map(|_| ())
    .map_err(|error| error.to_string())
}

async fn scan_site(
  app: &AppHandle,
  repository: &nafm_core::Repository,
  request_id: u64,
  selector: &str,
  cancellation: Arc<AtomicBool>,
) -> Result<(), String> {
  let site = repository
    .site_overview(selector)
    .await
    .map_err(|error| error.to_string())?;
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
      Some(Arc::new(move || cancellation.load(Ordering::Acquire))),
    )
    .await
    .map_err(|error| error.to_string())?;
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

fn emit_task_terminal(app: &AppHandle, request_id: u64, kind: ScanEventKind) {
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
      message: None,
      summary: None,
    },
  );
}

fn emit_event(app: &AppHandle, event: ScanTaskEvent) {
  let _ = app.emit(SCAN_EVENT_NAME, event);
}
