use std::fs;

use nafm_core::{
  AddSiteFolderRequest, DEFAULT_WORKSPACE_NAME, HiddenPolicy, NafmError, Repository, RepositoryOptions,
  WorkspaceManager,
};

#[tokio::test]
async fn workspace_defaults_to_default_name_without_config() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());

  assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
  assert_eq!(manager.resolve_workspace_name(None).unwrap(), DEFAULT_WORKSPACE_NAME);
}

#[tokio::test]
async fn ensure_default_workspace_creates_default_database() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());

  manager.ensure_default_workspace(None).await.unwrap();

  assert!(manager.workspace_exists(DEFAULT_WORKSPACE_NAME).unwrap());
  let workspaces = manager.list_workspaces().unwrap();
  assert_eq!(workspaces.len(), 1);
  assert_eq!(workspaces[0].name, DEFAULT_WORKSPACE_NAME);
  assert!(workspaces[0].active);
}

#[tokio::test]
async fn workspace_create_with_activate_sets_current_workspace() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());

  manager.create_workspace("alpha", true, None).await.unwrap();

  assert_eq!(manager.current_workspace_name().unwrap(), "alpha");
  assert!(manager.workspace_exists("alpha").unwrap());
}

#[tokio::test]
async fn activating_default_atomically_replaces_and_repairs_malformed_config() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());
  manager.ensure_default_workspace(None).await.unwrap();
  fs::write(manager.config_path(), b"{ invalid json").unwrap();

  manager.activate_workspace(DEFAULT_WORKSPACE_NAME).unwrap();

  assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
  let config = fs::read_to_string(manager.config_path()).unwrap();
  assert_eq!(
    serde_json::from_str::<serde_json::Value>(&config).unwrap()["active_workspace"],
    DEFAULT_WORKSPACE_NAME
  );
  assert!(
    fs::read_dir(temp.path())
      .unwrap()
      .filter_map(|entry| entry.ok())
      .all(|entry| !entry.file_name().to_string_lossy().starts_with(".config."))
  );
}

#[tokio::test]
async fn workspace_create_rejects_duplicates_without_altering_existing_data_or_activation() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());
  manager.create_workspace("alpha", false, None).await.unwrap();
  let alpha = Repository::open(RepositoryOptions {
    cache_path: manager.workspace_db_path("alpha").unwrap(),
    hash_algorithm: None,
  })
  .await
  .unwrap();
  alpha.create_site("keep-me").await.unwrap();

  let error = manager.create_workspace("alpha", true, None).await.unwrap_err();

  assert!(matches!(error, NafmError::WorkspaceAlreadyExists(name) if name == "alpha"));
  assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
  let reopened = Repository::open(RepositoryOptions {
    cache_path: manager.workspace_db_path("alpha").unwrap(),
    hash_algorithm: None,
  })
  .await
  .unwrap();
  assert_eq!(reopened.list_sites().await.unwrap()[0].name, "keep-me");
}

#[tokio::test]
async fn concurrent_default_workspace_creation_is_idempotent() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());
  let first = manager.clone();
  let second = manager.clone();

  let (first_result, second_result) = tokio::join!(
    first.ensure_default_workspace(None),
    second.ensure_default_workspace(None),
  );

  first_result.unwrap();
  second_result.unwrap();
  assert_eq!(manager.list_workspaces().unwrap().len(), 1);
  Repository::open(RepositoryOptions {
    cache_path: manager.workspace_db_path(DEFAULT_WORKSPACE_NAME).unwrap(),
    hash_algorithm: None,
  })
  .await
  .unwrap();
}

#[tokio::test]
async fn explicit_workspace_overrides_active_workspace() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());

  manager.create_workspace("alpha", true, None).await.unwrap();
  manager.create_workspace("beta", false, None).await.unwrap();

  assert_eq!(manager.resolve_workspace_name(Some("beta")).unwrap(), "beta");
  assert_eq!(manager.resolve_workspace_name(None).unwrap(), "alpha");
}

#[tokio::test]
async fn activate_requires_existing_workspace() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());

  assert!(manager.activate_workspace("missing").is_err());
}

#[tokio::test]
async fn list_workspaces_marks_active_workspace() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());

  manager.create_workspace("alpha", false, None).await.unwrap();
  manager.create_workspace("beta", true, None).await.unwrap();

  let workspaces = manager.list_workspaces().unwrap();
  assert_eq!(workspaces.len(), 2);
  assert!(
    workspaces
      .iter()
      .any(|workspace| workspace.name == "beta" && workspace.active)
  );
  assert!(
    workspaces
      .iter()
      .any(|workspace| workspace.name == "alpha" && !workspace.active)
  );
}

#[tokio::test]
async fn repositories_are_isolated_per_workspace() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());
  let data_root = tempfile::tempdir().unwrap();
  let docs = data_root.path().join("docs");
  fs::create_dir(&docs).unwrap();
  fs::write(docs.join("a.txt"), "same").unwrap();
  fs::write(docs.join("b.txt"), "same").unwrap();

  manager.create_workspace("alpha", false, None).await.unwrap();
  manager.create_workspace("beta", false, None).await.unwrap();

  let alpha = Repository::open(RepositoryOptions {
    cache_path: manager.workspace_db_path("alpha").unwrap(),
    hash_algorithm: None,
  })
  .await
  .unwrap();
  alpha.create_site("docs").await.unwrap();
  alpha
    .add_site_folder(
      "docs",
      AddSiteFolderRequest {
        path: docs.clone(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  alpha.scan_site("docs").await.unwrap();
  assert_eq!(alpha.find_duplicates(Some("docs")).await.unwrap().len(), 1);

  let beta = Repository::open(RepositoryOptions {
    cache_path: manager.workspace_db_path("beta").unwrap(),
    hash_algorithm: None,
  })
  .await
  .unwrap();
  assert!(beta.list_sites().await.unwrap().is_empty());
}
