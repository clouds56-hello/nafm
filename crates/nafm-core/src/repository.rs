use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use tokio::task::{self, JoinSet};
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

use crate::error::{NafmError, Result};
use crate::hash::{HashAlgorithm, default_hash_algorithm};
use crate::model::{
  AddSiteFolderRequest, DuplicateFile, DuplicateGroup, HiddenPolicy, MissingContentGroup, ScanProgress, ScanSummary,
  Site, SiteFolder, StageAddReport, StageCommitDryRun, StageHistoryReport, StageRemoveReport, StageResetReport,
  StageWarning, StageWarningReason,
};

type ScanProgressCallback = Arc<dyn Fn(&ScanProgress) + Send + Sync>;

#[derive(Clone)]
pub struct Repository {
  db_path: PathBuf,
  hash_algorithm: Arc<dyn HashAlgorithm>,
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
}

#[derive(Clone, Debug)]
struct ExistingRecord {
  id: String,
  content_hash: Option<String>,
  hash_algorithm: String,
}

#[derive(Clone, Debug)]
struct PendingFileRecord {
  file: FileProbe,
  content_hash: Option<String>,
}

#[derive(Clone, Debug)]
struct ScanProgressContext {
  site_id: String,
  site_name: String,
  total_files: u64,
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
    let repo = Self {
      db_path: options.cache_path,
      hash_algorithm: options.hash_algorithm.unwrap_or_else(default_hash_algorithm),
    };
    repo.initialize().await?;
    Ok(repo)
  }

  pub async fn open_default() -> Result<Self> {
    Self::open(RepositoryOptions {
      cache_path: default_cache_path()?,
      hash_algorithm: None,
    })
    .await
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

      let conn = Connection::open(db_path)?;
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
    .await?
  }

  pub async fn add_site_folder(&self, site_selector: &str, request: AddSiteFolderRequest) -> Result<SiteFolder> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
      let site = find_site(&conn, &site_selector)?.ok_or_else(|| NafmError::SiteNotFound(site_selector.clone()))?;
      let path = std::fs::canonicalize(&request.path)?;
      let now = Utc::now();
      let site_folder = SiteFolder {
        id: Uuid::new_v4().to_string(),
        site_id: site.id,
        path,
        hidden_policy: request.hidden_policy,
        added_at: now,
      };
      conn.execute(
        "insert into site_folders (id, site_id, path, hidden_policy, added_at)
         values (?1, ?2, ?3, ?4, ?5)",
        params![
          site_folder.id,
          site_folder.site_id,
          site_folder.path.to_string_lossy(),
          hidden_policy_to_db(site_folder.hidden_policy),
          site_folder.added_at
        ],
      )?;
      Ok(site_folder)
    })
    .await?
  }

  pub async fn list_sites(&self) -> Result<Vec<Site>> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
      list_sites(&conn)
    })
    .await?
  }

  pub async fn list_site_folders(&self, site_selector: Option<&str>) -> Result<Vec<SiteFolder>> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.map(str::to_owned);
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
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

  pub async fn file_counts_by_parent_folder(&self, site_selector: Option<&str>) -> Result<BTreeMap<String, u64>> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.map(str::to_owned);
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
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
    let sites = self.list_sites().await?;
    let mut tasks = JoinSet::new();
    for (index, site) in sites.into_iter().enumerate() {
      let repo = self.clone();
      let progress_callback = progress_callback.clone();
      tasks.spawn(async move { (index, repo.scan_site_with_progress(&site.id, progress_callback).await) });
    }

    let mut summaries = vec![None; tasks.len()];
    while let Some(result) = tasks.join_next().await {
      let (index, summary) = result?;
      summaries[index] = Some(summary?);
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
    let db_path = self.db_path.clone();
    let selector = selector.to_owned();
    let hash_algorithm = self.hash_algorithm.clone();
    task::spawn_blocking(move || {
      let conn = Connection::open(&db_path)?;
      let site = find_site(&conn, &selector)?.ok_or_else(|| NafmError::SiteNotFound(selector.clone()))?;
      let site_folders = list_site_folders(&conn, Some(&site.id))?;
      scan_site_blocking(
        &conn,
        &site,
        &site_folders,
        hash_algorithm.as_ref(),
        progress_callback.as_ref(),
      )
    })
    .await?
  }

  pub async fn find_duplicates(&self, site_selector: Option<&str>) -> Result<Vec<DuplicateGroup>> {
    let db_path = self.db_path.clone();
    let site_selector = site_selector.map(str::to_owned);
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
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

  pub async fn find_missing(
    &self,
    source_site_selector: &str,
    target_site_selector: &str,
  ) -> Result<Vec<MissingContentGroup>> {
    let db_path = self.db_path.clone();
    let source_site_selector = source_site_selector.to_owned();
    let target_site_selector = target_site_selector.to_owned();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
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
      let conn = Connection::open(db_path)?;
      let canonical_path = std::fs::canonicalize(&path)?;
      stage_add_path(&conn, &canonical_path)
    })
    .await?
  }

  pub async fn stage_commit_dry_run(&self) -> Result<StageCommitDryRun> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
      stage_commit_dry_run(&conn)
    })
    .await?
  }

  pub async fn stage_remove_path(&self, path: &Path) -> Result<StageRemoveReport> {
    let db_path = self.db_path.clone();
    let path = path.to_path_buf();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
      let canonical_path = std::fs::canonicalize(&path)?;
      stage_remove_path(&conn, &canonical_path)
    })
    .await?
  }

  pub async fn stage_reset(&self) -> Result<StageResetReport> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
      stage_reset(&conn)
    })
    .await?
  }

  pub async fn stage_undo(&self) -> Result<StageHistoryReport> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
      stage_undo(&conn)
    })
    .await?
  }

  pub async fn stage_redo(&self) -> Result<StageHistoryReport> {
    let db_path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = Connection::open(db_path)?;
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

      let conn = Connection::open(db_path)?;
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

        create index if not exists idx_site_folders_site_id on site_folders(site_id);
        create index if not exists idx_file_records_site_id on file_records(site_id);
        create index if not exists idx_file_records_site_folder_id on file_records(site_folder_id);
        create index if not exists idx_file_records_hash on file_records(hash_algorithm, content_hash, size_bytes);

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
      initialize_stage_history(&conn)?;
      Ok(())
    })
    .await?
  }
}

