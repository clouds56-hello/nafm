use std::path::PathBuf;

use nafm_core::{StageAddReport, StageCommitDryRun, StageRemoveReport};
use tauri::State;

use crate::state::AppState;

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
pub async fn preview_cleanup(state: State<'_, AppState>) -> Result<StageCommitDryRun, String> {
  let repository = state.repository().await;
  repository
    .stage_commit_dry_run()
    .await
    .map_err(|error| error.to_string())
}
