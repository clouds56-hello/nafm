use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use rusqlite::{Connection, OptionalExtension, params};
use tokio::task::{self, JoinSet};
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

use crate::credentials::{CredentialStore, SmbLocation};
use crate::error::{NafmError, Result};
use crate::hash::{HashAlgorithm, default_hash_algorithm};
use crate::model::{
  AddSiteFolderRequest, DuplicateFile, DuplicateGroup, FileContentMatch, FileContentMatchStatus,
  FileContentMatchesPage, HiddenPolicy, MissingContentGroup, ScanEvent, ScanPhase, ScanProgress, ScanStarted,
  ScanSummary, Site, SiteFolder, SiteFolderKind, SiteHashStatus, SiteOverview, StageAddReport, StageCommitDryRun,
  StageHistoryReport, StageRemoveReport, StageResetReport, StageWarning, StageWarningReason, StorageChildrenPage,
  StorageFileReveal, StorageLocation, StorageNode, StorageNodeKind, StorageTree, StorageViewSnapshot,
};

type ScanProgressCallback = Arc<dyn Fn(&ScanProgress) + Send + Sync>;
type ScanEventCallback = Arc<dyn Fn(&ScanEvent) + Send + Sync>;
type ScanCancellationCallback = Arc<dyn Fn() -> bool + Send + Sync>;

const MAX_STORAGE_CHILDREN_PAGE_SIZE: u64 = 200;
const MAX_FILE_CONTENT_MATCHES_PAGE_SIZE: u64 = 200;

#[derive(Clone, Copy)]
struct StorageViewParameters {
  offset: u64,
  max_depth: u32,
  max_children: u32,
  page_limit: u64,
}

#[derive(Clone)]
pub struct Repository {
  db_path: PathBuf,
  hash_algorithm: Arc<dyn HashAlgorithm>,
  credential_store: CredentialStore,
}

#[derive(Clone)]
pub struct RepositoryOptions {
  pub cache_path: PathBuf,
  pub hash_algorithm: Option<Arc<dyn HashAlgorithm>>,
}

#[derive(Clone, Debug)]
struct FileProbe {
  site_folder_id: String,
  path: PathBuf,
  size_bytes: u64,
  modified_unix_nanos: i64,
  source: FileSource,
}

#[derive(Clone, Debug)]
enum FileSource {
  Local,
  Smb {
    credential_url: String,
    remote_path: String,
  },
}

#[derive(Clone, Debug)]
struct ExistingRecord {
  site_id: String,
  size_bytes: u64,
  modified_unix_nanos: i64,
  content_hash: Option<String>,
  hash_algorithm: String,
  inventory_revision: u64,
  hash_revision: Option<u64>,
}

#[derive(Clone, Debug)]
struct CachedScanRecord {
  content_hash: String,
}

#[derive(Clone, Debug)]
struct StorageFileRecord {
  site_folder_id: String,
  path: PathBuf,
  size_bytes: u64,
  hash_verified: bool,
  content_key: Option<StorageContentKey>,
  source_copy_count: u64,
  covered_by_target: Option<bool>,
  duplicate: bool,
  reclaimable: bool,
}

#[derive(Clone, Debug)]
struct RevealFileRecord {
  id: String,
  site_id: String,
  site_folder_id: String,
  path: PathBuf,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct StorageContentKey {
  hash_algorithm: String,
  content_hash: String,
  size_bytes: u64,
}

#[derive(Clone, Debug)]
struct StorageNodeBuilder {
  id: String,
  name: String,
  path: Option<PathBuf>,
  kind: StorageNodeKind,
  total_bytes: u64,
  file_count: u64,
  verified_file_count: u64,
  pending_hash_count: u64,
  verified_bytes: u64,
  analysis_ready: bool,
  coverage_ready: bool,
  duplicate_bytes: u64,
  duplicate_file_count: u64,
  space_health_weighted_bytes: f64,
  space_healthy_file_equivalents: f64,
  space_total_files: u64,
  coverage_groups: BTreeMap<StorageContentKey, bool>,
  children: BTreeMap<String, StorageNodeBuilder>,
}

impl StorageNodeBuilder {
  fn new(id: String, name: String, path: Option<PathBuf>, kind: StorageNodeKind) -> Self {
    Self {
      id,
      name,
      path,
      kind,
      total_bytes: 0,
      file_count: 0,
      verified_file_count: 0,
      pending_hash_count: 0,
      verified_bytes: 0,
      analysis_ready: true,
      coverage_ready: false,
      duplicate_bytes: 0,
      duplicate_file_count: 0,
      space_health_weighted_bytes: 0.0,
      space_healthy_file_equivalents: 0.0,
      space_total_files: 0,
      coverage_groups: BTreeMap::new(),
      children: BTreeMap::new(),
    }
  }

  fn add_file_metrics(&mut self, file: &StorageFileRecord) {
    self.total_bytes = self.total_bytes.saturating_add(file.size_bytes);
    self.file_count = self.file_count.saturating_add(1);
    self.space_total_files = self.space_total_files.saturating_add(1);
    if file.hash_verified {
      self.verified_file_count = self.verified_file_count.saturating_add(1);
      self.verified_bytes = self.verified_bytes.saturating_add(file.size_bytes);
    } else {
      self.pending_hash_count = self.pending_hash_count.saturating_add(1);
    }
    if file.duplicate {
      self.duplicate_file_count = self.duplicate_file_count.saturating_add(1);
    }
    if file.reclaimable {
      self.duplicate_bytes = self.duplicate_bytes.saturating_add(file.size_bytes);
    }
    if file.source_copy_count > 0 && file.content_key.is_some() {
      let file_health = 100.0 / file.source_copy_count as f64;
      self.space_healthy_file_equivalents += 1.0 / file.source_copy_count as f64;
      if file.size_bytes > 0 {
        self.space_health_weighted_bytes += file.size_bytes as f64 * file_health;
      }
    }
    if let (Some(content_key), Some(covered_by_target)) = (&file.content_key, file.covered_by_target) {
      self
        .coverage_groups
        .entry(content_key.clone())
        .and_modify(|covered| *covered |= covered_by_target)
        .or_insert(covered_by_target);
    }
  }

  fn space_health(&self) -> Option<f64> {
    if !self.analysis_ready || self.pending_hash_count > 0 {
      return None;
    }
    self.estimated_space_health()
  }

  fn estimated_space_health(&self) -> Option<f64> {
    estimated_space_health(
      self.verified_file_count,
      self.total_bytes,
      self.file_count,
      self.space_health_weighted_bytes,
      self.space_healthy_file_equivalents,
    )
  }

  fn coverage_health(&self) -> Option<f64> {
    if !self.coverage_ready || self.pending_hash_count > 0 {
      return None;
    }
    self.estimated_coverage_health()
  }

  fn estimated_coverage_health(&self) -> Option<f64> {
    estimated_coverage_health(
      self.verified_file_count,
      self.total_bytes,
      self.verified_bytes,
      self.pending_hash_count,
      &self.coverage_groups,
    )
  }

  fn coverage_file_counts(&self) -> (u64, u64) {
    (
      self.coverage_groups.values().filter(|covered| **covered).count() as u64,
      self.coverage_groups.len() as u64,
    )
  }

  fn set_analysis_ready(&mut self, analysis_ready: bool, coverage_ready: bool) {
    self.analysis_ready = analysis_ready;
    self.coverage_ready = coverage_ready;
    for child in self.children.values_mut() {
      child.set_analysis_ready(analysis_ready, coverage_ready);
    }
  }
}

fn estimated_space_health(
  verified_file_count: u64,
  total_bytes: u64,
  file_count: u64,
  space_health_weighted_bytes: f64,
  space_healthy_file_equivalents: f64,
) -> Option<f64> {
  if verified_file_count == 0 {
    return None;
  }
  if total_bytes > 0 {
    Some((space_health_weighted_bytes / total_bytes as f64).clamp(0.0, 100.0))
  } else if file_count > 0 {
    Some((space_healthy_file_equivalents * 100.0 / file_count as f64).clamp(0.0, 100.0))
  } else {
    None
  }
}

fn estimated_coverage_health(
  verified_file_count: u64,
  total_bytes: u64,
  verified_bytes: u64,
  pending_hash_count: u64,
  coverage_groups: &BTreeMap<StorageContentKey, bool>,
) -> Option<f64> {
  if verified_file_count == 0 || coverage_groups.is_empty() {
    return None;
  }
  let verified_content_bytes = coverage_groups
    .keys()
    .map(|content_key| u128::from(content_key.size_bytes))
    .sum::<u128>();
  let covered_bytes = coverage_groups
    .iter()
    .filter(|(_, covered)| **covered)
    .map(|(content_key, _)| u128::from(content_key.size_bytes))
    .sum::<u128>();
  let pending_bytes = u128::from(total_bytes.saturating_sub(verified_bytes));
  let estimated_content_bytes = verified_content_bytes.saturating_add(pending_bytes);
  if estimated_content_bytes > 0 {
    return Some((covered_bytes as f64 * 100.0 / estimated_content_bytes as f64).clamp(0.0, 100.0));
  }

  let estimated_content_count = coverage_groups.len() as u128 + u128::from(pending_hash_count);
  (estimated_content_count > 0).then(|| {
    (coverage_groups.values().filter(|covered| **covered).count() as f64 * 100.0 / estimated_content_count as f64)
      .clamp(0.0, 100.0)
  })
}

#[derive(Clone, Debug)]
struct ScanProgressContext {
  site_id: String,
  site_name: String,
  files_reused: u64,
  total_files: u64,
  total_hash_targets: u64,
}

struct ScanExecutionContext<'a> {
  progress_callback: Option<&'a ScanProgressCallback>,
  progress_context: &'a Arc<ScanProgressContext>,
  processed_files: &'a AtomicU64,
  cancellation_callback: Option<&'a ScanCancellationCallback>,
}

struct SiteScanSnapshot<'a> {
  site: &'a Site,
  site_folders: &'a [SiteFolder],
  expected_inventory_revision: u64,
}

struct ScanPreparation {
  inventory_revision: u64,
  hash_targets: Vec<(usize, FileProbe)>,
  files_seen: u64,
  files_hashed: u64,
  files_reused: u64,
  bytes_hashed: u64,
  files_removed: u64,
}

struct InventoryHashState {
  content_hash: Option<String>,
  hash_revision: Option<u64>,
}

#[derive(Clone, Debug)]
struct StagedFileRecord {
  file: DuplicateFile,
}

#[derive(Clone, Copy, Debug)]
enum StageMutationKind {
  Add,
  Remove,
  Reset,
}

impl StageMutationKind {
  fn as_str(self) -> &'static str {
    match self {
      StageMutationKind::Add => "add",
      StageMutationKind::Remove => "remove",
      StageMutationKind::Reset => "reset",
    }
  }
}

impl Repository {
  pub async fn open(options: RepositoryOptions) -> Result<Self> {
    Self::open_with_credential_store(options, CredentialStore::from_default_root()?).await
  }

  pub async fn open_with_credential_store(
    options: RepositoryOptions,
    credential_store: CredentialStore,
  ) -> Result<Self> {
    let repo = Self {
      db_path: options.cache_path,
      hash_algorithm: options.hash_algorithm.unwrap_or_else(default_hash_algorithm),
      credential_store,
    };
    repo.initialize().await?;
    Ok(repo)
  }

  pub fn db_path(&self) -> &Path {
    &self.db_path
  }

  pub fn hash_algorithm_name(&self) -> &str {
    self.hash_algorithm.name()
  }

  pub async fn create_site(&self, name: &str) -> Result<Site> {
    let db_path = self.db_path.clone();
    let name = name.trim().to_owned();
    task::spawn_blocking(move || {
      if name.is_empty() {
        return Err(NafmError::EmptySiteName);
      }

      let conn = open_connection(db_path)?;
      with_immediate_transaction(&conn, || {
        if find_site_by_name(&conn, &name)?.is_some() {
          return Err(NafmError::SiteAlreadyExists(name.clone()));
        }
        let now = Utc::now();
        let site = Site {
          id: Uuid::new_v4().to_string(),
          name,
          added_at: now,
        };
        conn.execute(
          "insert into sites (id, name, added_at) values (?1, ?2, ?3)",
          params![site.id, site.name, site.added_at],
        )?;
        Ok(site)
      })
    })
    .await?
  }