pub fn default_cache_path() -> Result<PathBuf> {
  let dirs = ProjectDirs::from("dev", "nafm", "nafm").ok_or(NafmError::AppDataDirectoryUnavailable)?;
  Ok(dirs.data_dir().join("nafm.sqlite3"))
}

fn scan_site_blocking(
  conn: &Connection,
  site: &Site,
  site_folders: &[SiteFolder],
  hash_algorithm: &dyn HashAlgorithm,
  progress_callback: Option<&ScanProgressCallback>,
) -> Result<ScanSummary> {
  let files = discover_site_files(site_folders)?;
  let progress_context = Arc::new(ScanProgressContext {
    site_id: site.id.clone(),
    site_name: site.name.clone(),
    total_files: files.len() as u64,
  });
  let scan_time = Utc::now();
  let mut files_seen = 0;
  let mut files_hashed = 0;
  let mut files_reused = 0;
  let mut bytes_hashed = 0;
  let processed_files = AtomicU64::new(0);
  let mut pending_records = Vec::with_capacity(files.len());
  let mut hash_targets = Vec::new();

  for file in files {
    files_seen += 1;
    let existing = existing_record(conn, &file.path)?;
    let can_reuse = match existing.as_ref() {
      Some(record) if record.content_hash.is_some() && record.hash_algorithm == hash_algorithm.name() => {
        record_matches(
          conn,
          &record.id,
          file.size_bytes,
          file.modified_unix_nanos,
          hash_algorithm.name(),
        )?
      }
      _ => false,
    };
    if can_reuse {
      files_reused += 1;
      report_scan_progress(progress_callback, &progress_context, &file.path, &processed_files);
      pending_records.push(PendingFileRecord {
        file,
        content_hash: existing.and_then(|record| record.content_hash),
      });
    } else {
      files_hashed += 1;
      bytes_hashed += file.size_bytes;
      hash_targets.push((pending_records.len(), file.clone()));
      pending_records.push(PendingFileRecord {
        file,
        content_hash: None,
      });
    }
  }

  let hashed_records = hash_files_in_parallel(
    &hash_targets,
    hash_algorithm,
    progress_callback,
    &progress_context,
    &processed_files,
  )?;
  for (index, content_hash) in hashed_records {
    pending_records[index].content_hash = Some(content_hash);
  }

  for pending_record in &pending_records {
    upsert_file(
      conn,
      site,
      &pending_record.file,
      hash_algorithm.name(),
      pending_record.content_hash.as_deref(),
      scan_time,
    )?;
  }

  let removed = conn.execute(
    "delete from file_records where site_id = ?1 and last_seen_at <> ?2",
    params![site.id, scan_time],
  )?;
  let duplicate_groups = find_duplicates(conn, Some(&site.id))?;
  let duplicate_files = duplicate_groups.iter().map(|group| group.files.len() as u64).sum();

  Ok(ScanSummary {
    site_id: site.id.clone(),
    site_name: site.name.clone(),
    site_folders: site_folders.len() as u64,
    files_seen,
    files_hashed,
    files_reused,
    files_removed: removed as u64,
    bytes_hashed,
    duplicate_groups: duplicate_groups.len() as u64,
    duplicate_files,
  })
}

