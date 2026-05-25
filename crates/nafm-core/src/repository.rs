use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use tokio::task;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

use crate::error::{NafmError, Result};
use crate::hash::{HashAlgorithm, default_hash_algorithm};
use crate::model::{
  AddSiteFolderRequest, DuplicateFile, DuplicateGroup, HiddenPolicy, MissingContentGroup, ScanProgress, ScanSummary,
  Site, SiteFolder,
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

  pub async fn scan_all(&self) -> Result<Vec<ScanSummary>> {
    self.scan_all_with_progress(None).await
  }

  pub async fn scan_all_with_progress(
    &self,
    progress_callback: Option<ScanProgressCallback>,
  ) -> Result<Vec<ScanSummary>> {
    let sites = self.list_sites().await?;
    let mut summaries = Vec::with_capacity(sites.len());
    for site in sites {
      summaries.push(
        self
          .scan_site_with_progress(&site.id, progress_callback.clone())
          .await?,
      );
    }
    Ok(summaries)
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
        ",
      )?;
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
  let total_files = files.len() as u64;
  let scan_time = Utc::now();
  let mut files_seen = 0;
  let mut files_hashed = 0;
  let mut files_reused = 0;
  let mut bytes_hashed = 0;

  for file in &files {
    files_seen += 1;
    if let Some(progress_callback) = progress_callback {
      progress_callback(&ScanProgress {
        site_id: site.id.clone(),
        site_name: site.name.clone(),
        current_path: file.path.clone(),
        files_scanned: files_seen,
        total_files,
      });
    }
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
    let content_hash = if can_reuse {
      files_reused += 1;
      existing.and_then(|record| record.content_hash)
    } else {
      files_hashed += 1;
      bytes_hashed += file.size_bytes;
      Some(hash_algorithm.hash_file(&file.path)?)
    };

    upsert_file(
      conn,
      site,
      file,
      hash_algorithm.name(),
      content_hash.as_deref(),
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
