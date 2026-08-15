use std::path::PathBuf;

use chrono::{DateTime, Utc};
use nafm_core::{
  FileContentMatchesPage, Site, SiteFolderKind, StageCommitDryRun, StorageChildrenPage, StorageFileReveal,
  StorageLocation, StorageNode, StorageTree,
};
use serde::Serialize;
use tauri::State;

use crate::state::{AppState, ScanTask, ScanTaskStatus};

#[derive(Serialize)]
pub struct Dashboard {
  workspace_name: String,
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

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ScanState {
  Idle,
  Hashing,
  Cancelling,
  Done,
}

fn site_scan_state(active_tasks: &[ScanTask], site_id: &str, has_completed_scan: bool) -> ScanState {
  let active_status = active_tasks
    .iter()
    .find(|task| task.selector.includes_site(site_id))
    .map(|task| task.status);
  match active_status {
    Some(ScanTaskStatus::Running) => ScanState::Hashing,
    Some(ScanTaskStatus::Cancelling) => ScanState::Cancelling,
    None if has_completed_scan => ScanState::Done,
    None => ScanState::Idle,
  }
}

#[derive(Serialize)]
pub struct StorageTreeResponse {
  site_id: String,
  coverage_target: Option<Site>,
  root: StorageNode,
}

impl From<StorageTree> for StorageTreeResponse {
  fn from(tree: StorageTree) -> Self {
    Self {
      site_id: tree.site.id,
      coverage_target: tree.coverage_target,
      root: tree.root,
    }
  }
}

#[derive(Serialize)]
pub struct StorageLocationResponse {
  site_id: String,
  coverage_target: Option<Site>,
  breadcrumbs: Vec<StorageNode>,
  root: StorageNode,
}

impl From<StorageLocation> for StorageLocationResponse {
  fn from(location: StorageLocation) -> Self {
    Self {
      site_id: location.site.id,
      coverage_target: location.coverage_target,
      breadcrumbs: location.breadcrumbs,
      root: location.root,
    }
  }
}

#[derive(Serialize)]
pub struct StorageFileRevealResponse {
  tree: StorageTreeResponse,
  location: StorageLocationResponse,
  page: StorageChildrenPage,
  selected_file: StorageNode,
}

impl From<StorageFileReveal> for StorageFileRevealResponse {
  fn from(reveal: StorageFileReveal) -> Self {
    let StorageFileReveal {
      tree,
      location,
      page,
      selected_file,
    } = reveal;
    Self {
      tree: StorageTreeResponse::from(tree),
      location: StorageLocationResponse::from(location),
      page,
      selected_file,
    }
  }
}

#[tauri::command]
pub async fn load_dashboard(state: State<'_, AppState>) -> Result<Dashboard, String> {
  let workspace = state.active_workspace().await;
  let overviews = workspace
    .repository
    .site_overviews()
    .await
    .map_err(|error| error.to_string())?;
  let StageCommitDryRun { staged_files, .. } = workspace
    .repository
    .stage_commit_dry_run()
    .await
    .map_err(|error| error.to_string())?;
  let active_tasks = state.scan_tasks.active_tasks().await;
  let sites = overviews
    .into_iter()
    .map(|overview| {
      let primary_folder = overview.folders.first();
      let scan_state = site_scan_state(&active_tasks, &overview.site.id, overview.latest_scan_at.is_some());
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
        scan_state,
        last_scanned_at: overview.latest_scan_at,
        total_files: overview.total_file_count,
        total_bytes: overview.total_bytes,
        duplicate_files: overview.duplicate_file_count,
        duplicate_bytes: overview.duplicate_bytes,
      }
    })
    .collect();

