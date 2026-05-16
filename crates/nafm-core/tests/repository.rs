use std::fs;
use std::path::Path;

use nafm_core::{AddFolderRequest, HiddenPolicy, Repository, RepositoryOptions};
use tempfile::TempDir;

#[tokio::test]
async fn scan_finds_exact_duplicates_and_reuses_hashes() {
  let fixture = Fixture::new().await;
  fs::write(fixture.root.path().join("a.txt"), "same").unwrap();
  fs::write(fixture.root.path().join("b.txt"), "same").unwrap();
  fs::write(fixture.root.path().join("c.txt"), "other").unwrap();

  let folder = fixture.add_folder("docs", HiddenPolicy::Include).await;

  let first = fixture.repo.scan_folder(&folder.id).await.unwrap();
  assert_eq!(first.files_seen, 3);
  assert_eq!(first.files_hashed, 2);
  assert_eq!(first.duplicate_groups, 1);
  assert_eq!(first.duplicate_files, 2);

  let second = fixture.repo.scan_folder("docs").await.unwrap();
  assert_eq!(second.files_seen, 3);
  assert_eq!(second.files_hashed, 0);
  assert_eq!(second.files_reused, 2);

  let duplicates = fixture.repo.find_duplicates(Some("docs")).await.unwrap();
  assert_eq!(duplicates.len(), 1);
  assert_eq!(duplicates[0].files.len(), 2);
}

#[tokio::test]
async fn scan_respects_skip_hidden_policy() {
  let fixture = Fixture::new().await;
  fs::write(fixture.root.path().join("visible.txt"), "same").unwrap();
  fs::write(fixture.root.path().join(".hidden.txt"), "same").unwrap();

  fixture.add_folder("docs", HiddenPolicy::Skip).await;

  let summary = fixture.repo.scan_folder("docs").await.unwrap();
  assert_eq!(summary.files_seen, 1);
  assert_eq!(summary.duplicate_groups, 0);
}

#[tokio::test]
async fn trash_duplicate_group_dry_run_keeps_files_on_disk() {
  let fixture = Fixture::new().await;
  let kept_path = fixture.root.path().join("keep.txt");
  let trashed_path = fixture.root.path().join("trash.txt");
  fs::write(&kept_path, "same").unwrap();
  fs::write(&trashed_path, "same").unwrap();

  fixture.add_folder("docs", HiddenPolicy::Include).await;
  fixture.repo.scan_folder("docs").await.unwrap();

  let duplicates = fixture.repo.find_duplicates(Some("docs")).await.unwrap();
  let group = &duplicates[0];
  let kept_path = fs::canonicalize(kept_path).unwrap();
  let trashed_path = fs::canonicalize(trashed_path).unwrap();
  let keep = group.files.iter().find(|file| file.path == kept_path).unwrap();

  let plan = fixture
    .repo
    .trash_duplicate_group(&group.group_id, &keep.file_id, true)
    .await
    .unwrap();

  assert!(plan.dry_run);
  assert_eq!(plan.trashed_files.len(), 1);
  assert!(Path::new(&kept_path).exists());
  assert!(Path::new(&trashed_path).exists());
}

#[tokio::test]
async fn scan_hashes_cross_folder_size_collisions_for_global_duplicates() {
  let first_root = tempfile::tempdir().unwrap();
  let second_root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  fs::write(first_root.path().join("one.txt"), "same").unwrap();
  fs::write(second_root.path().join("two.txt"), "same").unwrap();
  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
  })
  .await
  .unwrap();

  repo
    .add_folder(AddFolderRequest {
      path: first_root.path().to_path_buf(),
      alias: Some("first".to_owned()),
      hidden_policy: HiddenPolicy::Include,
    })
    .await
    .unwrap();
  repo
    .add_folder(AddFolderRequest {
      path: second_root.path().to_path_buf(),
      alias: Some("second".to_owned()),
      hidden_policy: HiddenPolicy::Include,
    })
    .await
    .unwrap();

  repo.scan_folder("first").await.unwrap();
  repo.scan_folder("second").await.unwrap();

  let duplicates = repo.find_duplicates(None).await.unwrap();
  assert_eq!(duplicates.len(), 1);
  assert_eq!(duplicates[0].files.len(), 2);
}

#[tokio::test]
async fn scan_invalidates_stale_hash_when_same_size_file_changes() {
  let fixture = Fixture::new().await;
  let first_path = fixture.root.path().join("a.txt");
  let second_path = fixture.root.path().join("b.txt");
  fs::write(&first_path, "same").unwrap();
  fs::write(&second_path, "same").unwrap();

  fixture.add_folder("docs", HiddenPolicy::Include).await;
  fixture.repo.scan_folder("docs").await.unwrap();
  assert_eq!(fixture.repo.find_duplicates(Some("docs")).await.unwrap().len(), 1);

  std::thread::sleep(std::time::Duration::from_millis(5));
  fs::write(&second_path, "diff").unwrap();

  fixture.repo.scan_folder("docs").await.unwrap();
  assert!(fixture.repo.find_duplicates(Some("docs")).await.unwrap().is_empty());
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
    })
    .await
    .unwrap();
    Self {
      root,
      _cache: cache,
      repo,
    }
  }

  async fn add_folder(&self, alias: &str, hidden_policy: HiddenPolicy) -> nafm_core::Folder {
    self
      .repo
      .add_folder(AddFolderRequest {
        path: self.root.path().to_path_buf(),
        alias: Some(alias.to_owned()),
        hidden_policy,
      })
      .await
      .unwrap()
  }
}
