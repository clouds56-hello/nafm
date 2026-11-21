use crate::state::AppState;
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
pub struct FolderSimilarityRequest {
  workspace_name: String,
  site_id: String,
  node_id: String,
  offset: u64,
  limit: u64,
}

#[tauri::command]
pub async fn find_similar_folders(
  state: State<'_, AppState>,
  request: FolderSimilarityRequest,
) -> Result<nafm_core::FolderSimilarityPage, String> {
  state
    .repository_for(&request.workspace_name)
    .await?
    .folder_similarity(&request.site_id, &request.node_id, request.offset, request.limit)
    .await
    .map_err(|error| error.to_string())
}
