mod commands;
mod state;

use nafm_core::{CredentialStore, DEFAULT_WORKSPACE_NAME, Repository, RepositoryOptions, WorkspaceManager};

pub fn run() {
  let state = tauri::async_runtime::block_on(async {
    let workspace_manager =
      WorkspaceManager::from_default_root().expect("application data directory should be available");
    let credential_store = CredentialStore::from_default_root().expect("credential store path should resolve");
    let (workspace_name, workspace_path, repository) = open_startup_workspace(&workspace_manager, &credential_store)
      .await
      .expect("default workspace should initialize and open");

    state::AppState::new(
      workspace_manager,
      credential_store,
      workspace_name,
      workspace_path,
      repository,
    )
  });

  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .manage(state)
    .invoke_handler(tauri::generate_handler![
      commands::dashboard::load_dashboard,
      commands::dashboard::get_storage_tree,
      commands::dashboard::get_storage_location,
      commands::dashboard::get_storage_children,
      commands::dashboard::get_file_content_matches,
      commands::scan::start_scan,
      commands::scan::cancel_scan,
      commands::staging::stage_path,
      commands::staging::unstage_path,
      commands::staging::preview_cleanup,
      commands::management::load_management,
      commands::management::create_workspace,
      commands::management::switch_workspace,
      commands::management::create_site,
      commands::management::rename_site,
      commands::management::remove_site,
      commands::management::add_site_folder,
      commands::management::remove_site_folder,
      commands::management::connect_smb,
      commands::management::match_smb_connection,
    ])
    .run(tauri::generate_context!())
    .expect("error while running NAFM");
}

async fn open_startup_workspace(
  workspace_manager: &WorkspaceManager,
  credential_store: &CredentialStore,
) -> nafm_core::Result<(String, std::path::PathBuf, Repository)> {
  workspace_manager.ensure_default_workspace(None).await?;
  let configured_name = workspace_manager.resolve_workspace_name(None).ok();

  if let Some(name) = configured_name.as_deref() {
    let path = workspace_manager.workspace_db_path(name);
    let exists = workspace_manager.workspace_exists(name);
    if let (Ok(path), Ok(true)) = (path, exists)
      && let Ok(repository) = open_repository(path.clone(), credential_store.clone()).await
    {
      return Ok((name.to_owned(), path, repository));
    }
  }

  let default_path = workspace_manager.workspace_db_path(DEFAULT_WORKSPACE_NAME)?;
  let repository = open_repository(default_path.clone(), credential_store.clone()).await?;
  workspace_manager.activate_workspace(DEFAULT_WORKSPACE_NAME)?;
  Ok((DEFAULT_WORKSPACE_NAME.to_owned(), default_path, repository))
}

async fn open_repository(path: std::path::PathBuf, credential_store: CredentialStore) -> nafm_core::Result<Repository> {
  Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: path,
      hash_algorithm: None,
    },
    credential_store,
  )
  .await
}

#[cfg(test)]
mod tests {
  use super::open_startup_workspace;
  use nafm_core::{CredentialStore, DEFAULT_WORKSPACE_NAME, WorkspaceManager};

  #[tokio::test]
  async fn startup_repairs_a_missing_active_workspace() {
    let root = tempfile::tempdir().unwrap();
    let manager = WorkspaceManager::new(root.path().join("app"));
    let credentials = CredentialStore::new(root.path().join("credentials"));
    manager.ensure_default_workspace(None).await.unwrap();
    let removed_path = manager.create_workspace("removed", true, None).await.unwrap();
    std::fs::remove_file(removed_path).unwrap();

    let (name, _, _) = open_startup_workspace(&manager, &credentials).await.unwrap();

    assert_eq!(name, DEFAULT_WORKSPACE_NAME);
    assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
  }

  #[tokio::test]
  async fn startup_preserves_a_corrupt_active_workspace_and_falls_back() {
    let root = tempfile::tempdir().unwrap();
    let manager = WorkspaceManager::new(root.path().join("app"));
    let credentials = CredentialStore::new(root.path().join("credentials"));
    manager.ensure_default_workspace(None).await.unwrap();
    let corrupt_path = manager.create_workspace("corrupt", true, None).await.unwrap();
    std::fs::write(&corrupt_path, b"not sqlite").unwrap();

    let (name, _, _) = open_startup_workspace(&manager, &credentials).await.unwrap();

    assert_eq!(name, DEFAULT_WORKSPACE_NAME);
    assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
    assert_eq!(std::fs::read(corrupt_path).unwrap(), b"not sqlite");
  }

  #[tokio::test]
  async fn startup_repairs_malformed_workspace_config() {
    let root = tempfile::tempdir().unwrap();
    let manager = WorkspaceManager::new(root.path().join("app"));
    let credentials = CredentialStore::new(root.path().join("credentials"));
    manager.ensure_default_workspace(None).await.unwrap();
    std::fs::write(manager.config_path(), b"{ invalid json").unwrap();

    let (name, _, _) = open_startup_workspace(&manager, &credentials).await.unwrap();

    assert_eq!(name, DEFAULT_WORKSPACE_NAME);
    assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
  }

  #[tokio::test]
  async fn startup_repairs_an_invalid_active_workspace_name() {
    let root = tempfile::tempdir().unwrap();
    let manager = WorkspaceManager::new(root.path().join("app"));
    let credentials = CredentialStore::new(root.path().join("credentials"));
    manager.ensure_default_workspace(None).await.unwrap();
    std::fs::write(manager.config_path(), br#"{"active_workspace":"../outside"}"#).unwrap();

    let (name, _, _) = open_startup_workspace(&manager, &credentials).await.unwrap();

    assert_eq!(name, DEFAULT_WORKSPACE_NAME);
    assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
  }
}