  pub async fn rename_site(&self, site_selector: &str, new_name: &str) -> Result<Site> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let new_name = new_name.trim().to_owned();
    task::spawn_blocking(move || {
      if new_name.is_empty() {
        return Err(NafmError::EmptySiteName);
      }

      let conn = open_connection(db_path)?;
      with_immediate_transaction(&conn, || {
        let mut site =
          find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector.clone()))?;
        if find_site_by_name(&conn, &new_name)?.is_some_and(|existing| existing.id != site.id) {
          return Err(NafmError::SiteAlreadyExists(new_name.clone()));
        }
        conn.execute("update sites set name = ?1 where id = ?2", params![new_name, site.id])?;
        site.name = new_name;
        Ok(site)
      })
    })
    .await?
  }

  pub async fn remove_site(&self, site_selector: &str) -> Result<Site> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_immediate_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector.clone()))?;
        conn.execute("delete from sites where id = ?1", params![site.id])?;
        Ok(site)
      })
    })
    .await?
  }

  pub async fn remove_site_folder(&self, site_folder_id: &str) -> Result<SiteFolder> {
    let db_path = self.db_path.clone();
    let site_folder_id = site_folder_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_immediate_transaction(&conn, || {
        let site_folder = find_site_folder(&conn, &site_folder_id)?
          .ok_or_else(|| NafmError::SiteFolderNotFound(site_folder_id.clone()))?;
        conn.execute("delete from site_folders where id = ?1", params![site_folder.id])?;
        invalidate_site_scan_state(&conn, &site_folder.site_id)?;
        Ok(site_folder)
      })
    })
    .await?
  }

  pub async fn add_site_folder(&self, site_selector: &str, request: AddSiteFolderRequest) -> Result<SiteFolder> {
    let db_path = self.db_path.clone();
    let credential_store = self.credential_store.clone();
    let site_selector = site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector.clone()))?;
      let (kind, path) = resolve_site_folder_location(&request.path, &credential_store)?;
      let now = Utc::now();
      let site_folder = SiteFolder {
        id: Uuid::new_v4().to_string(),
        site_id: site.id,
        kind,
        path,
        hidden_policy: request.hidden_policy,
        added_at: now,
      };
      with_immediate_transaction(&conn, || {
        conn.execute(
          "insert into site_folders (id, site_id, kind, path, hidden_policy, added_at)
           values (?1, ?2, ?3, ?4, ?5, ?6)",
          params![
            site_folder.id,
            site_folder.site_id,
            site_folder_kind_to_db(site_folder.kind),
            site_folder.path.to_string_lossy(),
            hidden_policy_to_db(site_folder.hidden_policy),
            site_folder.added_at
          ],
        )?;
        invalidate_site_scan_state(&conn, &site_folder.site_id)?;
        Ok(site_folder)
      })
    })
    .await?
  }

  pub async fn list_sites(&self) -> Result<Vec<Site>> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      list_sites(&conn)
    })
    .await?
  }

  pub async fn list_site_folders(&self, site_selector: Option<&str>) -> Result<Vec<SiteFolder>> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.map(str::to_owned);
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let site_id = match site_selector {
        Some(selector) => Some(
          find_site(&conn, &selector)?
            .ok_or_else(|| NafmError::SiteNotFound(selector))?
            .id,
        ),
        None => None,
      };
      list_site_folders(&conn, site_id.as_deref())
    })
    .await?
  }

  pub async fn site_overviews(&self) -> Result<Vec<SiteOverview>> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        list_sites(&conn)?
          .into_iter()
          .map(|site| site_overview(&conn, site))
          .collect()
      })
    })
    .await?
  }

  pub async fn site_overview(&self, site_selector: &str) -> Result<SiteOverview> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        site_overview(&conn, site)
      })
    })
    .await?
  }

  pub async fn storage_tree(&self, site_selector: &str, max_depth: u32, max_children: u32) -> Result<StorageTree> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        storage_tree(&conn, site, None, max_depth, max_children)
      })
    })
    .await?
  }

  pub async fn storage_tree_with_coverage(
    &self,
    site_selector: &str,
    target_site_selector: &str,
    max_depth: u32,
    max_children: u32,
  ) -> Result<StorageTree> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let target_site_selector = target_site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        let target_site =
          find_site(&conn, &target_site_selector)?.ok_or_else(|| NafmError::SiteNotFound(target_site_selector))?;
        storage_tree(&conn, site, Some(target_site), max_depth, max_children)
      })
    })
    .await?
  }

  pub async fn storage_location(
    &self,
    site_selector: &str,
    node_id: &str,
    max_depth: u32,
    max_children: u32,
  ) -> Result<StorageLocation> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let node_id = node_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        storage_location(&conn, site, None, &node_id, max_depth, max_children)
      })
    })
    .await?
  }

  pub async fn storage_location_with_coverage(
    &self,
    site_selector: &str,
    target_site_selector: &str,
    node_id: &str,
    max_depth: u32,
    max_children: u32,
  ) -> Result<StorageLocation> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let target_site_selector = target_site_selector.to_owned();
    let node_id = node_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        let target_site =
          find_site(&conn, &target_site_selector)?.ok_or_else(|| NafmError::SiteNotFound(target_site_selector))?;
        storage_location(&conn, site, Some(target_site), &node_id, max_depth, max_children)
      })
    })
    .await?
  }

  pub async fn storage_children(
    &self,
    site_selector: &str,
    node_id: &str,
    offset: u64,
    limit: u64,
  ) -> Result<StorageChildrenPage> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let node_id = node_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        storage_children_page(&conn, site, None, &node_id, offset, limit)
      })
    })
    .await?
  }

  pub async fn storage_children_with_coverage(
    &self,
    site_selector: &str,
    target_site_selector: &str,
    node_id: &str,
    offset: u64,
    limit: u64,
  ) -> Result<StorageChildrenPage> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let target_site_selector = target_site_selector.to_owned();
    let node_id = node_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        let target_site =
          find_site(&conn, &target_site_selector)?.ok_or_else(|| NafmError::SiteNotFound(target_site_selector))?;
        storage_children_page(&conn, site, Some(target_site), &node_id, offset, limit)
      })
    })
    .await?
  }

  pub async fn storage_view_snapshot(
    &self,
    site_selector: &str,
    node_id: &str,
    offset: u64,
    max_depth: u32,
    max_children: u32,
    page_limit: u64,
  ) -> Result<StorageViewSnapshot> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let node_id = node_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        storage_view_snapshot(
          &conn,
          site,
          None,
          &node_id,
          StorageViewParameters {
            offset,
            max_depth,
            max_children,
            page_limit,
          },
        )
      })
    })
    .await?
  }

  #[allow(clippy::too_many_arguments)]
  pub async fn storage_view_snapshot_with_coverage(
    &self,
    site_selector: &str,
    target_site_selector: &str,
    node_id: &str,
    offset: u64,
    max_depth: u32,
    max_children: u32,
    page_limit: u64,
  ) -> Result<StorageViewSnapshot> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let target_site_selector = target_site_selector.to_owned();
    let node_id = node_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
        let target_site =
          find_site(&conn, &target_site_selector)?.ok_or_else(|| NafmError::SiteNotFound(target_site_selector))?;
        storage_view_snapshot(
          &conn,
          site,
          Some(target_site),
          &node_id,
          StorageViewParameters {
            offset,
            max_depth,
            max_children,
            page_limit,
          },
        )
      })
    })
    .await?
  }

  pub async fn storage_file_reveal(
    &self,
    file_id: &str,
    target_site_selector: Option<&str>,
    max_depth: u32,
    max_children: u32,
    page_limit: u64,
  ) -> Result<StorageFileReveal> {
    let db_path = self.db_path.clone();
    let file_id = file_id.to_owned();
    let target_site_selector = target_site_selector.map(str::to_owned);
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      with_deferred_transaction(&conn, || {
        let file =
          reveal_file_record(&conn, &file_id)?.ok_or_else(|| NafmError::TrackedFileNotFound(file_id.clone()))?;
        let site = find_site(&conn, &file.site_id)?.ok_or_else(|| NafmError::SiteNotFound(file.site_id.clone()))?;
        let coverage_target = match target_site_selector {
          Some(selector) => Some(find_site(&conn, &selector)?.ok_or_else(|| NafmError::SiteNotFound(selector))?),
          None => None,
        };
        storage_file_reveal(&conn, site, coverage_target, &file, max_depth, max_children, page_limit)
      })
    })
    .await?
  }

  pub async fn file_counts_by_parent_folder(&self, site_selector: Option<&str>) -> Result<BTreeMap<String, u64>> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.map(str::to_owned);
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let site_id = match site_selector {
        Some(selector) => Some(
          find_site(&conn, &selector)?
            .ok_or_else(|| NafmError::SiteNotFound(selector))?
            .id,
        ),
        None => None,
      };
      file_counts_by_parent_folder(&conn, site_id.as_deref())
    })
    .await?
  }

  pub async fn scan_all(&self) -> Result<Vec<ScanSummary>> {
    self.scan_all_with_progress(None).await
  }

  pub async fn scan_all_with_progress(
    &self,
    progress_callback: Option<ScanProgressCallback>,
  ) -> Result<Vec<ScanSummary>> {
    let event_callback = progress_callback.map(|progress_callback| {
      Arc::new(move |event: &ScanEvent| {
        if let ScanEvent::Progress(progress) = event {
          progress_callback(progress);
        }
      }) as ScanEventCallback
    });
    self.scan_all_with_events(event_callback).await
  }

  pub async fn scan_all_with_events(&self, event_callback: Option<ScanEventCallback>) -> Result<Vec<ScanSummary>> {
    self.scan_all_with_events_and_cancellation(event_callback, None).await
  }

  pub async fn scan_all_with_events_and_cancellation(
    &self,
    event_callback: Option<ScanEventCallback>,
    cancellation_callback: Option<ScanCancellationCallback>,
  ) -> Result<Vec<ScanSummary>> {
    let sites = self.list_sites().await?;
    let mut tasks = JoinSet::new();
    for (index, site) in sites.into_iter().enumerate() {
      if let Some(event_callback) = &event_callback {
        event_callback(&ScanEvent::Started(ScanStarted {
          site_id: site.id.clone(),
          site_name: site.name.clone(),
        }));
      }
      let repo = self.clone();
      let cancellation_callback = cancellation_callback.clone();
      let progress_callback = event_callback.clone().map(|event_callback| {
        Arc::new(move |progress: &ScanProgress| {
          event_callback(&ScanEvent::Progress(progress.clone()));
        }) as ScanProgressCallback
      });
      tasks.spawn(async move {
        (
          index,
          repo
            .scan_site_with_progress_and_cancellation(&site.id, progress_callback, cancellation_callback)
            .await,
        )
      });
    }

    let mut summaries = vec![None; tasks.len()];
    let mut first_repository_error = None;
    let mut first_cancellation = None;
    let mut first_join_error = None;
    // Dropping the JoinSet would abort these async wrappers without stopping any
    // spawn_blocking scan they are awaiting, so drain every site before returning.
    while let Some(result) = tasks.join_next().await {
      match result {
        Ok((index, Ok(summary))) => {
          if let Some(event_callback) = &event_callback {
            event_callback(&ScanEvent::Summary(summary.clone()));
          }
          summaries[index] = Some(summary);
        }
        Ok((index, Err(error))) => {
          let first_error = if matches!(error, NafmError::ScanCancelled) {
            &mut first_cancellation
          } else {
            &mut first_repository_error
          };
          if first_error.as_ref().is_none_or(|(first_index, _)| index < *first_index) {
            *first_error = Some((index, error));
          }
        }
        Err(error) => {
          first_join_error.get_or_insert(error);
        }
      }
    }

    // A sibling's cooperative cancellation must not mask the failure that
    // triggered it. Within each class, site order makes the result deterministic.
    if let Some((_, error)) = first_repository_error {
      return Err(error);
    }
    if let Some(error) = first_join_error {
      return Err(error.into());
    }
    if let Some((_, error)) = first_cancellation {
      return Err(error);
    }

    Ok(
      summaries
        .into_iter()
        .map(|summary| summary.expect("scan task should fill summary slot"))
        .collect(),
    )
  }

  pub async fn scan_site(&self, selector: &str) -> Result<ScanSummary> {
    self.scan_site_with_progress(selector, None).await
  }

  pub async fn scan_site_with_progress(
    &self,
    selector: &str,
    progress_callback: Option<ScanProgressCallback>,
  ) -> Result<ScanSummary> {
    self
      .scan_site_with_progress_and_cancellation(selector, progress_callback, None)
      .await
  }

  pub async fn scan_site_with_progress_and_cancellation(
    &self,
    selector: &str,
    progress_callback: Option<ScanProgressCallback>,
    cancellation_callback: Option<ScanCancellationCallback>,
  ) -> Result<ScanSummary> {
    let db_path = self.db_path.clone();
    let selector = selector.to_owned();
    let lookup_db_path = db_path.clone();
    let (site, site_folders, expected_inventory_revision) = task::spawn_blocking(move || {
      let conn = open_connection(&lookup_db_path)?;
      let site = find_site(&conn, &selector)?.ok_or_else(|| NafmError::SiteNotFound(selector.clone()))?;
      let site_folders = list_site_folders(&conn, Some(&site.id))?;
      let expected_inventory_revision = conn
        .query_row(
          "select inventory_revision from site_scan_state where site_id = ?1",
          params![site.id],
          |row| row.get::<_, u64>(0),
        )
        .optional()?
        .unwrap_or(0);
      Ok::<_, NafmError>((site, site_folders, expected_inventory_revision))
    })
    .await??;

    if site_folders.iter().any(|folder| folder.kind == SiteFolderKind::Smb) {
      return self
        .scan_site_with_smb(
          &site,
          &site_folders,
          expected_inventory_revision,
          progress_callback,
          cancellation_callback,
        )
        .await;
    }

    let hash_algorithm = self.hash_algorithm.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(&db_path)?;
      scan_site_blocking(
        &conn,
        &db_path,
        &SiteScanSnapshot {
          site: &site,
          site_folders: &site_folders,
          expected_inventory_revision,
        },
        hash_algorithm.as_ref(),
        progress_callback.as_ref(),
        cancellation_callback.as_ref(),
      )
    })
    .await?
  }

  async fn scan_site_with_smb(
    &self,
    site: &Site,
    site_folders: &[SiteFolder],
    expected_inventory_revision: u64,
    progress_callback: Option<ScanProgressCallback>,
    cancellation_callback: Option<ScanCancellationCallback>,
  ) -> Result<ScanSummary> {
    check_scan_cancelled(cancellation_callback.as_ref())?;
    report_scan_phase(
      progress_callback.as_ref(),
      site,
      ScanPhase::Discovering,
      None,
      0,
      None,
      0,
      0,
      0,
    );
    let mut files_by_path = BTreeMap::new();
    let local_folders = site_folders
      .iter()
      .filter(|folder| folder.kind == SiteFolderKind::Local)
      .cloned()
      .collect::<Vec<_>>();
    if !local_folders.is_empty() {
      let local_cancellation_callback = cancellation_callback.clone();
      let local_files =
        task::spawn_blocking(move || discover_site_files(&local_folders, local_cancellation_callback.as_ref(), None))
          .await??;
      check_scan_cancelled(cancellation_callback.as_ref())?;
      for file in local_files {
        files_by_path.insert(file.path.clone(), file);
        let discovered_files = files_by_path.len() as u64;
        if should_report_discovery(discovered_files) {
          report_discovery_progress(progress_callback.as_ref(), site, discovered_files, None);
        }
      }
    }

    let mut smb_folders = site_folders
      .iter()
      .filter(|folder| folder.kind == SiteFolderKind::Smb)
      .cloned()
      .collect::<Vec<_>>();
    smb_folders.sort_by_key(|folder| std::cmp::Reverse(folder.path.components().count()));
    let discovered_smb_files = AtomicU64::new(files_by_path.len() as u64);
    for site_folder in &smb_folders {
      check_scan_cancelled(cancellation_callback.as_ref())?;
      for file in discover_smb_files(
        site_folder,
        &self.credential_store,
        cancellation_callback.as_ref(),
        Some((site, progress_callback.as_ref(), &discovered_smb_files)),
      )
      .await?
      {
        files_by_path.entry(file.path.clone()).or_insert(file);
      }
    }

    check_scan_cancelled(cancellation_callback.as_ref())?;
    let discovered_count = files_by_path.len() as u64;
    report_scan_phase(
      progress_callback.as_ref(),
      site,
      ScanPhase::PublishingMetadata,
      None,
      0,
      Some(discovered_count),
      0,
      0,
      0,
    );
    check_scan_cancelled(cancellation_callback.as_ref())?;
    let db_path = self.db_path.clone();
    let preparation_db_path = db_path.clone();
    let preparation_site = site.clone();
    let preparation_site_folders = site_folders.to_vec();
    let hash_algorithm_name = self.hash_algorithm.name().to_owned();
    let scan_time = Utc::now();
    let preparation = task::spawn_blocking(move || {
      let conn = open_connection(preparation_db_path)?;
      publish_inventory_atomically(
        &conn,
        &preparation_site,
        &preparation_site_folders,
        expected_inventory_revision,
        files_by_path.into_values().collect(),
        &hash_algorithm_name,
        scan_time,
      )
    })
    .await??;

    let progress_context = Arc::new(ScanProgressContext {
      site_id: site.id.clone(),
      site_name: site.name.clone(),
      files_reused: preparation.files_reused,
      total_files: preparation.files_seen,
      total_hash_targets: preparation.files_hashed,
    });
    let processed_files = Arc::new(AtomicU64::new(0));
    report_scan_phase(
      progress_callback.as_ref(),
      site,
      ScanPhase::Hashing,
      None,
      preparation.files_reused,
      Some(preparation.files_seen),
      0,
      preparation.files_reused,
      preparation.files_hashed,
    );
    if preparation.files_hashed > 0 {
      check_scan_cancelled(cancellation_callback.as_ref())?;
    }
    let local_targets = preparation
      .hash_targets
      .iter()
      .filter(|(_, file)| matches!(file.source, FileSource::Local))
      .cloned()
      .collect::<Vec<_>>();
    if !local_targets.is_empty() {
      let local_db_path = db_path.clone();
      let local_site = site.clone();
      let local_hash_algorithm = self.hash_algorithm.clone();
      let local_progress_callback = progress_callback.clone();
      let local_progress_context = progress_context.clone();
      let local_processed_files = processed_files.clone();
      let local_cancellation_callback = cancellation_callback.clone();
      task::spawn_blocking(move || {
        let execution = ScanExecutionContext {
          progress_callback: local_progress_callback.as_ref(),
          progress_context: &local_progress_context,
          processed_files: &local_processed_files,
          cancellation_callback: local_cancellation_callback.as_ref(),
        };
        hash_files_in_parallel(
          &local_db_path,
          &local_site,
          preparation.inventory_revision,
          &local_targets,
          local_hash_algorithm.as_ref(),
          &execution,
        )
      })
      .await??;
      if preparation
        .hash_targets
        .iter()
        .any(|(_, file)| matches!(file.source, FileSource::Smb { .. }))
      {
        check_scan_cancelled(cancellation_callback.as_ref())?;
      }
    }

    let mut remote_targets = BTreeMap::<String, Vec<(usize, FileProbe)>>::new();
    for (index, file) in &preparation.hash_targets {
      if let FileSource::Smb { credential_url, .. } = &file.source {
        remote_targets
          .entry(credential_url.clone())
          .or_default()
          .push((*index, file.clone()));
      }
    }
    for (credential_url, targets) in remote_targets {
      check_scan_cancelled(cancellation_callback.as_ref())?;
      let credential = self
        .credential_store
        .load_smb_credential(&credential_url)?
        .ok_or_else(|| NafmError::SmbCredentialNotFound(credential_url.clone()))?;
      let location = SmbLocation::parse(&credential.url)?;
      let mut client = smb2::connect(&location.server_address, &credential.username, &credential.password).await?;
      check_scan_cancelled(cancellation_callback.as_ref())?;
      let tree = client.connect_share(&location.share).await?;
      let hash_result = async {
        check_scan_cancelled(cancellation_callback.as_ref())?;
        for (_, file) in targets {
          check_scan_cancelled(cancellation_callback.as_ref())?;
          let FileSource::Smb { remote_path, .. } = &file.source else {
            unreachable!("remote target should have an SMB source");
          };
          let content_hash = hash_smb_file(
            &client,
            &tree,
            remote_path,
            &file,
            self.hash_algorithm.as_ref(),
            cancellation_callback.as_ref(),
          )
          .await?;
          check_scan_cancelled(cancellation_callback.as_ref())?;
          publish_hashed_file_async(
            &db_path,
            &site.id,
            preparation.inventory_revision,
            &file,
            self.hash_algorithm.name(),
            &content_hash,
          )
          .await?;
          report_scan_progress(
            progress_callback.as_ref(),
            &progress_context,
            &file.path,
            &processed_files,
          );
        }
        Ok::<(), NafmError>(())
      }
      .await;
      let _ = client.disconnect_share(&tree).await;
      hash_result?;
    }

    report_scan_phase(
      progress_callback.as_ref(),
      site,
      ScanPhase::Finalizing,
      None,
      preparation.files_seen,
      Some(preparation.files_seen),
      preparation.files_hashed,
      preparation.files_reused,
      0,
    );
    let finalize_db_path = db_path;
    let finalize_site = site.clone();
    let inventory_revision = preparation.inventory_revision;
    let hash_algorithm_name = self.hash_algorithm.name().to_owned();
    let duplicate_groups = task::spawn_blocking(move || {
      let conn = open_connection(finalize_db_path)?;
      finalize_site_scan(
        &conn,
        &finalize_site,
        inventory_revision,
        &hash_algorithm_name,
        Utc::now(),
      )
    })
    .await??;
    let duplicate_files = duplicate_groups.iter().map(|group| group.files.len() as u64).sum();

    Ok(ScanSummary {
      site_id: site.id.clone(),
      site_name: site.name.clone(),
      site_folders: site_folders.len() as u64,
      files_seen: preparation.files_seen,
      files_hashed: preparation.files_hashed,
      files_reused: preparation.files_reused,
      files_pending: 0,
      files_removed: preparation.files_removed,
      bytes_hashed: preparation.bytes_hashed,
      duplicate_groups: duplicate_groups.len() as u64,
      duplicate_files,
    })
  }

  pub async fn find_duplicates(&self, site_selector: Option<&str>) -> Result<Vec<DuplicateGroup>> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.map(str::to_owned);
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let site_id = match site_selector {
        Some(selector) => {
          let site_id = find_site(&conn, &selector)?
            .ok_or_else(|| NafmError::SiteNotFound(selector))?
            .id;
          ensure_site_hash_ready(&conn, &site_id)?;
          Some(site_id)
        }
        None => {
          for site in list_sites(&conn)? {
            if site_has_configured_folders(&conn, &site.id)? {
              ensure_site_hash_ready(&conn, &site.id)?;
            }
          }
          None
        }
      };
      find_duplicates(&conn, site_id.as_deref())
    })
    .await?
  }

  pub async fn file_content_matches(
    &self,
    site_selector: &str,
    path: &Path,
    offset: u64,
    limit: u64,
  ) -> Result<FileContentMatchesPage> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    let path = path.to_path_buf();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      file_content_matches_page(&conn, &site.id, &path, offset, limit)
    })
    .await?
  }

  pub async fn find_missing(
    &self,
    source_site_selector: &str,
    target_site_selector: &str,
  ) -> Result<Vec<MissingContentGroup>> {
    let db_path = self.db_path.clone();
    let source_site_selector = source_site_selector.to_owned();
    let target_site_selector = target_site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let source_site = find_site(&conn, &source_site_selector)?
        .ok_or_else(|| NafmError::SiteNotFound(source_site_selector.clone()))?;
      let target_site = find_site(&conn, &target_site_selector)?
        .ok_or_else(|| NafmError::SiteNotFound(target_site_selector.clone()))?;
      find_missing(&conn, &source_site.id, &target_site.id)
    })
    .await?
  }

  pub async fn stage_add_path(&self, path: &Path) -> Result<StageAddReport> {
    let db_path = self.db_path.clone();
    let path = path.to_path_buf();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let (canonical_path, is_remote) = normalize_user_location(&path)?;
      stage_add_path(&conn, &canonical_path, is_remote)
    })
    .await?
  }

  pub async fn stage_commit_dry_run(&self) -> Result<StageCommitDryRun> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      stage_commit_dry_run(&conn)
    })
    .await?
  }

  pub async fn stage_remove_path(&self, path: &Path) -> Result<StageRemoveReport> {
    let db_path = self.db_path.clone();
    let path = path.to_path_buf();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let (canonical_path, is_remote) = normalize_user_location(&path)?;
      stage_remove_path(&conn, &canonical_path, is_remote)
    })
    .await?
  }

  pub async fn stage_reset(&self) -> Result<StageResetReport> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      stage_reset(&conn)
    })
    .await?
  }

  pub async fn stage_undo(&self) -> Result<StageHistoryReport> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      stage_undo(&conn)
    })
    .await?
  }

  pub async fn stage_redo(&self) -> Result<StageHistoryReport> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      stage_redo(&conn)
    })
    .await?
  }

  async fn initialize(&self) -> Result<()> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent)?;
      } else {
        return Err(NafmError::CachePathHasNoParent(db_path));
      }

      let conn = open_connection(db_path)?;
      conn.pragma_update(None, "journal_mode", "wal")?;
      conn.execute_batch(
        "
        pragma foreign_keys = on;

        create table if not exists sites (
          id text primary key not null,
          name text not null unique,
          added_at text not null
        );

        create table if not exists site_folders (
          id text primary key not null,
          site_id text not null references sites(id) on delete cascade,
          kind text not null default 'local',
          path text not null unique,
          hidden_policy text not null,
          added_at text not null
        );

        create table if not exists file_records (
          id text primary key not null,
          site_id text not null references sites(id) on delete cascade,
          site_folder_id text not null references site_folders(id) on delete cascade,
          path text not null unique,
          size_bytes integer not null,
          modified_unix_nanos integer not null,
          hash_algorithm text not null,
          content_hash text,
          inventory_revision integer not null default 0,
          hash_revision integer,
          last_seen_at text not null
        );

        create table if not exists scan_cache_entries (
          site_id text not null references sites(id) on delete cascade,
          site_folder_id text not null references site_folders(id) on delete cascade,
          path text not null,
          size_bytes integer not null,
          modified_unix_nanos integer not null,
          hash_algorithm text not null,
          content_hash text not null,
          cached_at text not null,
          primary key(site_id, path)
        );

        create table if not exists site_scan_state (
          site_id text primary key not null references sites(id) on delete cascade,
          last_scanned_at text not null,
          inventory_revision integer not null default 0,
          inventory_completed_at text,
          hash_algorithm text,
          hash_completed_at text
        );

        create index if not exists idx_site_folders_site_id on site_folders(site_id);
        create index if not exists idx_file_records_site_id on file_records(site_id);
        create index if not exists idx_file_records_site_folder_id on file_records(site_folder_id);
        create index if not exists idx_file_records_hash on file_records(hash_algorithm, content_hash, size_bytes);
        create index if not exists idx_scan_cache_entries_site_id on scan_cache_entries(site_id);

        create table if not exists stage_entries (
          file_id text primary key not null references file_records(id) on delete cascade,
          added_at text not null
        );

        create table if not exists stage_snapshots (
          id integer primary key autoincrement,
          mutation_kind text not null,
          created_at text not null
        );

        create table if not exists stage_snapshot_files (
          snapshot_id integer not null references stage_snapshots(id) on delete cascade,
          file_id text not null references file_records(id) on delete cascade,
          primary key(snapshot_id, file_id)
        );

        create table if not exists stage_state (
          singleton integer primary key check (singleton = 1),
          current_snapshot_id integer references stage_snapshots(id)
        );
        ",
      )?;
      ensure_site_folder_kind_column(&conn)?;
      migrate_scan_schema(&conn)?;
      backfill_site_scan_state(&conn)?;
      initialize_stage_history(&conn)?;
      Ok(())
    })
    .await?
  }
}

