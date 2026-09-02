use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, path::BaseDirectory};

use super::management::{ManagementMutationResult, ensure_scans_idle, mutation_result};
use crate::state::AppState;

#[derive(Deserialize)]
pub struct InstallAgentRequest {
  workspace_name: String,
  machine_id: String,
  request_id: String,
}

#[derive(Clone, Serialize)]
struct InstallAgentProgress {
  request_id: String,
  machine_id: String,
  message: String,
}

#[tauri::command]
pub async fn install_remote_agent(
  app: AppHandle,
  state: State<'_, AppState>,
  request: InstallAgentRequest,
) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  ensure_scans_idle(&state).await?;
  let repository = state.repository_for(&request.workspace_name).await?;
  let directory = if cfg!(debug_assertions) {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/agents")
  } else {
    app
      .path()
      .resolve("agents", BaseDirectory::Resource)
      .map_err(|error| error.to_string())?
  };
  let progress = |message: &str| {
    let _ = app.emit(
      "agent://install-progress",
      InstallAgentProgress {
        request_id: request.request_id.clone(),
        machine_id: request.machine_id.clone(),
        message: message.into(),
      },
    );
  };
  repository
    .install_remote_agent(&request.machine_id, directory, &progress)
    .await
    .map_err(|error| error.to_string())?;
  progress("Installed and verified");
  Ok(mutation_result(&state).await)
}
