use std::fs::{self, File, Metadata, OpenOptions};
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use tokio::task;
use uuid::Uuid;

use super::cleanup_plan::{CleanupFile, CleanupPlan};
use super::cleanup_trash::{is_system_trash_path, move_file_to_trash};
use super::{
  Repository, StageMutationKind, cleanup_review_snapshot, modified_unix_nanos, open_connection, record_stage_snapshot,
  with_deferred_transaction, with_immediate_transaction,
};
use crate::{CleanupFailure, CleanupReport, DuplicateFile, HashAlgorithm, NafmError, Result};

#[cfg(test)]
mod tests;

#[derive(Serialize, Deserialize)]
struct CleanupIntent {
  file: DuplicateFile,
  root: PathBuf,
  inventory_revision: u64,
}

#[derive(Serialize, Deserialize)]
struct CleanupJournal {
  targets: Vec<CleanupIntent>,
  skipped: Vec<CleanupFailure>,
}

struct VerifiedGroup<'a> {
  retained: &'a CleanupFile,
  retained_version: FileVersion,
  staged: Vec<(&'a CleanupFile, FileVersion)>,
}

struct FileVersion {
  identity: (u64, u128),
  change_time: Option<i64>,
  metadata: Metadata,
}

impl FileVersion {
  fn read(file: &File) -> io::Result<Self> {
    let (volume, file_id, change_time) = file_identity(file)?;
    Ok(Self {
      identity: (volume, file_id),
      change_time,
      metadata: file.metadata()?,
    })
  }

  fn matches(&self, other: &Self) -> bool {
    self.identity == other.identity
      && self.change_time == other.change_time
      && same_version(&self.metadata, &other.metadata)
  }
}

impl Repository {
  pub async fn move_cleanup_to_trash(&self, plan_id: &str) -> Result<CleanupReport> {
    let path = self.db_path.clone();
    let algorithm = self.hash_algorithm.clone();
    let plan_id = plan_id.to_owned();
    task::spawn_blocking(move || {
      let conn = open_connection(path)?;
      let app_root = crate::app_root_dir()?;
      fs::create_dir_all(&app_root)?;
      execute_cleanup(
        &conn,
        &app_root.join("cleanup.lock"),
        &plan_id,
        algorithm.as_ref(),
        move_file_to_trash,
      )
    })
    .await?
  }

  pub async fn latest_cleanup_activity(&self) -> Result<Option<CleanupReport>> {
    let path = self.db_path.clone();
    task::spawn_blocking(move || {
      let conn = open_connection(path)?;
      recover_interrupted(&conn)?;
      let json = conn
        .query_row(
          "select report_json from cleanup_operations where report_json is not null order by sequence desc limit 1",
          [],
          |row| row.get::<_, String>(0),
        )
        .optional()?;
      json
        .map(|json| serde_json::from_str(&json).map_err(Into::into))
        .transpose()
    })
    .await?
  }
}

pub(super) fn current_epoch(conn: &Connection) -> Result<i64> {
  Ok(
    conn.query_row("select coalesce(max(sequence), 0) from cleanup_operations", [], |row| {
      row.get(0)
    })?,
  )
}

pub(super) fn scan_epoch(conn: &Connection) -> Result<Option<i64>> {
  Ok(conn.query_row(
    "select case when not exists (select 1 from cleanup_operations where report_json is null)
       then (select coalesce(max(sequence), 0) from cleanup_operations) end",
    [],
    |row| row.get(0),
  )?)
}