fn open_connection(path: impl AsRef<Path>) -> Result<Connection> {
  let conn = Connection::open(path)?;
  conn.busy_timeout(Duration::from_secs(5))?;
  conn.pragma_update(None, "foreign_keys", "on")?;
  Ok(conn)
}

fn with_immediate_transaction<T>(conn: &Connection, operation: impl FnOnce() -> Result<T>) -> Result<T> {
  conn.execute_batch("begin immediate transaction")?;
  match operation() {
    Ok(value) => {
      conn.execute_batch("commit")?;
      Ok(value)
    }
    Err(error) => {
      let _ = conn.execute_batch("rollback");
      Err(error)
    }
  }
}

fn with_deferred_transaction<T>(conn: &Connection, operation: impl FnOnce() -> Result<T>) -> Result<T> {
  conn.execute_batch("begin deferred transaction")?;
  match operation() {
    Ok(value) => {
      conn.execute_batch("commit")?;
      Ok(value)
    }
    Err(error) => {
      let _ = conn.execute_batch("rollback");
      Err(error)
    }
  }
}

fn invalidate_site_scan_state(conn: &Connection, site_id: &str) -> Result<()> {
  conn.execute(
    "insert into site_scan_state (
       site_id, last_scanned_at, inventory_revision, inventory_completed_at, hash_algorithm, hash_completed_at
     ) values (?1, ?2, 1, null, null, null)
     on conflict(site_id) do update set
       inventory_revision = site_scan_state.inventory_revision + 1,
       inventory_completed_at = null,
       hash_completed_at = null",
    params![site_id, Utc::now()],
  )?;
  Ok(())
}

fn backfill_site_scan_state(conn: &Connection) -> Result<()> {
  conn.execute(
    "insert into site_scan_state (
       site_id, last_scanned_at, inventory_revision, inventory_completed_at, hash_algorithm, hash_completed_at
     )
     select site_id, max(last_seen_at), max(inventory_revision), max(last_seen_at), min(hash_algorithm), max(last_seen_at)
     from file_records
     group by site_id
     on conflict(site_id) do nothing",
    [],
  )?;
  Ok(())
}

fn migrate_scan_schema(conn: &Connection) -> Result<()> {
  let user_version = conn.query_row("pragma user_version", [], |row| row.get::<_, u32>(0))?;
  if user_version >= 1 {
    return Ok(());
  }

  with_immediate_transaction(conn, || {
    let file_columns = table_columns(conn, "file_records")?;
    if !file_columns.contains("inventory_revision") {
      conn.execute(
        "alter table file_records add column inventory_revision integer not null default 0",
        [],
      )?;
    }
    if !file_columns.contains("hash_revision") {
      conn.execute("alter table file_records add column hash_revision integer", [])?;
    }

    let state_columns = table_columns(conn, "site_scan_state")?;
    if !state_columns.contains("inventory_revision") {
      conn.execute(
        "alter table site_scan_state add column inventory_revision integer not null default 0",
        [],
      )?;
    }
    if !state_columns.contains("inventory_completed_at") {
      conn.execute("alter table site_scan_state add column inventory_completed_at text", [])?;
    }
    if !state_columns.contains("hash_algorithm") {
      conn.execute("alter table site_scan_state add column hash_algorithm text", [])?;
    }
    if !state_columns.contains("hash_completed_at") {
      conn.execute("alter table site_scan_state add column hash_completed_at text", [])?;
    }

    conn.execute(
      "update file_records
       set inventory_revision = case when inventory_revision = 0 then 1 else inventory_revision end,
           hash_revision = case
             when content_hash is not null and hash_revision is null then
               case when inventory_revision = 0 then 1 else inventory_revision end
             else hash_revision
           end",
      [],
    )?;
    conn.execute(
      "update site_scan_state
       set inventory_revision = case
             when inventory_revision = 0 then coalesce(
               (select max(file.inventory_revision) from file_records file where file.site_id = site_scan_state.site_id),
               1
             )
             else inventory_revision
           end,
           inventory_completed_at = coalesce(inventory_completed_at, last_scanned_at),
           hash_algorithm = coalesce(
             hash_algorithm,
             (select min(file.hash_algorithm) from file_records file where file.site_id = site_scan_state.site_id)
           ),
           hash_completed_at = coalesce(hash_completed_at, last_scanned_at)",
      [],
    )?;
    conn.execute_batch(
      "create index if not exists idx_file_records_pending_hash
         on file_records(site_id, inventory_revision)
         where content_hash is null or hash_revision is null or hash_revision <> inventory_revision;
       pragma user_version = 1;",
    )?;
    Ok(())
  })
}

fn table_columns(conn: &Connection, table: &str) -> Result<BTreeSet<String>> {
  let mut stmt = conn.prepare(&format!("pragma table_info({table})"))?;
  stmt
    .query_map([], |row| row.get::<_, String>(1))?
    .collect::<std::result::Result<BTreeSet<_>, _>>()
    .map_err(Into::into)
}

fn ensure_site_folder_kind_column(conn: &Connection) -> Result<()> {
  let mut stmt = conn.prepare("pragma table_info(site_folders)")?;
  let columns = stmt
    .query_map([], |row| row.get::<_, String>(1))?
    .collect::<std::result::Result<Vec<_>, _>>()?;
  if !columns.iter().any(|column| column == "kind") {
    conn.execute(
      "alter table site_folders add column kind text not null default 'local'",
      [],
    )?;
  }
  Ok(())
}

fn resolve_site_folder_location(path: &Path, credential_store: &CredentialStore) -> Result<(SiteFolderKind, PathBuf)> {
  let value = path.to_string_lossy();
  if value
    .get(..6)
    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("smb://"))
  {
    let location = SmbLocation::parse(&value)?;
    if credential_store
      .load_smb_credential(&location.normalized_url)?
      .is_none()
    {
      return Err(NafmError::SmbCredentialNotFound(location.normalized_url));
    }
    return Ok((SiteFolderKind::Smb, PathBuf::from(location.normalized_url)));
  }
  if let Some((scheme, _)) = value.split_once("://") {
    return Err(NafmError::UnsupportedLocationScheme(scheme.to_owned()));
  }
  Ok((SiteFolderKind::Local, std::fs::canonicalize(path)?))
}

fn normalize_user_location(path: &Path) -> Result<(PathBuf, bool)> {
  let value = path.to_string_lossy();
  if value
    .get(..6)
    .is_some_and(|prefix| prefix.eq_ignore_ascii_case("smb://"))
  {
    let location = SmbLocation::parse(&value)?;
    return Ok((PathBuf::from(location.normalized_url), true));
  }
  if let Some((scheme, _)) = value.split_once("://") {
    return Err(NafmError::UnsupportedLocationScheme(scheme.to_owned()));
  }
  Ok((std::fs::canonicalize(path)?, false))
}

async fn discover_smb_files(
  site_folder: &SiteFolder,
  credential_store: &CredentialStore,
  cancellation_callback: Option<&ScanCancellationCallback>,
  progress: Option<(&Site, Option<&ScanProgressCallback>, &AtomicU64)>,
) -> Result<Vec<FileProbe>> {
  check_scan_cancelled(cancellation_callback)?;
  let location_value = site_folder.path.to_string_lossy();
  let location = SmbLocation::parse(&location_value)?;
  let credential = credential_store
    .load_smb_credential(&location_value)?
    .ok_or_else(|| NafmError::SmbCredentialNotFound(location_value.into_owned()))?;
  let mut client = smb2::connect(&location.server_address, &credential.username, &credential.password).await?;
  check_scan_cancelled(cancellation_callback)?;
  let mut tree = client.connect_share(&location.share).await?;
  let discovery_result = async {
    check_scan_cancelled(cancellation_callback)?;
    let mut files = Vec::new();
    let mut directories = vec![(location.relative_path.clone(), Vec::<String>::new())];
    let mut visited = BTreeSet::new();

    while let Some((remote_directory, relative_segments)) = directories.pop() {
      check_scan_cancelled(cancellation_callback)?;
      if !visited.insert(remote_directory.clone()) {
        continue;
      }
      let mut entries = client.list_directory(&mut tree, &remote_directory).await?;
      check_scan_cancelled(cancellation_callback)?;
      entries.sort_by(|left, right| left.name.cmp(&right.name));
      for entry in entries {
        check_scan_cancelled(cancellation_callback)?;
        if entry.name == "." || entry.name == ".." {
          continue;
        }
        if site_folder.hidden_policy == HiddenPolicy::Skip && entry.name.starts_with('.') {
          continue;
        }

        let remote_path = join_smb_path(&remote_directory, &entry.name);
        let mut child_segments = relative_segments.clone();
        child_segments.push(entry.name);
        if entry.is_directory {
          directories.push((remote_path, child_segments));
          continue;
        }

        let display_url = location.join_path_segments(&child_segments)?;
        let modified_unix_nanos = match entry.modified.to_system_time() {
          Some(time) => modified_unix_nanos(time)?,
          None => 0,
        };
        let file = FileProbe {
          site_folder_id: site_folder.id.clone(),
          path: PathBuf::from(display_url),
          size_bytes: entry.size,
          modified_unix_nanos,
          source: FileSource::Smb {
            credential_url: credential.url.clone(),
            remote_path,
          },
        };
        if let Some((site, progress_callback, discovered_files)) = progress {
          let discovered_files = discovered_files.fetch_add(1, Ordering::Relaxed) + 1;
          if should_report_discovery(discovered_files) {
            report_discovery_progress(progress_callback, site, discovered_files, Some(&file.path));
          }
        }
        files.push(file);
      }
    }

    Ok::<_, NafmError>(files)
  }
  .await;

  let _ = client.disconnect_share(&tree).await;
  let files = discovery_result?;
  check_scan_cancelled(cancellation_callback)?;
  Ok(files)
}

fn join_smb_path(parent: &str, name: &str) -> String {
  if parent.is_empty() {
    name.to_owned()
  } else {
    format!("{}/{}", parent.trim_end_matches('/'), name)
  }
}

async fn hash_smb_file(
  client: &smb2::SmbClient,
  tree: &smb2::Tree,
  remote_path: &str,
  file: &FileProbe,
  hash_algorithm: &dyn HashAlgorithm,
  cancellation_callback: Option<&ScanCancellationCallback>,
) -> Result<String> {
  const CHUNK_SIZE: u64 = 4 * 1024 * 1024;

  check_scan_cancelled(cancellation_callback)?;
  let reader = client.open_file_reader(tree, remote_path).await?;
  let hash_result = async {
    check_scan_cancelled(cancellation_callback)?;
    if reader.size() != file.size_bytes {
      return Err(NafmError::SmbFileChanged(file.path.clone()));
    }

    let mut hasher = hash_algorithm.new_hasher();
    let mut offset = 0;
    while offset < file.size_bytes {
      check_scan_cancelled(cancellation_callback)?;
      let bytes = reader.read_at(offset, CHUNK_SIZE.min(file.size_bytes - offset)).await?;
      check_scan_cancelled(cancellation_callback)?;
      if bytes.is_empty() {
        break;
      }
      offset += bytes.len() as u64;
      hasher.update(&bytes);
    }
    if offset != file.size_bytes {
      return Err(NafmError::SmbFileChanged(file.path.clone()));
    }
    if reader.size() != file.size_bytes {
      return Err(NafmError::SmbFileChanged(file.path.clone()));
    }
    Ok(hasher.finalize())
  }
  .await;

  let close_result = reader.close().await;
  let content_hash = hash_result?;
  close_result?;
  check_scan_cancelled(cancellation_callback)?;
  Ok(content_hash)
}