  Ok(Dashboard {
    workspace_name: workspace.name,
    workspace_path: workspace.path.display().to_string(),
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
  let repository = state.repository().await;
  let tree = match target_site_id {
    Some(target_site_id) => {
      repository
        .storage_tree_with_coverage(&site_id, &target_site_id, max_depth, max_children)
        .await
    }
    None => repository.storage_tree(&site_id, max_depth, max_children).await,
  }
  .map_err(|error| error.to_string())?;
  Ok(StorageTreeResponse::from(tree))
}

#[tauri::command]
pub async fn get_storage_location(
  state: State<'_, AppState>,
  site_id: String,
  target_site_id: Option<String>,
  node_id: String,
  max_depth: u32,
  max_children: u32,
) -> Result<StorageLocationResponse, String> {
  let repository = state.repository().await;
  let location = match target_site_id {
    Some(target_site_id) => {
      repository
        .storage_location_with_coverage(&site_id, &target_site_id, &node_id, max_depth, max_children)
        .await
    }
    None => {
      repository
        .storage_location(&site_id, &node_id, max_depth, max_children)
        .await
    }
  }
  .map_err(|error| error.to_string())?;
  Ok(StorageLocationResponse::from(location))
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
  let repository = state.repository().await;
  match target_site_id {
    Some(target_site_id) => {
      repository
        .storage_children_with_coverage(&site_id, &target_site_id, &node_id, offset, limit)
        .await
    }
    None => repository.storage_children(&site_id, &node_id, offset, limit).await,
  }
  .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_file_content_matches(
  state: State<'_, AppState>,
  expected_workspace: String,
  site_id: String,
  path: PathBuf,
  offset: u64,
  limit: u64,
) -> Result<FileContentMatchesPage, String> {
  state
    .repository_for(&expected_workspace)
    .await?
    .file_content_matches(&site_id, &path, offset, limit)
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn get_storage_file_reveal(
  state: State<'_, AppState>,
  expected_workspace: String,
  file_id: String,
  target_site_id: Option<String>,
  max_depth: u32,
  max_children: u32,
  limit: u64,
) -> Result<StorageFileRevealResponse, String> {
  state
    .repository_for(&expected_workspace)
    .await?
    .storage_file_reveal(&file_id, target_site_id.as_deref(), max_depth, max_children, limit)
    .await
    .map(StorageFileRevealResponse::from)
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
  use chrono::Utc;
  use nafm_core::{StorageNodeKind, StorageTree};

  use super::*;
  use crate::state::{ScanSelector, ScanTaskStatus};

  fn scan_task(request_id: u64, selector: ScanSelector, status: ScanTaskStatus) -> ScanTask {
    ScanTask {
      request_id,
      selector,
      status,
      created_at: Utc::now(),
    }
  }

  #[test]
  fn dashboard_maps_cancelling_scan_to_every_affected_site() {
    let tasks = vec![scan_task(
      1,
      ScanSelector {
        site_id: None,
        all: true,
      },
      ScanTaskStatus::Cancelling,
    )];

    assert_eq!(site_scan_state(&tasks, "photos", false), ScanState::Cancelling);
    assert_eq!(site_scan_state(&tasks, "videos", true), ScanState::Cancelling);
  }

  #[test]
  fn dashboard_scan_state_respects_site_scope_and_history() {
    let tasks = vec![scan_task(
      1,
      ScanSelector {
        site_id: Some("photos".to_owned()),
        all: false,
      },
      ScanTaskStatus::Running,
    )];

    assert_eq!(site_scan_state(&tasks, "photos", false), ScanState::Hashing);
    assert_eq!(site_scan_state(&tasks, "videos", true), ScanState::Done);
    assert_eq!(site_scan_state(&tasks, "documents", false), ScanState::Idle);
  }

  #[test]
  fn storage_file_reveal_uses_existing_desktop_tree_and_location_shapes() {
    let site = Site {
      id: "source-site".to_owned(),
      name: "Source".to_owned(),
      added_at: Utc::now(),
    };
    let selected_file = StorageNode {
      id: "selected-file".to_owned(),
      name: "selected.bin".to_owned(),
      path: Some(PathBuf::from("/source/selected.bin")),
      kind: StorageNodeKind::File,
      total_bytes: 8,
      file_count: 1,
      duplicate_bytes: 0,
      duplicate_file_count: 1,
      space_health: Some(50.0),
      space_healthy_file_equivalents: 0.5,
      space_total_files: 1,
      coverage_health: None,
      coverage_covered_files: 0,
      coverage_total_files: 0,
      children: Vec::new(),
    };
    let parent = StorageNode {
      id: "parent".to_owned(),
      name: "source".to_owned(),
      path: Some(PathBuf::from("/source")),
      kind: StorageNodeKind::LocalRoot,
      total_bytes: 8,
      file_count: 1,
      duplicate_bytes: 0,
      duplicate_file_count: 1,
      space_health: Some(50.0),
      space_healthy_file_equivalents: 0.5,
      space_total_files: 1,
      coverage_health: None,
      coverage_covered_files: 0,
      coverage_total_files: 0,
      children: vec![selected_file.clone()],
    };
    let reveal = StorageFileReveal {
      tree: StorageTree {
        site: site.clone(),
        coverage_target: None,
        max_depth: 5,
        max_children: 12,
        root: parent.clone(),
      },
      location: StorageLocation {
        site: site.clone(),
        coverage_target: None,
        max_depth: 5,
        max_children: 12,
        breadcrumbs: vec![parent.clone()],
        root: parent.clone(),
      },
      page: StorageChildrenPage {
        site,
        coverage_target: None,
        parent,
        children: vec![selected_file.clone()],
        total_children: 1,
        offset: 0,
        limit: 6,
      },
      selected_file,
    };

    let json = serde_json::to_value(StorageFileRevealResponse::from(reveal)).unwrap();
    assert_eq!(json["tree"]["site_id"], "source-site");
    assert!(json["tree"].get("site").is_none());
    assert!(json["tree"].get("max_depth").is_none());
    assert!(json["tree"].get("max_children").is_none());
    assert_eq!(json["location"]["site_id"], "source-site");
    assert!(json["location"].get("site").is_none());
    assert!(json["location"].get("max_depth").is_none());
    assert!(json["location"].get("max_children").is_none());
    assert_eq!(json["page"]["limit"], 6);
    assert_eq!(json["selected_file"]["id"], "selected-file");
  }
}
