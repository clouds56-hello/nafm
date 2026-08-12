use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{SystemTime, UNIX_EPOCH};

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
  FileContentMatchesPage, HiddenPolicy, MissingContentGroup, ScanEvent, ScanProgress, ScanStarted, ScanSummary, Site,
  SiteFolder, SiteFolderKind, SiteOverview, StageAddReport, StageCommitDryRun, StageHistoryReport, StageRemoveReport,
  StageResetReport, StageWarning, StageWarningReason, StorageChildrenPage, StorageLocation, StorageNode,
  StorageNodeKind, StorageTree,
};

type ScanProgressCallback = Arc<dyn Fn(&ScanProgress) + Send + Sync>;
type ScanEventCallback = Arc<dyn Fn(&ScanEvent) + Send + Sync>;
type ScanCancellationCallback = Arc<dyn Fn() -> bool + Send + Sync>;

const MAX_STORAGE_CHILDREN_PAGE_SIZE: u64 = 200;
const MAX_FILE_CONTENT_MATCHES_PAGE_SIZE: u64 = 200;

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
  id: String,
  content_hash: Option<String>,
  hash_algorithm: String,
}

#[derive(Clone, Debug)]
struct CachedScanRecord {
  content_hash: String,
}

#[derive(Clone, Debug)]
struct PendingFileRecord {
  file: FileProbe,
  content_hash: Option<String>,
}

#[derive(Clone, Debug)]
struct StorageFileRecord {
  site_folder_id: String,
  path: PathBuf,
  size_bytes: u64,
  content_key: Option<StorageContentKey>,
  source_copy_count: u64,
  covered_by_target: Option<bool>,
  duplicate: bool,
  reclaimable: bool,
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
  duplicate_bytes: u64,
  duplicate_file_count: u64,
  space_health_weighted_bytes: f64,
  space_health_bytes: u128,
  zero_byte_space_health_sum: f64,
  zero_byte_space_health_count: u64,
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
      duplicate_bytes: 0,
      duplicate_file_count: 0,
      space_health_weighted_bytes: 0.0,
      space_health_bytes: 0,
      zero_byte_space_health_sum: 0.0,
      zero_byte_space_health_count: 0,
      space_healthy_file_equivalents: 0.0,
      space_total_files: 0,
      coverage_groups: BTreeMap::new(),
      children: BTreeMap::new(),
    }
  }

  fn add_file_metrics(&mut self, file: &StorageFileRecord) {
    self.total_bytes = self.total_bytes.saturating_add(file.size_bytes);
    self.file_count = self.file_count.saturating_add(1);
    if file.duplicate {
      self.duplicate_file_count = self.duplicate_file_count.saturating_add(1);
    }
    if file.reclaimable {
      self.duplicate_bytes = self.duplicate_bytes.saturating_add(file.size_bytes);
    }
    if file.source_copy_count > 0 && file.content_key.is_some() {
      let file_health = 100.0 / file.source_copy_count as f64;
      self.space_healthy_file_equivalents += 1.0 / file.source_copy_count as f64;
      self.space_total_files = self.space_total_files.saturating_add(1);
      if file.size_bytes > 0 {
        self.space_health_weighted_bytes += file.size_bytes as f64 * file_health;
        self.space_health_bytes += u128::from(file.size_bytes);
      } else {
        self.zero_byte_space_health_sum += file_health;
        self.zero_byte_space_health_count = self.zero_byte_space_health_count.saturating_add(1);
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
    if self.space_health_bytes > 0 {
      Some((self.space_health_weighted_bytes / self.space_health_bytes as f64).clamp(0.0, 100.0))
    } else if self.zero_byte_space_health_count > 0 {
      Some((self.zero_byte_space_health_sum / self.zero_byte_space_health_count as f64).clamp(0.0, 100.0))
    } else {
      None
    }
  }

  fn coverage_health(&self) -> Option<f64> {
    let total_bytes = self
      .coverage_groups
      .keys()
      .map(|content_key| u128::from(content_key.size_bytes))
      .sum::<u128>();
    if total_bytes == 0 {
      return (!self.coverage_groups.is_empty()).then(|| {
        self.coverage_groups.values().filter(|covered| **covered).count() as f64 * 100.0
          / self.coverage_groups.len() as f64
      });
    }
    let covered_bytes = self
      .coverage_groups
      .iter()
      .filter(|(_, covered)| **covered)
      .map(|(content_key, _)| u128::from(content_key.size_bytes))
      .sum::<u128>();
    Some((covered_bytes as f64 * 100.0 / total_bytes as f64).clamp(0.0, 100.0))
  }

  fn coverage_file_counts(&self) -> (u64, u64) {
    (
      self.coverage_groups.values().filter(|covered| **covered).count() as u64,
      self.coverage_groups.len() as u64,
    )
  }
}

#[derive(Clone, Debug)]
struct ScanProgressContext {
  site_id: String,
  site_name: String,
  files_reused: u64,
  total_files: u64,
}

struct ScanExecutionContext<'a> {
  progress_callback: Option<&'a ScanProgressCallback>,
  progress_context: &'a Arc<ScanProgressContext>,
  processed_files: &'a AtomicU64,
  cancellation_callback: Option<&'a ScanCancellationCallback>,
}