async fn publish_hashed_file_async(
  db_path: &Path,
  site_id: &str,
  inventory_revision: u64,
  file: &FileProbe,
  hash_algorithm: &str,
  content_hash: &str,
) -> Result<()> {
  let db_path = db_path.to_path_buf();
  let site_id = site_id.to_owned();
  let file = file.clone();
  let hash_algorithm = hash_algorithm.to_owned();
  let content_hash = content_hash.to_owned();
  task::spawn_blocking(move || {
    let conn = open_connection(db_path)?;
    publish_hashed_file(
      &conn,
      &site_id,
      inventory_revision,
      &file,
      &hash_algorithm,
      &content_hash,
    )
  })
  .await?
}

fn scan_site_blocking(
  conn: &Connection,
  db_path: &Path,
  scan_snapshot: &SiteScanSnapshot<'_>,
  hash_algorithm: &dyn HashAlgorithm,
  progress_callback: Option<&ScanProgressCallback>,
  cancellation_callback: Option<&ScanCancellationCallback>,
) -> Result<ScanSummary> {
  let SiteScanSnapshot {
    site,
    site_folders,
    expected_inventory_revision,
  } = scan_snapshot;
  check_scan_cancelled(cancellation_callback)?;
  report_scan_phase(progress_callback, site, ScanPhase::Discovering, None, 0, None, 0, 0, 0);
  let files = discover_site_files(site_folders, cancellation_callback, Some((site, progress_callback)))?;
  check_scan_cancelled(cancellation_callback)?;
  let scan_time = Utc::now();
  let processed_files = AtomicU64::new(0);
  report_scan_phase(
    progress_callback,
    site,
    ScanPhase::PublishingMetadata,
    None,
    0,
    Some(files.len() as u64),
    0,
    0,
    0,
  );
  check_scan_cancelled(cancellation_callback)?;
  let preparation = publish_inventory_atomically(
    conn,
    site,
    site_folders,
    *expected_inventory_revision,
    files,
    hash_algorithm.name(),
    scan_time,
  )?;

  let progress_context = Arc::new(ScanProgressContext {
    site_id: site.id.clone(),
    site_name: site.name.clone(),
    files_reused: preparation.files_reused,
    total_files: preparation.files_seen,
    total_hash_targets: preparation.files_hashed,
  });
  report_scan_phase(
    progress_callback,
    site,
    ScanPhase::Hashing,
    None,
    preparation.files_reused,
    Some(preparation.files_seen),
    0,
    preparation.files_reused,
    preparation.files_hashed,
  );
  if preparation.files_hashed > 0 {
    check_scan_cancelled(cancellation_callback)?;
  }

  let execution = ScanExecutionContext {
    progress_callback,
    progress_context: &progress_context,
    processed_files: &processed_files,
    cancellation_callback,
  };
  hash_files_in_parallel(
    db_path,
    site,
    preparation.inventory_revision,
    &preparation.hash_targets,
    hash_algorithm,
    &execution,
  )?;

  report_scan_phase(
    progress_callback,
    site,
    ScanPhase::Finalizing,
    None,
    preparation.files_seen,
    Some(preparation.files_seen),
    preparation.files_hashed,
    preparation.files_reused,
    0,
  );
  let duplicate_groups = finalize_site_scan(
    conn,
    site,
    preparation.inventory_revision,
    hash_algorithm.name(),
    Utc::now(),
  )?;
  let duplicate_files = duplicate_groups.iter().map(|group| group.files.len() as u64).sum();

  Ok(ScanSummary {
    site_id: site.id.clone(),
    site_name: site.name.clone(),
    site_folders: site_folders.len() as u64,
    files_seen: preparation.files_seen,
    files_hashed: preparation.files_hashed,
    files_reused: preparation.files_reused,
    files_pending: 0,
    files_removed: preparation.files_removed,
    bytes_hashed: preparation.bytes_hashed,
    duplicate_groups: duplicate_groups.len() as u64,
    duplicate_files,
  })
}

fn publish_inventory_atomically(
  conn: &Connection,
  site: &Site,
  expected_site_folders: &[SiteFolder],
  expected_inventory_revision: u64,
  files: Vec<FileProbe>,
  hash_algorithm: &str,
  scan_time: DateTime<Utc>,
) -> Result<ScanPreparation> {
  with_immediate_transaction(conn, || {
    let previous_revision = conn
      .query_row(
        "select inventory_revision from site_scan_state where site_id = ?1",
        params![site.id],
        |row| row.get::<_, u64>(0),
      )
      .optional()?
      .unwrap_or(0);
    let current_site_folders = list_site_folders(conn, Some(&site.id))?;
    if previous_revision != expected_inventory_revision
      || !site_folder_configuration_matches(expected_site_folders, &current_site_folders)
    {
      return Err(NafmError::ScanSuperseded(site.id.clone()));
    }
    let inventory_revision = previous_revision.saturating_add(1).max(1);
    let mut preparation = ScanPreparation {
      inventory_revision,
      hash_targets: Vec::new(),
      files_seen: files.len() as u64,
      files_hashed: 0,
      files_reused: 0,
      bytes_hashed: 0,
      files_removed: 0,
    };

    for (index, file) in files.into_iter().enumerate() {
      let existing = existing_record(conn, &file.path)?;
      let cached = cached_scan_record(conn, &site.id, &file, hash_algorithm)?;
      let exact_verified = existing.as_ref().is_some_and(|record| {
        record.site_id == site.id
          && record.hash_algorithm == hash_algorithm
          && record.content_hash.is_some()
          && record.hash_revision == Some(record.inventory_revision)
          && record.size_bytes == file.size_bytes
          && record.modified_unix_nanos == file.modified_unix_nanos
          && matches!(file.source, FileSource::Local)
      });
      let (content_hash, hash_revision) = if exact_verified {
        preparation.files_reused += 1;
        (
          existing.as_ref().and_then(|record| record.content_hash.clone()),
          Some(inventory_revision),
        )
      } else if matches!(file.source, FileSource::Local)
        && let Some(cached) = cached
      {
        preparation.files_reused += 1;
        (Some(cached.content_hash), Some(inventory_revision))
      } else {
        let retained_stale_hash = existing.as_ref().and_then(|record| {
          (record.site_id == site.id && record.hash_algorithm == hash_algorithm && record.size_bytes == file.size_bytes)
            .then(|| record.content_hash.clone())
            .flatten()
        });
        preparation.files_hashed += 1;
        preparation.bytes_hashed = preparation.bytes_hashed.saturating_add(file.size_bytes);
        preparation.hash_targets.push((index, file.clone()));
        let retained_hash_revision = retained_stale_hash
          .as_ref()
          .and_then(|_| existing.as_ref().and_then(|record| record.hash_revision));
        (retained_stale_hash, retained_hash_revision)
      };
      upsert_inventory_file(
        conn,
        site,
        &file,
        hash_algorithm,
        &InventoryHashState {
          content_hash,
          hash_revision,
        },
        inventory_revision,
        scan_time,
      )?;
    }

    preparation.files_removed = conn.execute(
      "delete from file_records where site_id = ?1 and inventory_revision <> ?2",
      params![site.id, inventory_revision],
    )? as u64;
    conn.execute("delete from scan_cache_entries where site_id = ?1", params![site.id])?;
    conn.execute(
      "insert into site_scan_state (
         site_id, last_scanned_at, inventory_revision, inventory_completed_at, hash_algorithm, hash_completed_at
       ) values (?1, ?2, ?3, ?2, ?4, null)
       on conflict(site_id) do update set
         inventory_revision = excluded.inventory_revision,
         inventory_completed_at = excluded.inventory_completed_at,
         hash_algorithm = excluded.hash_algorithm,
         hash_completed_at = null",
      params![site.id, scan_time, inventory_revision, hash_algorithm],
    )?;
    Ok(preparation)
  })
}

fn hash_files_in_parallel(
  db_path: &Path,
  site: &Site,
  inventory_revision: u64,
  hash_targets: &[(usize, FileProbe)],
  hash_algorithm: &dyn HashAlgorithm,
  execution: &ScanExecutionContext<'_>,
) -> Result<u64> {
  if hash_targets.is_empty() {
    return Ok(0);
  }

  let worker_count = std::thread::available_parallelism()
    .map(|parallelism| parallelism.get())
    .unwrap_or(1)
    .min(hash_targets.len());
  let chunk_size = hash_targets.len().div_ceil(worker_count);
  let writer_db_path = db_path.to_path_buf();
  let site_id = site.id.clone();
  let hash_algorithm_name = hash_algorithm.name().to_owned();
  let ScanExecutionContext {
    progress_callback,
    progress_context,
    processed_files,
    cancellation_callback,
  } = execution;

  std::thread::scope(|scope| -> Result<u64> {
    let (sender, receiver) = mpsc::channel::<(FileProbe, String)>();
    let writer_progress_context = Arc::clone(progress_context);
    let writer = scope.spawn(move || -> Result<u64> {
      let conn = open_connection(writer_db_path)?;
      let mut hashed_records = 0_u64;
      for (file, content_hash) in receiver {
        publish_hashed_file(
          &conn,
          &site_id,
          inventory_revision,
          &file,
          &hash_algorithm_name,
          &content_hash,
        )?;
        report_scan_progress(
          *progress_callback,
          writer_progress_context.as_ref(),
          &file.path,
          processed_files,
        );
        hashed_records += 1;
      }
      Ok(hashed_records)
    });
    let mut tasks = Vec::with_capacity(worker_count);
    for chunk in hash_targets.chunks(chunk_size) {
      let sender = sender.clone();
      tasks.push(scope.spawn(move || -> Result<()> {
        for (_, file) in chunk {
          check_scan_cancelled(*cancellation_callback)?;
          verify_local_probe(file)?;
          let content_hash = match cancellation_callback {
            Some(is_cancelled) => hash_algorithm.hash_file_with_cancellation(&file.path, is_cancelled.as_ref())?,
            None => hash_algorithm.hash_file(&file.path)?,
          };
          verify_local_probe(file)?;
          check_scan_cancelled(*cancellation_callback)?;
          sender
            .send((file.clone(), content_hash))
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        }
        Ok(())
      }));
    }
    drop(sender);

    let mut first_error = None;
    for task in tasks {
      if let Err(error) = task.join().expect("hash worker thread should not panic")
        && first_error.is_none()
      {
        first_error = Some(error);
      }
    }
    let hashed_records = writer.join().expect("scan cache writer thread should not panic")?;
    if let Some(error) = first_error {
      return Err(error);
    }
    Ok(hashed_records)
  })
}

fn check_scan_cancelled(cancellation_callback: Option<&ScanCancellationCallback>) -> Result<()> {
  if cancellation_callback.is_some_and(|is_cancelled| is_cancelled()) {
    Err(NafmError::ScanCancelled)
  } else {
    Ok(())
  }
}

fn report_scan_progress(
  progress_callback: Option<&ScanProgressCallback>,
  progress_context: &ScanProgressContext,
  current_path: &Path,
  processed_files: &AtomicU64,
) {
  let Some(progress_callback) = progress_callback else {
    return;
  };
  let hashed_files = processed_files.fetch_add(1, Ordering::Relaxed) + 1;
  progress_callback(&ScanProgress {
    site_id: progress_context.site_id.clone(),
    site_name: progress_context.site_name.clone(),
    phase: ScanPhase::Hashing,
    current_path: Some(current_path.to_path_buf()),
    processed_files: progress_context.files_reused + hashed_files,
    total_files: Some(progress_context.total_files),
    hashed_files,
    reused_files: progress_context.files_reused,
    hashes_pending: progress_context.total_hash_targets.saturating_sub(hashed_files),
  });
}

#[allow(clippy::too_many_arguments)]
fn report_scan_phase(
  progress_callback: Option<&ScanProgressCallback>,
  site: &Site,
  phase: ScanPhase,
  current_path: Option<&Path>,
  processed_files: u64,
  total_files: Option<u64>,
  hashed_files: u64,
  reused_files: u64,
  hashes_pending: u64,
) {
  let Some(progress_callback) = progress_callback else {
    return;
  };
  progress_callback(&ScanProgress {
    site_id: site.id.clone(),
    site_name: site.name.clone(),
    phase,
    current_path: current_path.map(Path::to_path_buf),
    processed_files,
    total_files,
    hashed_files,
    reused_files,
    hashes_pending,
  });
}

fn report_discovery_progress(
  progress_callback: Option<&ScanProgressCallback>,
  site: &Site,
  discovered_files: u64,
  current_path: Option<&Path>,
) {
  report_scan_phase(
    progress_callback,
    site,
    ScanPhase::Discovering,
    current_path,
    discovered_files,
    None,
    0,
    0,
    0,
  );
}

fn should_report_discovery(discovered_files: u64) -> bool {
  discovered_files == 1 || discovered_files.is_multiple_of(128)
}

fn discover_site_files(
  site_folders: &[SiteFolder],
  cancellation_callback: Option<&ScanCancellationCallback>,
  progress: Option<(&Site, Option<&ScanProgressCallback>)>,
) -> Result<Vec<FileProbe>> {
  let mut files_by_path = BTreeMap::new();
  let mut sorted_site_folders = site_folders.to_vec();
  sorted_site_folders.sort_by_key(|site_folder| std::cmp::Reverse(site_folder.path.components().count()));

  for site_folder in &sorted_site_folders {
    check_scan_cancelled(cancellation_callback)?;
    if site_folder.kind != SiteFolderKind::Local {
      continue;
    }
    let walker = WalkDir::new(&site_folder.path).follow_links(false).into_iter();
    for entry in walker.filter_entry(|entry| should_visit(entry, site_folder.hidden_policy)) {
      check_scan_cancelled(cancellation_callback)?;
      let entry = entry.map_err(|err| std::io::Error::other(err.to_string()))?;
      if !entry.file_type().is_file() {
        continue;
      }
      let path = entry.path().to_path_buf();
      if files_by_path.contains_key(&path) {
        continue;
      }
      let metadata = entry.metadata().map_err(|err| std::io::Error::other(err.to_string()))?;
      files_by_path.insert(
        path.clone(),
        FileProbe {
          site_folder_id: site_folder.id.clone(),
          path: path.clone(),
          size_bytes: metadata.len(),
          modified_unix_nanos: modified_unix_nanos(metadata.modified()?)?,
          source: FileSource::Local,
        },
      );
      if let Some((site, progress_callback)) = progress {
        let discovered_files = files_by_path.len() as u64;
        if should_report_discovery(discovered_files) {
          report_discovery_progress(progress_callback, site, discovered_files, Some(&path));
        }
      }
    }
  }

  Ok(files_by_path.into_values().collect())
}

fn should_visit(entry: &DirEntry, hidden_policy: HiddenPolicy) -> bool {
  if entry.depth() == 0 {
    return true;
  }
  if hidden_policy == HiddenPolicy::Include {
    return true;
  }
  entry.file_name().to_str().is_none_or(|name| !name.starts_with('.'))
}

fn modified_unix_nanos(time: SystemTime) -> Result<i64> {
  let duration = time
    .duration_since(UNIX_EPOCH)
    .map_err(|err| std::io::Error::other(err.to_string()))?;
  Ok((duration.as_secs() as i64 * 1_000_000_000) + duration.subsec_nanos() as i64)
}

fn verify_local_probe(file: &FileProbe) -> Result<()> {
  let metadata = std::fs::metadata(&file.path)?;
  let matches = metadata.is_file()
    && metadata.len() == file.size_bytes
    && modified_unix_nanos(metadata.modified()?)? == file.modified_unix_nanos;
  if !matches {
    return Err(NafmError::FileChanged(file.path.clone()));
  }
  Ok(())
}

fn existing_record(conn: &Connection, path: &Path) -> Result<Option<ExistingRecord>> {
  conn
    .query_row(
      "select site_id, size_bytes, modified_unix_nanos, content_hash, hash_algorithm,
         inventory_revision, hash_revision
       from file_records where path = ?1",
      params![path.to_string_lossy()],
      |row| {
        Ok(ExistingRecord {
          site_id: row.get(0)?,
          size_bytes: row.get(1)?,
          modified_unix_nanos: row.get(2)?,
          content_hash: row.get(3)?,
          hash_algorithm: row.get(4)?,
          inventory_revision: row.get(5)?,
          hash_revision: row.get(6)?,
        })
      },
    )
    .optional()
    .map_err(Into::into)
}

fn reveal_file_record(conn: &Connection, file_id: &str) -> Result<Option<RevealFileRecord>> {
  conn
    .query_row(
      "select site_id, site_folder_id, path from file_records where id = ?1",
      params![file_id],
      |row| {
        Ok(RevealFileRecord {
          id: file_id.to_owned(),
          site_id: row.get(0)?,
          site_folder_id: row.get(1)?,
          path: PathBuf::from(row.get::<_, String>(2)?),
        })
      },
    )
    .optional()
    .map_err(Into::into)
}

fn cached_scan_record(
  conn: &Connection,
  site_id: &str,
  file: &FileProbe,
  hash_algorithm: &str,
) -> Result<Option<CachedScanRecord>> {
  conn
    .query_row(
      "select content_hash
       from scan_cache_entries
       where site_id = ?1
         and path = ?2
         and size_bytes = ?3
         and modified_unix_nanos = ?4
         and hash_algorithm = ?5",
      params![
        site_id,
        file.path.to_string_lossy(),
        file.size_bytes,
        file.modified_unix_nanos,
        hash_algorithm
      ],
      |row| {
        Ok(CachedScanRecord {
          content_hash: row.get(0)?,
        })
      },
    )
    .optional()
    .map_err(Into::into)
}

