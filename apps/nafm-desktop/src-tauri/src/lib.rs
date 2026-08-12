mod commands;
mod state;

use nafm_core::{DEFAULT_WORKSPACE_NAME, Repository, RepositoryOptions, WorkspaceManager};

pub fn run() {
  let state = tauri::async_runtime::block_on(async {
    let workspace_manager =
      WorkspaceManager::from_default_root().expect("application data directory should be available");
    workspace_manager
      .ensure_default_workspace(None)
      .await
      .expect("default workspace should initialize");
    let workspace_name = workspace_manager
      .resolve_workspace_name(None)
      .unwrap_or_else(|_| DEFAULT_WORKSPACE_NAME.to_owned());
    let workspace_path = workspace_manager
      .workspace_db_path(&workspace_name)
      .expect("workspace path should resolve");
    let repository = Repository::open(RepositoryOptions {
      cache_path: workspace_path.clone(),
      hash_algorithm: None,
    })
    .await
    .expect("workspace repository should open");

    state::AppState::new(repository, workspace_path.display().to_string())
  });

  tauri::Builder::default()
    .manage(state)
    .invoke_handler(tauri::generate_handler![
      commands::dashboard::load_dashboard,
      commands::dashboard::get_storage_tree,
      commands::scan::start_scan,
      commands::scan::cancel_scan,
      commands::staging::stage_path,
      commands::staging::unstage_path,
      commands::staging::preview_cleanup,
    ])
    .run(tauri::generate_context!())
    .expect("error while running NAFM");
}