fn execute_cleanup(
  conn: &Connection,
  account_lock_path: &Path,
  plan_id: &str,
  algorithm: &dyn HashAlgorithm,
  trash: impl Fn(&Path) -> Result<()>,
) -> Result<CleanupReport> {
  // Two different workspaces can index the same files. Hold the account lock
  // across verification and the moves so neither operation can keep the other's target.
  let _account_lock = try_lock(account_lock_path)?.ok_or(NafmError::CleanupInProgress)?;
  let _workspace_lock = try_lock(&workspace_lock_path(conn)?)?.ok_or(NafmError::CleanupInProgress)?;
  reconcile_interrupted(conn)?;
  if let Some(report) = completed_report(conn, plan_id)? {
    return Ok(report);
  }
  let (epoch, plan) = with_deferred_transaction(conn, || {
    let epoch = scan_epoch(conn)?.ok_or(NafmError::CleanupInProgress)?;
    Ok((epoch, reviewed_plan(conn, epoch, plan_id)?))
  })?;

  let mut report = CleanupReport {
    operation_id: Uuid::new_v4().to_string(),
    moved_files: Vec::new(),
    skipped_files: Vec::new(),
  };
  let groups = verify_plan(&plan, algorithm, &mut report);
  let targets = groups
    .iter()
    .flat_map(|group| &group.staged)
    .map(|(target, _)| CleanupIntent {
      file: target.file.clone(),
      root: target.root.clone(),
      inventory_revision: target.inventory_revision,
    })
    .collect::<Vec<_>>();
  let journal = CleanupJournal {
    targets,
    skipped: report.skipped_files.clone(),
  };

  let existing = with_immediate_transaction(conn, || {
    if let Some(report) = completed_report(conn, plan_id)? {
      return Ok(Some(report));
    }
    if scan_epoch(conn)? != Some(epoch) {
      return Err(NafmError::CleanupPreviewChanged);
    }
    reviewed_plan(conn, epoch, plan_id)?;
    conn.execute(
      "insert into cleanup_operations (operation_id, plan_id, intent_json) values (?1, ?2, ?3)",
      params![report.operation_id, plan_id, serde_json::to_string(&journal)?],
    )?;
    Ok(None)
  })?;
  if let Some(report) = existing {
    return Ok(report);
  }

  // Persist the intent before the OS call. A crash rolls back the index changes,
  // while the next scan or cleanup visit can reconcile the original paths.
  with_immediate_transaction(conn, || {
    if let Some(report) = completed_report(conn, plan_id)? {
      return Ok(report);
    }
    match reviewed_plan(conn, epoch, plan_id) {
      Err(NafmError::CleanupPreviewChanged) => {
        for intent in &journal.targets {
          skip(&mut report, &intent.file, NafmError::CleanupPreviewChanged.to_string());
        }
        save_report(conn, &report)?;
        return Ok(report);
      }
      other => {
        other?;
      }
    }
    let mut removed = false;
    for group in groups {
      for (target, version) in group.staged {
        let result = verify_unchanged(group.retained, &group.retained_version)
          .map_err(|_| "The retained copy changed. Rescan before trying again.".to_owned())
          .and_then(|()| verify_unchanged(target, &version).map_err(|error| error.to_string()))
          .and_then(|()| trash(&target.file.path).map_err(|error| error.to_string()));
        if let Err(message) = result {
          skip(&mut report, &target.file, message);
          continue;
        }
        if path_is_missing(&target.file.path, &target.root) {
          removed |= remove_file_record(conn, &target.file, target.inventory_revision)?;
          report.moved_files.push(target.file.clone());
        } else {
          skip(
            &mut report,
            &target.file,
            "The original path is still occupied. Check Trash and rescan this site.",
          );
        }
      }
    }
    if removed {
      record_stage_snapshot(conn, StageMutationKind::Remove)?;
    }
    save_report(conn, &report)?;
    Ok(report)
  })
}

fn reviewed_plan(conn: &Connection, epoch: i64, plan_id: &str) -> Result<CleanupPlan> {
  let (_, plan) = cleanup_review_snapshot(conn, epoch)?;
  if plan.preview.plan_id.as_deref() != Some(plan_id) || plan.groups.is_empty() {
    return Err(NafmError::CleanupPreviewChanged);
  }
  Ok(plan)
}