fn upsert_inventory_file(
  conn: &Connection,
  site: &Site,
  file: &FileProbe,
  hash_algorithm: &str,
  hash_state: &InventoryHashState,
  inventory_revision: u64,
  last_seen_at: DateTime<Utc>,
) -> Result<()> {
  conn.execute(
    "insert into file_records (
      id, site_id, site_folder_id, path, size_bytes, modified_unix_nanos, hash_algorithm, content_hash,
      inventory_revision, hash_revision, last_seen_at
    )
    values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
    on conflict(path) do update set
      site_id = excluded.site_id,
      site_folder_id = excluded.site_folder_id,
      size_bytes = excluded.size_bytes,
      modified_unix_nanos = excluded.modified_unix_nanos,
      hash_algorithm = excluded.hash_algorithm,
      content_hash = excluded.content_hash,
      inventory_revision = excluded.inventory_revision,
      hash_revision = excluded.hash_revision,
      last_seen_at = excluded.last_seen_at",
    params![
      Uuid::new_v4().to_string(),
      site.id,
      file.site_folder_id,
      file.path.to_string_lossy(),
      file.size_bytes,
      file.modified_unix_nanos,
      hash_algorithm,
      hash_state.content_hash,
      inventory_revision,
      hash_state.hash_revision,
      last_seen_at,
    ],
  )?;
  Ok(())
}

fn publish_hashed_file(
  conn: &Connection,
  site_id: &str,
  inventory_revision: u64,
  file: &FileProbe,
  hash_algorithm: &str,
  content_hash: &str,
) -> Result<()> {
  let updated = conn.execute(
    "update file_records
     set content_hash = ?1, hash_revision = inventory_revision
     where site_id = ?2
       and path = ?3
       and site_folder_id = ?4
       and size_bytes = ?5
       and modified_unix_nanos = ?6
       and hash_algorithm = ?7
       and inventory_revision = ?8",
    params![
      content_hash,
      site_id,
      file.path.to_string_lossy(),
      file.site_folder_id,
      file.size_bytes,
      file.modified_unix_nanos,
      hash_algorithm,
      inventory_revision,
    ],
  )?;
  if updated != 1 {
    return Err(NafmError::ScanSuperseded(site_id.to_owned()));
  }
  Ok(())
}

fn finalize_site_scan(
  conn: &Connection,
  site: &Site,
  inventory_revision: u64,
  hash_algorithm: &str,
  completed_at: DateTime<Utc>,
) -> Result<Vec<DuplicateGroup>> {
  with_immediate_transaction(conn, || {
    let current_revision = conn
      .query_row(
        "select inventory_revision from site_scan_state where site_id = ?1",
        params![site.id],
        |row| row.get::<_, u64>(0),
      )
      .optional()?;
    if current_revision != Some(inventory_revision) {
      return Err(NafmError::ScanSuperseded(site.id.clone()));
    }
    let pending_hashes = pending_hash_count(conn, &site.id, inventory_revision)?;
    if pending_hashes > 0 {
      return Err(NafmError::SiteHashesPending {
        site_id: site.id.clone(),
        pending_hashes,
      });
    }
    conn.execute(
      "update file_records set last_seen_at = ?1
       where site_id = ?2 and inventory_revision = ?3",
      params![completed_at, site.id, inventory_revision],
    )?;
    let updated = conn.execute(
      "update site_scan_state
       set last_scanned_at = ?1, hash_completed_at = ?1, hash_algorithm = ?2
       where site_id = ?3 and inventory_revision = ?4",
      params![completed_at, hash_algorithm, site.id, inventory_revision],
    )?;
    if updated != 1 {
      return Err(NafmError::ScanSuperseded(site.id.clone()));
    }
    find_duplicates(conn, Some(&site.id))
  })
}

fn pending_hash_count(conn: &Connection, site_id: &str, inventory_revision: u64) -> Result<u64> {
  conn
    .query_row(
      "select count(*)
       from file_records
       where site_id = ?1
         and inventory_revision = ?2
         and (content_hash is null or hash_revision is null or hash_revision <> inventory_revision)",
      params![site_id, inventory_revision],
      |row| row.get::<_, u64>(0),
    )
    .map_err(Into::into)
}

fn find_duplicates(conn: &Connection, site_id: Option<&str>) -> Result<Vec<DuplicateGroup>> {
  let groups = if let Some(site_id) = site_id {
    conn
      .prepare(
        "select file.hash_algorithm, file.content_hash, file.size_bytes
         from file_records file
         join site_scan_state state on state.site_id = file.site_id
         where file.content_hash is not null
           and file.hash_revision = file.inventory_revision
           and state.inventory_completed_at is not null
           and state.hash_completed_at is not null
           and state.inventory_revision = file.inventory_revision
           and file.site_id = ?1
         group by file.hash_algorithm, file.content_hash, file.size_bytes
         having count(*) > 1
         order by file.size_bytes desc, file.content_hash",
      )?
      .query_map(params![site_id], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, u64>(2)?,
        ))
      })?
      .collect::<std::result::Result<Vec<_>, _>>()?
  } else {
    conn
      .prepare(
        "select file.hash_algorithm, file.content_hash, file.size_bytes
         from file_records file
         join site_scan_state state on state.site_id = file.site_id
         where file.content_hash is not null
           and file.hash_revision = file.inventory_revision
           and state.inventory_completed_at is not null
           and state.hash_completed_at is not null
           and state.inventory_revision = file.inventory_revision
         group by file.hash_algorithm, file.content_hash, file.size_bytes
         having count(*) > 1
         order by file.size_bytes desc, file.content_hash",
      )?
      .query_map([], |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, u64>(2)?,
        ))
      })?
      .collect::<std::result::Result<Vec<_>, _>>()?
  };

  let mut duplicate_groups = Vec::with_capacity(groups.len());
  for (hash_algorithm, hash, size_bytes) in groups {
    let files = duplicate_files(conn, site_id, &hash_algorithm, &hash, size_bytes)?;
    duplicate_groups.push(DuplicateGroup {
      group_id: format!("{hash_algorithm}:{hash}:{size_bytes}"),
      hash_algorithm,
      hash,
      size_bytes,
      files,
    });
  }
  Ok(duplicate_groups)
}

fn file_content_matches_page(
  conn: &Connection,
  source_site_id: &str,
  path: &Path,
  offset: u64,
  limit: u64,
) -> Result<FileContentMatchesPage> {
  let limit = limit.clamp(1, MAX_FILE_CONTENT_MATCHES_PAGE_SIZE);
  let selected_site_ready = site_has_completed_scan(conn, source_site_id)?;
  let workspace_pending_hash_count = conn.query_row(
    "select count(*) from file_records
     where content_hash is null or hash_revision is null or hash_revision <> inventory_revision",
    [],
    |row| row.get::<_, u64>(0),
  )?;
  let workspace_incomplete_site_count = list_sites(conn)?.into_iter().try_fold(0_u64, |count, site| {
    let incomplete = site_has_configured_folders(conn, &site.id)? && !site_has_completed_scan(conn, &site.id)?;
    Ok::<_, NafmError>(count + u64::from(incomplete))
  })?;
  let selected = conn
    .query_row(
      "select file.id, file.site_id, site.name, file.site_folder_id, folder.kind, file.path, file.size_bytes,
         file.hash_algorithm, file.content_hash,
         coalesce(file.content_hash is not null and file.hash_revision = file.inventory_revision, false)
       from file_records file
       join sites site on site.id = file.site_id
       join site_folders folder on folder.id = file.site_folder_id
       where file.site_id = ?1 and file.path = ?2",
      params![source_site_id, path.to_string_lossy()],
      |row| {
        let site_folder_kind = row.get::<_, String>(4)?;
        Ok((
          FileContentMatch {
            file_id: row.get(0)?,
            site_id: row.get(1)?,
            site_name: row.get(2)?,
            site_folder_id: row.get(3)?,
            site_folder_kind: site_folder_kind_from_db(&site_folder_kind),
            path: PathBuf::from(row.get::<_, String>(5)?),
            size_bytes: row.get(6)?,
            is_current: true,
          },
          row.get::<_, String>(7)?,
          row.get::<_, Option<String>>(8)?,
          row.get::<_, bool>(9)?,
        ))
      },
    )
    .optional()?
    .ok_or_else(|| NafmError::TrackedPathNotFound(path.to_path_buf()))?;
  let (selected_match, hash_algorithm, content_hash, hash_verified) = selected;
  let Some(content_hash) = content_hash else {
    return Ok(FileContentMatchesPage {
      status: FileContentMatchStatus::NotHashed,
      workspace_pending_hash_count,
      workspace_incomplete_site_count,
      matches: (offset == 0).then_some(selected_match).into_iter().collect(),
      total_matches: 1,
      offset,
      limit,
    });
  };
  if !hash_verified || !selected_site_ready {
    return Ok(FileContentMatchesPage {
      status: FileContentMatchStatus::NeedsVerification,
      workspace_pending_hash_count,
      workspace_incomplete_site_count,
      matches: (offset == 0).then_some(selected_match).into_iter().collect(),
      total_matches: 1,
      offset,
      limit,
    });
  }

  let total_matches = conn.query_row(
    "select count(*)
     from file_records file
     join site_scan_state state on state.site_id = file.site_id
     where file.hash_algorithm = ?1 and file.content_hash = ?2 and file.size_bytes = ?3
       and file.hash_revision = file.inventory_revision
       and state.inventory_completed_at is not null
       and state.hash_completed_at is not null
       and state.inventory_revision = file.inventory_revision",
    params![hash_algorithm, content_hash, selected_match.size_bytes],
    |row| row.get::<_, u64>(0),
  )?;
  let sql_offset = i64::try_from(offset).unwrap_or(i64::MAX);
  let mut stmt = conn.prepare(
    "select file.id, file.site_id, site.name, file.site_folder_id, folder.kind, file.path, file.size_bytes
     from file_records file
     join sites site on site.id = file.site_id
     join site_folders folder on folder.id = file.site_folder_id
     join site_scan_state state on state.site_id = file.site_id
     where file.hash_algorithm = ?1
       and file.content_hash = ?2
       and file.size_bytes = ?3
       and file.hash_revision = file.inventory_revision
       and state.inventory_completed_at is not null
       and state.hash_completed_at is not null
       and state.inventory_revision = file.inventory_revision
     order by
       case when file.id = ?4 then 0 when file.site_id = ?5 then 1 else 2 end,
       site.name,
       file.path,
       file.id
     limit ?6 offset ?7",
  )?;
  let matches = stmt
    .query_map(
      params![
        hash_algorithm,
        content_hash,
        selected_match.size_bytes,
        selected_match.file_id,
        source_site_id,
        limit,
        sql_offset,
      ],
      |row| {
        let site_folder_kind = row.get::<_, String>(4)?;
        let file_id = row.get::<_, String>(0)?;
        Ok(FileContentMatch {
          is_current: file_id == selected_match.file_id,
          file_id,
          site_id: row.get(1)?,
          site_name: row.get(2)?,
          site_folder_id: row.get(3)?,
          site_folder_kind: site_folder_kind_from_db(&site_folder_kind),
          path: PathBuf::from(row.get::<_, String>(5)?),
          size_bytes: row.get(6)?,
        })
      },
    )?
    .collect::<std::result::Result<Vec<_>, _>>()?;

  Ok(FileContentMatchesPage {
    status: FileContentMatchStatus::Ready,
    workspace_pending_hash_count,
    workspace_incomplete_site_count,
    matches,
    total_matches,
    offset,
    limit,
  })
}

fn duplicate_files(
  conn: &Connection,
  site_id: Option<&str>,
  hash_algorithm: &str,
  hash: &str,
  size_bytes: u64,
) -> Result<Vec<DuplicateFile>> {
  if let Some(site_id) = site_id {
    let mut stmt = conn.prepare(
      "select file.id, file.site_id, file.site_folder_id, file.path, file.size_bytes, file.modified_unix_nanos
       from file_records file
       join site_scan_state state on state.site_id = file.site_id
       where file.site_id = ?1 and file.hash_algorithm = ?2 and file.content_hash = ?3 and file.size_bytes = ?4
         and file.hash_revision = file.inventory_revision
         and state.inventory_completed_at is not null
         and state.hash_completed_at is not null
         and state.inventory_revision = file.inventory_revision
       order by file.path",
    )?;
    stmt
      .query_map(
        params![site_id, hash_algorithm, hash, size_bytes],
        duplicate_file_from_row,
      )?
      .collect::<std::result::Result<Vec<_>, _>>()
      .map_err(Into::into)
  } else {
    let mut stmt = conn.prepare(
      "select file.id, file.site_id, file.site_folder_id, file.path, file.size_bytes, file.modified_unix_nanos
       from file_records file
       join site_scan_state state on state.site_id = file.site_id
       where file.hash_algorithm = ?1 and file.content_hash = ?2 and file.size_bytes = ?3
         and file.hash_revision = file.inventory_revision
         and state.inventory_completed_at is not null
         and state.hash_completed_at is not null
         and state.inventory_revision = file.inventory_revision
       order by file.path",
    )?;
    stmt
      .query_map(params![hash_algorithm, hash, size_bytes], duplicate_file_from_row)?
      .collect::<std::result::Result<Vec<_>, _>>()
      .map_err(Into::into)
  }
}

fn find_missing(conn: &Connection, source_site_id: &str, target_site_id: &str) -> Result<Vec<MissingContentGroup>> {
  ensure_site_hash_ready(conn, source_site_id)?;
  ensure_site_hash_ready(conn, target_site_id)?;
  let groups = conn
    .prepare(
      "select distinct source.hash_algorithm, source.content_hash, source.size_bytes
       from file_records source
       where source.site_id = ?1
         and source.content_hash is not null
         and source.hash_revision = source.inventory_revision
         and not exists (
           select 1
           from file_records target
           where target.site_id = ?2
             and target.hash_algorithm = source.hash_algorithm
             and target.content_hash = source.content_hash
             and target.size_bytes = source.size_bytes
             and target.hash_revision = target.inventory_revision
         )
       order by source.size_bytes desc, source.content_hash",
    )?
    .query_map(params![source_site_id, target_site_id], |row| {
      Ok((
        row.get::<_, String>(0)?,
        row.get::<_, String>(1)?,
        row.get::<_, u64>(2)?,
      ))
    })?
    .collect::<std::result::Result<Vec<_>, _>>()?;

  let mut missing_groups = Vec::with_capacity(groups.len());
  for (hash_algorithm, hash, size_bytes) in groups {
    missing_groups.push(MissingContentGroup {
      group_id: format!("{source_site_id}:{target_site_id}:{hash_algorithm}:{hash}:{size_bytes}"),
      source_site_id: source_site_id.to_owned(),
      target_site_id: target_site_id.to_owned(),
      hash_algorithm: hash_algorithm.clone(),
      hash: hash.clone(),
      size_bytes,
      source_files: duplicate_files(conn, Some(source_site_id), &hash_algorithm, &hash, size_bytes)?,
    });
  }
  Ok(missing_groups)
}

fn duplicate_file_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DuplicateFile> {
  Ok(DuplicateFile {
    file_id: row.get(0)?,
    site_id: row.get(1)?,
    site_folder_id: row.get(2)?,
    path: PathBuf::from(row.get::<_, String>(3)?),
    size_bytes: row.get(4)?,
    modified_unix_nanos: row.get(5)?,
  })
}

