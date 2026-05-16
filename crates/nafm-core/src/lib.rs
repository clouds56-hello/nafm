use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, Utc};
use directories::ProjectDirs;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::task;
use uuid::Uuid;
use walkdir::{DirEntry, WalkDir};

pub type Result<T> = std::result::Result<T, NafmError>;

#[derive(Debug, Error)]
pub enum NafmError {
    #[error("folder not found: {0}")]
    FolderNotFound(String),
    #[error("duplicate group not found: {0}")]
    DuplicateGroupNotFound(String),
    #[error("file is not part of duplicate group: {0}")]
    FileNotInDuplicateGroup(String),
    #[error("cache path has no parent directory: {0}")]
    CachePathHasNoParent(PathBuf),
    #[error("unable to resolve app data directory")]
    AppDataDirectoryUnavailable,
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("blocking task failed: {0}")]
    Join(#[from] tokio::task::JoinError),
    #[error("trash error: {0}")]
    Trash(String),
}

#[derive(Clone, Debug)]
pub struct Repository {
    db_path: PathBuf,
}

#[derive(Clone, Debug)]
pub struct RepositoryOptions {
    pub cache_path: PathBuf,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HiddenPolicy {
    Include,
    Skip,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Folder {
    pub id: String,
    pub path: PathBuf,
    pub alias: Option<String>,
    pub hidden_policy: HiddenPolicy,
    pub added_at: DateTime<Utc>,
}

#[derive(Clone, Debug)]
pub struct AddFolderRequest {
    pub path: PathBuf,
    pub alias: Option<String>,
    pub hidden_policy: HiddenPolicy,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ScanSummary {
    pub folder_id: String,
    pub files_seen: u64,
    pub files_hashed: u64,
    pub files_reused: u64,
    pub files_removed: u64,
    pub bytes_hashed: u64,
    pub duplicate_groups: u64,
    pub duplicate_files: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DuplicateFile {
    pub file_id: String,
    pub folder_id: String,
    pub path: PathBuf,
    pub size_bytes: u64,
    pub modified_unix_nanos: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct DuplicateGroup {
    pub group_id: String,
    pub hash: String,
    pub size_bytes: u64,
    pub files: Vec<DuplicateFile>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct TrashPlan {
    pub group_id: String,
    pub kept_file_id: String,
    pub trashed_files: Vec<DuplicateFile>,
    pub dry_run: bool,
}

#[derive(Clone, Debug)]
struct FileProbe {
    path: PathBuf,
    size_bytes: u64,
    modified_unix_nanos: i64,
}

#[derive(Clone, Debug)]
struct ExistingRecord {
    id: String,
    content_hash: Option<String>,
}

impl Repository {
    pub async fn open(options: RepositoryOptions) -> Result<Self> {
        let repo = Self {
            db_path: options.cache_path,
        };
        repo.initialize().await?;
        Ok(repo)
    }

    pub async fn open_default() -> Result<Self> {
        Self::open(RepositoryOptions {
            cache_path: default_cache_path()?,
        })
        .await
    }

    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    pub async fn add_folder(&self, request: AddFolderRequest) -> Result<Folder> {
        let db_path = self.db_path.clone();
        task::spawn_blocking(move || {
            let path = std::fs::canonicalize(&request.path)?;
            let conn = Connection::open(db_path)?;
            let now = Utc::now();
            let id = Uuid::new_v4().to_string();
            conn.execute(
                "insert into folders (id, path, alias, hidden_policy, added_at)
         values (?1, ?2, ?3, ?4, ?5)",
                params![
                    id,
                    path.to_string_lossy(),
                    request.alias,
                    hidden_policy_to_db(request.hidden_policy),
                    now
                ],
            )?;
            Ok(Folder {
                id,
                path,
                alias: request.alias,
                hidden_policy: request.hidden_policy,
                added_at: now,
            })
        })
        .await?
    }

    pub async fn remove_folder(&self, selector: &str) -> Result<Option<Folder>> {
        let db_path = self.db_path.clone();
        let selector = selector.to_owned();
        task::spawn_blocking(move || {
            let conn = Connection::open(db_path)?;
            let folder = find_folder(&conn, &selector)?;
            if let Some(folder) = &folder {
                conn.execute("delete from files where folder_id = ?1", params![folder.id])?;
                conn.execute("delete from folders where id = ?1", params![folder.id])?;
            }
            Ok(folder)
        })
        .await?
    }

    pub async fn list_folders(&self) -> Result<Vec<Folder>> {
        let db_path = self.db_path.clone();
        task::spawn_blocking(move || {
            let conn = Connection::open(db_path)?;
            list_folders(&conn)
        })
        .await?
    }

    pub async fn scan_all(&self) -> Result<Vec<ScanSummary>> {
        let folders = self.list_folders().await?;
        let mut summaries = Vec::with_capacity(folders.len());
        for folder in folders {
            summaries.push(self.scan_folder(&folder.id).await?);
        }
        Ok(summaries)
    }

    pub async fn scan_folder(&self, selector: &str) -> Result<ScanSummary> {
        let db_path = self.db_path.clone();
        let selector = selector.to_owned();
        task::spawn_blocking(move || {
            let conn = Connection::open(&db_path)?;
            let folder = find_folder(&conn, &selector)?
                .ok_or_else(|| NafmError::FolderNotFound(selector.clone()))?;
            scan_folder_blocking(&conn, &folder)
        })
        .await?
    }

    pub async fn find_duplicates(&self, selector: Option<&str>) -> Result<Vec<DuplicateGroup>> {
        let db_path = self.db_path.clone();
        let selector = selector.map(str::to_owned);
        task::spawn_blocking(move || {
            let conn = Connection::open(db_path)?;
            let folder_id = match selector {
                Some(selector) => Some(
                    find_folder(&conn, &selector)?
                        .ok_or_else(|| NafmError::FolderNotFound(selector))?
                        .id,
                ),
                None => None,
            };
            find_duplicates(&conn, folder_id.as_deref())
        })
        .await?
    }

    pub async fn trash_duplicate_group(
        &self,
        group_id: &str,
        keep_file_id: &str,
        dry_run: bool,
    ) -> Result<TrashPlan> {
        let db_path = self.db_path.clone();
        let group_id = group_id.to_owned();
        let keep_file_id = keep_file_id.to_owned();
        task::spawn_blocking(move || {
            let conn = Connection::open(db_path)?;
            let group = find_duplicates(&conn, None)?
                .into_iter()
                .find(|group| group.group_id == group_id)
                .ok_or_else(|| NafmError::DuplicateGroupNotFound(group_id.clone()))?;

            if !group.files.iter().any(|file| file.file_id == keep_file_id) {
                return Err(NafmError::FileNotInDuplicateGroup(keep_file_id));
            }

            let trashed_files = group
                .files
                .into_iter()
                .filter(|file| file.file_id != keep_file_id)
                .collect::<Vec<_>>();

            if !dry_run {
                for file in &trashed_files {
                    trash::delete(&file.path).map_err(|err| NafmError::Trash(err.to_string()))?;
                    conn.execute("delete from files where id = ?1", params![file.file_id])?;
                }
            }

            Ok(TrashPlan {
                group_id,
                kept_file_id: keep_file_id,
                trashed_files,
                dry_run,
            })
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

        create table if not exists folders (
          id text primary key not null,
          path text not null unique,
          alias text unique,
          hidden_policy text not null,
          added_at text not null
        );

        create table if not exists files (
          id text primary key not null,
          folder_id text not null references folders(id) on delete cascade,
          path text not null unique,
          size_bytes integer not null,
          modified_unix_nanos integer not null,
          content_hash text,
          last_seen_at text not null,
          foreign key(folder_id) references folders(id)
        );

        create index if not exists idx_files_folder_id on files(folder_id);
        create index if not exists idx_files_hash_size on files(content_hash, size_bytes);
        ",
            )?;
            Ok(())
        })
        .await?
    }
}

pub fn default_cache_path() -> Result<PathBuf> {
    let dirs =
        ProjectDirs::from("dev", "nafm", "nafm").ok_or(NafmError::AppDataDirectoryUnavailable)?;
    Ok(dirs.data_dir().join("nafm.sqlite3"))
}

fn scan_folder_blocking(conn: &Connection, folder: &Folder) -> Result<ScanSummary> {
    let files = discover_files(folder)?;
    let scan_time = Utc::now();
    let mut by_size: HashMap<u64, Vec<FileProbe>> = HashMap::new();
    for file in files {
        by_size.entry(file.size_bytes).or_default().push(file);
    }

    let mut files_seen = 0;
    let mut files_hashed = 0;
    let mut files_reused = 0;
    let mut bytes_hashed = 0;

    for candidates in by_size.values() {
        let should_hash = candidates.len() > 1 || has_external_size_collision(conn, candidates)?;
        for file in candidates {
            files_seen += 1;
            let existing = existing_record(conn, &file.path)?;
            let hash = if should_hash {
                match existing {
                    Some(record)
                        if record.content_hash.is_some()
                            && record_matches(
                                conn,
                                &record.id,
                                file.size_bytes,
                                file.modified_unix_nanos,
                            )? =>
                    {
                        files_reused += 1;
                        record.content_hash
                    }
                    _ => {
                        files_hashed += 1;
                        bytes_hashed += file.size_bytes;
                        Some(hash_file(&file.path)?)
                    }
                }
            } else {
                existing.and_then(|record| record.content_hash)
            };

            upsert_file(conn, folder, file, hash.as_deref(), scan_time)?;
        }
        if should_hash {
            let (extra_files_hashed, extra_bytes_hashed) =
                hash_unhashed_same_size_records(conn, candidates[0].size_bytes)?;
            files_hashed += extra_files_hashed;
            bytes_hashed += extra_bytes_hashed;
        }
    }

    let removed = conn.execute(
        "delete from files where folder_id = ?1 and last_seen_at <> ?2",
        params![folder.id, scan_time],
    )?;
    let duplicate_groups = find_duplicates(conn, Some(&folder.id))?;
    let duplicate_files = duplicate_groups
        .iter()
        .map(|group| group.files.len() as u64)
        .sum();

    Ok(ScanSummary {
        folder_id: folder.id.clone(),
        files_seen,
        files_hashed,
        files_reused,
        files_removed: removed as u64,
        bytes_hashed,
        duplicate_groups: duplicate_groups.len() as u64,
        duplicate_files,
    })
}

fn discover_files(folder: &Folder) -> Result<Vec<FileProbe>> {
    let mut files = Vec::new();
    let walker = WalkDir::new(&folder.path).follow_links(false).into_iter();
    for entry in walker.filter_entry(|entry| should_visit(entry, folder.hidden_policy)) {
        let entry = entry.map_err(|err| std::io::Error::other(err.to_string()))?;
        if !entry.file_type().is_file() {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| std::io::Error::other(err.to_string()))?;
        files.push(FileProbe {
            path: entry.path().to_path_buf(),
            size_bytes: metadata.len(),
            modified_unix_nanos: modified_unix_nanos(metadata.modified()?)?,
        });
    }
    Ok(files)
}

fn should_visit(entry: &DirEntry, hidden_policy: HiddenPolicy) -> bool {
    if entry.depth() == 0 {
        return true;
    }
    if hidden_policy == HiddenPolicy::Include {
        return true;
    }
    entry
        .file_name()
        .to_str()
        .is_none_or(|name| !name.starts_with('.'))
}

fn modified_unix_nanos(time: SystemTime) -> Result<i64> {
    let duration = time
        .duration_since(UNIX_EPOCH)
        .map_err(|err| std::io::Error::other(err.to_string()))?;
    Ok((duration.as_secs() as i64 * 1_000_000_000) + duration.subsec_nanos() as i64)
}

fn hash_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0; 1024 * 64];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

fn existing_record(conn: &Connection, path: &Path) -> Result<Option<ExistingRecord>> {
    conn.query_row(
        "select id, content_hash from files where path = ?1",
        params![path.to_string_lossy()],
        |row| {
            Ok(ExistingRecord {
                id: row.get(0)?,
                content_hash: row.get(1)?,
            })
        },
    )
    .optional()
    .map_err(Into::into)
}

fn has_external_size_collision(conn: &Connection, candidates: &[FileProbe]) -> Result<bool> {
    let Some(first) = candidates.first() else {
        return Ok(false);
    };
    let candidate_paths = candidates
        .iter()
        .map(|file| file.path.to_string_lossy().to_string())
        .collect::<HashSet<_>>();
    let mut stmt = conn.prepare("select path from files where size_bytes = ?1")?;
    let existing_paths = stmt
        .query_map(params![first.size_bytes], |row| row.get::<_, String>(0))?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(existing_paths
        .iter()
        .any(|path| !candidate_paths.contains(path)))
}

fn hash_unhashed_same_size_records(conn: &Connection, size_bytes: u64) -> Result<(u64, u64)> {
    let records = {
        let mut stmt = conn.prepare(
            "select id, path, size_bytes
       from files
       where size_bytes = ?1 and content_hash is null",
        )?;
        stmt.query_map(params![size_bytes], |row| {
            Ok((
                row.get::<_, String>(0)?,
                PathBuf::from(row.get::<_, String>(1)?),
                row.get::<_, u64>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut files_hashed = 0;
    let mut bytes_hashed = 0;
    for (id, path, size_bytes) in records {
        if !path.is_file() {
            conn.execute("delete from files where id = ?1", params![id])?;
            continue;
        }
        let content_hash = hash_file(&path)?;
        conn.execute(
            "update files set content_hash = ?1 where id = ?2",
            params![content_hash, id],
        )?;
        files_hashed += 1;
        bytes_hashed += size_bytes;
    }

    Ok((files_hashed, bytes_hashed))
}

fn record_matches(
    conn: &Connection,
    id: &str,
    size_bytes: u64,
    modified_unix_nanos: i64,
) -> Result<bool> {
    let found = conn.query_row(
        "select exists(
      select 1 from files
      where id = ?1 and size_bytes = ?2 and modified_unix_nanos = ?3
    )",
        params![id, size_bytes, modified_unix_nanos],
        |row| row.get::<_, bool>(0),
    )?;
    Ok(found)
}

fn upsert_file(
    conn: &Connection,
    folder: &Folder,
    file: &FileProbe,
    content_hash: Option<&str>,
    last_seen_at: DateTime<Utc>,
) -> Result<()> {
    conn.execute(
        "insert into files (
      id, folder_id, path, size_bytes, modified_unix_nanos, content_hash, last_seen_at
    )
    values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    on conflict(path) do update set
      folder_id = excluded.folder_id,
      size_bytes = excluded.size_bytes,
      modified_unix_nanos = excluded.modified_unix_nanos,
      content_hash = excluded.content_hash,
      last_seen_at = excluded.last_seen_at",
        params![
            Uuid::new_v4().to_string(),
            folder.id,
            file.path.to_string_lossy(),
            file.size_bytes,
            file.modified_unix_nanos,
            content_hash,
            last_seen_at,
        ],
    )?;
    Ok(())
}

fn find_duplicates(conn: &Connection, folder_id: Option<&str>) -> Result<Vec<DuplicateGroup>> {
    let mut groups = if let Some(folder_id) = folder_id {
        conn.prepare(
            "select content_hash, size_bytes
       from files
       where content_hash is not null and folder_id = ?1
       group by content_hash, size_bytes
       having count(*) > 1
       order by size_bytes desc, content_hash",
        )?
        .query_map(params![folder_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    } else {
        conn.prepare(
            "select content_hash, size_bytes
       from files
       where content_hash is not null
       group by content_hash, size_bytes
       having count(*) > 1
       order by size_bytes desc, content_hash",
        )?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, u64>(1)?))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?
    };

    let mut duplicate_groups = Vec::with_capacity(groups.len());
    for (hash, size_bytes) in groups.drain(..) {
        let files = duplicate_files(conn, folder_id, &hash, size_bytes)?;
        duplicate_groups.push(DuplicateGroup {
            group_id: hash.clone(),
            hash,
            size_bytes,
            files,
        });
    }
    Ok(duplicate_groups)
}

fn duplicate_files(
    conn: &Connection,
    folder_id: Option<&str>,
    hash: &str,
    size_bytes: u64,
) -> Result<Vec<DuplicateFile>> {
    if let Some(folder_id) = folder_id {
        let mut stmt = conn.prepare(
            "select id, folder_id, path, size_bytes, modified_unix_nanos
       from files
       where folder_id = ?1 and content_hash = ?2 and size_bytes = ?3
       order by path",
        )?;
        stmt.query_map(
            params![folder_id, hash, size_bytes],
            duplicate_file_from_row,
        )?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
    } else {
        let mut stmt = conn.prepare(
            "select id, folder_id, path, size_bytes, modified_unix_nanos
       from files
       where content_hash = ?1 and size_bytes = ?2
       order by path",
        )?;
        stmt.query_map(params![hash, size_bytes], duplicate_file_from_row)?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(Into::into)
    }
}

fn duplicate_file_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<DuplicateFile> {
    Ok(DuplicateFile {
        file_id: row.get(0)?,
        folder_id: row.get(1)?,
        path: PathBuf::from(row.get::<_, String>(2)?),
        size_bytes: row.get(3)?,
        modified_unix_nanos: row.get(4)?,
    })
}

fn list_folders(conn: &Connection) -> Result<Vec<Folder>> {
    let mut stmt = conn.prepare(
        "select id, path, alias, hidden_policy, added_at
     from folders
     order by coalesce(alias, path)",
    )?;
    stmt.query_map([], folder_from_row)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(Into::into)
}

fn find_folder(conn: &Connection, selector: &str) -> Result<Option<Folder>> {
    conn.query_row(
        "select id, path, alias, hidden_policy, added_at
       from folders
       where id = ?1 or alias = ?1 or path = ?1",
        params![selector],
        folder_from_row,
    )
    .optional()
    .map_err(Into::into)
}

fn folder_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Folder> {
    let hidden_policy: String = row.get(3)?;
    Ok(Folder {
        id: row.get(0)?,
        path: PathBuf::from(row.get::<_, String>(1)?),
        alias: row.get(2)?,
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
