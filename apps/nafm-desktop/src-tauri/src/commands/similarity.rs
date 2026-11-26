use crate::state::AppState;
use nafm_core::FolderSimilarityAnchor;
use serde::Deserialize;
use tauri::State;

#[derive(Deserialize)]
pub struct FolderSimilarityRequest {
  workspace_name: String,
  site_id: String,
  node_id: String,
  offset: u64,
  limit: u64,
  anchor: Option<FolderSimilarityAnchor>,
}

#[tauri::command]
pub async fn find_similar_folders(
  state: State<'_, AppState>,
  request: FolderSimilarityRequest,
) -> Result<nafm_core::FolderSimilarityPage, String> {
  state
    .repository_for(&request.workspace_name)
    .await?
    .folder_similarity_with_anchor(
      &request.site_id,
      &request.node_id,
      request.offset,
      request.limit,
      request.anchor.as_ref(),
    )
    .await
    .map_err(|error| error.to_string())
}