fn stage_add_path(conn: &Connection, canonical_path: &Path, is_remote: bool) -> Result<StageAddReport> {
  let duplicate_groups = find_duplicates(conn, None)?;
  let staged_files = list_staged_files(conn)?;
  let mut staged_file_ids = staged_files
    .iter()
    .map(|record| record.file.file_id.clone())
    .collect::<std::collections::HashSet<_>>();
  let staged_by_path = staged_files
    .iter()
    .map(|record| (record.file.path.clone(), record.file.clone()))
    .collect::<BTreeMap<_, _>>();
  let mut files_by_path = BTreeMap::new();
  let mut group_by_file_id = BTreeMap::new();

  for group in &duplicate_groups {
    for file in &group.files {
      files_by_path.insert(file.path.clone(), file.clone());
      group_by_file_id.insert(file.file_id.clone(), group.clone());
    }
  }

  let is_directory = canonical_path.is_dir()
    || (is_remote && !files_by_path.contains_key(canonical_path) && tracked_descendant_exists(conn, canonical_path)?);
  let requested_files = if is_directory {
    files_by_path
      .values()
      .filter(|file| file.path.starts_with(canonical_path))
      .cloned()
      .collect::<Vec<_>>()
  } else {
    match files_by_path.get(canonical_path) {
      Some(file) => vec![file.clone()],
      None => {
        if tracked_file_exists(conn, canonical_path)? {
          return Ok(StageAddReport {
            staged_files: Vec::new(),
            warnings: Vec::new(),
          });
        }
        return Err(NafmError::TrackedPathNotFound(canonical_path.to_path_buf()));
      }
    }
  };

  if is_directory && requested_files.is_empty() {
    return Err(NafmError::TrackedPathNotFound(canonical_path.to_path_buf()));
  }

  let mut requested_by_group = BTreeMap::<String, Vec<DuplicateFile>>::new();
  let mut warnings = Vec::new();
  for file in requested_files {
    if staged_by_path.contains_key(&file.path) {
      warnings.push(StageWarning {
        path: file.path.clone(),
        reason: StageWarningReason::AlreadyStaged,
      });
      continue;
    }
    let Some(group) = group_by_file_id.get(&file.file_id) else {
      warnings.push(StageWarning {
        path: file.path.clone(),
        reason: StageWarningReason::NotDuplicate,
      });
      continue;
    };
    requested_by_group.entry(group.group_id.clone()).or_default().push(file);
  }

  let mut staged_now = Vec::new();
  let now = Utc::now();
  for (group_id, mut requested) in requested_by_group {
    let group = group_by_file_id
      .values()
      .find(|group| group.group_id == group_id)
      .expect("group id should resolve");
    let mut unstaged_group_files = group
      .files
      .iter()
      .filter(|file| !staged_file_ids.contains(&file.file_id))
      .cloned()
      .collect::<Vec<_>>();
    unstaged_group_files.sort_by(|left, right| left.path.cmp(&right.path));
    requested.sort_by(|left, right| left.path.cmp(&right.path));

    let outside_requested_count = unstaged_group_files
      .iter()
      .filter(|file| !requested.iter().any(|candidate| candidate.file_id == file.file_id))
      .count();

    let allowed_from_requested = if outside_requested_count > 0 {
      requested.len()
    } else {
      requested.len().saturating_sub(1)
    };

    for (index, file) in requested.into_iter().enumerate() {
      if index < allowed_from_requested {
        conn.execute(
          "insert or ignore into stage_entries (file_id, added_at) values (?1, ?2)",
          params![file.file_id, now],
        )?;
        staged_file_ids.insert(file.file_id.clone());
        staged_now.push(file);
      } else {
        warnings.push(StageWarning {
          path: file.path,
          reason: StageWarningReason::WouldRemoveLastCopy,
        });
      }
    }
  }

  if !staged_now.is_empty() {
    record_stage_snapshot(conn, StageMutationKind::Add)?;
  }

  Ok(StageAddReport {
    staged_files: staged_now,
    warnings,
  })
}

fn stage_remove_path(conn: &Connection, canonical_path: &Path, is_remote: bool) -> Result<StageRemoveReport> {
  let staged_files = list_staged_files(conn)?;
  let staged_by_path = staged_files
    .iter()
    .map(|record| (record.file.path.clone(), record.file.clone()))
    .collect::<BTreeMap<_, _>>();

  let is_directory = canonical_path.is_dir()
    || (is_remote && !staged_by_path.contains_key(canonical_path) && tracked_descendant_exists(conn, canonical_path)?);
  let removed_files = if is_directory {
    staged_by_path
      .values()
      .filter(|file| file.path.starts_with(canonical_path))
      .cloned()
      .collect::<Vec<_>>()
  } else {
    match staged_by_path.get(canonical_path) {
      Some(file) => vec![file.clone()],
      None => Vec::new(),
    }
  };

  let mut warnings = Vec::new();
  if !is_directory && removed_files.is_empty() {
    let warning_reason = if tracked_file_exists(conn, canonical_path)? {
      StageWarningReason::NotStaged
    } else {
      StageWarningReason::NotTracked
    };
    warnings.push(StageWarning {
      path: canonical_path.to_path_buf(),
      reason: warning_reason,
    });
  }

  if is_directory && removed_files.is_empty() {
    if tracked_descendant_exists(conn, canonical_path)? {
      warnings.push(StageWarning {
        path: canonical_path.to_path_buf(),
        reason: StageWarningReason::NotStaged,
      });
    } else {
      return Err(NafmError::TrackedPathNotFound(canonical_path.to_path_buf()));
    }
  }

  if !removed_files.is_empty() {
    for file in &removed_files {
      conn.execute("delete from stage_entries where file_id = ?1", params![file.file_id])?;
    }
    record_stage_snapshot(conn, StageMutationKind::Remove)?;
  }

  Ok(StageRemoveReport {
    removed_files,
    warnings,
  })
}

fn stage_reset(conn: &Connection) -> Result<StageResetReport> {
  let removed_files = list_staged_files(conn)?
    .into_iter()
    .map(|record| record.file)
    .collect::<Vec<_>>();
  if !removed_files.is_empty() {
    conn.execute("delete from stage_entries", [])?;
    record_stage_snapshot(conn, StageMutationKind::Reset)?;
  }
  Ok(StageResetReport { removed_files })
}

fn stage_undo(conn: &Connection) -> Result<StageHistoryReport> {
  let current_snapshot_id = current_stage_snapshot_id(conn)?;
  let previous_snapshot_id = conn
    .query_row(
      "select id from stage_snapshots where id < ?1 order by id desc limit 1",
      params![current_snapshot_id],
      |row| row.get::<_, i64>(0),
    )
    .optional()?;
  let Some(previous_snapshot_id) = previous_snapshot_id else {
    return Err(NafmError::StageHistoryUnavailable("undo"));
  };
  restore_stage_snapshot(conn, previous_snapshot_id)
}

fn stage_redo(conn: &Connection) -> Result<StageHistoryReport> {
  let current_snapshot_id = current_stage_snapshot_id(conn)?;
  let next_snapshot_id = conn
    .query_row(
      "select id from stage_snapshots where id > ?1 order by id asc limit 1",
      params![current_snapshot_id],
      |row| row.get::<_, i64>(0),
    )
    .optional()?;
  let Some(next_snapshot_id) = next_snapshot_id else {
    return Err(NafmError::StageHistoryUnavailable("redo"));
  };
  restore_stage_snapshot(conn, next_snapshot_id)
}

fn stage_commit_dry_run(conn: &Connection) -> Result<StageCommitDryRun> {
  conn.execute_batch("begin deferred transaction")?;
  match stage_commit_dry_run_snapshot(conn) {
    Ok(report) => {
      conn.execute_batch("commit")?;
      Ok(report)
    }
    Err(error) => {
      let _ = conn.execute_batch("rollback");
      Err(error)
    }
  }
}

fn stage_commit_dry_run_snapshot(conn: &Connection) -> Result<StageCommitDryRun> {
  let tracked_file_count_before = total_file_record_count(conn)?;
  let duplicate_groups_before = find_duplicates(conn, None)?;
  let duplicate_group_count_before = duplicate_groups_before.len() as u64;
  let duplicate_file_count_before = duplicate_groups_before
    .iter()
    .map(|group| group.files.len() as u64)
    .sum();
  let staged_files = list_staged_files(conn)?
    .into_iter()
    .map(|record| record.file)
    .collect::<Vec<_>>();
  let duplicate_group_by_file_id = duplicate_groups_before
    .iter()
    .flat_map(|group| group.files.iter().map(move |file| (file.file_id.as_str(), group)))
    .collect::<BTreeMap<_, _>>();
  let mut warnings = Vec::new();
  let hashes_pending = staged_files.iter().try_fold(0_u64, |count, file| {
    let pending = conn.query_row(
      "select content_hash is null or hash_revision is null or hash_revision <> inventory_revision
       from file_records where id = ?1",
      params![file.file_id],
      |row| row.get::<_, bool>(0),
    )?;
    if pending || !duplicate_group_by_file_id.contains_key(file.file_id.as_str()) {
      warnings.push(StageWarning {
        path: file.path.clone(),
        reason: StageWarningReason::NotDuplicate,
      });
    }
    Ok::<_, NafmError>(count + u64::from(pending))
  })?;
  let all_staged_ids = staged_files
    .iter()
    .map(|file| file.file_id.clone())
    .collect::<std::collections::HashSet<_>>();
  for group in &duplicate_groups_before {
    let staged_in_group = group
      .files
      .iter()
      .filter(|file| all_staged_ids.contains(&file.file_id))
      .collect::<Vec<_>>();
    if staged_in_group.len() == group.files.len()
      && let Some(file) = staged_in_group.last()
    {
      warnings.push(StageWarning {
        path: file.path.clone(),
        reason: StageWarningReason::WouldRemoveLastCopy,
      });
    }
  }
  let cleanup_ready = warnings.is_empty();
  let staged_ids = if cleanup_ready {
    all_staged_ids
  } else {
    std::collections::HashSet::new()
  };

  let duplicate_groups_after = duplicate_groups_before
    .iter()
    .filter_map(|group| {
      let remaining_files = group
        .files
        .iter()
        .filter(|file| !staged_ids.contains(&file.file_id))
        .cloned()
        .collect::<Vec<_>>();
      if remaining_files.len() > 1 {
        Some(DuplicateGroup {
          group_id: group.group_id.clone(),
          hash_algorithm: group.hash_algorithm.clone(),
          hash: group.hash.clone(),
          size_bytes: group.size_bytes,
          files: remaining_files,
        })
      } else {
        None
      }
    })
    .collect::<Vec<_>>();
  let duplicate_group_count_after = duplicate_groups_after.len() as u64;
  let duplicate_file_count_after = duplicate_groups_after
    .iter()
    .map(|group| group.files.len() as u64)
    .sum();
  let tracked_file_count_after = tracked_file_count_before.saturating_sub(staged_ids.len() as u64);
  let db_entry_count_stable = tracked_file_count_before == total_file_record_count(conn)?;

  Ok(StageCommitDryRun {
    staged_files,
    hashes_pending,
    cleanup_ready,
    warnings,
    tracked_file_count_before,
    tracked_file_count_after,
    duplicate_group_count_before,
    duplicate_group_count_after,
    duplicate_file_count_before,
    duplicate_file_count_after,
    db_entry_count_stable,
    duplicate_groups_after,
  })
}

fn list_staged_files(conn: &Connection) -> Result<Vec<StagedFileRecord>> {
  let mut stmt = conn.prepare(
    "select f.id, f.site_id, f.site_folder_id, f.path, f.size_bytes, f.modified_unix_nanos, s.added_at
     from stage_entries s
     join file_records f on f.id = s.file_id
     order by s.added_at, f.path",
  )?;
  stmt
    .query_map([], |row| {
      Ok(StagedFileRecord {
        file: DuplicateFile {
          file_id: row.get(0)?,
          site_id: row.get(1)?,
          site_folder_id: row.get(2)?,
          path: PathBuf::from(row.get::<_, String>(3)?),
          size_bytes: row.get(4)?,
          modified_unix_nanos: row.get(5)?,
        },
      })
    })?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(Into::into)
}

fn tracked_descendant_exists(conn: &Connection, path: &Path) -> Result<bool> {
  Ok(!tracked_file_paths_under_prefix(conn, path)?.is_empty())
}

fn tracked_file_paths_under_prefix(conn: &Connection, path: &Path) -> Result<Vec<PathBuf>> {
  let prefix = format!("{}/%", path.to_string_lossy());
  conn
    .prepare("select path from file_records where path like ?1 order by path")?
    .query_map(params![prefix], |row| row.get::<_, String>(0))?
    .map(|row| row.map(PathBuf::from))
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(Into::into)
}

fn initialize_stage_history(conn: &Connection) -> Result<()> {
  conn.execute(
    "insert or ignore into stage_state (singleton, current_snapshot_id) values (1, null)",
    [],
  )?;
  let current_snapshot_id = current_stage_snapshot_id_optional(conn)?;
  if current_snapshot_id.is_none() {
    record_stage_snapshot(conn, StageMutationKind::Reset)?;
  }
  Ok(())
}

fn record_stage_snapshot(conn: &Connection, mutation_kind: StageMutationKind) -> Result<i64> {
  let now = Utc::now();
  let current_snapshot_id = current_stage_snapshot_id_optional(conn)?;
  if let Some(current_snapshot_id) = current_snapshot_id {
    conn.execute(
      "delete from stage_snapshots where id > ?1",
      params![current_snapshot_id],
    )?;
  }
  conn.execute(
    "insert into stage_snapshots (mutation_kind, created_at) values (?1, ?2)",
    params![mutation_kind.as_str(), now],
  )?;
  let snapshot_id = conn.last_insert_rowid();
  conn.execute(
    "insert into stage_snapshot_files (snapshot_id, file_id)
     select ?1, file_id from stage_entries",
    params![snapshot_id],
  )?;
  conn.execute(
    "update stage_state set current_snapshot_id = ?1 where singleton = 1",
    params![snapshot_id],
  )?;
  Ok(snapshot_id)
}

fn restore_stage_snapshot(conn: &Connection, snapshot_id: i64) -> Result<StageHistoryReport> {
  conn.execute("delete from stage_entries", [])?;
  let now = Utc::now();
  conn.execute(
    "insert into stage_entries (file_id, added_at)
     select file_id, ?2
     from stage_snapshot_files
     where snapshot_id = ?1",
    params![snapshot_id, now],
  )?;
  conn.execute(
    "update stage_state set current_snapshot_id = ?1 where singleton = 1",
    params![snapshot_id],
  )?;
  let restored_files = list_staged_files(conn)?
    .into_iter()
    .map(|record| record.file)
    .collect::<Vec<_>>();
  Ok(StageHistoryReport {
    applied: true,
    restored_files,
  })
}

fn current_stage_snapshot_id(conn: &Connection) -> Result<i64> {
  current_stage_snapshot_id_optional(conn)?.ok_or(NafmError::StageHistoryUnavailable("undo"))
}

fn current_stage_snapshot_id_optional(conn: &Connection) -> Result<Option<i64>> {
  conn
    .query_row(
      "select current_snapshot_id from stage_state where singleton = 1",
      [],
      |row| row.get::<_, Option<i64>>(0),
    )
    .optional()
    .map(|row| row.flatten())
    .map_err(Into::into)
}

fn total_file_record_count(conn: &Connection) -> Result<u64> {
  conn
    .query_row("select count(*) from file_records", [], |row| row.get::<_, u64>(0))
    .map_err(Into::into)
}

fn tracked_file_exists(conn: &Connection, path: &Path) -> Result<bool> {
  conn
    .query_row(
      "select exists(select 1 from file_records where path = ?1)",
      params![path.to_string_lossy()],
      |row| row.get::<_, bool>(0),
    )
    .map_err(Into::into)
}

struct SiteOverviewScanState {
  inventory_revision: u64,
  inventory_completed_at: Option<DateTime<Utc>>,
  hash_completed_at: Option<DateTime<Utc>>,
  hash_algorithm: Option<String>,
}

struct SiteOverviewFileStats {
  total_file_count: u64,
  verified_file_count: u64,
  total_bytes: u64,
  verified_bytes: u64,
}

fn site_overview(conn: &Connection, site: Site) -> Result<SiteOverview> {
  let folders = list_site_folders(conn, Some(&site.id))?;
  let scan_state = conn
    .query_row(
      "select inventory_revision, inventory_completed_at, hash_completed_at, hash_algorithm
       from site_scan_state where site_id = ?1",
      params![site.id],
      |row| {
        Ok(SiteOverviewScanState {
          inventory_revision: row.get(0)?,
          inventory_completed_at: row.get(1)?,
          hash_completed_at: row.get(2)?,
          hash_algorithm: row.get(3)?,
        })
      },
    )
    .optional()?;
  let published_inventory_revision = scan_state
    .as_ref()
    .and_then(|state| state.inventory_completed_at.as_ref().map(|_| state.inventory_revision));
  let SiteOverviewFileStats {
    total_file_count,
    verified_file_count,
    total_bytes,
    verified_bytes,
  } = site_overview_file_stats(conn, &site.id, published_inventory_revision)?;
  let pending_hash_count = total_file_count.saturating_sub(verified_file_count);
  let analysis_ready = scan_state.as_ref().is_some_and(|state| {
    state.inventory_completed_at.is_some() && state.hash_completed_at.is_some() && pending_hash_count == 0
  });
  let (duplicate_file_count, duplicate_bytes) = if analysis_ready {
    site_overview_duplicate_stats(
      conn,
      &site.id,
      published_inventory_revision.expect("ready analysis should have a published inventory"),
    )?
  } else {
    (0, 0)
  };
  let (hash_status, latest_inventory_at, latest_scan_at) = match scan_state {
    None => (SiteHashStatus::Unscanned, None, None),
    Some(SiteOverviewScanState {
      inventory_completed_at: None,
      hash_algorithm: None,
      ..
    }) => (SiteHashStatus::Unscanned, None, None),
    Some(state) if pending_hash_count > 0 || state.hash_completed_at.is_none() => (
      SiteHashStatus::Pending,
      state.inventory_completed_at,
      state.hash_completed_at,
    ),
    Some(state) => (
      SiteHashStatus::Ready,
      state.inventory_completed_at,
      state.hash_completed_at,
    ),
  };

  Ok(SiteOverview {
    site,
    folders,
    total_file_count,
    verified_file_count,
    pending_hash_count,
    total_bytes,
    verified_bytes,
    duplicate_file_count,
    duplicate_bytes,
    hash_status,
    latest_inventory_at,
    latest_scan_at,
  })
}