struct ScanPreparation {
  pending_records: Vec<PendingFileRecord>,
  hash_targets: Vec<(usize, FileProbe)>,
  files_seen: u64,
  files_hashed: u64,
  files_reused: u64,
  bytes_hashed: u64,
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
        conn.execute(
          "delete from site_scan_state where site_id = ?1",
          params![site_folder.site_id],
        )?;
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
        conn.execute(
          "delete from site_scan_state where site_id = ?1",
          params![site_folder.site_id],
        )?;
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
      list_sites(&conn)?
        .into_iter()
        .map(|site| site_overview(&conn, site))
        .collect()
    })
    .await?
  }

  pub async fn site_overview(&self, site_selector: &str) -> Result<SiteOverview> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      site_overview(&conn, site)
    })
    .await?
  }

  pub async fn storage_tree(&self, site_selector: &str, max_depth: u32, max_children: u32) -> Result<StorageTree> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(db_path)?;
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      storage_tree(&conn, site, None, max_depth, max_children)
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
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      let target_site =
        find_site(&conn, &target_site_selector)?.ok_or_else(|| NafmError::SiteNotFound(target_site_selector))?;
      storage_tree(&conn, site, Some(target_site), max_depth, max_children)
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
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      storage_location(&conn, site, None, &node_id, max_depth, max_children)
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
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      let target_site =
        find_site(&conn, &target_site_selector)?.ok_or_else(|| NafmError::SiteNotFound(target_site_selector))?;
      storage_location(&conn, site, Some(target_site), &node_id, max_depth, max_children)
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
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      storage_children_page(&conn, site, None, &node_id, offset, limit)
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
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector))?;
      let target_site =
        find_site(&conn, &target_site_selector)?.ok_or_else(|| NafmError::SiteNotFound(target_site_selector))?;
      storage_children_page(&conn, site, Some(target_site), &node_id, offset, limit)
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
    while let Some(result) = tasks.join_next().await {
      let (index, summary) = result?;
      let summary = summary?;
      if let Some(event_callback) = &event_callback {
        event_callback(&ScanEvent::Summary(summary.clone()));
      }
      summaries[index] = Some(summary);
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
    let (site, site_folders) = task::spawn_blocking(move || {
      let conn = open_connection(&lookup_db_path)?;
      let site = find_site(&conn, &selector)?.ok_or_else(|| NafmError::SiteNotFound(selector.clone()))?;
      let site_folders = list_site_folders(&conn, Some(&site.id))?;
      Ok::<_, NafmError>((site, site_folders))
    })
    .await??;

    if site_folders.iter().any(|folder| folder.kind == SiteFolderKind::Smb) {
      return self
        .scan_site_with_smb(&site, &site_folders, progress_callback, cancellation_callback)
        .await;
    }

    let hash_algorithm = self.hash_algorithm.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(&db_path)?;
      scan_site_blocking(
        &conn,
        &db_path,
        &site,
        &site_folders,
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
    progress_callback: Option<ScanProgressCallback>,
    cancellation_callback: Option<ScanCancellationCallback>,
  ) -> Result<ScanSummary> {
    check_scan_cancelled(cancellation_callback.as_ref())?;
    let mut files_by_path = BTreeMap::new();
    let local_folders = site_folders
      .iter()
      .filter(|folder| folder.kind == SiteFolderKind::Local)
      .cloned()
      .collect::<Vec<_>>();
    if !local_folders.is_empty() {
      let local_cancellation_callback = cancellation_callback.clone();
      for file in
        task::spawn_blocking(move || discover_site_files(&local_folders, local_cancellation_callback.as_ref()))
          .await??
      {
        files_by_path.insert(file.path.clone(), file);
      }
    }

    let mut smb_folders = site_folders
      .iter()
      .filter(|folder| folder.kind == SiteFolderKind::Smb)
      .cloned()
      .collect::<Vec<_>>();
    smb_folders.sort_by_key(|folder| std::cmp::Reverse(folder.path.components().count()));
    for site_folder in &smb_folders {
      check_scan_cancelled(cancellation_callback.as_ref())?;
      for file in discover_smb_files(site_folder, &self.credential_store, cancellation_callback.as_ref()).await? {
        files_by_path.entry(file.path.clone()).or_insert(file);
      }
    }

    let db_path = self.db_path.clone();
    let preparation_db_path = db_path.clone();
    let preparation_site = site.clone();
    let hash_algorithm_name = self.hash_algorithm.name().to_owned();
    let mut preparation = task::spawn_blocking(move || {
      let conn = open_connection(preparation_db_path)?;
      prepare_scan(
        &conn,
        &preparation_site,
        files_by_path.into_values().collect(),
        &hash_algorithm_name,
      )
    })
    .await??;

    let progress_context = Arc::new(ScanProgressContext {
      site_id: site.id.clone(),
      site_name: site.name.clone(),
      files_reused: preparation.files_reused,
      total_files: preparation.files_seen,
    });
    let processed_files = Arc::new(AtomicU64::new(0));
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
      let hashed_records = task::spawn_blocking(move || {
        let execution = ScanExecutionContext {
          progress_callback: local_progress_callback.as_ref(),
          progress_context: &local_progress_context,
          processed_files: &local_processed_files,
          cancellation_callback: local_cancellation_callback.as_ref(),
        };
        hash_files_in_parallel(
          &local_db_path,
          &local_site,
          &local_targets,
          local_hash_algorithm.as_ref(),
          &execution,
        )
      })
      .await??;
      for (index, content_hash) in hashed_records {
        preparation.pending_records[index].content_hash = Some(content_hash);
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
      let credential = self
        .credential_store
        .load_smb_credential(&credential_url)?
        .ok_or_else(|| NafmError::SmbCredentialNotFound(credential_url.clone()))?;
      let location = SmbLocation::parse(&credential.url)?;
      let mut client = smb2::connect(&location.server_address, &credential.username, &credential.password).await?;
      let tree = client.connect_share(&location.share).await?;
      for (index, file) in targets {
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
        cache_hashed_file(&db_path, &site.id, &file, self.hash_algorithm.name(), &content_hash).await?;
        report_scan_progress(
          progress_callback.as_ref(),
          &progress_context,
          &file.path,
          &processed_files,
        );
        preparation.pending_records[index].content_hash = Some(content_hash);
      }
      let _ = client.disconnect_share(&tree).await;
    }

    check_scan_cancelled(cancellation_callback.as_ref())?;
    let finalize_db_path = db_path;
    let finalize_site = site.clone();
    let pending_records = preparation.pending_records;
    let hash_algorithm_name = self.hash_algorithm.name().to_owned();
    let scan_time = Utc::now();
    let (removed, duplicate_groups) = task::spawn_blocking(move || {
      let conn = open_connection(finalize_db_path)?;
      replace_site_file_records_atomically(&conn, &finalize_site, &pending_records, &hash_algorithm_name, scan_time)
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
      files_removed: removed,
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
        Some(selector) => Some(
          find_site(&conn, &selector)?
            .ok_or_else(|| NafmError::SiteNotFound(selector))?
            .id,
        ),
        None => None,
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
          last_scanned_at text not null
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
      backfill_site_scan_state(&conn)?;
      initialize_stage_history(&conn)?;
      Ok(())
    })
    .await?
  }
}

