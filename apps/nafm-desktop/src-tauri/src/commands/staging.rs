use std::path::PathBuf;

use nafm_core::{StageAddReport, StageCommitDryRun, StageRemoveReport};
use tauri::State;

use crate::state::AppState;

#[tauri::command]
pub async fn stage_path(state: State<'_, AppState>, path: String) -> Result<StageAddReport, String> {
  state
    .repository
    .stage_add_path(&PathBuf::from(path))
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn unstage_path(state: State<'_, AppState>, path: String) -> Result<StageRemoveReport, String> {
  state
    .repository
    .stage_remove_path(&PathBuf::from(path))
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn preview_cleanup(state: State<'_, AppState>) -> Result<StageCommitDryRun, String> {
  state
    .repository
    .stage_commit_dry_run()
    .await
    .map_err(|error| error.to_string())
}
