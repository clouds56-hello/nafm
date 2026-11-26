use std::fs::FileTimes;
use std::sync::Mutex;

use super::*;
use crate::{AddSiteFolderRequest, Blake3HashAlgorithm, HiddenPolicy, RepositoryOptions};

struct Fixture {
  _temporary: tempfile::TempDir,
  repo: Repository,
  staged: PathBuf,
  retained: PathBuf,
}

impl Fixture {
  async fn new() -> Self {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("site");
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    let staged = root.join("staged.bin");
    let retained = root.join("retained.bin");
    fs::write(&staged, b"same bytes").unwrap();
    fs::write(&retained, b"same bytes").unwrap();
    let repo = Repository::open(RepositoryOptions {
      cache_path: temporary.path().join("workspace.sqlite3"),
      hash_algorithm: None,
    })
    .await
    .unwrap();
    repo.create_site("Local archive").await.unwrap();
    repo
      .add_site_folder(
        "Local archive",
        AddSiteFolderRequest {
          path: root,
          hidden_policy: HiddenPolicy::Include,
        },
      )
      .await
      .unwrap();
    repo.scan_site("Local archive").await.unwrap();
    repo.stage_add_path(&staged).await.unwrap();
    Self {
      _temporary: temporary,
      repo,
      staged,
      retained,
    }
  }

  async fn plan(&self) -> String {
    self.repo.stage_commit_dry_run().await.unwrap().action.plan_id.unwrap()
  }

  fn connection(&self) -> Connection {
    open_connection(self.repo.db_path()).unwrap()
  }

  fn execute(&self, plan: &str, trash: impl Fn(&Path) -> Result<()>) -> Result<CleanupReport> {
    self.execute_with_progress(plan, trash, None)
  }

  fn execute_with_progress(
    &self,
    plan: &str,
    trash: impl Fn(&Path) -> Result<()>,
    on_progress: Option<&CleanupProgressCallback>,
  ) -> Result<CleanupReport> {
    execute_cleanup(
      &self.connection(),
      &self._temporary.path().join("account.lock"),
      plan,
      &Blake3HashAlgorithm,
      trash,
      on_progress,
    )
  }

  fn fake_trash(&self, from: &Path) -> Result<()> {
    fs::rename(from, self._temporary.path().join("trashed.bin"))?;
    Ok(())
  }
}

#[tokio::test]
async fn progress_checks_each_selected_file_before_attempting_the_move() {
  use CleanupProgressPhase::{Moving, Verifying};

  let fixture = Fixture::new().await;
  let plan = fixture.plan().await;
  let events = Arc::new(Mutex::new(Vec::<CleanupProgress>::new()));
  let received = events.clone();
  let on_progress = move |state: &CleanupProgress| received.lock().unwrap().push(state.clone());

  let receipt = fixture
    .execute_with_progress(
      &plan,
      |path| {
        let latest = events.lock().unwrap().last().unwrap().clone();
        assert_eq!(latest.phase, Moving);
        assert_eq!(latest.processed_files, 0);
        assert_eq!(latest.current_file.as_deref(), Some(path));
        assert_eq!(latest.bytes_checked, None);
        fixture.fake_trash(path)
      },
      Some(&on_progress),
    )
    .unwrap();
  assert_eq!(receipt.moved_files.len(), 1);

  let events = events.lock().unwrap();
  let initial = events.first().unwrap();
  assert_eq!(initial.phase, Verifying);
  assert_eq!(initial.processed_files, 0);
  assert_eq!(initial.current_file.as_deref(), Some(fixture.staged.as_path()));
  assert_eq!(initial.bytes_checked, Some(0));
  assert_eq!(initial.file_size_bytes, Some(b"same bytes".len() as u64));
  let (verification, movement) = events.split_at(events.iter().position(|event| event.phase == Moving).unwrap());
  for (phase, steps) in [(Verifying, verification), (Moving, movement)] {
    assert!(steps.iter().all(|step| step.phase == phase && step.total_files == 1));
    let completed = steps.last().unwrap();
    assert_eq!(completed.processed_files, 1);
    assert_eq!(completed.current_file, None);
  }
}

#[tokio::test]
async fn a_completed_cleanup_updates_the_index_and_retries_are_read_only() {
  let fixture = Fixture::new().await;
  let plan = fixture.plan().await;
  let receipt = fixture.execute(&plan, |path| fixture.fake_trash(path)).unwrap();
  assert_eq!(receipt.moved_files[0].path, fixture.staged);
  assert!(receipt.skipped_files.is_empty());
  assert_eq!(fs::read(&fixture.retained).unwrap(), b"same bytes");
  assert!(!fixture.staged.exists());
  assert!(
    fixture
      .repo
      .stage_commit_dry_run()
      .await
      .unwrap()
      .staged_files
      .is_empty()
  );
  assert!(fixture.repo.find_duplicates(None).await.unwrap().is_empty());

  let repeated = fixture.execute(&plan, |_| panic!("second move")).unwrap();
  assert_eq!(repeated.operation_id, receipt.operation_id);
  assert_eq!(
    fixture
      .repo
      .latest_cleanup_activity()
      .await
      .unwrap()
      .unwrap()
      .operation_id,
    receipt.operation_id
  );

  fs::rename(fixture._temporary.path().join("trashed.bin"), &fixture.staged).unwrap();
  fixture.repo.scan_site("Local archive").await.unwrap();
  assert_eq!(fixture.repo.find_duplicates(None).await.unwrap()[0].files.len(), 2);
  assert!(
    fixture
      .repo
      .stage_commit_dry_run()
      .await
      .unwrap()
      .staged_files
      .is_empty()
  );
}

