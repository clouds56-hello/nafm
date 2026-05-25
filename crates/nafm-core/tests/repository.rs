use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nafm_core::{AddSiteFolderRequest, HashAlgorithm, HiddenPolicy, Repository, RepositoryOptions};
use tempfile::TempDir;

#[tokio::test]
async fn scan_site_detects_duplicates_across_site_folders() {
  let fixture = Fixture::new().await;
  let first = fixture.mkdir("first");
  let second = fixture.mkdir("second");
  fs::write(first.join("a.txt"), "same").unwrap();
  fs::write(second.join("b.txt"), "same").unwrap();
  fs::write(second.join("c.txt"), "other").unwrap();

  fixture.create_site("archive").await;
  fixture.add_site_folder("archive", &first, HiddenPolicy::Include).await;
  fixture.add_site_folder("archive", &second, HiddenPolicy::Include).await;

  let summary = fixture.repo.scan_site("archive").await.unwrap();
  assert_eq!(summary.site_name, "archive");
  assert_eq!(summary.site_folders, 2);
  assert_eq!(summary.files_seen, 3);
  assert_eq!(summary.files_hashed, 3);
  assert_eq!(summary.duplicate_groups, 1);
  assert_eq!(summary.duplicate_files, 2);

  let duplicates = fixture.repo.find_duplicates(Some("archive")).await.unwrap();
  assert_eq!(duplicates.len(), 1);
  assert_eq!(duplicates[0].files.len(), 2);
}

#[tokio::test]
async fn scan_site_reuses_hashes_for_unchanged_files() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("a.txt"), "same").unwrap();
  fs::write(docs.join("b.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Include).await;

  let first = fixture.repo.scan_site("docs").await.unwrap();
  let second = fixture.repo.scan_site("docs").await.unwrap();

  assert_eq!(first.files_hashed, 2);
  assert_eq!(second.files_hashed, 0);
  assert_eq!(second.files_reused, 2);
}

#[tokio::test]
async fn scan_respects_hidden_policy_per_site_folder() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("visible.txt"), "same").unwrap();
  fs::write(docs.join(".hidden.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Skip).await;

  let summary = fixture.repo.scan_site("docs").await.unwrap();
  assert_eq!(summary.files_seen, 1);
}

#[tokio::test]
async fn missing_reports_content_present_in_one_site_and_absent_in_another() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("source");
  let target = fixture.mkdir("target");
  fs::write(source.join("shared.txt"), "shared").unwrap();
  fs::write(source.join("missing.txt"), "missing").unwrap();
  fs::write(target.join("shared-copy.txt"), "shared").unwrap();

  fixture.create_site("source").await;
  fixture.create_site("target").await;
  fixture.add_site_folder("source", &source, HiddenPolicy::Include).await;
  fixture.add_site_folder("target", &target, HiddenPolicy::Include).await;

  fixture.repo.scan_all().await.unwrap();

  let missing = fixture.repo.find_missing("source", "target").await.unwrap();
  assert_eq!(missing.len(), 1);
  assert_eq!(missing[0].source_files.len(), 1);
  assert!(missing[0].source_files[0].path.ends_with("missing.txt"));
}

#[tokio::test]
async fn scan_deduplicates_overlapping_site_folders() {
  let fixture = Fixture::new().await;
  let root = fixture.mkdir("root");
  let nested = root.join("nested");
  fs::create_dir(&nested).unwrap();
  fs::write(nested.join("file.txt"), "same").unwrap();

  fixture.create_site("archive").await;
  fixture.add_site_folder("archive", &root, HiddenPolicy::Include).await;
  fixture.add_site_folder("archive", &nested, HiddenPolicy::Include).await;

  let summary = fixture.repo.scan_site("archive").await.unwrap();
  assert_eq!(summary.files_seen, 1);
}

#[tokio::test]
async fn repository_uses_the_configured_hash_algorithm() {
  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  fs::write(root.path().join("a.txt"), "alpha").unwrap();
  fs::write(root.path().join("b.txt"), "algae").unwrap();

  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(FirstByteHashAlgorithm)),
  })
  .await
  .unwrap();

  repo.create_site("docs").await.unwrap();
  repo
    .add_site_folder(
      "docs",
      AddSiteFolderRequest {
        path: root.path().to_path_buf(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  repo.scan_site("docs").await.unwrap();
  let duplicates = repo.find_duplicates(Some("docs")).await.unwrap();
  assert_eq!(repo.hash_algorithm_name(), "first_byte");
  assert_eq!(duplicates.len(), 1);
  assert_eq!(duplicates[0].hash_algorithm, "first_byte");
}

#[tokio::test]
async fn changing_hash_algorithm_invalidates_cached_hashes() {
  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  fs::write(root.path().join("a.txt"), "alpha").unwrap();
  fs::write(root.path().join("b.txt"), "algae").unwrap();

  let blake_repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: None,
  })
  .await
  .unwrap();
  blake_repo.create_site("docs").await.unwrap();
  blake_repo
    .add_site_folder(
      "docs",
      AddSiteFolderRequest {
        path: root.path().to_path_buf(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  blake_repo.scan_site("docs").await.unwrap();
  assert!(blake_repo.find_duplicates(Some("docs")).await.unwrap().is_empty());

  let first_byte_repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(FirstByteHashAlgorithm)),
  })
  .await
  .unwrap();
  let summary = first_byte_repo.scan_site("docs").await.unwrap();
  let duplicates = first_byte_repo.find_duplicates(Some("docs")).await.unwrap();

  assert_eq!(summary.files_hashed, 2);
  assert_eq!(summary.files_reused, 0);
  assert_eq!(duplicates.len(), 1);
}