fn open_connection(path: impl AsRef<Path>) -> Result<Connection> {
  let conn = Connection::open(path)?;
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

fn backfill_site_scan_state(conn: &Connection) -> Result<()> {
  conn.execute(
    "insert into site_scan_state (site_id, last_scanned_at)
     select site_id, max(last_seen_at)
     from file_records
     group by site_id
     on conflict(site_id) do nothing",
    [],
  )?;
  Ok(())
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
) -> Result<Vec<FileProbe>> {
  check_scan_cancelled(cancellation_callback)?;
  let location_value = site_folder.path.to_string_lossy();
  let location = SmbLocation::parse(&location_value)?;
  let credential = credential_store
    .load_smb_credential(&location_value)?
    .ok_or_else(|| NafmError::SmbCredentialNotFound(location_value.into_owned()))?;
  let mut client = smb2::connect(&location.server_address, &credential.username, &credential.password).await?;
  let mut tree = client.connect_share(&location.share).await?;
  let mut files = Vec::new();
  let mut directories = vec![(location.relative_path.clone(), Vec::<String>::new())];
  let mut visited = BTreeSet::new();

  while let Some((remote_directory, relative_segments)) = directories.pop() {
    check_scan_cancelled(cancellation_callback)?;
    if !visited.insert(remote_directory.clone()) {
      continue;
    }
    let mut entries = client.list_directory(&mut tree, &remote_directory).await?;
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
      files.push(FileProbe {
        site_folder_id: site_folder.id.clone(),
        path: PathBuf::from(display_url),
        size_bytes: entry.size,
        modified_unix_nanos,
        source: FileSource::Smb {
          credential_url: credential.url.clone(),
          remote_path,
        },
      });
    }
  }

  let _ = client.disconnect_share(&tree).await;
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

  let reader = client.open_file_reader(tree, remote_path).await?;
  if reader.size() != file.size_bytes {
    let _ = reader.close().await;
    return Err(NafmError::SmbFileChanged(file.path.clone()));
  }

  let mut hasher = hash_algorithm.new_hasher();
  let mut offset = 0;
  while offset < file.size_bytes {
    check_scan_cancelled(cancellation_callback)?;
    let bytes = reader.read_at(offset, CHUNK_SIZE.min(file.size_bytes - offset)).await?;
    if bytes.is_empty() {
      break;
    }
    offset += bytes.len() as u64;
    hasher.update(&bytes);
  }
  reader.close().await?;
  if offset != file.size_bytes {
    return Err(NafmError::SmbFileChanged(file.path.clone()));
  }
  Ok(hasher.finalize())
}