fn site_overview_file_stats(
  conn: &Connection,
  site_id: &str,
  published_inventory_revision: Option<u64>,
) -> Result<SiteOverviewFileStats> {
  conn
    .query_row(
      "select
         count(*),
         coalesce(sum(
           case when ?2 is not null
             and inventory_revision = ?2
             and content_hash is not null
             and hash_revision = inventory_revision
           then 1 else 0 end
         ), 0),
         coalesce(sum(size_bytes), 0),
         coalesce(sum(
           case when ?2 is not null
             and inventory_revision = ?2
             and content_hash is not null
             and hash_revision = inventory_revision
           then size_bytes else 0 end
         ), 0)
       from file_records
       where site_id = ?1",
      params![site_id, published_inventory_revision],
      |row| {
        Ok(SiteOverviewFileStats {
          total_file_count: row.get(0)?,
          verified_file_count: row.get(1)?,
          total_bytes: row.get(2)?,
          verified_bytes: row.get(3)?,
        })
      },
    )
    .map_err(Into::into)
}

fn site_overview_duplicate_stats(conn: &Connection, site_id: &str, inventory_revision: u64) -> Result<(u64, u64)> {
  let mut stmt = conn.prepare(
    "select hash_algorithm, content_hash, size_bytes, count(*)
     from file_records
     where site_id = ?1
       and inventory_revision = ?2
       and content_hash is not null
       and hash_revision = inventory_revision
     group by hash_algorithm, content_hash, size_bytes
     having count(*) > 1",
  )?;
  let groups = stmt.query_map(params![site_id, inventory_revision], |row| {
    Ok((
      row.get::<_, String>(0)?,
      row.get::<_, String>(1)?,
      row.get::<_, u64>(2)?,
      row.get::<_, u64>(3)?,
    ))
  })?;
  let mut duplicate_file_count = 0_u64;
  let mut duplicate_bytes = 0_u64;
  for group in groups {
    let (_, _, size_bytes, copy_count) = group?;
    duplicate_file_count = duplicate_file_count.saturating_add(copy_count);
    duplicate_bytes = duplicate_bytes.saturating_add(size_bytes.saturating_mul(copy_count.saturating_sub(1)));
  }
  Ok((duplicate_file_count, duplicate_bytes))
}

fn storage_file_records(
  conn: &Connection,
  site_id: &str,
  coverage_target_content_keys: Option<&BTreeSet<StorageContentKey>>,
) -> Result<Vec<StorageFileRecord>> {
  let analysis_ready = site_has_completed_scan(conn, site_id)?;
  let published_inventory_revision = site_published_inventory_revision(conn, site_id)?;
  let mut rows = conn
    .prepare(
      "select site_folder_id, path, size_bytes, hash_algorithm, content_hash,
         coalesce(
           ?2 is not null
             and inventory_revision = ?2
             and content_hash is not null
             and hash_revision = inventory_revision,
           false
         )
       from file_records
       where site_id = ?1
       order by path",
    )?
    .query_map(params![site_id, published_inventory_revision], |row| {
      Ok((
        StorageFileRecord {
          site_folder_id: row.get(0)?,
          path: PathBuf::from(row.get::<_, String>(1)?),
          size_bytes: row.get(2)?,
          hash_verified: row.get(5)?,
          content_key: None,
          source_copy_count: 0,
          covered_by_target: None,
          duplicate: false,
          reclaimable: false,
        },
        row.get::<_, String>(3)?,
        row.get::<_, Option<String>>(4)?,
      ))
    })?
    .collect::<std::result::Result<Vec<_>, _>>()?;

  let mut groups = BTreeMap::<(String, String, u64), Vec<usize>>::new();
  for (index, (file, hash_algorithm, content_hash)) in rows.iter().enumerate() {
    if file.hash_verified
      && let Some(content_hash) = content_hash
    {
      groups
        .entry((hash_algorithm.clone(), content_hash.clone(), file.size_bytes))
        .or_default()
        .push(index);
    }
  }
  if analysis_ready {
    for indexes in groups.values().filter(|indexes| indexes.len() > 1) {
      for (group_index, row_index) in indexes.iter().enumerate() {
        rows[*row_index].0.duplicate = true;
        rows[*row_index].0.reclaimable = group_index > 0;
      }
    }
  }

  for ((hash_algorithm, content_hash, size_bytes), indexes) in &groups {
    let content_key = StorageContentKey {
      hash_algorithm: hash_algorithm.clone(),
      content_hash: content_hash.clone(),
      size_bytes: *size_bytes,
    };
    let covered_by_target =
      coverage_target_content_keys.map(|target_content_keys| target_content_keys.contains(&content_key));
    for row_index in indexes {
      let file = &mut rows[*row_index].0;
      file.content_key = Some(content_key.clone());
      file.source_copy_count = indexes.len() as u64;
      file.covered_by_target = covered_by_target;
    }
  }

  Ok(rows.into_iter().map(|(file, _, _)| file).collect())
}

fn site_has_completed_scan(conn: &Connection, site_id: &str) -> Result<bool> {
  let state = conn
    .query_row(
      "select inventory_revision, inventory_completed_at is not null, hash_completed_at is not null
       from site_scan_state where site_id = ?1",
      params![site_id],
      |row| Ok((row.get::<_, u64>(0)?, row.get::<_, bool>(1)?, row.get::<_, bool>(2)?)),
    )
    .optional()?;
  let Some((inventory_revision, has_inventory, has_hash_completion)) = state else {
    return Ok(false);
  };
  Ok(has_inventory && has_hash_completion && site_analysis_pending_count(conn, site_id, inventory_revision)? == 0)
}

fn site_published_inventory_revision(conn: &Connection, site_id: &str) -> Result<Option<u64>> {
  conn
    .query_row(
      "select inventory_revision
       from site_scan_state
       where site_id = ?1 and inventory_completed_at is not null",
      params![site_id],
      |row| row.get(0),
    )
    .optional()
    .map_err(Into::into)
}

fn site_inventory_hash_algorithm(conn: &Connection, site_id: &str) -> Result<Option<String>> {
  conn
    .query_row(
      "select hash_algorithm from site_scan_state
       where site_id = ?1 and inventory_completed_at is not null",
      params![site_id],
      |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
    .map_err(Into::into)
}

fn site_has_configured_folders(conn: &Connection, site_id: &str) -> Result<bool> {
  conn
    .query_row(
      "select exists(select 1 from site_folders where site_id = ?1)",
      params![site_id],
      |row| row.get::<_, bool>(0),
    )
    .map_err(Into::into)
}

fn site_analysis_pending_count(conn: &Connection, site_id: &str, inventory_revision: u64) -> Result<u64> {
  conn
    .query_row(
      "select count(*) from file_records
       where site_id = ?1
         and (
           inventory_revision <> ?2
           or content_hash is null
           or hash_revision is null
           or hash_revision <> inventory_revision
         )",
      params![site_id, inventory_revision],
      |row| row.get::<_, u64>(0),
    )
    .map_err(Into::into)
}

fn ensure_site_hash_ready(conn: &Connection, site_id: &str) -> Result<()> {
  let inventory_revision = conn
    .query_row(
      "select inventory_revision from site_scan_state
       where site_id = ?1
         and inventory_completed_at is not null
         and hash_completed_at is not null",
      params![site_id],
      |row| row.get::<_, u64>(0),
    )
    .optional()?;
  let pending_hashes = match inventory_revision {
    Some(inventory_revision) => site_analysis_pending_count(conn, site_id, inventory_revision)?,
    None => conn.query_row(
      "select count(*) from file_records
       where site_id = ?1
         and (content_hash is null or hash_revision is null or hash_revision <> inventory_revision)",
      params![site_id],
      |row| row.get::<_, u64>(0),
    )?,
  };
  if inventory_revision.is_none() || pending_hashes > 0 {
    return Err(NafmError::SiteHashesPending {
      site_id: site_id.to_owned(),
      pending_hashes,
    });
  }
  Ok(())
}

fn storage_content_keys(conn: &Connection, site_id: &str) -> Result<BTreeSet<StorageContentKey>> {
  let mut stmt = conn.prepare(
    "select distinct file.hash_algorithm, file.content_hash, file.size_bytes
     from file_records file
     join site_scan_state state on state.site_id = file.site_id
     where file.site_id = ?1
       and state.inventory_completed_at is not null
       and file.inventory_revision = state.inventory_revision
       and file.content_hash is not null
       and file.hash_revision = file.inventory_revision",
  )?;
  stmt
    .query_map(params![site_id], |row| {
      Ok(StorageContentKey {
        hash_algorithm: row.get(0)?,
        content_hash: row.get(1)?,
        size_bytes: row.get(2)?,
      })
    })?
    .collect::<std::result::Result<BTreeSet<_>, _>>()
    .map_err(Into::into)
}

fn storage_tree(
  conn: &Connection,
  site: Site,
  coverage_target: Option<Site>,
  max_depth: u32,
  max_children: u32,
) -> Result<StorageTree> {
  let root = build_storage_tree_root(conn, &site, coverage_target.as_ref())?;

  Ok(StorageTree {
    site,
    coverage_target,
    max_depth,
    max_children,
    root: finish_storage_node(root, 0, max_depth, max_children),
  })
}

fn storage_location(
  conn: &Connection,
  site: Site,
  coverage_target: Option<Site>,
  node_id: &str,
  max_depth: u32,
  max_children: u32,
) -> Result<StorageLocation> {
  if parse_smaller_items_node_id(node_id).is_some() {
    return Err(NafmError::StorageNodeNotNavigable(node_id.to_owned()));
  }

  let root = build_storage_tree_root(conn, &site, coverage_target.as_ref())?;
  let node_path =
    find_storage_node_builder_path(&root, node_id).ok_or_else(|| NafmError::StorageNodeNotFound(node_id.to_owned()))?;
  let selected = node_path.last().expect("a storage node path should contain its root");
  if matches!(selected.kind, StorageNodeKind::File | StorageNodeKind::SmallerItems) {
    return Err(NafmError::StorageNodeNotNavigable(node_id.to_owned()));
  }
  let breadcrumbs = node_path
    .iter()
    .map(|node| storage_node_without_children(node))
    .collect();

  Ok(StorageLocation {
    site,
    coverage_target,
    max_depth,
    max_children,
    breadcrumbs,
    root: finish_storage_node((*selected).clone(), 0, max_depth, max_children),
  })
}

fn storage_view_snapshot(
  conn: &Connection,
  site: Site,
  coverage_target: Option<Site>,
  node_id: &str,
  parameters: StorageViewParameters,
) -> Result<StorageViewSnapshot> {
  let StorageViewParameters {
    offset,
    max_depth,
    max_children,
    page_limit,
  } = parameters;
  if parse_smaller_items_node_id(node_id).is_some() {
    return Err(NafmError::StorageNodeNotNavigable(node_id.to_owned()));
  }

  let root = build_storage_tree_root(conn, &site, coverage_target.as_ref())?;
  let node_path =
    find_storage_node_builder_path(&root, node_id).ok_or_else(|| NafmError::StorageNodeNotFound(node_id.to_owned()))?;
  let selected = node_path.last().expect("a storage node path should contain its root");
  if matches!(selected.kind, StorageNodeKind::File | StorageNodeKind::SmallerItems) {
    return Err(NafmError::StorageNodeNotNavigable(node_id.to_owned()));
  }

  let breadcrumbs = node_path
    .iter()
    .map(|node| storage_node_without_children(node))
    .collect();
  let location_root = finish_storage_node((*selected).clone(), 0, max_depth, max_children);
  let page_limit = page_limit.clamp(1, MAX_STORAGE_CHILDREN_PAGE_SIZE);
  let mut child_builders = selected.children.values().collect::<Vec<_>>();
  child_builders.sort_by(|left, right| storage_node_builder_order(left, right));
  let total_children = child_builders.len() as u64;
  let page_offset = if total_children == 0 {
    0
  } else if offset >= total_children {
    (total_children - 1) / page_limit * page_limit
  } else {
    offset
  };
  let page_children = child_builders
    .into_iter()
    .skip(usize::try_from(page_offset).unwrap_or(usize::MAX))
    .take(page_limit as usize)
    .map(storage_node_without_children)
    .collect();
  let page_parent = storage_node_without_children(selected);

  Ok(StorageViewSnapshot {
    tree: StorageTree {
      site: site.clone(),
      coverage_target: coverage_target.clone(),
      max_depth,
      max_children,
      root: finish_storage_node(root, 0, max_depth, max_children),
    },
    location: StorageLocation {
      site: site.clone(),
      coverage_target: coverage_target.clone(),
      max_depth,
      max_children,
      breadcrumbs,
      root: location_root,
    },
    page: StorageChildrenPage {
      site,
      coverage_target,
      parent: page_parent,
      children: page_children,
      total_children,
      offset: page_offset,
      limit: page_limit,
    },
  })
}

fn storage_file_reveal(
  conn: &Connection,
  site: Site,
  coverage_target: Option<Site>,
  file: &RevealFileRecord,
  max_depth: u32,
  max_children: u32,
  page_limit: u64,
) -> Result<StorageFileReveal> {
  let root = build_storage_tree_root(conn, &site, coverage_target.as_ref())?;
  let selected_node_id = format!("storage:{}:{}", file.site_folder_id, file.path.display());
  let selected_path = find_storage_node_builder_path(&root, &selected_node_id)
    .ok_or_else(|| NafmError::TrackedFileNotFound(file.id.clone()))?;
  let (selected, parent_path) = selected_path
    .split_last()
    .expect("a selected storage file path should contain a file");
  if selected.kind != StorageNodeKind::File {
    return Err(NafmError::TrackedFileNotFound(file.id.clone()));
  }
  let parent = parent_path
    .last()
    .expect("a selected storage file should have a parent");
  let mut child_builders = parent.children.values().collect::<Vec<_>>();
  child_builders.sort_by(|left, right| storage_node_builder_order(left, right));
  let selected_index = child_builders
    .iter()
    .position(|child| child.id == selected.id)
    .ok_or_else(|| NafmError::TrackedFileNotFound(file.id.clone()))?;
  let page_limit = page_limit.clamp(1, MAX_STORAGE_CHILDREN_PAGE_SIZE);
  let offset = selected_index as u64 / page_limit * page_limit;
  let selected_file = storage_node_without_children(selected);
  let page_children = child_builders
    .into_iter()
    .skip(offset as usize)
    .take(page_limit as usize)
    .map(storage_node_without_children)
    .collect();

  Ok(StorageFileReveal {
    tree: StorageTree {
      site: site.clone(),
      coverage_target: coverage_target.clone(),
      max_depth,
      max_children,
      root: finish_storage_node(root.clone(), 0, max_depth, max_children),
    },
    location: StorageLocation {
      site: site.clone(),
      coverage_target: coverage_target.clone(),
      max_depth,
      max_children,
      breadcrumbs: parent_path
        .iter()
        .map(|node| storage_node_without_children(node))
        .collect(),
      root: finish_storage_node((*parent).clone(), 0, max_depth, max_children),
    },
    page: StorageChildrenPage {
      site,
      coverage_target,
      parent: storage_node_without_children(parent),
      children: page_children,
      total_children: parent.children.len() as u64,
      offset,
      limit: page_limit,
    },
    selected_file,
  })
}

fn build_storage_tree_root(
  conn: &Connection,
  site: &Site,
  coverage_target: Option<&Site>,
) -> Result<StorageNodeBuilder> {
  let folders = list_site_folders(conn, Some(&site.id))?;
  let analysis_ready = site_has_completed_scan(conn, &site.id)?;
  let source_hash_algorithm = site_inventory_hash_algorithm(conn, &site.id)?;
  let (coverage_target_content_keys, coverage_ready) = match coverage_target {
    Some(target) => {
      let target_hash_algorithm = site_inventory_hash_algorithm(conn, &target.id)?;
      if source_hash_algorithm.is_some() && source_hash_algorithm == target_hash_algorithm {
        (
          Some(storage_content_keys(conn, &target.id)?),
          analysis_ready && site_has_completed_scan(conn, &target.id)?,
        )
      } else {
        (None, false)
      }
    }
    None => (None, false),
  };
  let files = storage_file_records(conn, &site.id, coverage_target_content_keys.as_ref())?;
  let mut root = StorageNodeBuilder::new(
    format!("site:{}", site.id),
    site.name.clone(),
    None,
    StorageNodeKind::Site,
  );

  for folder in &folders {
    root.children.insert(
      folder.id.clone(),
      StorageNodeBuilder::new(
        format!("site_folder:{}", folder.id),
        storage_root_name(folder),
        Some(folder.path.clone()),
        match folder.kind {
          SiteFolderKind::Local => StorageNodeKind::LocalRoot,
          SiteFolderKind::Smb => StorageNodeKind::SmbRoot,
        },
      ),
    );
  }

  let folders_by_id = folders
    .iter()
    .map(|folder| (folder.id.as_str(), folder))
    .collect::<BTreeMap<_, _>>();
  for file in &files {
    let Some(folder) = folders_by_id.get(file.site_folder_id.as_str()) else {
      continue;
    };
    let segments = storage_relative_segments(folder, &file.path)?;
    if segments.is_empty() {
      continue;
    }

    root.add_file_metrics(file);
    let folder_node = root
      .children
      .get_mut(&folder.id)
      .expect("site folder node should exist");
    folder_node.add_file_metrics(file);
    insert_storage_file(folder_node, folder, &segments, file)?;
  }

  root.set_analysis_ready(analysis_ready, coverage_ready);

  Ok(root)
}

fn storage_children_page(
  conn: &Connection,
  site: Site,
  coverage_target: Option<Site>,
  node_id: &str,
  offset: u64,
  limit: u64,
) -> Result<StorageChildrenPage> {
  let root = build_storage_tree_root(conn, &site, coverage_target.as_ref())?;
  let limit = limit.clamp(1, MAX_STORAGE_CHILDREN_PAGE_SIZE);

  if let Some((retained_count, parent_id)) = parse_smaller_items_node_id(node_id) {
    let parent_builder =
      find_storage_node_builder(&root, parent_id).ok_or_else(|| NafmError::StorageNodeNotFound(node_id.to_owned()))?;
    let mut child_builders = parent_builder.children.values().cloned().collect::<Vec<_>>();
    sort_storage_node_builders(&mut child_builders);
    if retained_count >= child_builders.len() {
      return Err(NafmError::StorageNodeNotFound(node_id.to_owned()));
    }
    let parent = consolidate_storage_nodes(
      parent_id,
      retained_count,
      child_builders.into_iter().skip(retained_count).collect(),
    );
    return Ok(StorageChildrenPage {
      site,
      coverage_target,
      parent,
      children: Vec::new(),
      total_children: 0,
      offset,
      limit,
    });
  }

  let parent_builder =
    find_storage_node_builder(&root, node_id).ok_or_else(|| NafmError::StorageNodeNotFound(node_id.to_owned()))?;
  let mut child_builders = parent_builder.children.values().collect::<Vec<_>>();
  child_builders.sort_by(|left, right| storage_node_builder_order(left, right));
  let total_children = child_builders.len() as u64;
  let children = child_builders
    .into_iter()
    .skip(usize::try_from(offset).unwrap_or(usize::MAX))
    .take(limit as usize)
    .map(storage_node_without_children)
    .collect();

  Ok(StorageChildrenPage {
    site,
    coverage_target,
    parent: storage_node_without_children(parent_builder),
    children,
    total_children,
    offset,
    limit,
  })
}

fn parse_smaller_items_node_id(node_id: &str) -> Option<(usize, &str)> {
  let (retained_count, parent_id) = node_id.strip_prefix("smaller_items:")?.split_once(':')?;
  Some((retained_count.parse().ok()?, parent_id))
}

fn find_storage_node_builder<'a>(root: &'a StorageNodeBuilder, node_id: &str) -> Option<&'a StorageNodeBuilder> {
  let mut pending = vec![root];
  while let Some(node) = pending.pop() {
    if node.id == node_id {
      return Some(node);
    }
    pending.extend(node.children.values());
  }
  None
}

