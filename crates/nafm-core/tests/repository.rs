use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