async fn cache_hashed_file(
  db_path: &Path,
  site_id: &str,
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
    upsert_scan_cache_entry(&conn, &site_id, &file, &hash_algorithm, &content_hash)
  })
  .await?
}

fn scan_site_blocking(
  conn: &Connection,
  db_path: &Path,
  site: &Site,
  site_folders: &[SiteFolder],
  hash_algorithm: &dyn HashAlgorithm,
  progress_callback: Option<&ScanProgressCallback>,
  cancellation_callback: Option<&ScanCancellationCallback>,
) -> Result<ScanSummary> {
  check_scan_cancelled(cancellation_callback)?;
  let files = discover_site_files(site_folders, cancellation_callback)?;
  let scan_time = Utc::now();
  let processed_files = AtomicU64::new(0);
  let mut preparation = prepare_scan(conn, site, files, hash_algorithm.name())?;

  let progress_context = Arc::new(ScanProgressContext {
    site_id: site.id.clone(),
    site_name: site.name.clone(),
    files_reused: preparation.files_reused,
    total_files: preparation.files_seen,
  });

  let execution = ScanExecutionContext {
    progress_callback,
    progress_context: &progress_context,
    processed_files: &processed_files,
    cancellation_callback,
  };
  let hashed_records = hash_files_in_parallel(db_path, site, &preparation.hash_targets, hash_algorithm, &execution)?;
  for (index, content_hash) in hashed_records {
    preparation.pending_records[index].content_hash = Some(content_hash);
  }

  check_scan_cancelled(cancellation_callback)?;
  let (removed, duplicate_groups) = replace_site_file_records_atomically(
    conn,
    site,
    &preparation.pending_records,
    hash_algorithm.name(),
    scan_time,
  )?;
  let duplicate_files = duplicate_groups.iter().map(|group| group.files.len() as u64).sum();

  Ok(ScanSummary {
    site_id: site.id.clone(),
    site_name: site.name.clone(),
    site_folders: site_folders.len() as u64,
    files_seen: preparation.files_seen,
    files_hashed: preparation.files_hashed,
    files_reused: preparation.files_reused,
    files_removed: removed,
    bytes_hashed: preparation.bytes_hashed,
    duplicate_groups: duplicate_groups.len() as u64,
    duplicate_files,
  })
}

fn prepare_scan(
  conn: &Connection,
  site: &Site,
  files: Vec<FileProbe>,
  hash_algorithm: &str,
) -> Result<ScanPreparation> {
  let mut preparation = ScanPreparation {
    pending_records: Vec::with_capacity(files.len()),
    hash_targets: Vec::new(),
    files_seen: 0,
    files_hashed: 0,
    files_reused: 0,
    bytes_hashed: 0,
  };
  for file in files {
    preparation.files_seen += 1;
    let existing = existing_record(conn, &file.path)?;
    let can_reuse = match existing.as_ref() {
      Some(record) if record.content_hash.is_some() && record.hash_algorithm == hash_algorithm => record_matches(
        conn,
        &record.id,
        file.size_bytes,
        file.modified_unix_nanos,
        hash_algorithm,
      )?,
      _ => false,
    };
    if can_reuse {
      preparation.files_reused += 1;
      preparation.pending_records.push(PendingFileRecord {
        file,
        content_hash: existing.and_then(|record| record.content_hash),
      });
    } else if let Some(cached_record) = cached_scan_record(conn, &site.id, &file, hash_algorithm)? {
      preparation.files_reused += 1;
      preparation.pending_records.push(PendingFileRecord {
        file,
        content_hash: Some(cached_record.content_hash),
      });
    } else {
      preparation.files_hashed += 1;
      preparation.bytes_hashed += file.size_bytes;
      preparation
        .hash_targets
        .push((preparation.pending_records.len(), file.clone()));
      preparation.pending_records.push(PendingFileRecord {
        file,
        content_hash: None,
      });
    }
  }
  Ok(preparation)
}