#[tokio::test]
async fn rejects_a_changed_stage_before_touching_the_filesystem() {
  let fixture = Fixture::new().await;
  let plan = fixture.plan().await;
  fixture.repo.stage_remove_path(&fixture.staged).await.unwrap();
  let error = fixture
    .execute(&plan, |_| panic!("stale plan moved a file"))
    .unwrap_err();
  assert!(matches!(error, NafmError::CleanupPreviewChanged));
  assert!(fixture.staged.exists());
}

#[tokio::test]
async fn an_off_index_same_size_edit_to_the_last_retained_copy_prevents_cleanup() {
  let fixture = Fixture::new().await;
  let plan = fixture.plan().await;
  let before = fs::metadata(&fixture.retained).unwrap().modified().unwrap();
  fs::write(&fixture.retained, b"new bytes!").unwrap();
  File::options()
    .write(true)
    .open(&fixture.retained)
    .unwrap()
    .set_times(FileTimes::new().set_modified(before))
    .unwrap();
  let receipt = fixture.execute(&plan, |_| panic!("unverified copy moved")).unwrap();
  assert!(receipt.moved_files.is_empty());
  assert_eq!(receipt.skipped_files[0].file.path, fixture.staged);
  assert!(
    receipt.skipped_files[0]
      .message
      .contains("No independent retained copy")
  );
  assert!(fixture.staged.exists());
  assert_ne!(fixture.plan().await, plan);
}

#[tokio::test]
async fn interrupted_transfer_removes_only_confirmably_absent_index_paths() {
  let fixture = Fixture::new().await;
  let plan = fixture.plan().await;
  let interrupted = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    fixture.execute(&plan, |path| {
      fixture.fake_trash(path)?;
      panic!("simulated exit after the OS moved a file");
    })
  }));
  assert!(interrupted.is_err());

  let recovered = fixture.repo.latest_cleanup_activity().await.unwrap().unwrap();
  assert!(recovered.moved_files.is_empty());
  assert!(recovered.skipped_files[0].message.contains("path is now empty"));
  assert!(
    fixture
      .repo
      .stage_commit_dry_run()
      .await
      .unwrap()
      .staged_files
      .is_empty()
  );
  assert_eq!(fs::read(&fixture.retained).unwrap(), b"same bytes");
}

#[tokio::test]
async fn an_unavailable_trash_leaves_failed_files_staged() {
  let fixture = Fixture::new().await;
  let plan = fixture.plan().await;
  let receipt = fixture
    .execute(&plan, |_| {
      Err(io::Error::new(io::ErrorKind::PermissionDenied, "Trash unavailable").into())
    })
    .unwrap();
  assert!(receipt.moved_files.is_empty());
  assert!(receipt.skipped_files[0].message.contains("Trash unavailable"));
  assert!(fixture.staged.exists());
  assert_eq!(fixture.repo.stage_commit_dry_run().await.unwrap().staged_files.len(), 1);
}

#[tokio::test]
async fn hard_links_do_not_count_as_an_independent_retained_copy() {
  let fixture = Fixture::new().await;
  fs::remove_file(&fixture.retained).unwrap();
  fs::hard_link(&fixture.staged, &fixture.retained).unwrap();
  fixture.repo.scan_site("Local archive").await.unwrap();
  let plan = fixture.plan().await;
  let report = fixture
    .execute(&plan, |_| panic!("hard link is not an independent witness"))
    .unwrap();
  assert!(report.moved_files.is_empty());
  assert!(report.skipped_files[0].message.contains("No independent retained copy"));
}

#[tokio::test]
async fn a_live_intent_is_left_alone_and_another_workspace_cannot_move_files() {
  let fixture = Fixture::new().await;
  let conn = fixture.connection();
  let other = Fixture::new().await;
  let other_conn = other.connection();
  let plan = fixture.plan().await;
  let other_plan = other.plan().await;
  let account_lock = fixture._temporary.path().join("account.lock");
  let _account = try_lock(&account_lock).unwrap().unwrap();
  let _workspace = try_lock(&workspace_lock_path(&conn).unwrap()).unwrap().unwrap();
  conn
    .execute(
      "insert into cleanup_operations (operation_id, plan_id, intent_json) values ('live', ?1, '')",
      [&plan],
    )
    .unwrap();
  recover_interrupted(&conn).unwrap();
  assert_eq!(scan_epoch(&conn).unwrap(), None);
  assert!(matches!(
    execute_cleanup(
      &other_conn,
      &account_lock,
      &other_plan,
      &Blake3HashAlgorithm,
      |_| panic!("overlapping cleanup"),
      None,
    ),
    Err(NafmError::CleanupInProgress)
  ));
}
