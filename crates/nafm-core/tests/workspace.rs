use std::fs;

use nafm_core::{
  AddSiteFolderRequest, DEFAULT_WORKSPACE_NAME, HiddenPolicy, Repository, RepositoryOptions, WorkspaceManager,
};

#[tokio::test]
async fn workspace_defaults_to_default_name_without_config() {
  let temp = tempfile::tempdir().unwrap();
  let manager = WorkspaceManager::new(temp.path().to_path_buf());

  assert_eq!(manager.current_workspace_name().unwrap(), DEFAULT_WORKSPACE_NAME);
  assert_eq!(manager.resolve_workspace_name(None).unwrap(), DEFAULT_WORKSPACE_NAME);
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