fn find_storage_node_builder_path<'a>(
  root: &'a StorageNodeBuilder,
  node_id: &str,
) -> Option<Vec<&'a StorageNodeBuilder>> {
  if root.id == node_id {
    return Some(vec![root]);
  }
  for child in root.children.values() {
    if let Some(mut path) = find_storage_node_builder_path(child, node_id) {
      path.insert(0, root);
      return Some(path);
    }
  }
  None
}

fn storage_node_builder_order(left: &StorageNodeBuilder, right: &StorageNodeBuilder) -> std::cmp::Ordering {
  right
    .total_bytes
    .cmp(&left.total_bytes)
    .then_with(|| left.name.cmp(&right.name))
    .then_with(|| left.id.cmp(&right.id))
}

fn sort_storage_node_builders(nodes: &mut [StorageNodeBuilder]) {
  nodes.sort_by(storage_node_builder_order);
}

fn storage_root_name(folder: &SiteFolder) -> String {
  if folder.kind == SiteFolderKind::Smb {
    return SmbLocation::parse(&folder.path.to_string_lossy())
      .ok()
      .and_then(|location| {
        location
          .relative_path
          .rsplit('/')
          .find(|segment| !segment.is_empty())
          .map(str::to_owned)
          .or(Some(location.share))
      })
      .unwrap_or_else(|| folder.path.display().to_string());
  }

  folder
    .path
    .file_name()
    .map(|name| name.to_string_lossy().into_owned())
    .filter(|name| !name.is_empty())
    .unwrap_or_else(|| folder.path.display().to_string())
}

fn storage_relative_segments(folder: &SiteFolder, file_path: &Path) -> Result<Vec<String>> {
  if folder.kind == SiteFolderKind::Smb {
    let folder_location = SmbLocation::parse(&folder.path.to_string_lossy())?;
    let file_location = SmbLocation::parse(&file_path.to_string_lossy())?;
    if folder_location.server_address != file_location.server_address
      || !folder_location.share.eq_ignore_ascii_case(&file_location.share)
    {
      return Ok(Vec::new());
    }
    let folder_segments = folder_location
      .relative_path
      .split('/')
      .filter(|segment| !segment.is_empty())
      .collect::<Vec<_>>();
    let file_segments = file_location
      .relative_path
      .split('/')
      .filter(|segment| !segment.is_empty())
      .collect::<Vec<_>>();
    return Ok(
      file_segments
        .strip_prefix(folder_segments.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|segment| (*segment).to_owned())
        .collect(),
    );
  }

  Ok(
    file_path
      .strip_prefix(&folder.path)
      .unwrap_or(file_path)
      .components()
      .map(|component| component.as_os_str().to_string_lossy().into_owned())
      .collect(),
  )
}

fn insert_storage_file(
  folder_node: &mut StorageNodeBuilder,
  folder: &SiteFolder,
  segments: &[String],
  file: &StorageFileRecord,
) -> Result<()> {
  let mut current = folder_node;
  for (index, name) in segments.iter().enumerate() {
    let path = storage_child_path(folder, &segments[..=index])?;
    let kind = if index + 1 == segments.len() {
      StorageNodeKind::File
    } else {
      StorageNodeKind::Directory
    };
    let id = format!("storage:{}:{}", folder.id, path.display());
    current = current
      .children
      .entry(name.clone())
      .or_insert_with(|| StorageNodeBuilder::new(id, name.clone(), Some(path), kind));
    current.add_file_metrics(file);
  }
  Ok(())
}

fn storage_child_path(folder: &SiteFolder, segments: &[String]) -> Result<PathBuf> {
  if folder.kind == SiteFolderKind::Smb {
    let location = SmbLocation::parse(&folder.path.to_string_lossy())?;
    return Ok(PathBuf::from(location.join_path_segments(segments)?));
  }
  Ok(
    segments
      .iter()
      .fold(folder.path.clone(), |path, segment| path.join(segment)),
  )
}

fn finish_storage_node(builder: StorageNodeBuilder, depth: u32, max_depth: u32, max_children: u32) -> StorageNode {
  let space_health = builder.space_health();
  let estimated_space_health = builder.estimated_space_health();
  let coverage_health = builder.coverage_health();
  let estimated_coverage_health = builder.estimated_coverage_health();
  let (coverage_covered_files, coverage_total_files) = builder.coverage_file_counts();
  let mut child_builders = builder.children.into_values().collect::<Vec<_>>();
  sort_storage_node_builders(&mut child_builders);

  let children = if depth >= max_depth || max_children == 0 {
    Vec::new()
  } else if child_builders.len() <= max_children as usize {
    child_builders
      .into_iter()
      .map(|child| finish_storage_node(child, depth + 1, max_depth, max_children))
      .collect()
  } else {
    let retained_count = max_children.saturating_sub(1) as usize;
    let consolidated = child_builders.split_off(retained_count);
    let mut children = child_builders
      .into_iter()
      .map(|child| finish_storage_node(child, depth + 1, max_depth, max_children))
      .collect::<Vec<_>>();
    children.push(consolidate_storage_nodes(&builder.id, retained_count, consolidated));
    children
  };

  StorageNode {
    id: builder.id,
    name: builder.name,
    path: builder.path,
    kind: builder.kind,
    total_bytes: builder.total_bytes,
    file_count: builder.file_count,
    verified_file_count: builder.verified_file_count,
    pending_hash_count: builder.pending_hash_count,
    verified_bytes: builder.verified_bytes,
    duplicate_bytes: builder.duplicate_bytes,
    duplicate_file_count: builder.duplicate_file_count,
    space_health,
    estimated_space_health,
    space_healthy_file_equivalents: builder.space_healthy_file_equivalents,
    space_total_files: builder.space_total_files,
    coverage_health,
    estimated_coverage_health,
    coverage_covered_files,
    coverage_total_files,
    children,
  }
}

fn storage_node_without_children(builder: &StorageNodeBuilder) -> StorageNode {
  let (coverage_covered_files, coverage_total_files) = builder.coverage_file_counts();
  StorageNode {
    id: builder.id.clone(),
    name: builder.name.clone(),
    path: builder.path.clone(),
    kind: builder.kind,
    total_bytes: builder.total_bytes,
    file_count: builder.file_count,
    verified_file_count: builder.verified_file_count,
    pending_hash_count: builder.pending_hash_count,
    verified_bytes: builder.verified_bytes,
    duplicate_bytes: builder.duplicate_bytes,
    duplicate_file_count: builder.duplicate_file_count,
    space_health: builder.space_health(),
    estimated_space_health: builder.estimated_space_health(),
    space_healthy_file_equivalents: builder.space_healthy_file_equivalents,
    space_total_files: builder.space_total_files,
    coverage_health: builder.coverage_health(),
    estimated_coverage_health: builder.estimated_coverage_health(),
    coverage_covered_files,
    coverage_total_files,
    children: Vec::new(),
  }
}

fn consolidate_storage_nodes(parent_id: &str, retained_count: usize, nodes: Vec<StorageNodeBuilder>) -> StorageNode {
  let analysis_ready = nodes.iter().all(|node| node.analysis_ready);
  let coverage_ready = nodes.iter().all(|node| node.coverage_ready);
  let total_bytes = nodes.iter().map(|node| node.total_bytes).sum::<u64>();
  let file_count = nodes.iter().map(|node| node.file_count).sum::<u64>();
  let verified_file_count = nodes.iter().map(|node| node.verified_file_count).sum::<u64>();
  let pending_hash_count = nodes.iter().map(|node| node.pending_hash_count).sum::<u64>();
  let verified_bytes = nodes.iter().map(|node| node.verified_bytes).sum::<u64>();
  let space_health_weighted_bytes = nodes.iter().map(|node| node.space_health_weighted_bytes).sum::<f64>();
  let space_healthy_file_equivalents = nodes
    .iter()
    .map(|node| node.space_healthy_file_equivalents)
    .sum::<f64>();
  let estimated_space_health = estimated_space_health(
    verified_file_count,
    total_bytes,
    file_count,
    space_health_weighted_bytes,
    space_healthy_file_equivalents,
  );
  let space_health = (analysis_ready && pending_hash_count == 0)
    .then_some(estimated_space_health)
    .flatten();
  let mut coverage_groups = BTreeMap::<StorageContentKey, bool>::new();
  for node in &nodes {
    for (content_key, covered) in &node.coverage_groups {
      coverage_groups
        .entry(content_key.clone())
        .and_modify(|aggregate_covered| *aggregate_covered |= *covered)
        .or_insert(*covered);
    }
  }
  let estimated_coverage_health = estimated_coverage_health(
    verified_file_count,
    total_bytes,
    verified_bytes,
    pending_hash_count,
    &coverage_groups,
  );
  let coverage_health = (coverage_ready && pending_hash_count == 0)
    .then_some(estimated_coverage_health)
    .flatten();
  StorageNode {
    id: format!("smaller_items:{retained_count}:{parent_id}"),
    name: "Smaller items".to_owned(),
    path: None,
    kind: StorageNodeKind::SmallerItems,
    total_bytes,
    file_count,
    verified_file_count,
    pending_hash_count,
    verified_bytes,
    duplicate_bytes: nodes.iter().map(|node| node.duplicate_bytes).sum(),
    duplicate_file_count: nodes.iter().map(|node| node.duplicate_file_count).sum(),
    space_health,
    estimated_space_health,
    space_healthy_file_equivalents,
    space_total_files: nodes.iter().map(|node| node.space_total_files).sum(),
    coverage_health,
    estimated_coverage_health,
    coverage_covered_files: coverage_groups.values().filter(|covered| **covered).count() as u64,
    coverage_total_files: coverage_groups.len() as u64,
    children: Vec::new(),
  }
}

fn list_sites(conn: &Connection) -> Result<Vec<Site>> {
  let mut stmt = conn.prepare(
    "select id, name, added_at
     from sites
     order by name",
  )?;
  stmt
    .query_map([], site_from_row)?
    .collect::<std::result::Result<Vec<_>, _>>()
    .map_err(Into::into)
}

fn list_site_folders(conn: &Connection, site_id: Option<&str>) -> Result<Vec<SiteFolder>> {
  if let Some(site_id) = site_id {
    let mut stmt = conn.prepare(
      "select id, site_id, kind, path, hidden_policy, added_at
       from site_folders
       where site_id = ?1
       order by path",
    )?;
    stmt
      .query_map(params![site_id], site_folder_from_row)?
      .collect::<std::result::Result<Vec<_>, _>>()
      .map_err(Into::into)
  } else {
    let mut stmt = conn.prepare(
      "select id, site_id, kind, path, hidden_policy, added_at
       from site_folders
       order by path",
    )?;
    stmt
      .query_map([], site_folder_from_row)?
      .collect::<std::result::Result<Vec<_>, _>>()
      .map_err(Into::into)
  }
}

fn site_folder_configuration_matches(expected: &[SiteFolder], current: &[SiteFolder]) -> bool {
  expected.len() == current.len()
    && expected.iter().zip(current).all(|(expected, current)| {
      expected.id == current.id
        && expected.site_id == current.site_id
        && expected.kind == current.kind
        && expected.path == current.path
        && expected.hidden_policy == current.hidden_policy
    })
}

fn file_counts_by_parent_folder(conn: &Connection, site_id: Option<&str>) -> Result<BTreeMap<String, u64>> {
  let paths = if let Some(site_id) = site_id {
    let mut stmt = conn.prepare(
      "select path
       from file_records
       where site_id = ?1",
    )?;
    stmt
      .query_map(params![site_id], |row| row.get::<_, String>(0))?
      .collect::<std::result::Result<Vec<_>, _>>()?
  } else {
    let mut stmt = conn.prepare("select path from file_records")?;
    stmt
      .query_map([], |row| row.get::<_, String>(0))?
      .collect::<std::result::Result<Vec<_>, _>>()?
  };

  let mut counts = BTreeMap::new();
  for path in paths {
    let parent = Path::new(&path)
      .parent()
      .unwrap_or_else(|| Path::new(""))
      .display()
      .to_string();
    *counts.entry(parent).or_insert(0) += 1;
  }

  Ok(counts)
}

fn find_site(conn: &Connection, selector: &str) -> Result<Option<Site>> {
  conn
    .query_row(
      "select id, name, added_at
       from sites
       where id = ?1 or name = ?1",
      params![selector],
      site_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn find_site_by_name(conn: &Connection, name: &str) -> Result<Option<Site>> {
  conn
    .query_row(
      "select id, name, added_at
       from sites
       where name = ?1",
      params![name],
      site_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn find_site_folder(conn: &Connection, id: &str) -> Result<Option<SiteFolder>> {
  conn
    .query_row(
      "select id, site_id, kind, path, hidden_policy, added_at
       from site_folders
       where id = ?1",
      params![id],
      site_folder_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn site_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Site> {
  Ok(Site {
    id: row.get(0)?,
    name: row.get(1)?,
    added_at: row.get(2)?,
  })
}

fn site_folder_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SiteFolder> {
  let kind: String = row.get(2)?;
  let hidden_policy: String = row.get(4)?;
  Ok(SiteFolder {
    id: row.get(0)?,
    site_id: row.get(1)?,
    kind: site_folder_kind_from_db(&kind),
    path: PathBuf::from(row.get::<_, String>(3)?),
    hidden_policy: hidden_policy_from_db(&hidden_policy),
    added_at: row.get(5)?,
  })
}

fn site_folder_kind_to_db(kind: SiteFolderKind) -> &'static str {
  match kind {
    SiteFolderKind::Local => "local",
    SiteFolderKind::Smb => "smb",
  }
}

fn site_folder_kind_from_db(value: &str) -> SiteFolderKind {
  match value {
    "smb" => SiteFolderKind::Smb,
    _ => SiteFolderKind::Local,
  }
}

fn hidden_policy_to_db(policy: HiddenPolicy) -> &'static str {
  match policy {
    HiddenPolicy::Include => "include",
    HiddenPolicy::Skip => "skip",
  }
}

fn hidden_policy_from_db(value: &str) -> HiddenPolicy {
  match value {
    "skip" => HiddenPolicy::Skip,
    _ => HiddenPolicy::Include,
  }
}

#[cfg(test)]
mod transaction_tests {
  use super::*;

  #[test]
  fn deferred_transaction_pins_reads_while_another_connection_commits() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("read-snapshot.sqlite3");
    let setup = Connection::open(&path).unwrap();
    setup
      .execute_batch(
        "pragma journal_mode = wal;
         create table revision (value integer not null);
         insert into revision (value) values (1);",
      )
      .unwrap();
    drop(setup);

    let reader = open_connection(&path).unwrap();
    let writer = open_connection(&path).unwrap();
    let observed = with_deferred_transaction(&reader, || {
      let before = reader.query_row("select value from revision", [], |row| row.get::<_, u64>(0))?;
      writer.execute("update revision set value = 2", [])?;
      let after = reader.query_row("select value from revision", [], |row| row.get::<_, u64>(0))?;
      Ok((before, after))
    })
    .unwrap();

    assert_eq!(observed, (1, 1));
    assert_eq!(
      writer
        .query_row("select value from revision", [], |row| row.get::<_, u64>(0))
        .unwrap(),
      2
    );
  }
}
