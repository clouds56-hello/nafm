use std::path::PathBuf;

use chrono::{DateTime, Utc};
use nafm_core::{
  AddSiteFolderRequest, HiddenPolicy, Repository, RepositoryOptions, SavedSmbCredential, SiteFolder, SiteFolderKind,
  SiteOverview, SmbLocation, normalize_workspace_name, verify_smb_connection,
};
use serde::Serialize;
use tauri::State;
use zeroize::Zeroizing;

use crate::state::{ActiveWorkspace, AppState};

#[derive(Serialize)]
pub struct ManagementSnapshot {
  active_workspace: WorkspaceSummary,
  workspaces: Vec<WorkspaceSummary>,
  sites: Vec<ManagedSite>,
  connections: Vec<SavedSmbCredential>,
}

#[derive(Clone, Serialize)]
pub struct WorkspaceSummary {
  name: String,
  path: String,
  active: bool,
}

#[derive(Serialize)]
pub struct ManagementMutationResult {
  snapshot: Option<ManagementSnapshot>,
  active_workspace: WorkspaceSummary,
  refresh_error: Option<String>,
}

#[derive(Serialize)]
pub struct ManagedSite {
  id: String,
  name: String,
  added_at: DateTime<Utc>,
  folders: Vec<ManagedSiteFolder>,
  last_scanned_at: Option<DateTime<Utc>>,
  total_files: u64,
  total_bytes: u64,
}

#[derive(Serialize)]
pub struct ManagedSiteFolder {
  id: String,
  site_id: String,
  kind: SiteFolderKind,
  path: String,
  hidden_policy: HiddenPolicy,
  added_at: DateTime<Utc>,
}

#[tauri::command]
pub async fn load_management(state: State<'_, AppState>) -> Result<ManagementSnapshot, String> {
  let _transition = state.transition_gate.lock().await;
  management_snapshot(&state).await
}

#[tauri::command]
pub async fn create_workspace(state: State<'_, AppState>, name: String) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  ensure_scans_idle(&state).await?;

  let name = normalize_workspace_name(&name).map_err(|error| error.to_string())?;
  let workspace_path = state
    .workspace_manager
    .create_workspace(&name, false, None)
    .await
    .map_err(|error| error.to_string())?;
  let repository = match open_workspace_repository(&state, workspace_path.clone()).await {
    Ok(repository) => repository,
    Err(error) => return Err(rollback_created_workspace(&workspace_path, error)),
  };

  if let Err(error) = state.workspace_manager.activate_workspace(&name) {
    drop(repository);
    return Err(rollback_created_workspace(&workspace_path, error.to_string()));
  }
  state
    .replace_active_workspace(ActiveWorkspace {
      name,
      path: workspace_path,
      repository,
    })
    .await;

  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn switch_workspace(state: State<'_, AppState>, name: String) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  ensure_scans_idle(&state).await?;

  let name = normalize_workspace_name(&name).map_err(|error| error.to_string())?;
  let exists = state
    .workspace_manager
    .workspace_exists(&name)
    .map_err(|error| error.to_string())?;
  if !exists {
    return Err(format!("workspace not found: {name}"));
  }

  let workspace_path = state
    .workspace_manager
    .workspace_db_path(&name)
    .map_err(|error| error.to_string())?;
  let repository = open_workspace_repository(&state, workspace_path.clone()).await?;

  state
    .workspace_manager
    .activate_workspace(&name)
    .map_err(|error| error.to_string())?;
  state
    .replace_active_workspace(ActiveWorkspace {
      name,
      path: workspace_path,
      repository,
    })
    .await;

  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn create_site(
  state: State<'_, AppState>,
  workspace_name: String,
  name: String,
  folder_path: Option<String>,
  hidden_policy: Option<HiddenPolicy>,
) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&workspace_name).await?;
  ensure_scans_idle(&state).await?;
  let site = repository.create_site(&name).await.map_err(|error| error.to_string())?;

  if let Some(folder_path) = non_empty(folder_path) {
    let result = repository
      .add_site_folder(
        &site.id,
        AddSiteFolderRequest {
          path: PathBuf::from(folder_path),
          hidden_policy: hidden_policy.unwrap_or(HiddenPolicy::Include),
        },
      )
      .await;
    if let Err(error) = result {
      if let Err(rollback_error) = repository.remove_site(&site.id).await {
        return Err(format!(
          "{error}; additionally failed to roll back site creation: {rollback_error}"
        ));
      }
      return Err(error.to_string());
    }
  }

  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn rename_site(
  state: State<'_, AppState>,
  workspace_name: String,
  site_id: String,
  name: String,
) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&workspace_name).await?;
  ensure_scans_idle(&state).await?;
  repository
    .rename_site(&site_id, &name)
    .await
    .map_err(|error| error.to_string())?;
  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn remove_site(
  state: State<'_, AppState>,
  workspace_name: String,
  site_id: String,
) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&workspace_name).await?;
  ensure_scans_idle(&state).await?;
  repository
    .remove_site(&site_id)
    .await
    .map_err(|error| error.to_string())?;
  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn add_site_folder(
  state: State<'_, AppState>,
  workspace_name: String,
  site_id: String,
  path: String,
  hidden_policy: Option<HiddenPolicy>,
) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&workspace_name).await?;
  ensure_scans_idle(&state).await?;
  repository
    .add_site_folder(
      &site_id,
      AddSiteFolderRequest {
        path: PathBuf::from(path),
        hidden_policy: hidden_policy.unwrap_or(HiddenPolicy::Include),
      },
    )
    .await
    .map_err(|error| error.to_string())?;
  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn remove_site_folder(
  state: State<'_, AppState>,
  workspace_name: String,
  folder_id: String,
) -> Result<ManagementMutationResult, String> {
  let _transition = state.transition_gate.lock().await;
  let repository = state.repository_for(&workspace_name).await?;
  ensure_scans_idle(&state).await?;
  repository
    .remove_site_folder(&folder_id)
    .await
    .map_err(|error| error.to_string())?;
  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn connect_smb(
  state: State<'_, AppState>,
  url: String,
  username: String,
  password: String,
) -> Result<ManagementMutationResult, String> {
  let password = Zeroizing::new(password);
  let location = SmbLocation::parse(&url).map_err(|error| error.to_string())?;
  let _transition = state.transition_gate.lock().await;
  verify_smb_connection(&location, &username, password.as_str())
    .await
    .map_err(|error| error.to_string())?;
  state
    .credential_store
    .save_smb_credential(&location.normalized_url, &username, password.as_str())
    .map_err(|error| error.to_string())?;
  Ok(mutation_result(&state).await)
}

#[tauri::command]
pub async fn match_smb_connection(
  state: State<'_, AppState>,
  url: String,
) -> Result<Option<SavedSmbCredential>, String> {
  let credential = state
    .credential_store
    .load_smb_credential(&url)
    .map_err(|error| error.to_string())?;
  Ok(credential.map(|credential| {
    let password = Zeroizing::new(credential.password);
    let saved = SavedSmbCredential {
      url: credential.url,
      username: credential.username,
    };
    drop(password);
    saved
  }))
}

async fn open_workspace_repository(state: &AppState, workspace_path: PathBuf) -> Result<Repository, String> {
  Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: workspace_path,
      hash_algorithm: None,
    },
    state.credential_store.clone(),
  )
  .await
  .map_err(|error| error.to_string())
}

