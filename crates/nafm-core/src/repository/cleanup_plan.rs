use super::{Connection, DuplicateFile, Result, StageReviewGroup};
use crate::model::{CleanupActionBlocker, CleanupActionBlockerReason, CleanupActionPreview};
use rusqlite::params;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Component, PathBuf, Prefix};

#[derive(Debug, Default)]
pub(super) struct CleanupPlan {
  pub(super) preview: CleanupActionPreview,
  pub(super) groups: Vec<CleanupGroup>,
}

#[derive(Debug)]
pub(super) struct CleanupGroup {
  pub(super) hash_algorithm: String,
  pub(super) content_hash: String,
  pub(super) staged: Vec<CleanupFile>,
  pub(super) retained: Vec<CleanupFile>,
}

#[derive(Debug, Serialize)]
pub(super) struct CleanupFile {
  pub(super) file: DuplicateFile,
  pub(super) root: PathBuf,
  pub(super) inventory_revision: u64,
  hash_revision: u64,
  hash_algorithm: String,
  content_hash: String,
  hash_source_key: Option<String>,
  root_kind: String,
}

impl CleanupFile {
  fn is_local(&self) -> bool {
    // SMB and mapped SSH scans share an SMB namespace. Windows UNC roots can also be
    // registered as native paths; only disk prefixes are eligible for local Trash.
    if self.root_kind != "local" || self.hash_source_key.is_some() || !self.root.is_absolute() {
      return false;
    }
    if self.root.to_string_lossy().starts_with("//") {
      return false;
    }
    if let Some(Component::Prefix(prefix)) = self.root.components().next()
      && !matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    {
      return false;
    }
    self.file.path.strip_prefix(&self.root).is_ok_and(|relative| {
      !relative.as_os_str().is_empty() && relative.components().all(|part| matches!(part, Component::Normal(_)))
    })
  }
}

/// Called inside the transaction that read the staged files and verified review groups.
pub(super) fn derive(
  conn: &Connection,
  staged_files: &[DuplicateFile],
  review_groups: &[StageReviewGroup],
  cleanup_ready: bool,
  snapshot_id: &str,
) -> Result<CleanupPlan> {
  if !cleanup_ready || staged_files.is_empty() {
    return Ok(CleanupPlan::default());
  }
  let mut metadata = conn.prepare(
    "select root.path, root.kind, file.inventory_revision, file.hash_revision,
       file.hash_algorithm, file.content_hash, file.hash_source_key
     from file_records file
     join site_folders root on root.id = file.site_folder_id and root.site_id = file.site_id
     where file.id = ?1",
  )?;
  let mut indexed = |file: &DuplicateFile| -> Result<CleanupFile> {
    metadata
      .query_row(params![file.file_id], |row| {
        Ok(CleanupFile {
          file: file.clone(),
          root: PathBuf::from(row.get::<_, String>(0)?),
          root_kind: row.get(1)?,
          inventory_revision: row.get(2)?,
          hash_revision: row.get(3)?,
          hash_algorithm: row.get(4)?,
          content_hash: row.get(5)?,
          hash_source_key: row.get(6)?,
        })
      })
      .map_err(Into::into)
  };

  let mut staged_by_id: BTreeMap<_, _> = staged_files.iter().map(|file| (file.file_id.as_str(), file)).collect();
  let mut ordered_groups: Vec<_> = review_groups.iter().collect();
  ordered_groups.sort_unstable_by_key(|group| &group.group_id);
  let mut fingerprint = blake3::Hasher::new_derive_key("NAFM indexed cleanup plan v1");
  serde_json::to_writer(&mut fingerprint, snapshot_id)?;
  let mut plan = CleanupPlan::default();
  for group in ordered_groups {
    let mut staged = Vec::with_capacity(group.staged_file_ids.len());
    for id in &group.staged_file_ids {
      let Some(file) = staged_by_id.remove(id.as_str()) else {
        return Ok(CleanupPlan::default());
      };
      staged.push(indexed(file)?);
    }
    staged.sort_unstable_by(|a, b| a.file.file_id.cmp(&b.file.file_id));
    let Some(first) = staged.first() else {
      return Ok(CleanupPlan::default());
    };
    let hash_algorithm = first.hash_algorithm.clone();
    let content_hash = first.content_hash.clone();
    let mut retained: Vec<_> = group.retained_files.iter().map(&mut indexed).collect::<Result<_>>()?;
    retained.sort_unstable_by(|a, b| a.file.file_id.cmp(&b.file.file_id));
    // The token includes *all* copies identified to the user, even if one cannot serve
    // as a live local witness. Reordering query results preserves the same token.
    serde_json::to_writer(&mut fingerprint, &(&group.group_id, &staged, &retained))?;
    retained.retain(CleanupFile::is_local);
    for file in &staged {
      let reason = if !file.is_local() {
        CleanupActionBlockerReason::UnsupportedSource
      } else if retained.is_empty() {
        CleanupActionBlockerReason::NoLocalRetainedCopy
      } else {
        continue;
      };
      plan.preview.blockers.push(CleanupActionBlocker {
        file_id: file.file.file_id.clone(),
        reason,
      });
    }
    plan.groups.push(CleanupGroup {
      hash_algorithm,
      content_hash,
      staged,
      retained,
    });
  }
  if !staged_by_id.is_empty() {
    return Ok(CleanupPlan::default());
  }
  if plan.preview.blockers.is_empty() {
    plan.preview.plan_id = Some(fingerprint.finalize().to_hex().to_string());
  } else {
    plan.groups.clear();
  }
  Ok(plan)
}

