use std::path::PathBuf;
use std::sync::Arc;

use nafm_core::{
  CleanupProgress, CleanupReport, StageAddReport, StageCommitDryRun, StageHistoryRequest, StageRemoveReport,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::state::AppState;

const CLEANUP_PROGRESS_EVENT: &str = "task://cleanup/progress";

#[derive(Clone, Serialize)]
struct CleanupProgressEvent<'a> {
  workspace_name: &'a str,
  plan_id: &'a str,
  progress: &'a CleanupProgress,
}

#[tauri::command]
pub async fn stage_path(
  state: State<'_, AppState>,
  path: String,
  expected_workspace: String,
) -> Result<StageAddReport, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&expected_workspace).await?;
  repository
    .stage_add_path(&PathBuf::from(path))
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn unstage_path(
  state: State<'_, AppState>,
  path: String,
  expected_workspace: String,
) -> Result<StageRemoveReport, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&expected_workspace).await?;
  repository
    .stage_remove_path(&PathBuf::from(path))
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_cleanup(
  state: State<'_, AppState>,
  expected_workspace: String,
) -> Result<StageCommitDryRun, String> {
  let repository = state.repository_for(&expected_workspace).await?;
  repository
    .stage_commit_dry_run()
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn move_cleanup_to_trash(
  app: AppHandle,
  state: State<'_, AppState>,
  expected_workspace: String,
  plan_id: String,
) -> Result<CleanupReport, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&expected_workspace).await?;
  if !state.scan_tasks.active_tasks().is_empty() {
    return Err("Wait for scans to finish before moving files to Trash.".to_owned());
  }
  let event_plan_id = plan_id.clone();
  let progress = Arc::new(move |progress: &CleanupProgress| {
    let _ = app.emit(
      CLEANUP_PROGRESS_EVENT,
      CleanupProgressEvent {
        workspace_name: &expected_workspace,
        plan_id: &event_plan_id,
        progress,
      },
    );
  });
  repository
    .move_cleanup_to_trash_with_progress(&plan_id, Some(progress))
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn load_cleanup_activity(
  state: State<'_, AppState>,
  expected_workspace: String,
) -> Result<Option<CleanupReport>, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&expected_workspace).await?;
  repository
    .latest_cleanup_activity()
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn move_stage_history(
  state: State<'_, AppState>,
  expected_workspace: String,
  request: StageHistoryRequest,
) -> Result<StageCommitDryRun, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&expected_workspace).await?;
  repository
    .move_stage_history(request)
    .await
    .map_err(|error| error.to_string())
}
