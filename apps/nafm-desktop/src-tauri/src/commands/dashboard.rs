use std::path::PathBuf;

use chrono::{DateTime, Utc};
use nafm_core::{
  FileContentMatchesPage, ScanPhase, Site, SiteFolderKind, SiteHashStatus, StageCommitDryRun, StorageChildrenPage,
  StorageFileReveal, StorageLocation, StorageNode, StorageTree, StorageViewSnapshot,
};
use serde::Serialize;
use tauri::State;

use crate::state::{AppState, ScanTask, ScanTaskSiteStatus, ScanTaskStatus};

#[derive(Serialize)]
pub struct Dashboard {
  workspace_name: String,
  workspace_path: String,
  sites: Vec<SiteOverview>,
  active_tasks: Vec<ScanTask>,
  staged: Vec<nafm_core::DuplicateFile>,
  staged_hashes_pending: u64,
  staged_cleanup_ready: bool,
  staged_warnings: Vec<nafm_core::StageWarning>,
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
  hash_status: SiteHashStatus,
  latest_inventory_at: Option<DateTime<Utc>>,
  last_scanned_at: Option<DateTime<Utc>>,
  total_files: u64,
  verified_file_count: u64,
  pending_hash_count: u64,
  total_bytes: u64,
  verified_bytes: u64,
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
  Queued,
  Discovering,
  PublishingMetadata,
  Hashing,
  Finalizing,
  Cancelling,
  Done,
}

fn site_scan_state(active_tasks: &[ScanTask], site_id: &str, hash_status: SiteHashStatus) -> ScanState {
  let active_task = active_tasks.iter().find(|task| task.selector.includes_site(site_id));
  let Some(task) = active_task else {
    return inactive_site_scan_state(hash_status);
  };
  let site_state = task.site_states.iter().find(|state| state.site_id == site_id);
  if task.status == ScanTaskStatus::Cancelling
    && site_state.is_none_or(|state| state.status != ScanTaskSiteStatus::Completed)
  {
    return ScanState::Cancelling;
  }
  let Some(site_state) = site_state else {
    return ScanState::Queued;
  };
  match site_state.status {
    ScanTaskSiteStatus::Queued => ScanState::Queued,
    ScanTaskSiteStatus::Running => match site_state.phase {
      None => ScanState::Queued,
      Some(ScanPhase::Discovering) => ScanState::Discovering,
      Some(ScanPhase::PublishingMetadata) => ScanState::PublishingMetadata,
      Some(ScanPhase::Hashing) => ScanState::Hashing,
      Some(ScanPhase::Finalizing) => ScanState::Finalizing,
    },
    ScanTaskSiteStatus::Completed => inactive_site_scan_state(hash_status),
  }
}

fn inactive_site_scan_state(hash_status: SiteHashStatus) -> ScanState {
  match hash_status {
    SiteHashStatus::Ready => ScanState::Done,
    SiteHashStatus::Unscanned | SiteHashStatus::Pending => ScanState::Idle,
  }
}