#[tokio::test]
async fn scan_site_reports_current_file_progress() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("a.txt"), "alpha").unwrap();
  fs::write(docs.join("b.txt"), "beta").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Include).await;

  let seen = Arc::new(Mutex::new(Vec::new()));
  let seen_clone = seen.clone();
  fixture
    .repo
    .scan_site_with_progress(
      "docs",
      Some(Arc::new(move |progress| {
        seen_clone.lock().unwrap().push((
          progress.current_path.clone(),
          progress.files_scanned,
          progress.total_files,
        ));
      })),
    )
    .await
    .unwrap();

  let seen = seen.lock().unwrap();
  assert_eq!(seen.len(), 2);
  assert_eq!(seen[0].1, 1);
  assert_eq!(seen[0].2, 2);
  assert!(seen.iter().any(|(path, _, _)| path.ends_with("a.txt")));
  assert!(seen.iter().any(|(path, _, _)| path.ends_with("b.txt")));
}

#[tokio::test]
async fn scan_site_hashes_files_in_parallel() {
  if std::thread::available_parallelism()
    .map(|parallelism| parallelism.get())
    .unwrap_or(1)
    < 2
  {
    return;
  }

  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  for index in 0..8 {
    fs::write(
      root.path().join(format!("file-{index}.txt")),
      format!("content-{index}"),
    )
    .unwrap();
  }

  let current = Arc::new(AtomicUsize::new(0));
  let max = Arc::new(AtomicUsize::new(0));
  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(SlowHashAlgorithm {
      current: current.clone(),
      max: max.clone(),
    })),
  })
  .await
  .unwrap();
  repo.create_site("docs").await.unwrap();
  repo
    .add_site_folder(
      "docs",
      AddSiteFolderRequest {
        path: root.path().to_path_buf(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  repo.scan_site("docs").await.unwrap();

  assert!(max.load(Ordering::SeqCst) > 1);
}

#[tokio::test]
async fn stage_add_file_stages_only_one_copy_of_a_pair() {
  let fixture = Fixture::new().await;
  let first = fixture.mkdir("first");
  let second = fixture.mkdir("second");
  let first_file = first.join("a.txt");
  let second_file = second.join("b.txt");
  fs::write(&first_file, "same").unwrap();
  fs::write(&second_file, "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &first, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &second, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  let report = fixture.repo.stage_add_path(&first_file).await.unwrap();
  assert_eq!(report.staged_files.len(), 1);
  assert!(report.warnings.is_empty());

  let second_report = fixture.repo.stage_add_path(&second_file).await.unwrap();
  assert!(second_report.staged_files.is_empty());
  assert_eq!(second_report.warnings.len(), 1);
}

#[tokio::test]
async fn stage_add_folder_recursively_stages_duplicate_files_and_warns_on_last_copy() {
  let fixture = Fixture::new().await;
  let root = fixture.mkdir("root");
  let other = fixture.mkdir("other");
  let dup_dir = root.join("dup");
  let pair_dir = root.join("pair");
  fs::create_dir(&dup_dir).unwrap();
  fs::create_dir(&pair_dir).unwrap();
  fs::write(dup_dir.join("one.txt"), "same-a").unwrap();
  fs::write(dup_dir.join("two.txt"), "same-a").unwrap();
  fs::write(pair_dir.join("left.txt"), "same-b").unwrap();
  fs::write(other.join("right.txt"), "same-b").unwrap();
  fs::write(root.join("unique.txt"), "unique").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &root, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &other, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  let report = fixture.repo.stage_add_path(&root).await.unwrap();
  assert_eq!(report.staged_files.len(), 2);
  assert!(report.staged_files.iter().any(|file| file.path.ends_with("left.txt")));
  assert_eq!(report.warnings.len(), 1);
  assert!(report.warnings[0].path.ends_with("two.txt") || report.warnings[0].path.ends_with("one.txt"));
}

#[tokio::test]
async fn stage_commit_dry_run_reports_remaining_duplicates() {
  let fixture = Fixture::new().await;
  let first = fixture.mkdir("first");
  let second = fixture.mkdir("second");
  let third = fixture.mkdir("third");
  fs::write(first.join("a.txt"), "same").unwrap();
  fs::write(second.join("b.txt"), "same").unwrap();
  fs::write(third.join("c.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &first, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &second, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &third, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  fixture.repo.stage_add_path(&first.join("a.txt")).await.unwrap();
  let report = fixture.repo.stage_commit_dry_run().await.unwrap();

  assert_eq!(report.staged_files.len(), 1);
  assert!(report.db_entry_count_stable);
  assert_eq!(report.duplicate_group_count_before, 1);
  assert_eq!(report.duplicate_group_count_after, 1);
  assert_eq!(report.duplicate_file_count_before, 3);
  assert_eq!(report.duplicate_file_count_after, 2);
}

#[tokio::test]
async fn stage_remove_path_unstages_a_file() {
  let fixture = Fixture::new().await;
  let first = fixture.mkdir("first");
  let second = fixture.mkdir("second");
  let first_file = first.join("a.txt");
  fs::write(&first_file, "same").unwrap();
  fs::write(second.join("b.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &first, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &second, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  fixture.repo.stage_add_path(&first_file).await.unwrap();
  let report = fixture.repo.stage_remove_path(&first_file).await.unwrap();
  assert_eq!(report.removed_files.len(), 1);

  let commit = fixture.repo.stage_commit_dry_run().await.unwrap();
  assert!(commit.staged_files.is_empty());
}

#[tokio::test]
async fn stage_reset_clears_all_staged_files() {
  let fixture = Fixture::new().await;
  let first = fixture.mkdir("first");
  let second = fixture.mkdir("second");
  let third = fixture.mkdir("third");
  fs::write(first.join("a.txt"), "same").unwrap();
  fs::write(second.join("b.txt"), "same").unwrap();
  fs::write(third.join("c.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &first, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &second, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &third, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  fixture.repo.stage_add_path(&first.join("a.txt")).await.unwrap();
  fixture.repo.stage_add_path(&second.join("b.txt")).await.unwrap();
  let report = fixture.repo.stage_reset().await.unwrap();

  assert_eq!(report.removed_files.len(), 2);
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
async fn stage_undo_and_redo_restore_stage_state() {
  let fixture = Fixture::new().await;
  let first = fixture.mkdir("first");
  let second = fixture.mkdir("second");
  let first_file = first.join("a.txt");
  fs::write(&first_file, "same").unwrap();
  fs::write(second.join("b.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &first, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &second, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  fixture.repo.stage_add_path(&first_file).await.unwrap();
  fixture.repo.stage_remove_path(&first_file).await.unwrap();

  let undo = fixture.repo.stage_undo().await.unwrap();
  assert_eq!(undo.restored_files.len(), 1);
  assert!(undo.restored_files[0].path.ends_with("a.txt"));

  let redo = fixture.repo.stage_redo().await.unwrap();
  assert!(redo.restored_files.is_empty());
}

struct Fixture {
  root: TempDir,
  _cache: TempDir,
  repo: Repository,
}

impl Fixture {
  async fn new() -> Self {
    let root = tempfile::tempdir().unwrap();
    let cache = tempfile::tempdir().unwrap();
    let repo = Repository::open(RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    })
    .await
    .unwrap();
    Self {
      root,
      _cache: cache,
      repo,
    }
  }

  fn mkdir(&self, name: &str) -> PathBuf {
    let path = self.root.path().join(name);
    fs::create_dir(&path).unwrap();
    path
  }

  async fn create_site(&self, name: &str) {
    self.repo.create_site(name).await.unwrap();
  }

  async fn add_site_folder(&self, site: &str, path: &Path, hidden_policy: HiddenPolicy) {
    self
      .repo
      .add_site_folder(
        site,
        AddSiteFolderRequest {
          path: path.to_path_buf(),
          hidden_policy,
        },
      )
      .await
      .unwrap();
  }
}

struct FirstByteHashAlgorithm;

impl HashAlgorithm for FirstByteHashAlgorithm {
  fn name(&self) -> &'static str {
    "first_byte"
  }

  fn hash_file(&self, path: &Path) -> nafm_core::Result<String> {
    let bytes = fs::read(path)?;
    Ok(bytes.first().copied().unwrap_or_default().to_string())
  }
}

struct SlowHashAlgorithm {
  current: Arc<AtomicUsize>,
  max: Arc<AtomicUsize>,
}

impl HashAlgorithm for SlowHashAlgorithm {
  fn name(&self) -> &'static str {
    "slow_hash"
  }

  fn hash_file(&self, path: &Path) -> nafm_core::Result<String> {
    let in_flight = self.current.fetch_add(1, Ordering::SeqCst) + 1;
    let mut observed_max = self.max.load(Ordering::SeqCst);
    while in_flight > observed_max {
      match self
        .max
        .compare_exchange(observed_max, in_flight, Ordering::SeqCst, Ordering::SeqCst)
      {
        Ok(_) => break,
        Err(next) => observed_max = next,
      }
    }

    std::thread::sleep(Duration::from_millis(25));
    let bytes = fs::read(path)?;
    self.current.fetch_sub(1, Ordering::SeqCst);
    Ok(bytes.len().to_string())
  }
}
