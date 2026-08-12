use chrono::{DateTime, Utc};
use nafm_core::{Site, SiteFolderKind, StageCommitDryRun, StorageChildrenPage, StorageNode, StorageTree};
use serde::Serialize;
use tauri::State;

use crate::state::{AppState, ScanTask};

#[derive(Serialize)]
pub struct Dashboard {
  workspace_path: String,
  sites: Vec<SiteOverview>,
  active_tasks: Vec<ScanTask>,
  staged: Vec<nafm_core::DuplicateFile>,
  last_updated_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct SiteOverview {
  id: String,
  name: String,
  location: String,
  kind: SiteFolderKind,
  connection_state: ConnectionState,
  scan_state: ScanState,
  last_scanned_at: Option<DateTime<Utc>>,
  total_files: u64,
  total_bytes: u64,
  duplicate_files: u64,
  duplicate_bytes: u64,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ConnectionState {
  Unknown,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum ScanState {
  Idle,
  Hashing,
  Done,
}

#[derive(Serialize)]
pub struct StorageTreeResponse {
  site_id: String,
  coverage_target: Option<Site>,
  root: StorageNode,
}

#[tauri::command]
pub async fn load_dashboard(state: State<'_, AppState>) -> Result<Dashboard, String> {
  let overviews = state
    .repository
    .site_overviews()
    .await
    .map_err(|error| error.to_string())?;
  let StageCommitDryRun { staged_files, .. } = state
    .repository
    .stage_commit_dry_run()
    .await
    .map_err(|error| error.to_string())?;
  let active_tasks = state.scan_tasks.active_tasks().await;
  let sites = overviews
    .into_iter()
    .map(|overview| {
      let primary_folder = overview.folders.first();
      let is_scanning = active_tasks
        .iter()
        .any(|task| task.selector.all || task.selector.site_id.as_deref() == Some(overview.site.id.as_str()));
      SiteOverview {
        id: overview.site.id,
        name: overview.site.name,
        location: primary_folder
          .map(|folder| folder.path.display().to_string())
          .unwrap_or_else(|| "No folder configured".to_owned()),
        kind: primary_folder
          .map(|folder| folder.kind)
          .unwrap_or(SiteFolderKind::Local),
        connection_state: ConnectionState::Unknown,
        scan_state: if is_scanning {
          ScanState::Hashing
        } else if overview.latest_scan_at.is_some() {
          ScanState::Done
        } else {
          ScanState::Idle
        },
        last_scanned_at: overview.latest_scan_at,
        total_files: overview.total_file_count,
        total_bytes: overview.total_bytes,
        duplicate_files: overview.duplicate_file_count,
        duplicate_bytes: overview.duplicate_bytes,
      }
    })
    .collect();

  Ok(Dashboard {
    workspace_path: state.workspace_path.clone(),
    sites,
    active_tasks,
    staged: staged_files,
    last_updated_at: Utc::now(),
  })
}

#[tauri::command]
pub async fn get_storage_tree(
  state: State<'_, AppState>,
  site_id: String,
  target_site_id: Option<String>,
  max_depth: u32,
  max_children: u32,
) -> Result<StorageTreeResponse, String> {
  let tree = match target_site_id {
    Some(target_site_id) => {
      state
        .repository
        .storage_tree_with_coverage(&site_id, &target_site_id, max_depth, max_children)
        .await
    }
    None => state.repository.storage_tree(&site_id, max_depth, max_children).await,
  }
  .map_err(|error| error.to_string())?;
  let StorageTree {
    site,
    coverage_target,
    root,
    ..
  } = tree;

  Ok(StorageTreeResponse {
    site_id: site.id,
    coverage_target,
    root,
  })
}

#[tauri::command]
pub async fn get_storage_children(
  state: State<'_, AppState>,
  site_id: String,
  target_site_id: Option<String>,
  node_id: String,
  offset: u64,
  limit: u64,
) -> Result<StorageChildrenPage, String> {
  match target_site_id {
    Some(target_site_id) => {
      state
        .repository
        .storage_children_with_coverage(&site_id, &target_site_id, &node_id, offset, limit)
        .await
    }
    None => {
      state
        .repository
        .storage_children(&site_id, &node_id, offset, limit)
        .await
    }
  }
  .map_err(|error| error.to_string())
}