fn site_overview_response(overview: nafm_core::SiteOverview, active_tasks: &[ScanTask]) -> SiteOverview {
  let primary_folder = overview.folders.first();
  let scan_state = site_scan_state(active_tasks, &overview.site.id, overview.hash_status);
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
    hash_status: overview.hash_status,
    latest_inventory_at: overview.latest_inventory_at,
    last_scanned_at: overview.latest_scan_at,
    total_files: overview.total_file_count,
    verified_file_count: overview.verified_file_count,
    pending_hash_count: overview.pending_hash_count,
    total_bytes: overview.total_bytes,
    verified_bytes: overview.verified_bytes,
    duplicate_files: overview.duplicate_file_count,
    duplicate_bytes: overview.duplicate_bytes,
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

#[derive(Serialize)]
pub struct StorageViewSnapshotResponse {
  tree: StorageTreeResponse,
  location: StorageLocationResponse,
  page: StorageChildrenPage,
}

impl From<StorageViewSnapshot> for StorageViewSnapshotResponse {
  fn from(snapshot: StorageViewSnapshot) -> Self {
    let StorageViewSnapshot { tree, location, page } = snapshot;
    Self {
      tree: StorageTreeResponse::from(tree),
      location: StorageLocationResponse::from(location),
      page,
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
  let StageCommitDryRun {
    staged_files,
    hashes_pending: staged_hashes_pending,
    cleanup_ready: staged_cleanup_ready,
    warnings: staged_warnings,
    ..
  } = workspace
    .repository
    .stage_commit_dry_run()
    .await
    .map_err(|error| error.to_string())?;
  let active_tasks = state.scan_tasks.active_tasks();
  let sites = overviews
    .into_iter()
    .map(|overview| site_overview_response(overview, &active_tasks))
    .collect();

  Ok(Dashboard {
    workspace_name: workspace.name,
    workspace_path: workspace.path.display().to_string(),
    sites,
    active_tasks,
    staged: staged_files,
    staged_hashes_pending,
    staged_cleanup_ready,
    staged_warnings,
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
#[allow(clippy::too_many_arguments)]
pub async fn get_storage_view_snapshot(
  state: State<'_, AppState>,
  expected_workspace: String,
  site_id: String,
  target_site_id: Option<String>,
  node_id: String,
  offset: u64,
  max_depth: u32,
  max_children: u32,
  limit: u64,
) -> Result<StorageViewSnapshotResponse, String> {
  let repository = state.repository_for(&expected_workspace).await?;
  let snapshot = match target_site_id {
    Some(target_site_id) => {
      repository
        .storage_view_snapshot_with_coverage(
          &site_id,
          &target_site_id,
          &node_id,
          offset,
          max_depth,
          max_children,
          limit,
        )
        .await
    }
    None => {
      repository
        .storage_view_snapshot(&site_id, &node_id, offset, max_depth, max_children, limit)
        .await
    }
  }
  .map_err(|error| error.to_string())?;
  Ok(StorageViewSnapshotResponse::from(snapshot))
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
  use crate::state::{ScanSelector, ScanTaskSiteState, ScanTaskSiteStatus, ScanTaskStatus};

  fn scan_task(
    request_id: u64,
    selector: ScanSelector,
    status: ScanTaskStatus,
    site_states: Vec<ScanTaskSiteState>,
  ) -> ScanTask {
    ScanTask {
      request_id,
      selector,
      status,
      created_at: Utc::now(),
      site_states,
    }
  }

  fn site_state(site_id: &str, status: ScanTaskSiteStatus, phase: Option<ScanPhase>) -> ScanTaskSiteState {
    ScanTaskSiteState {
      site_id: site_id.to_owned(),
      status,
      phase,
      processed_files: 0,
      total_files: None,
      hashed_files: 0,
      reused_files: 0,
      hashes_pending: 0,
      current_path: None,
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
      vec![
        site_state("photos", ScanTaskSiteStatus::Completed, Some(ScanPhase::Finalizing)),
        site_state("videos", ScanTaskSiteStatus::Running, Some(ScanPhase::Hashing)),
      ],
    )];

    assert_eq!(
      site_scan_state(&tasks, "photos", SiteHashStatus::Ready),
      ScanState::Done
    );
    assert_eq!(
      site_scan_state(&tasks, "videos", SiteHashStatus::Pending),
      ScanState::Cancelling
    );
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
      vec![site_state(
        "photos",
        ScanTaskSiteStatus::Running,
        Some(ScanPhase::PublishingMetadata),
      )],
    )];

    assert_eq!(
      site_scan_state(&tasks, "photos", SiteHashStatus::Pending),
      ScanState::PublishingMetadata
    );
    assert_eq!(
      site_scan_state(&tasks, "videos", SiteHashStatus::Ready),
      ScanState::Done
    );
    assert_eq!(
      site_scan_state(&tasks, "documents", SiteHashStatus::Unscanned),
      ScanState::Idle
    );
  }

  #[test]
  fn dashboard_site_overview_maps_inventory_and_verified_bytes() {
    let inventory_at = Utc::now();
    let response = site_overview_response(
      nafm_core::SiteOverview {
        site: Site {
          id: "photos".to_owned(),
          name: "Photos".to_owned(),
          added_at: inventory_at,
        },
        folders: Vec::new(),
        total_file_count: 12,
        verified_file_count: 7,
        pending_hash_count: 5,
        total_bytes: 128,
        verified_bytes: 96,
        duplicate_file_count: 0,
        duplicate_bytes: 0,
        hash_status: SiteHashStatus::Pending,
        latest_inventory_at: Some(inventory_at),
        latest_scan_at: None,
      },
      &[],
    );
    let json = serde_json::to_value(response).unwrap();

    assert_eq!(json["total_bytes"], 128);
    assert_eq!(json["verified_bytes"], 96);
    assert_eq!(json["scan_state"], "idle");
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
      verified_bytes: 6,
      file_count: 1,
      verified_file_count: 1,
      pending_hash_count: 0,
      duplicate_bytes: 0,
      duplicate_file_count: 1,
      space_health: Some(50.0),
      estimated_space_health: Some(62.5),
      space_healthy_file_equivalents: 0.5,
      space_total_files: 1,
      coverage_health: None,
      estimated_coverage_health: Some(75.0),
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
      verified_bytes: 6,
      file_count: 1,
      verified_file_count: 1,
      pending_hash_count: 0,
      duplicate_bytes: 0,
      duplicate_file_count: 1,
      space_health: Some(50.0),
      estimated_space_health: Some(62.5),
      space_healthy_file_equivalents: 0.5,
      space_total_files: 1,
      coverage_health: None,
      estimated_coverage_health: Some(75.0),
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

    let snapshot_json = serde_json::to_value(StorageViewSnapshotResponse::from(StorageViewSnapshot {
      tree: reveal.tree.clone(),
      location: reveal.location.clone(),
      page: reveal.page.clone(),
    }))
    .unwrap();
    assert_eq!(snapshot_json["tree"]["site_id"], "source-site");
    assert!(snapshot_json["tree"].get("site").is_none());
    assert_eq!(snapshot_json["location"]["root"]["id"], "parent");
    assert!(snapshot_json["location"].get("max_depth").is_none());
    assert_eq!(snapshot_json["page"]["children"][0]["id"], "selected-file");

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
    assert_eq!(json["selected_file"]["verified_bytes"], 6);
    assert_eq!(json["selected_file"]["estimated_space_health"], 62.5);
    assert_eq!(json["selected_file"]["estimated_coverage_health"], 75.0);
  }
}