fn verify_plan<'a>(
  plan: &'a CleanupPlan,
  algorithm: &dyn HashAlgorithm,
  report: &mut CleanupReport,
) -> Vec<VerifiedGroup<'a>> {
  let mut verified = Vec::new();
  for group in &plan.groups {
    let verify = |candidate| verify_content(candidate, algorithm, &group.hash_algorithm, &group.content_hash);
    let mut staged = Vec::new();
    for target in &group.staged {
      match verify(target) {
        Ok(version) => staged.push((target, version)),
        Err(error) => skip(report, &target.file, error.to_string()),
      }
    }
    if staged.is_empty() {
      continue;
    }
    let retained = group.retained.iter().find_map(|candidate| {
      let version = verify(candidate).ok()?;
      // Aliases (including bind mounts and hard links) do not prove an independent copy.
      (!staged.iter().any(|(_, staged)| staged.identity == version.identity)).then_some((candidate, version))
    });
    let Some((retained, retained_version)) = retained else {
      for (target, _) in staged {
        skip(
          report,
          &target.file,
          "No independent retained copy could be verified on this device. Rescan or keep another copy before trying again.",
        );
      }
      continue;
    };
    verified.push(VerifiedGroup {
      retained,
      retained_version,
      staged,
    });
  }
  verified
}

fn verify_content(file: &CleanupFile, algorithm: &dyn HashAlgorithm, name: &str, digest: &str) -> Result<FileVersion> {
  if algorithm.name() != name {
    return Err(NafmError::CleanupFileChanged);
  }
  let before = checked_metadata(file)?;
  let mut handle = File::open(&file.file.path)?;
  let version = FileVersion::read(&handle)?;
  if !same_version(&before, &version.metadata) {
    return Err(NafmError::CleanupFileChanged);
  }
  let mut hasher = algorithm.new_hasher();
  let mut buffer = [0; 64 * 1024];
  loop {
    let size = handle.read(&mut buffer)?;
    if size == 0 {
      break;
    }
    hasher.update(&buffer[..size]);
  }
  if hasher.finalize() != digest || !version.matches(&FileVersion::read(&handle)?) {
    return Err(NafmError::CleanupFileChanged);
  }
  verify_unchanged(file, &version)?;
  Ok(version)
}

fn verify_unchanged(file: &CleanupFile, version: &FileVersion) -> Result<()> {
  if !same_version(&checked_metadata(file)?, &version.metadata) {
    return Err(NafmError::CleanupFileChanged);
  }
  let current = File::open(&file.file.path)?;
  if !version.matches(&FileVersion::read(&current)?) {
    return Err(NafmError::CleanupFileChanged);
  }
  Ok(())
}

fn checked_metadata(file: &CleanupFile) -> Result<Metadata> {
  let path = &file.file.path;
  let meta = fs::symlink_metadata(path)?;
  if !meta.file_type().is_file()
    || is_system_trash_path(path)
    || !path.starts_with(&file.root)
    || fs::canonicalize(&file.root)? != file.root
    || fs::canonicalize(path)? != *path
    || meta.len() != file.file.size_bytes
    || modified_unix_nanos(meta.modified()?)? != file.file.modified_unix_nanos
  {
    return Err(NafmError::CleanupFileChanged);
  }
  Ok(meta)
}

fn same_version(a: &Metadata, b: &Metadata) -> bool {
  if a.modified().ok() != b.modified().ok() || a.len() != b.len() {
    return false;
  }
  #[cfg(unix)]
  {
    use std::os::unix::fs::MetadataExt;
    return a.dev() == b.dev() && a.ino() == b.ino() && a.ctime() == b.ctime() && a.ctime_nsec() == b.ctime_nsec();
  }
  #[cfg(windows)]
  {
    use std::os::windows::fs::MetadataExt;
    return a.creation_time() == b.creation_time() && a.file_attributes() == b.file_attributes();
  }
  #[allow(unreachable_code)]
  false
}

#[cfg(unix)]
fn file_identity(file: &File) -> io::Result<(u64, u128, Option<i64>)> {
  use std::os::unix::fs::MetadataExt;
  let metadata = file.metadata()?;
  // Unix change time is checked to nanosecond precision in same_version.
  Ok((metadata.dev(), u128::from(metadata.ino()), None))
}

#[cfg(windows)]
fn file_identity(file: &File) -> io::Result<(u64, u128, Option<i64>)> {
  let (volume, file_id, change_time) = super::cleanup_trash::windows_file_identity(file)?;
  Ok((volume, file_id, Some(change_time)))
}

#[cfg(not(any(unix, windows)))]
fn file_identity(_file: &File) -> io::Result<(u64, u128, Option<i64>)> {
  Err(io::Error::new(
    io::ErrorKind::Unsupported,
    "This platform cannot verify file identity for Trash.",
  ))
}