fn hash_files_in_parallel(
  db_path: &Path,
  site: &Site,
  hash_targets: &[(usize, FileProbe)],
  hash_algorithm: &dyn HashAlgorithm,
  execution: &ScanExecutionContext<'_>,
) -> Result<Vec<(usize, String)>> {
  if hash_targets.is_empty() {
    return Ok(Vec::new());
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

  std::thread::scope(|scope| -> Result<Vec<(usize, String)>> {
    let (sender, receiver) = mpsc::channel::<(usize, FileProbe, String)>();
    let writer_progress_context = Arc::clone(progress_context);
    let writer = scope.spawn(move || -> Result<Vec<(usize, String)>> {
      let conn = open_connection(writer_db_path)?;
      let mut hashed_records = Vec::with_capacity(hash_targets.len());
      for (index, file, content_hash) in receiver {
        upsert_scan_cache_entry(&conn, &site_id, &file, &hash_algorithm_name, &content_hash)?;
        report_scan_progress(
          *progress_callback,
          writer_progress_context.as_ref(),
          &file.path,
          processed_files,
        );
        hashed_records.push((index, content_hash));
      }
      Ok(hashed_records)
    });
    let mut tasks = Vec::with_capacity(worker_count);
    for chunk in hash_targets.chunks(chunk_size) {
      let sender = sender.clone();
      tasks.push(scope.spawn(move || -> Result<()> {
        for (index, file) in chunk {
          check_scan_cancelled(*cancellation_callback)?;
          let content_hash = hash_algorithm.hash_file(&file.path)?;
          check_scan_cancelled(*cancellation_callback)?;
          sender
            .send((*index, file.clone(), content_hash))
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
  progress_callback(&ScanProgress {
    site_id: progress_context.site_id.clone(),
    site_name: progress_context.site_name.clone(),
    current_path: current_path.to_path_buf(),
    files_scanned: processed_files.fetch_add(1, Ordering::Relaxed) + 1,
    files_reused: progress_context.files_reused,
    total_files: progress_context.total_files,
  });
}

fn discover_site_files(
  site_folders: &[SiteFolder],
  cancellation_callback: Option<&ScanCancellationCallback>,
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
          path,
          size_bytes: metadata.len(),
          modified_unix_nanos: modified_unix_nanos(metadata.modified()?)?,
          source: FileSource::Local,
        },
      );
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

fn existing_record(conn: &Connection, path: &Path) -> Result<Option<ExistingRecord>> {
  conn
    .query_row(
      "select id, content_hash, hash_algorithm from file_records where path = ?1",
      params![path.to_string_lossy()],
      |row| {
        Ok(ExistingRecord {
          id: row.get(0)?,
          content_hash: row.get(1)?,
          hash_algorithm: row.get(2)?,
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

fn record_matches(
  conn: &Connection,
  id: &str,
  size_bytes: u64,
  modified_unix_nanos: i64,
  hash_algorithm: &str,
) -> Result<bool> {
  let found = conn.query_row(
    "select exists(
      select 1 from file_records
      where id = ?1 and size_bytes = ?2 and modified_unix_nanos = ?3 and hash_algorithm = ?4
    )",
    params![id, size_bytes, modified_unix_nanos, hash_algorithm],
    |row| row.get::<_, bool>(0),
  )?;
  Ok(found)
}

fn upsert_file(
  conn: &Connection,
  site: &Site,
  file: &FileProbe,
  hash_algorithm: &str,
  content_hash: Option<&str>,
  last_seen_at: DateTime<Utc>,
) -> Result<()> {
  conn.execute(
    "insert into file_records (
      id, site_id, site_folder_id, path, size_bytes, modified_unix_nanos, hash_algorithm, content_hash, last_seen_at
    )
    values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    on conflict(path) do update set
      site_id = excluded.site_id,
      site_folder_id = excluded.site_folder_id,
      size_bytes = excluded.size_bytes,
      modified_unix_nanos = excluded.modified_unix_nanos,
      hash_algorithm = excluded.hash_algorithm,
      content_hash = excluded.content_hash,
      last_seen_at = excluded.last_seen_at",
    params![
      Uuid::new_v4().to_string(),
      site.id,
      file.site_folder_id,
      file.path.to_string_lossy(),
      file.size_bytes,
      file.modified_unix_nanos,
      hash_algorithm,
      content_hash,
      last_seen_at,
    ],
  )?;
  Ok(())
}

fn upsert_scan_cache_entry(
  conn: &Connection,
  site_id: &str,
  file: &FileProbe,
  hash_algorithm: &str,
  content_hash: &str,
) -> Result<()> {
  conn.execute(
    "insert into scan_cache_entries (
      site_id, site_folder_id, path, size_bytes, modified_unix_nanos, hash_algorithm, content_hash, cached_at
    )
    values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
    on conflict(site_id, path) do update set
      site_folder_id = excluded.site_folder_id,
      size_bytes = excluded.size_bytes,
      modified_unix_nanos = excluded.modified_unix_nanos,
      hash_algorithm = excluded.hash_algorithm,
      content_hash = excluded.content_hash,
      cached_at = excluded.cached_at",
    params![
      site_id,
      file.site_folder_id,
      file.path.to_string_lossy(),
      file.size_bytes,
      file.modified_unix_nanos,
      hash_algorithm,
      content_hash,
      Utc::now(),
    ],
  )?;
  Ok(())
}

fn replace_site_file_records_atomically(
  conn: &Connection,
  site: &Site,
  pending_records: &[PendingFileRecord],
  hash_algorithm: &str,
  scan_time: DateTime<Utc>,
) -> Result<(u64, Vec<DuplicateGroup>)> {
  conn.execute_batch("begin immediate transaction")?;
  let result = (|| -> Result<(u64, Vec<DuplicateGroup>)> {
    for pending_record in pending_records {
      upsert_file(
        conn,
        site,
        &pending_record.file,
        hash_algorithm,
        pending_record.content_hash.as_deref(),
        scan_time,
      )?;
    }

    let removed = conn.execute(
      "delete from file_records where site_id = ?1 and last_seen_at <> ?2",
      params![site.id, scan_time],
    )? as u64;
    conn.execute("delete from scan_cache_entries where site_id = ?1", params![site.id])?;
    conn.execute(
      "insert into site_scan_state (site_id, last_scanned_at) values (?1, ?2)
       on conflict(site_id) do update set last_scanned_at = excluded.last_scanned_at",
      params![site.id, scan_time],
    )?;
    let duplicate_groups = find_duplicates(conn, Some(&site.id))?;
    Ok((removed, duplicate_groups))
  })();

  match result {
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

fn find_duplicates(conn: &Connection, site_id: Option<&str>) -> Result<Vec<DuplicateGroup>> {
  let groups = if let Some(site_id) = site_id {
    conn
      .prepare(
        "select hash_algorithm, content_hash, size_bytes
         from file_records
         where content_hash is not null and site_id = ?1
         group by hash_algorithm, content_hash, size_bytes
         having count(*) > 1
         order by size_bytes desc, content_hash",
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
        "select hash_algorithm, content_hash, size_bytes
         from file_records
         where content_hash is not null
         group by hash_algorithm, content_hash, size_bytes
         having count(*) > 1
         order by size_bytes desc, content_hash",
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
  let selected = conn
    .query_row(
      "select id, hash_algorithm, content_hash, size_bytes
       from file_records
       where site_id = ?1 and path = ?2",
      params![source_site_id, path.to_string_lossy()],
      |row| {
        Ok((
          row.get::<_, String>(0)?,
          row.get::<_, String>(1)?,
          row.get::<_, Option<String>>(2)?,
          row.get::<_, u64>(3)?,
        ))
      },
    )
    .optional()?
    .ok_or_else(|| NafmError::TrackedPathNotFound(path.to_path_buf()))?;
  let (selected_file_id, hash_algorithm, Some(content_hash), size_bytes) = selected else {
    return Ok(FileContentMatchesPage {
      status: FileContentMatchStatus::NotHashed,
      matches: Vec::new(),
      total_matches: 0,
      offset,
      limit,
    });
  };

  let total_matches = conn.query_row(
    "select count(*)
     from file_records
     where id <> ?1 and hash_algorithm = ?2 and content_hash = ?3 and size_bytes = ?4",
    params![selected_file_id, hash_algorithm, content_hash, size_bytes],
    |row| row.get::<_, u64>(0),
  )?;
  let sql_offset = i64::try_from(offset).unwrap_or(i64::MAX);
  let mut stmt = conn.prepare(
    "select file.id, file.site_id, site.name, file.site_folder_id, folder.kind, file.path, file.size_bytes
     from file_records file
     join sites site on site.id = file.site_id
     join site_folders folder on folder.id = file.site_folder_id
     where file.id <> ?1
       and file.hash_algorithm = ?2
       and file.content_hash = ?3
       and file.size_bytes = ?4
     order by
       case when file.site_id = ?5 then 0 else 1 end,
       site.name,
       file.path,
       file.id
     limit ?6 offset ?7",
  )?;
  let matches = stmt
    .query_map(
      params![
        selected_file_id,
        hash_algorithm,
        content_hash,
        size_bytes,
        source_site_id,
        limit,
        sql_offset,
      ],
      |row| {
        let site_folder_kind = row.get::<_, String>(4)?;
        Ok(FileContentMatch {
          file_id: row.get(0)?,
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
      "select id, site_id, site_folder_id, path, size_bytes, modified_unix_nanos
       from file_records
       where site_id = ?1 and hash_algorithm = ?2 and content_hash = ?3 and size_bytes = ?4
       order by path",
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
      "select id, site_id, site_folder_id, path, size_bytes, modified_unix_nanos
       from file_records
       where hash_algorithm = ?1 and content_hash = ?2 and size_bytes = ?3
       order by path",
    )?;
    stmt
      .query_map(params![hash_algorithm, hash, size_bytes], duplicate_file_from_row)?
      .collect::<std::result::Result<Vec<_>, _>>()
      .map_err(Into::into)
  }
}

fn find_missing(conn: &Connection, source_site_id: &str, target_site_id: &str) -> Result<Vec<MissingContentGroup>> {
  let groups = conn
    .prepare(
      "select distinct source.hash_algorithm, source.content_hash, source.size_bytes
       from file_records source
       where source.site_id = ?1
         and source.content_hash is not null
         and not exists (
           select 1
           from file_records target
           where target.site_id = ?2
             and target.hash_algorithm = source.hash_algorithm
             and target.content_hash = source.content_hash
             and target.size_bytes = source.size_bytes
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
  let staged_ids = staged_files
    .iter()
    .map(|file| file.file_id.clone())
    .collect::<std::collections::HashSet<_>>();

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
  let tracked_file_count_after = tracked_file_count_before.saturating_sub(staged_files.len() as u64);
  let db_entry_count_stable = tracked_file_count_before == total_file_record_count(conn)?;

  Ok(StageCommitDryRun {
    staged_files,
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

fn site_overview(conn: &Connection, site: Site) -> Result<SiteOverview> {
  let folders = list_site_folders(conn, Some(&site.id))?;
  let files = storage_file_records(conn, &site.id, None)?;
  let total_file_count = files.len() as u64;
  let total_bytes = files.iter().map(|file| file.size_bytes).sum();
  let duplicate_file_count = files.iter().filter(|file| file.duplicate).count() as u64;
  let duplicate_bytes = files
    .iter()
    .filter(|file| file.reclaimable)
    .map(|file| file.size_bytes)
    .sum();
  let latest_scan_at = conn
    .query_row(
      "select last_scanned_at from site_scan_state where site_id = ?1",
      params![site.id],
      |row| row.get::<_, DateTime<Utc>>(0),
    )
    .optional()?;

  Ok(SiteOverview {
    site,
    folders,
    total_file_count,
    total_bytes,
    duplicate_file_count,
    duplicate_bytes,
    latest_scan_at,
  })
}

fn storage_file_records(
  conn: &Connection,
  site_id: &str,
  coverage_target_content_keys: Option<&BTreeSet<StorageContentKey>>,
) -> Result<Vec<StorageFileRecord>> {
  let mut rows = conn
    .prepare(
      "select site_folder_id, path, size_bytes, hash_algorithm, content_hash
       from file_records
       where site_id = ?1
       order by path",
    )?
    .query_map(params![site_id], |row| {
      Ok((
        StorageFileRecord {
          site_folder_id: row.get(0)?,
          path: PathBuf::from(row.get::<_, String>(1)?),
          size_bytes: row.get(2)?,
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
    if let Some(content_hash) = content_hash {
      groups
        .entry((hash_algorithm.clone(), content_hash.clone(), file.size_bytes))
        .or_default()
        .push(index);
    }
  }
  for indexes in groups.values().filter(|indexes| indexes.len() > 1) {
    for (group_index, row_index) in indexes.iter().enumerate() {
      rows[*row_index].0.duplicate = true;
      rows[*row_index].0.reclaimable = group_index > 0;
    }
  }

  let target_hash_algorithms = coverage_target_content_keys.map(|content_keys| {
    content_keys
      .iter()
      .map(|content_key| content_key.hash_algorithm.as_str())
      .collect::<BTreeSet<_>>()
  });
  for ((hash_algorithm, content_hash, size_bytes), indexes) in &groups {
    let content_key = StorageContentKey {
      hash_algorithm: hash_algorithm.clone(),
      content_hash: content_hash.clone(),
      size_bytes: *size_bytes,
    };
    let covered_by_target = coverage_target_content_keys.and_then(|target_content_keys| {
      (target_content_keys.is_empty()
        || target_hash_algorithms
          .as_ref()
          .is_some_and(|algorithms| algorithms.contains(hash_algorithm.as_str())))
      .then(|| target_content_keys.contains(&content_key))
    });
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
  conn
    .query_row(
      "select exists(select 1 from site_scan_state where site_id = ?1)",
      params![site_id],
      |row| row.get::<_, bool>(0),
    )
    .map_err(Into::into)
}

fn site_has_tracked_files(conn: &Connection, site_id: &str) -> Result<bool> {
  conn
    .query_row(
      "select exists(select 1 from file_records where site_id = ?1)",
      params![site_id],
      |row| row.get::<_, bool>(0),
    )
    .map_err(Into::into)
}

fn storage_content_keys(conn: &Connection, site_id: &str) -> Result<BTreeSet<StorageContentKey>> {
  let mut stmt = conn.prepare(
    "select distinct hash_algorithm, content_hash, size_bytes
     from file_records
     where site_id = ?1 and content_hash is not null",
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

fn build_storage_tree_root(
  conn: &Connection,
  site: &Site,
  coverage_target: Option<&Site>,
) -> Result<StorageNodeBuilder> {
  let folders = list_site_folders(conn, Some(&site.id))?;
  let coverage_target_content_keys = match coverage_target {
    Some(target) if site_has_completed_scan(conn, &target.id)? => {
      let content_keys = storage_content_keys(conn, &target.id)?;
      if content_keys.is_empty() && site_has_tracked_files(conn, &target.id)? {
        None
      } else {
        Some(content_keys)
      }
    }
    _ => None,
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
  let coverage_health = builder.coverage_health();
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
    duplicate_bytes: builder.duplicate_bytes,
    duplicate_file_count: builder.duplicate_file_count,
    space_health,
    space_healthy_file_equivalents: builder.space_healthy_file_equivalents,
    space_total_files: builder.space_total_files,
    coverage_health,
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
    duplicate_bytes: builder.duplicate_bytes,
    duplicate_file_count: builder.duplicate_file_count,
    space_health: builder.space_health(),
    space_healthy_file_equivalents: builder.space_healthy_file_equivalents,
    space_total_files: builder.space_total_files,
    coverage_health: builder.coverage_health(),
    coverage_covered_files,
    coverage_total_files,
    children: Vec::new(),
  }
}

fn consolidate_storage_nodes(parent_id: &str, retained_count: usize, nodes: Vec<StorageNodeBuilder>) -> StorageNode {
  let total_space_health_bytes = nodes.iter().map(|node| node.space_health_bytes).sum::<u128>();
  let zero_byte_space_health_count = nodes.iter().map(|node| node.zero_byte_space_health_count).sum::<u64>();
  let space_health = if total_space_health_bytes > 0 {
    Some(
      (nodes.iter().map(|node| node.space_health_weighted_bytes).sum::<f64>() / total_space_health_bytes as f64)
        .clamp(0.0, 100.0),
    )
  } else if zero_byte_space_health_count > 0 {
    Some(
      (nodes.iter().map(|node| node.zero_byte_space_health_sum).sum::<f64>() / zero_byte_space_health_count as f64)
        .clamp(0.0, 100.0),
    )
  } else {
    None
  };
  let mut coverage_groups = BTreeMap::<StorageContentKey, bool>::new();
  for node in &nodes {
    for (content_key, covered) in &node.coverage_groups {
      coverage_groups
        .entry(content_key.clone())
        .and_modify(|aggregate_covered| *aggregate_covered |= *covered)
        .or_insert(*covered);
    }
  }
  let coverage_total_bytes = coverage_groups
    .keys()
    .map(|content_key| u128::from(content_key.size_bytes))
    .sum::<u128>();
  let coverage_health = if coverage_total_bytes > 0 {
    let covered_bytes = coverage_groups
      .iter()
      .filter(|(_, covered)| **covered)
      .map(|(content_key, _)| u128::from(content_key.size_bytes))
      .sum::<u128>();
    Some((covered_bytes as f64 * 100.0 / coverage_total_bytes as f64).clamp(0.0, 100.0))
  } else if !coverage_groups.is_empty() {
    Some(coverage_groups.values().filter(|covered| **covered).count() as f64 * 100.0 / coverage_groups.len() as f64)
  } else {
    None
  };
  StorageNode {
    id: format!("smaller_items:{retained_count}:{parent_id}"),
    name: "Smaller items".to_owned(),
    path: None,
    kind: StorageNodeKind::SmallerItems,
    total_bytes: nodes.iter().map(|node| node.total_bytes).sum(),
    file_count: nodes.iter().map(|node| node.file_count).sum(),
    duplicate_bytes: nodes.iter().map(|node| node.duplicate_bytes).sum(),
    duplicate_file_count: nodes.iter().map(|node| node.duplicate_file_count).sum(),
    space_health,
    space_healthy_file_equivalents: nodes.iter().map(|node| node.space_healthy_file_equivalents).sum(),
    space_total_files: nodes.iter().map(|node| node.space_total_files).sum(),
    coverage_health,
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