#[cfg(test)]
mod tests {
  use super::*;
  use crate::{AddSiteFolderRequest, HiddenPolicy, Repository, RepositoryOptions, StageCommitDryRun};
  use std::fs;

  struct Fixture {
    _directory: tempfile::TempDir,
    repo: Repository,
    conn: Connection,
  }

  impl Fixture {
    fn plan(&self, review: &StageCommitDryRun, snapshot: &str) -> CleanupPlan {
      derive(
        &self.conn,
        &review.staged_files,
        &review.review_groups,
        review.cleanup_ready,
        snapshot,
      )
      .unwrap()
    }

    async fn new() -> Self {
      let directory = tempfile::tempdir().unwrap();
      let repo = Repository::open(RepositoryOptions {
        cache_path: directory.path().join("workspace.sqlite3"),
        hash_algorithm: None,
      })
      .await
      .unwrap();
      for site in ["staged", "retained"] {
        let path = directory.path().join(site);
        fs::create_dir(&path).unwrap();
        for (name, bytes) in [
          ("alpha.txt", "alpha"),
          ("also-alpha.txt", "alpha"),
          ("beta.txt", "beta"),
        ] {
          fs::write(path.join(name), bytes).unwrap();
        }
        repo.create_site(site).await.unwrap();
        repo
          .add_site_folder(
            site,
            AddSiteFolderRequest {
              path,
              hidden_policy: HiddenPolicy::Include,
            },
          )
          .await
          .unwrap();
      }
      repo.scan_all().await.unwrap();
      let report = repo.stage_add_path(&directory.path().join("staged")).await.unwrap();
      assert_eq!(report.staged_files.len(), 3);
      let conn = Connection::open(repo.db_path()).unwrap();
      Self {
        _directory: directory,
        repo,
        conn,
      }
    }
  }

  #[tokio::test]
  async fn token_binds_reviewed_records_and_snapshot_independently_of_row_order() {
    let fixture = Fixture::new().await;
    let mut review = fixture.repo.stage_commit_dry_run().await.unwrap();
    let token = fixture
      .plan(&review, &review.stage_history.snapshot_id)
      .preview
      .plan_id
      .unwrap();
    assert_eq!(review.review_groups.len(), 2);
    review.staged_files.reverse();
    review.review_groups.reverse();
    for group in &mut review.review_groups {
      group.staged_file_ids.reverse();
      group.retained_files.reverse();
    }
    let plan = |snapshot: &str| fixture.plan(&review, snapshot).preview.plan_id.unwrap();
    assert_eq!(plan(&review.stage_history.snapshot_id), token);
    assert_ne!(plan("a different staged selection"), token);

    fixture.repo.scan_site("retained").await.unwrap();
    let after_scan = fixture.repo.stage_commit_dry_run().await.unwrap();
    assert_eq!(after_scan.stage_history, review.stage_history);
    assert_ne!(after_scan.action.plan_id.unwrap(), review.action.plan_id.unwrap());
  }

  #[tokio::test]
  async fn only_native_sources_can_be_moved_or_count_as_a_local_retained_copy() {
    let fixture = Fixture::new().await;
    let initial = fixture.repo.stage_commit_dry_run().await.unwrap();
    let original_token = fixture
      .plan(&initial, &initial.stage_history.snapshot_id)
      .preview
      .plan_id
      .unwrap();
    let group = initial
      .review_groups
      .iter()
      .find(|group| group.retained_files.len() == 2)
      .unwrap();
    let retained = &group.retained_files[0];
    fixture
      .conn
      .execute(
        "update file_records set hash_source_key = 'remote-mapping' where id = ?1",
        [&retained.file_id],
      )
      .unwrap();
    let plan = fixture.plan(&initial, &initial.stage_history.snapshot_id);
    assert!(plan.preview.blockers.is_empty());
    assert_ne!(plan.preview.plan_id.unwrap(), original_token);
    assert_eq!(plan.groups.iter().map(|group| group.retained.len()).sum::<usize>(), 2);

    let staged = &initial.staged_files[0];
    fixture
      .conn
      .execute(
        "update file_records set hash_source_key = 'remote-mapping' where id = ?1",
        [&staged.file_id],
      )
      .unwrap();
    let changed = fixture.repo.stage_commit_dry_run().await.unwrap();
    assert_eq!(changed.action.plan_id, None);
    assert_eq!(
      changed.action.blockers,
      vec![CleanupActionBlocker {
        file_id: staged.file_id.clone(),
        reason: CleanupActionBlockerReason::UnsupportedSource,
      }]
    );

    fixture
      .conn
      .execute("update file_records set hash_source_key = null", [])
      .unwrap();
    fixture
      .conn
      .execute(
        "update site_folders set kind = 'smb' where id = ?1",
        [&retained.site_folder_id],
      )
      .unwrap();
    let blocked = fixture.repo.stage_commit_dry_run().await.unwrap();
    assert!(blocked.cleanup_ready);
    assert!(blocked.action.plan_id.is_none());
    let mut blocked_ids: Vec<_> = blocked
      .action
      .blockers
      .into_iter()
      .map(|blocker| {
        assert_eq!(blocker.reason, CleanupActionBlockerReason::NoLocalRetainedCopy);
        blocker.file_id
      })
      .collect();
    let mut staged_ids: Vec<_> = blocked.staged_files.into_iter().map(|file| file.file_id).collect();
    blocked_ids.sort();
    staged_ids.sort();
    assert_eq!(blocked_ids, staged_ids);
  }
}