fn path_is_missing(path: &Path, root: &Path) -> bool {
  path.starts_with(root)
    && fs::canonicalize(root).is_ok_and(|resolved| resolved == root)
    && path
      .parent()
      .is_some_and(|parent| fs::canonicalize(parent).is_ok_and(|resolved| resolved == parent))
    && fs::symlink_metadata(path).is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
}

fn remove_file_record(conn: &Connection, file: &DuplicateFile, revision: u64) -> Result<bool> {
  let removed = conn.execute(
    "delete from file_records where id = ?1 and path = ?2 and inventory_revision = ?3",
    params![file.file_id, file.path.to_string_lossy(), revision],
  )?;
  if removed > 0 {
    conn.execute(
      "delete from scan_cache_entries where site_id = ?1 and path = ?2",
      params![file.site_id, file.path.to_string_lossy()],
    )?;
  }
  Ok(removed > 0)
}

fn skip(report: &mut CleanupReport, file: &DuplicateFile, message: impl Into<String>) {
  report.skipped_files.push(CleanupFailure {
    file: file.clone(),
    message: message.into(),
  });
}

fn save_report(conn: &Connection, report: &CleanupReport) -> Result<()> {
  conn.execute(
    "update cleanup_operations set report_json = ?2, intent_json = '[]' where operation_id = ?1",
    params![report.operation_id, serde_json::to_string(report)?],
  )?;
  Ok(())
}

fn completed_report(conn: &Connection, plan_id: &str) -> Result<Option<CleanupReport>> {
  let json = conn
    .query_row(
      "select report_json from cleanup_operations where plan_id = ?1 and report_json is not null",
      [plan_id],
      |row| row.get::<_, String>(0),
    )
    .optional()?;
  json
    .map(|json| serde_json::from_str(&json).map_err(Into::into))
    .transpose()
}

pub(super) fn recover_interrupted(conn: &Connection) -> Result<()> {
  if scan_epoch(conn)?.is_some() {
    return Ok(());
  }
  if let Some(_workspace_lock) = try_lock(&workspace_lock_path(conn)?)? {
    reconcile_interrupted(conn)?;
  }
  Ok(())
}

fn workspace_lock_path(conn: &Connection) -> Result<PathBuf> {
  let database = conn
    .path()
    .ok_or_else(|| io::Error::other("Cleanup requires a workspace on disk."))?;
  let mut path = fs::canonicalize(database)?.into_os_string();
  path.push(".cleanup-lock");
  Ok(path.into())
}

fn try_lock(path: &Path) -> Result<Option<File>> {
  let handle = OpenOptions::new()
    .read(true)
    .write(true)
    .create(true)
    .truncate(false)
    .open(path)?;
  match fs2::FileExt::try_lock_exclusive(&handle) {
    Ok(()) => Ok(Some(handle)),
    Err(error) if error.raw_os_error() == fs2::lock_contended_error().raw_os_error() => Ok(None),
    Err(error) => Err(error.into()),
  }
}

fn reconcile_interrupted(conn: &Connection) -> Result<()> {
  if scan_epoch(conn)?.is_some() {
    return Ok(());
  }
  with_immediate_transaction(conn, || {
    let pending = conn
      .query_row(
        "select operation_id, intent_json from cleanup_operations where report_json is null",
        [],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
      )
      .optional()?;
    let mut removed = false;
    if let Some((operation_id, json)) = pending {
      let journal: CleanupJournal = serde_json::from_str(&json)?;
      let mut report = CleanupReport {
        operation_id,
        moved_files: Vec::new(),
        skipped_files: journal.skipped,
      };
      for intent in journal.targets {
        let missing = path_is_missing(&intent.file.path, &intent.root);
        if missing {
          removed |= remove_file_record(conn, &intent.file, intent.inventory_revision)?;
        }
        let message = if missing {
          "Cleanup was interrupted and this path is now empty. Check the system Trash for the file."
        } else {
          "Cleanup was interrupted. Check the original folder and the system Trash before trying again."
        };
        skip(&mut report, &intent.file, message);
      }
      save_report(conn, &report)?;
    }
    if removed {
      record_stage_snapshot(conn, StageMutationKind::Remove)?;
    }
    Ok(())
  })
}