async fn ensure_scans_idle(state: &AppState) -> Result<(), String> {
  if state.scan_tasks.active_tasks().await.is_empty() {
    Ok(())
  } else {
    Err("site and workspace management is unavailable while scans are running".to_owned())
  }
}

async fn management_snapshot(state: &AppState) -> Result<ManagementSnapshot, String> {
  let active = state.active_workspace().await;
  let workspace_infos = state
    .workspace_manager
    .list_workspaces()
    .map_err(|error| error.to_string())?;
  let workspaces = workspace_infos
    .into_iter()
    .map(|workspace| {
      let path = state
        .workspace_manager
        .workspace_db_path(&workspace.name)
        .map_err(|error| error.to_string())?;
      Ok(WorkspaceSummary {
        active: workspace.name == active.name,
        name: workspace.name,
        path: path.display().to_string(),
      })
    })
    .collect::<Result<Vec<_>, String>>()?;
  let sites = active
    .repository
    .site_overviews()
    .await
    .map_err(|error| error.to_string())?
    .into_iter()
    .map(ManagedSite::from)
    .collect();
  let connections = state
    .credential_store
    .list_smb_credentials()
    .map_err(|error| error.to_string())?;

  Ok(ManagementSnapshot {
    active_workspace: WorkspaceSummary {
      name: active.name,
      path: active.path.display().to_string(),
      active: true,
    },
    workspaces,
    sites,
    connections,
  })
}

async fn mutation_result(state: &AppState) -> ManagementMutationResult {
  let active = state.active_workspace().await;
  let active_workspace = WorkspaceSummary {
    name: active.name,
    path: active.path.display().to_string(),
    active: true,
  };
  match management_snapshot(state).await {
    Ok(snapshot) => ManagementMutationResult {
      snapshot: Some(snapshot),
      active_workspace,
      refresh_error: None,
    },
    Err(error) => ManagementMutationResult {
      snapshot: None,
      active_workspace,
      refresh_error: Some(error),
    },
  }
}

fn rollback_created_workspace(path: &std::path::Path, error: String) -> String {
  match std::fs::remove_file(path) {
    Ok(()) => error,
    Err(rollback_error) if rollback_error.kind() == std::io::ErrorKind::NotFound => error,
    Err(rollback_error) => format!("{error}; additionally failed to roll back workspace creation: {rollback_error}"),
  }
}

fn non_empty(value: Option<String>) -> Option<String> {
  value.and_then(|value| {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
  })
}

impl From<SiteOverview> for ManagedSite {
  fn from(overview: SiteOverview) -> Self {
    Self {
      id: overview.site.id,
      name: overview.site.name,
      added_at: overview.site.added_at,
      folders: overview.folders.into_iter().map(ManagedSiteFolder::from).collect(),
      last_scanned_at: overview.latest_scan_at,
      total_files: overview.total_file_count,
      total_bytes: overview.total_bytes,
    }
  }
}

impl From<SiteFolder> for ManagedSiteFolder {
  fn from(folder: SiteFolder) -> Self {
    Self {
      id: folder.id,
      site_id: folder.site_id,
      kind: folder.kind,
      path: folder.path.display().to_string(),
      hidden_policy: folder.hidden_policy,
      added_at: folder.added_at,
    }
  }
}

#[cfg(test)]
mod tests {
  use super::non_empty;

  #[test]
  fn optional_folder_path_ignores_blank_values() {
    assert_eq!(non_empty(None), None);
    assert_eq!(non_empty(Some("  ".to_owned())), None);
    assert_eq!(
      non_empty(Some("  /media/photos  ".to_owned())),
      Some("/media/photos".to_owned())
    );
  }
}