fn hash_files_in_parallel(
  hash_targets: &[(usize, FileProbe)],
  hash_algorithm: &dyn HashAlgorithm,
  progress_callback: Option<&ScanProgressCallback>,
  progress_context: &Arc<ScanProgressContext>,
  processed_files: &AtomicU64,
) -> Result<Vec<(usize, String)>> {
  if hash_targets.is_empty() {
    return Ok(Vec::new());
  }

  let worker_count = std::thread::available_parallelism()
    .map(|parallelism| parallelism.get())
    .unwrap_or(1)
    .min(hash_targets.len());
  let chunk_size = hash_targets.len().div_ceil(worker_count);
  let mut hashed_records = Vec::with_capacity(hash_targets.len());

  std::thread::scope(|scope| -> Result<()> {
    let mut tasks = Vec::with_capacity(worker_count);
    for chunk in hash_targets.chunks(chunk_size) {
      let progress_context = progress_context.clone();
      tasks.push(scope.spawn(move || -> Result<Vec<(usize, String)>> {
        let mut results = Vec::with_capacity(chunk.len());
        for (index, file) in chunk {
          let content_hash = hash_algorithm.hash_file(&file.path)?;
          report_scan_progress(progress_callback, &progress_context, &file.path, processed_files);
          results.push((*index, content_hash));
        }
        Ok(results)
      }));
    }

    for task in tasks {
      hashed_records.extend(task.join().expect("hash worker thread should not panic")?);
    }
    Ok(())
  })?;

  Ok(hashed_records)
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
    total_files: progress_context.total_files,
  });
}

fn discover_site_files(site_folders: &[SiteFolder]) -> Result<Vec<FileProbe>> {
  let mut files_by_path = BTreeMap::new();
  let mut sorted_site_folders = site_folders.to_vec();
  sorted_site_folders.sort_by_key(|site_folder| std::cmp::Reverse(site_folder.path.components().count()));

  for site_folder in &sorted_site_folders {
    let walker = WalkDir::new(&site_folder.path).follow_links(false).into_iter();
    for entry in walker.filter_entry(|entry| should_visit(entry, site_folder.hidden_policy)) {
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

fn stage_add_path(conn: &Connection, canonical_path: &Path) -> Result<StageAddReport> {
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

  let tracked_descendant_paths = if canonical_path.is_dir() {
    tracked_file_paths_under_prefix(conn, canonical_path)?
  } else {
    Vec::new()
  };

  let requested_files = if canonical_path.is_dir() {
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
            warnings: vec![StageWarning {
              path: canonical_path.to_path_buf(),
              reason: StageWarningReason::NotDuplicate,
            }],
          });
        }
        return Err(NafmError::TrackedPathNotFound(canonical_path.to_path_buf()));
      }
    }
  };

  if canonical_path.is_dir() && requested_files.is_empty() {
    if !tracked_descendant_paths.is_empty() {
      return Ok(StageAddReport {
        staged_files: Vec::new(),
        warnings: tracked_descendant_paths
          .into_iter()
          .map(|path| StageWarning {
            path,
            reason: StageWarningReason::NotDuplicate,
          })
          .collect(),
      });
    }
    return Err(NafmError::TrackedPathNotFound(canonical_path.to_path_buf()));
  }

  let mut requested_by_group = BTreeMap::<String, Vec<DuplicateFile>>::new();
  let mut warnings = Vec::new();
  if canonical_path.is_dir() {
    let duplicate_paths = requested_files
      .iter()
      .map(|file| file.path.clone())
      .collect::<std::collections::HashSet<_>>();
    for path in tracked_descendant_paths {
      if !duplicate_paths.contains(&path) {
        warnings.push(StageWarning {
          path,
          reason: StageWarningReason::NotDuplicate,
        });
      }
    }
  }
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

fn stage_remove_path(conn: &Connection, canonical_path: &Path) -> Result<StageRemoveReport> {
  let staged_files = list_staged_files(conn)?;
  let staged_by_path = staged_files
    .iter()
    .map(|record| (record.file.path.clone(), record.file.clone()))
    .collect::<BTreeMap<_, _>>();

  let removed_files = if canonical_path.is_dir() {
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
  if canonical_path.is_file() && removed_files.is_empty() {
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

  if canonical_path.is_dir() && removed_files.is_empty() {
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
      "select id, site_id, path, hidden_policy, added_at
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
      "select id, site_id, path, hidden_policy, added_at
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

fn site_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Site> {
  Ok(Site {
    id: row.get(0)?,
    name: row.get(1)?,
    added_at: row.get(2)?,
  })
}

fn site_folder_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SiteFolder> {
  let hidden_policy: String = row.get(3)?;
  Ok(SiteFolder {
    id: row.get(0)?,
    site_id: row.get(1)?,
    path: PathBuf::from(row.get::<_, String>(2)?),
    hidden_policy: hidden_policy_from_db(&hidden_policy),
    added_at: row.get(4)?,
  })
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
