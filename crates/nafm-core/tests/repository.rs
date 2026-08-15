use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nafm_core::{
  AddSiteFolderRequest, Blake3HashAlgorithm, ContentHasher, CredentialStore, FileContentMatchStatus, HashAlgorithm,
  HiddenPolicy, NafmError, Repository, RepositoryOptions, ScanEvent, SiteFolderKind, StageWarningReason,
  StorageNodeKind,
};
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
async fn file_content_matches_orders_same_site_first_and_pages_six_at_a_time() {
  let fixture = Fixture::new().await;
  let source_root = fs::canonicalize(fixture.mkdir("matches-source")).unwrap();
  let first_target_root = fs::canonicalize(fixture.mkdir("matches-first-target")).unwrap();
  let second_target_root = fs::canonicalize(fixture.mkdir("matches-second-target")).unwrap();
  let selected_path = source_root.join("selected.bin");
  fs::write(&selected_path, b"shared-content").unwrap();
  for index in 0..7 {
    fs::write(source_root.join(format!("copy-{index}.bin")), b"shared-content").unwrap();
  }
  fs::write(first_target_root.join("target.bin"), b"shared-content").unwrap();
  fs::write(second_target_root.join("target.bin"), b"shared-content").unwrap();

  let source_site = fixture.repo.create_site("z-source").await.unwrap();
  fixture
    .add_site_folder(&source_site.id, &source_root, HiddenPolicy::Include)
    .await;
  fixture.create_site("a-target").await;
  fixture
    .add_site_folder("a-target", &first_target_root, HiddenPolicy::Include)
    .await;
  fixture.create_site("b-target").await;
  fixture
    .add_site_folder("b-target", &second_target_root, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();

  let first_page = fixture
    .repo
    .file_content_matches(&source_site.id, &selected_path, 0, 6)
    .await
    .unwrap();
  assert_eq!(first_page.status, FileContentMatchStatus::Ready);
  assert_eq!(first_page.total_matches, 10);
  assert_eq!(first_page.offset, 0);
  assert_eq!(first_page.limit, 6);
  assert_eq!(first_page.matches.len(), 6);
  assert_eq!(first_page.matches[0].path, selected_path);
  assert!(first_page.matches[0].is_current);
  assert!(first_page.matches[1..].iter().all(|item| {
    item.site_id == source_site.id
      && item.site_name == "z-source"
      && item.site_folder_kind == SiteFolderKind::Local
      && item.path != selected_path
      && item.size_bytes == 14
      && !item.is_current
  }));

  let second_page = fixture
    .repo
    .file_content_matches(&source_site.id, &selected_path, 6, 6)
    .await
    .unwrap();
  assert_eq!(second_page.status, FileContentMatchStatus::Ready);
  assert_eq!(second_page.total_matches, 10);
  assert_eq!(second_page.offset, 6);
  assert_eq!(second_page.limit, 6);
  assert_eq!(second_page.matches.len(), 4);
  assert_eq!(
    second_page
      .matches
      .iter()
      .map(|item| item.site_name.as_str())
      .collect::<Vec<_>>(),
    vec!["z-source", "z-source", "a-target", "b-target"]
  );
  assert_eq!(
    second_page.matches[0].path,
    source_root.join("copy-5.bin"),
    "same-site matches should be path ordered before alphabetically earlier sites"
  );
  assert!(second_page.matches.iter().all(|item| !item.is_current));
}

#[tokio::test]
async fn file_content_matches_preserves_smb_metadata_and_requires_exact_content_identity() {
  let cache = tempfile::tempdir().unwrap();
  let local_root = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://nas.example.test/share", "sample-user", "secret")
    .unwrap();
  let repo = Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    },
    credential_store,
  )
  .await
  .unwrap();
  let local_site = repo.create_site("local").await.unwrap();
  let local_folder = repo
    .add_site_folder(
      &local_site.id,
      AddSiteFolderRequest {
        path: local_root.path().to_path_buf(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  let local_path = local_root.path().join("local-copy.bin");
  fs::write(&local_path, b"shared-content").unwrap();
  let local_path = fs::canonicalize(local_path).unwrap();
  repo.scan_site(&local_site.id).await.unwrap();
  let (local_file_id, hash_algorithm, content_hash, size_bytes) = tracked_file_identity(&repo, &local_path);

  let network_site = repo.create_site("network").await.unwrap();
  let network_folder = repo
    .add_site_folder(
      &network_site.id,
      AddSiteFolderRequest {
        path: PathBuf::from("smb://nas.example.test/share/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  let selected_path = PathBuf::from("smb://nas.example.test/share/Media/selected.bin");
  let smb_copy_path = PathBuf::from("smb://nas.example.test/share/Media/copy.bin");
  insert_tracked_file(
    &repo,
    "smb-selected",
    &network_site.id,
    &network_folder.id,
    &selected_path,
    size_bytes,
    &hash_algorithm,
    Some(&content_hash),
  );
  insert_tracked_file(
    &repo,
    "smb-copy",
    &network_site.id,
    &network_folder.id,
    &smb_copy_path,
    size_bytes,
    &hash_algorithm,
    Some(&content_hash),
  );
  insert_tracked_file(
    &repo,
    "wrong-size",
    &network_site.id,
    &network_folder.id,
    Path::new("smb://nas.example.test/share/Media/wrong-size.bin"),
    size_bytes + 1,
    &hash_algorithm,
    Some(&content_hash),
  );
  insert_tracked_file(
    &repo,
    "wrong-algorithm",
    &network_site.id,
    &network_folder.id,
    Path::new("smb://nas.example.test/share/Media/wrong-algorithm.bin"),
    size_bytes,
    "other-algorithm",
    Some(&content_hash),
  );

  let page = repo
    .file_content_matches(&network_site.id, &selected_path, 0, 6)
    .await
    .unwrap();
  assert_eq!(page.status, FileContentMatchStatus::Ready);
  assert_eq!(page.total_matches, 3);
  assert_eq!(
    page
      .matches
      .iter()
      .map(|item| item.file_id.as_str())
      .collect::<Vec<_>>(),
    vec!["smb-selected", "smb-copy", local_file_id.as_str()]
  );
  assert_eq!(page.matches[0].site_name, "network");
  assert_eq!(page.matches[0].site_folder_id, network_folder.id);
  assert_eq!(page.matches[0].site_folder_kind, SiteFolderKind::Smb);
  assert_eq!(page.matches[0].path, selected_path);
  assert!(page.matches[0].is_current);
  assert_eq!(page.matches[1].path, smb_copy_path);
  assert_eq!(page.matches[2].site_name, "local");
  assert_eq!(page.matches[2].site_folder_id, local_folder.id);
  assert_eq!(page.matches[2].site_folder_kind, SiteFolderKind::Local);
  assert_eq!(page.matches[2].path, local_path);
  assert!(page.matches[1..].iter().all(|item| !item.is_current));
}

#[tokio::test]
async fn file_content_matches_reports_not_hashed_and_rejects_untracked_site_paths() {
  let fixture = Fixture::new().await;
  let root = fs::canonicalize(fixture.mkdir("not-hashed")).unwrap();
  let selected_path = root.join("selected.bin");
  fs::write(&selected_path, b"content").unwrap();
  let site = fixture.repo.create_site("source").await.unwrap();
  fixture.add_site_folder(&site.id, &root, HiddenPolicy::Include).await;
  fixture.repo.scan_site(&site.id).await.unwrap();
  rusqlite::Connection::open(fixture.repo.db_path())
    .unwrap()
    .execute(
      "update file_records set content_hash = null where site_id = ?1 and path = ?2",
      rusqlite::params![site.id, selected_path.to_string_lossy()],
    )
    .unwrap();

  let first_page = fixture
    .repo
    .file_content_matches(&site.id, &selected_path, 0, 6)
    .await
    .unwrap();
  assert_eq!(first_page.status, FileContentMatchStatus::NotHashed);
  assert_eq!(first_page.matches.len(), 1);
  assert_eq!(first_page.matches[0].path, selected_path);
  assert!(first_page.matches[0].is_current);
  assert_eq!(first_page.total_matches, 1);

  let later_page = fixture
    .repo
    .file_content_matches(&site.id, &selected_path, 12, 0)
    .await
    .unwrap();
  assert_eq!(later_page.status, FileContentMatchStatus::NotHashed);
  assert!(later_page.matches.is_empty());
  assert_eq!(later_page.total_matches, 1);
  assert_eq!(later_page.offset, 12);
  assert_eq!(later_page.limit, 1);

  let missing_path = root.join("missing.bin");
  let missing_error = fixture
    .repo
    .file_content_matches(&site.id, &missing_path, 0, 6)
    .await
    .unwrap_err();
  assert!(matches!(
    missing_error,
    NafmError::TrackedPathNotFound(path) if path == missing_path
  ));

  let other_site = fixture.repo.create_site("other").await.unwrap();
  let wrong_site_error = fixture
    .repo
    .file_content_matches(&other_site.id, &selected_path, 0, 6)
    .await
    .unwrap_err();
  assert!(matches!(
    wrong_site_error,
    NafmError::TrackedPathNotFound(path) if path == selected_path
  ));

  let missing_site_error = fixture
    .repo
    .file_content_matches("missing-site", &selected_path, 0, 6)
    .await
    .unwrap_err();
  assert!(matches!(
    missing_site_error,
    NafmError::SiteNotFound(selector) if selector == "missing-site"
  ));
}

#[tokio::test]
async fn storage_file_reveal_returns_exact_local_parent_page_and_coverage() {
  let fixture = Fixture::new().await;
  let source_root = fs::canonicalize(fixture.mkdir("reveal-source")).unwrap();
  let target_root = fs::canonicalize(fixture.mkdir("reveal-target")).unwrap();
  let camera = source_root.join("year/day/camera");
  fs::create_dir_all(&camera).unwrap();
  for (name, size) in [
    ("largest.bin", 10),
    ("large.bin", 9),
    ("medium.bin", 8),
    ("selected.bin", 7),
    ("small.bin", 6),
    ("tiny.bin", 5),
    ("last.bin", 4),
  ] {
    fs::write(camera.join(name), vec![size as u8; size]).unwrap();
  }
  let target_path = target_root.join("selected-copy.bin");
  fs::write(&target_path, vec![7_u8; 7]).unwrap();
  let source = fixture.repo.create_site("reveal-source").await.unwrap();
  fixture
    .add_site_folder(&source.id, &source_root, HiddenPolicy::Include)
    .await;
  let target = fixture.repo.create_site("reveal-target").await.unwrap();
  fixture
    .add_site_folder(&target.id, &target_root, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();
  let selected_path = camera.join("selected.bin");
  let (selected_file_id, _, _, _) = tracked_file_identity(&fixture.repo, &selected_path);

  let reveal = fixture
    .repo
    .storage_file_reveal(&selected_file_id, Some(&target.id), 2, 2, 3)
    .await
    .unwrap();

  assert_eq!(reveal.tree.site.id, source.id);
  assert_eq!(reveal.tree.coverage_target.as_ref().unwrap().id, target.id);
  assert_eq!(reveal.tree.max_depth, 2);
  assert_eq!(reveal.tree.max_children, 2);
  assert_eq!(reveal.location.site.id, source.id);
  assert_eq!(reveal.location.coverage_target.as_ref().unwrap().id, target.id);
  assert_eq!(
    reveal
      .location
      .breadcrumbs
      .iter()
      .map(|node| node.name.as_str())
      .collect::<Vec<_>>(),
    vec!["reveal-source", "reveal-source", "year", "day", "camera"]
  );
  assert_eq!(reveal.location.root.name, "camera");
  assert_eq!(reveal.page.parent.id, reveal.location.root.id);
  assert_eq!(reveal.page.site.id, source.id);
  assert_eq!(reveal.page.coverage_target.as_ref().unwrap().id, target.id);
  assert_eq!(reveal.page.total_children, 7);
  assert_eq!(reveal.page.offset, 3);
  assert_eq!(reveal.page.limit, 3);
  assert_eq!(
    reveal
      .page
      .children
      .iter()
      .map(|node| node.name.as_str())
      .collect::<Vec<_>>(),
    vec!["selected.bin", "small.bin", "tiny.bin"]
  );
  assert_eq!(reveal.selected_file.name, "selected.bin");
  assert_eq!(reveal.selected_file.path, Some(selected_path));
  assert_eq!(reveal.selected_file.kind, StorageNodeKind::File);
  assert!(reveal.selected_file.children.is_empty());
  assert_eq!(
    reveal.page.children[0].id, reveal.selected_file.id,
    "the containing page should include the exact selected node"
  );

  let (target_file_id, _, _, _) = tracked_file_identity(&fixture.repo, &target_path);
  let cross_site_reveal = fixture
    .repo
    .storage_file_reveal(&target_file_id, Some(&source.id), 5, 12, 6)
    .await
    .unwrap();
  assert_eq!(cross_site_reveal.tree.site.id, target.id);
  assert_eq!(cross_site_reveal.tree.coverage_target.as_ref().unwrap().id, source.id);
  assert_eq!(cross_site_reveal.location.site.id, target.id);
  assert_eq!(cross_site_reveal.page.site.id, target.id);
  assert_eq!(cross_site_reveal.selected_file.path, Some(target_path));
  assert_eq!(
    cross_site_reveal.page.children[0].id,
    cross_site_reveal.selected_file.id
  );
}

#[tokio::test]
async fn storage_file_reveal_preserves_smb_paths_and_cross_site_identity() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://nas.example.test/share", "sample-user", "secret")
    .unwrap();
  let repo = Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    },
    credential_store,
  )
  .await
  .unwrap();
  let network = repo.create_site("network").await.unwrap();
  let network_folder = repo
    .add_site_folder(
      &network.id,
      AddSiteFolderRequest {
        path: PathBuf::from("smb://nas.example.test/share/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  let target = repo.create_site("target").await.unwrap();
  let selected_path = Path::new("smb://nas.example.test/share/Media/Camera/selected.mp4");
  insert_tracked_file(
    &repo,
    "smb-reveal",
    &network.id,
    &network_folder.id,
    selected_path,
    8,
    "blake3",
    Some("selected-hash"),
  );
  insert_tracked_file(
    &repo,
    "smb-sibling",
    &network.id,
    &network_folder.id,
    Path::new("smb://nas.example.test/share/Media/Camera/sibling.mp4"),
    4,
    "blake3",
    Some("sibling-hash"),
  );

  let reveal = repo
    .storage_file_reveal("smb-reveal", Some(&target.id), 5, 12, 6)
    .await
    .unwrap();

  assert_eq!(reveal.tree.site.id, network.id);
  assert_eq!(reveal.tree.coverage_target.as_ref().unwrap().id, target.id);
  assert_eq!(reveal.location.root.name, "Camera");
  assert_eq!(
    reveal.location.root.path,
    Some(PathBuf::from("smb://nas.example.test/share/Media/Camera"))
  );
  assert_eq!(reveal.page.offset, 0);
  assert_eq!(reveal.page.limit, 6);
  assert_eq!(reveal.page.total_children, 2);
  assert_eq!(reveal.selected_file.path, Some(selected_path.to_path_buf()));
  assert_eq!(reveal.selected_file.kind, StorageNodeKind::File);
  assert!(
    reveal
      .page
      .children
      .iter()
      .any(|node| node.id == reveal.selected_file.id)
  );
}

#[tokio::test]
async fn storage_file_reveal_rejects_vanished_files_and_invalid_targets() {
  let fixture = Fixture::new().await;
  let root = fs::canonicalize(fixture.mkdir("reveal-errors")).unwrap();
  let selected_path = root.join("selected.bin");
  fs::write(&selected_path, b"selected").unwrap();
  let source = fixture.repo.create_site("reveal-errors").await.unwrap();
  fixture.add_site_folder(&source.id, &root, HiddenPolicy::Include).await;
  fixture.repo.scan_site(&source.id).await.unwrap();
  let (file_id, _, _, _) = tracked_file_identity(&fixture.repo, &selected_path);

  let target_error = fixture
    .repo
    .storage_file_reveal(&file_id, Some("missing-target"), 5, 12, 6)
    .await
    .unwrap_err();
  assert!(matches!(
    target_error,
    NafmError::SiteNotFound(selector) if selector == "missing-target"
  ));

  rusqlite::Connection::open(fixture.repo.db_path())
    .unwrap()
    .execute("delete from file_records where id = ?1", rusqlite::params![file_id])
    .unwrap();
  let vanished_error = fixture
    .repo
    .storage_file_reveal(&file_id, None, 5, 12, 6)
    .await
    .unwrap_err();
  assert!(matches!(
    vanished_error,
    NafmError::TrackedFileNotFound(id) if id == file_id
  ));
}

#[tokio::test]
async fn site_overview_reports_site_scoped_storage_and_reclaimable_bytes() {
  let fixture = Fixture::new().await;
  let archive = fixture.mkdir("archive");
  let backup = fixture.mkdir("backup");
  fs::write(archive.join("a-copy.bin"), b"ten-bytes!").unwrap();
  fs::write(archive.join("b-copy.bin"), b"ten-bytes!").unwrap();
  fs::write(archive.join("unique.bin"), b"solo").unwrap();
  fs::write(backup.join("only-copy.bin"), b"ten-bytes!").unwrap();

  fixture.create_site("archive").await;
  fixture
    .add_site_folder("archive", &archive, HiddenPolicy::Include)
    .await;
  fixture.create_site("backup").await;
  fixture.add_site_folder("backup", &backup, HiddenPolicy::Include).await;
  fixture.repo.scan_all().await.unwrap();

  let overview = fixture.repo.site_overview("archive").await.unwrap();
  assert_eq!(overview.site.name, "archive");
  assert_eq!(overview.folders.len(), 1);
  assert_eq!(overview.total_file_count, 3);
  assert_eq!(overview.total_bytes, 24);
  assert_eq!(overview.duplicate_file_count, 2);
  assert_eq!(overview.duplicate_bytes, 10);
  assert!(overview.latest_scan_at.is_some());

  let overviews = fixture.repo.site_overviews().await.unwrap();
  assert_eq!(
    overviews
      .iter()
      .map(|overview| overview.site.name.as_str())
      .collect::<Vec<_>>(),
    vec!["archive", "backup"]
  );
  let backup = overviews
    .iter()
    .find(|overview| overview.site.name == "backup")
    .unwrap();
  assert_eq!(backup.total_file_count, 1);
  assert_eq!(backup.duplicate_file_count, 0);
  assert_eq!(backup.duplicate_bytes, 0);
}

#[tokio::test]
async fn site_overview_has_no_scan_timestamp_before_files_are_tracked() {
  let fixture = Fixture::new().await;
  fixture.create_site("empty").await;

  let overview = fixture.repo.site_overview("empty").await.unwrap();
  assert_eq!(overview.total_file_count, 0);
  assert_eq!(overview.total_bytes, 0);
  assert_eq!(overview.duplicate_file_count, 0);
  assert_eq!(overview.duplicate_bytes, 0);
  assert_eq!(overview.latest_scan_at, None);
}

#[tokio::test]
async fn rename_site_preserves_identity_and_rejects_name_conflicts() {
  let fixture = Fixture::new().await;
  let original = fixture.repo.create_site("camera").await.unwrap();
  fixture.repo.create_site("archive").await.unwrap();
  assert!(matches!(
    fixture.repo.create_site("archive").await.unwrap_err(),
    NafmError::SiteAlreadyExists(name) if name == "archive"
  ));

  let renamed = fixture.repo.rename_site(&original.id, "media").await.unwrap();

  assert_eq!(renamed.id, original.id);
  assert_eq!(renamed.added_at, original.added_at);
  assert_eq!(renamed.name, "media");
  assert!(matches!(
    fixture.repo.rename_site(&renamed.id, "archive").await.unwrap_err(),
    NafmError::SiteAlreadyExists(name) if name == "archive"
  ));
  assert!(matches!(
    fixture.repo.rename_site(&renamed.id, "  ").await.unwrap_err(),
    NafmError::EmptySiteName
  ));
  assert_eq!(
    fixture.repo.site_overview(&renamed.id).await.unwrap().site.name,
    "media"
  );
}

#[tokio::test]
async fn remove_site_folder_cascades_index_data_but_keeps_source_and_allows_empty_site() {
  let fixture = Fixture::new().await;
  let first = fixture.mkdir("first-root");
  let second = fixture.mkdir("second-root");
  let first_file = first.join("one.bin");
  let second_file = second.join("two.bin");
  fs::write(&first_file, b"same-content").unwrap();
  fs::write(&second_file, b"same-content").unwrap();
  let site = fixture.repo.create_site("media").await.unwrap();
  let first_folder = fixture
    .repo
    .add_site_folder(
      &site.id,
      AddSiteFolderRequest {
        path: first.clone(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  let second_folder = fixture
    .repo
    .add_site_folder(
      &site.id,
      AddSiteFolderRequest {
        path: second.clone(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  fixture.repo.scan_site(&site.id).await.unwrap();
  fixture.repo.stage_add_path(&first_file).await.unwrap();
  insert_scan_cache_entry(&fixture.repo, &site.id, &first_folder.id, &first_file);

  let removed = fixture.repo.remove_site_folder(&first_folder.id).await.unwrap();

  assert_eq!(removed.id, first_folder.id);
  assert!(first_file.is_file());
  assert!(second_file.is_file());
  assert_eq!(database_count(&fixture.repo, "site_folders", "id", &first_folder.id), 0);
  assert_eq!(
    database_count(&fixture.repo, "file_records", "site_folder_id", &first_folder.id),
    0
  );
  assert_eq!(
    database_count(&fixture.repo, "scan_cache_entries", "site_folder_id", &first_folder.id),
    0
  );
  assert_eq!(table_count(&fixture.repo, "stage_entries"), 0);
  assert_eq!(table_count(&fixture.repo, "stage_snapshot_files"), 0);
  assert_eq!(database_count(&fixture.repo, "site_scan_state", "site_id", &site.id), 0);
  assert_eq!(fixture.repo.list_site_folders(Some(&site.id)).await.unwrap().len(), 1);

  fixture.repo.remove_site_folder(&second_folder.id).await.unwrap();
  assert!(fixture.repo.list_site_folders(Some(&site.id)).await.unwrap().is_empty());
  assert_eq!(fixture.repo.site_overview(&site.id).await.unwrap().site.id, site.id);
}

fn insert_scan_cache_entry(repo: &Repository, site_id: &str, site_folder_id: &str, path: &Path) {
  rusqlite::Connection::open(repo.db_path())
    .unwrap()
    .execute(
      "insert into scan_cache_entries (
        site_id, site_folder_id, path, size_bytes, modified_unix_nanos,
        hash_algorithm, content_hash, cached_at
      ) values (?1, ?2, ?3, 12, 0, 'blake3', 'cached-hash', '2026-01-01T00:00:00Z')",
      rusqlite::params![site_id, site_folder_id, path.to_string_lossy()],
    )
    .unwrap();
}

fn database_count(repo: &Repository, table: &str, column: &str, value: &str) -> u64 {
  let query = format!("select count(*) from {table} where {column} = ?1");
  rusqlite::Connection::open(repo.db_path())
    .unwrap()
    .query_row(&query, rusqlite::params![value], |row| row.get(0))
    .unwrap()
}

fn table_count(repo: &Repository, table: &str) -> u64 {
  let query = format!("select count(*) from {table}");
  rusqlite::Connection::open(repo.db_path())
    .unwrap()
    .query_row(&query, [], |row| row.get(0))
    .unwrap()
}

fn tracked_file_identity(repo: &Repository, path: &Path) -> (String, String, String, u64) {
  rusqlite::Connection::open(repo.db_path())
    .unwrap()
    .query_row(
      "select id, hash_algorithm, content_hash, size_bytes from file_records where path = ?1",
      rusqlite::params![path.to_string_lossy()],
      |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
    )
    .unwrap()
}

#[allow(clippy::too_many_arguments)]
fn insert_tracked_file(
  repo: &Repository,
  id: &str,
  site_id: &str,
  site_folder_id: &str,
  path: &Path,
  size_bytes: u64,
  hash_algorithm: &str,
  content_hash: Option<&str>,
) {
  rusqlite::Connection::open(repo.db_path())
    .unwrap()
    .execute(
      "insert into file_records (
        id, site_id, site_folder_id, path, size_bytes, modified_unix_nanos,
        hash_algorithm, content_hash, last_seen_at
      ) values (?1, ?2, ?3, ?4, ?5, 0, ?6, ?7, '2026-01-01T00:00:00Z')",
      rusqlite::params![
        id,
        site_id,
        site_folder_id,
        path.to_string_lossy(),
        size_bytes,
        hash_algorithm,
        content_hash,
      ],
    )
    .unwrap();
}

#[tokio::test]
async fn remove_site_cascades_all_site_owned_data_without_deleting_source_files() {
  let fixture = Fixture::new().await;
  let root = fixture.mkdir("remove-site-root");
  let first_file = root.join("one.bin");
  let second_file = root.join("two.bin");
  fs::write(&first_file, b"same-content").unwrap();
  fs::write(&second_file, b"same-content").unwrap();
  let site = fixture.repo.create_site("temporary").await.unwrap();
  let folder = fixture
    .repo
    .add_site_folder(
      &site.id,
      AddSiteFolderRequest {
        path: root.clone(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  fixture.repo.scan_site(&site.id).await.unwrap();
  fixture.repo.stage_add_path(&first_file).await.unwrap();
  insert_scan_cache_entry(&fixture.repo, &site.id, &folder.id, &first_file);

  let removed = fixture.repo.remove_site(&site.id).await.unwrap();

  assert_eq!(removed.id, site.id);
  assert!(root.is_dir());
  assert!(first_file.is_file());
  assert!(second_file.is_file());
  assert_eq!(database_count(&fixture.repo, "sites", "id", &site.id), 0);
  assert_eq!(database_count(&fixture.repo, "site_folders", "site_id", &site.id), 0);
  assert_eq!(database_count(&fixture.repo, "file_records", "site_id", &site.id), 0);
  assert_eq!(
    database_count(&fixture.repo, "scan_cache_entries", "site_id", &site.id),
    0
  );
  assert_eq!(database_count(&fixture.repo, "site_scan_state", "site_id", &site.id), 0);
  assert_eq!(table_count(&fixture.repo, "stage_entries"), 0);
  assert_eq!(table_count(&fixture.repo, "stage_snapshot_files"), 0);
  assert!(matches!(
    fixture.repo.remove_site(&site.id).await.unwrap_err(),
    NafmError::SiteNotFound(selector) if selector == site.id
  ));
}

#[tokio::test]
async fn storage_tree_is_bounded_aggregated_and_stable() {
  let fixture = Fixture::new().await;
  let media = fixture.mkdir("media");
  for (directory, contents) in [
    ("large", b"123456789".as_slice()),
    ("medium", b"123456".as_slice()),
    ("small", b"123".as_slice()),
    ("tiny", b"1".as_slice()),
  ] {
    let path = media.join(directory);
    fs::create_dir(&path).unwrap();
    fs::write(path.join("clip.bin"), contents).unwrap();
  }
  fs::write(media.join("large/copy.bin"), b"123456").unwrap();

  fixture.create_site("media").await;
  fixture.add_site_folder("media", &media, HiddenPolicy::Include).await;
  fixture.repo.scan_site("media").await.unwrap();

  let tree = fixture.repo.storage_tree("media", 3, 3).await.unwrap();
  assert_eq!(tree.max_depth, 3);
  assert_eq!(tree.max_children, 3);
  assert_eq!(tree.root.kind, StorageNodeKind::Site);
  assert_eq!(tree.root.total_bytes, 25);
  assert_eq!(tree.root.file_count, 5);
  assert_eq!(tree.root.duplicate_file_count, 2);
  assert_eq!(tree.root.duplicate_bytes, 6);
  assert_eq!(tree.root.children.len(), 1);

  let folder = &tree.root.children[0];
  assert_eq!(folder.kind, StorageNodeKind::LocalRoot);
  assert_eq!(
    folder.path.as_deref(),
    Some(fs::canonicalize(&media).unwrap().as_path())
  );
  assert_eq!(folder.children.len(), 3);
  assert_eq!(folder.children[0].name, "large");
  assert_eq!(folder.children[0].duplicate_file_count, 1);
  assert_eq!(folder.children[0].duplicate_bytes, 0);
  assert_eq!(folder.children[1].name, "medium");
  assert_eq!(folder.children[1].duplicate_file_count, 1);
  assert_eq!(folder.children[1].duplicate_bytes, 6);
  let smaller = &folder.children[2];
  assert_eq!(smaller.kind, StorageNodeKind::SmallerItems);
  assert_eq!(smaller.total_bytes, 4);
  assert_eq!(smaller.file_count, 2);
  assert!(smaller.children.is_empty());
  assert!(folder.children.iter().all(|child| child.children.len() <= 3));

  let repeated = fixture.repo.storage_tree("media", 3, 3).await.unwrap();
  assert_eq!(tree.root.id, repeated.root.id);
  assert_eq!(folder.id, repeated.root.children[0].id);
  assert_eq!(smaller.id, repeated.root.children[0].children[2].id);

  let shallow = fixture.repo.storage_tree("media", 1, 10).await.unwrap();
  assert_eq!(shallow.root.children.len(), 1);
  assert!(shallow.root.children[0].children.is_empty());

  let no_children = fixture.repo.storage_tree("media", 10, 0).await.unwrap();
  assert!(no_children.root.children.is_empty());
  assert_eq!(no_children.root.total_bytes, 25);
}

#[tokio::test]
async fn storage_location_finds_deep_folders_and_resets_subtree_bounds() {
  let fixture = Fixture::new().await;
  let media = fixture.mkdir("location-media");
  let selected_path = media.join("year/day/camera");
  fs::create_dir_all(&selected_path).unwrap();
  fs::write(selected_path.join("first.bin"), b"12345678").unwrap();
  fs::write(selected_path.join("second.bin"), b"1234").unwrap();
  fixture.create_site("location-source").await;
  fixture
    .add_site_folder("location-source", &media, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_site("location-source").await.unwrap();

  let complete = fixture.repo.storage_tree("location-source", 8, 20).await.unwrap();
  let storage_root = &complete.root.children[0];
  let year = child_named(storage_root, "year");
  let day = child_named(year, "day");
  let camera = child_named(day, "camera");
  let camera_id = camera.id.clone();

  let bounded = fixture.repo.storage_tree("location-source", 1, 20).await.unwrap();
  assert!(find_node(&bounded.root, &camera_id).is_none());

  let location = fixture
    .repo
    .storage_location("location-source", &camera_id, 1, 20)
    .await
    .unwrap();
  assert_eq!(location.site.name, "location-source");
  assert!(location.coverage_target.is_none());
  assert_eq!(location.max_depth, 1);
  assert_eq!(location.max_children, 20);
  assert_eq!(
    location
      .breadcrumbs
      .iter()
      .map(|node| node.name.as_str())
      .collect::<Vec<_>>(),
    vec!["location-source", "location-media", "year", "day", "camera"]
  );
  assert!(location.breadcrumbs.iter().all(|node| node.children.is_empty()));
  assert_storage_metrics_equal(location.breadcrumbs.last().unwrap(), &location.root);
  assert_eq!(location.root.children.len(), 2);
  assert!(
    location
      .root
      .children
      .iter()
      .all(|child| child.kind == StorageNodeKind::File && child.children.is_empty())
  );
}

#[tokio::test]
async fn storage_location_preserves_coverage_and_rejects_non_folders() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("location-coverage-source");
  let target = fixture.mkdir("location-coverage-target");
  fs::create_dir(source.join("camera")).unwrap();
  fs::write(source.join("camera/covered.bin"), b"shared").unwrap();
  fs::write(source.join("camera/missing.bin"), b"missing").unwrap();
  fs::write(target.join("shared.bin"), b"shared").unwrap();
  fixture.create_site("location-coverage-source").await;
  fixture.create_site("location-coverage-target").await;
  fixture
    .add_site_folder("location-coverage-source", &source, HiddenPolicy::Include)
    .await;
  fixture
    .add_site_folder("location-coverage-target", &target, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();

  let tree = fixture
    .repo
    .storage_tree_with_coverage("location-coverage-source", "location-coverage-target", 5, 20)
    .await
    .unwrap();
  let camera = child_named(&tree.root.children[0], "camera");
  let file = child_named(camera, "covered.bin");
  let location = fixture
    .repo
    .storage_location_with_coverage(
      "location-coverage-source",
      "location-coverage-target",
      &camera.id,
      2,
      20,
    )
    .await
    .unwrap();
  assert_eq!(location.coverage_target.unwrap().name, "location-coverage-target");
  assert_health(location.root.coverage_health, 6.0 * 100.0 / 13.0);
  assert_storage_metrics_equal(location.breadcrumbs.last().unwrap(), &location.root);

  let file_error = fixture
    .repo
    .storage_location("location-coverage-source", &file.id, 2, 20)
    .await
    .unwrap_err();
  assert!(matches!(
    file_error,
    NafmError::StorageNodeNotNavigable(node_id) if node_id == file.id
  ));

  let aggregate = fixture
    .repo
    .storage_tree("location-coverage-source", 3, 1)
    .await
    .unwrap();
  let smaller_items = aggregate.root.children[0].children[0].children[0].clone();
  assert_eq!(smaller_items.kind, StorageNodeKind::SmallerItems);
  let aggregate_error = fixture
    .repo
    .storage_location("location-coverage-source", &smaller_items.id, 2, 20)
    .await
    .unwrap_err();
  assert!(matches!(
    aggregate_error,
    NafmError::StorageNodeNotNavigable(node_id) if node_id == smaller_items.id
  ));
}

#[tokio::test]
async fn storage_tree_preserves_smb_roots_and_paths() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://nas.example.test/share", "sample-user", "secret")
    .unwrap();
  let repo = Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    },
    credential_store,
  )
  .await
  .unwrap();
  let site = repo.create_site("network").await.unwrap();
  let folder = repo
    .add_site_folder(
      "network",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://nas.example.test/share/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  let conn = rusqlite::Connection::open(repo.db_path()).unwrap();
  for (id, path) in [
    ("file-a", "smb://nas.example.test/share/Media/Camera/A.mp4"),
    ("file-b", "smb://nas.example.test/share/Media/Camera/B.mp4"),
  ] {
    conn
      .execute(
        "insert into file_records (
          id, site_id, site_folder_id, path, size_bytes, modified_unix_nanos,
          hash_algorithm, content_hash, last_seen_at
        ) values (?1, ?2, ?3, ?4, 8, 0, 'blake3', 'same-hash', '2026-01-01T00:00:00Z')",
        rusqlite::params![id, &site.id, &folder.id, path],
      )
      .unwrap();
  }
  drop(conn);

  let tree = repo.storage_tree("network", 4, 10).await.unwrap();
  let root = &tree.root.children[0];
  assert_eq!(root.kind, StorageNodeKind::SmbRoot);
  assert_eq!(root.name, "Media");
  assert_eq!(root.path, Some(PathBuf::from("smb://nas.example.test/share/Media")));
  assert_eq!(root.children[0].name, "Camera");
  assert_eq!(
    root.children[0].path,
    Some(PathBuf::from("smb://nas.example.test/share/Media/Camera"))
  );
  assert_eq!(
    root.children[0].children[0].path,
    Some(PathBuf::from("smb://nas.example.test/share/Media/Camera/A.mp4"))
  );
  assert_eq!(tree.root.duplicate_file_count, 2);
  assert_eq!(tree.root.duplicate_bytes, 8);

  let camera = &root.children[0];
  let location = repo.storage_location("network", &camera.id, 1, 10).await.unwrap();
  assert_eq!(
    location
      .breadcrumbs
      .iter()
      .map(|node| node.name.as_str())
      .collect::<Vec<_>>(),
    vec!["network", "Media", "Camera"]
  );
  assert_eq!(
    location.root.path,
    Some(PathBuf::from("smb://nas.example.test/share/Media/Camera"))
  );
  assert_eq!(location.root.children.len(), 2);
}

#[tokio::test]
async fn storage_tree_reports_weighted_space_health_for_every_level() {
  let fixture = Fixture::new().await;
  let media = fixture.mkdir("health-media");
  let duplicates = media.join("duplicates");
  let unique = media.join("unique");
  fs::create_dir(&duplicates).unwrap();
  fs::create_dir(&unique).unwrap();
  fs::write(duplicates.join("one.bin"), b"0123456789").unwrap();
  fs::write(duplicates.join("two.bin"), b"0123456789").unwrap();
  fs::write(unique.join("only.bin"), b"12345").unwrap();

  fixture.create_site("health").await;
  fixture.add_site_folder("health", &media, HiddenPolicy::Include).await;
  fixture.repo.scan_site("health").await.unwrap();

  let tree = fixture.repo.storage_tree("health", 8, 32).await.unwrap();
  assert!(tree.coverage_target.is_none());
  assert_health(tree.root.space_health, 60.0);
  assert_eq!(tree.root.coverage_health, None);
  let site_folder = &tree.root.children[0];
  assert_health(site_folder.space_health, 60.0);
  let duplicates = child_named(site_folder, "duplicates");
  assert_health(duplicates.space_health, 50.0);
  assert_health(duplicates.children[0].space_health, 50.0);
  assert_health(child_named(site_folder, "unique").space_health, 100.0);
}

#[tokio::test]
async fn storage_nodes_report_comparable_file_counts_without_changing_health_weighting() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("count-source");
  let target = fixture.mkdir("count-target");
  fs::create_dir(source.join("copies")).unwrap();
  fs::write(source.join("copies/a.bin"), b"duplicate").unwrap();
  fs::write(source.join("copies/b.bin"), b"duplicate").unwrap();
  fs::write(source.join("unique.bin"), b"unique-content").unwrap();
  fs::write(target.join("copy.bin"), b"duplicate").unwrap();

  fixture.create_site("count-source").await;
  fixture.create_site("count-target").await;
  fixture
    .add_site_folder("count-source", &source, HiddenPolicy::Include)
    .await;
  fixture
    .add_site_folder("count-target", &target, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();

  let tree = fixture
    .repo
    .storage_tree_with_coverage("count-source", "count-target", 8, 32)
    .await
    .unwrap();
  assert_health(tree.root.space_health, 2300.0 / 32.0);
  assert_eq!(tree.root.space_healthy_file_equivalents, 2.0);
  assert_eq!(tree.root.space_total_files, 3);
  assert_eq!(tree.root.coverage_covered_files, 1);
  assert_eq!(tree.root.coverage_total_files, 2);

  let source_root = &tree.root.children[0];
  let copies = child_named(source_root, "copies");
  assert_eq!(copies.space_healthy_file_equivalents, 1.0);
  assert_eq!(copies.space_total_files, 2);
  assert_eq!(copies.coverage_covered_files, 1);
  assert_eq!(copies.coverage_total_files, 1);
  let copy = child_named(copies, "a.bin");
  assert_eq!(copy.space_healthy_file_equivalents, 0.5);
  assert_eq!(copy.space_total_files, 1);
  assert_eq!(copy.coverage_covered_files, 1);
  assert_eq!(copy.coverage_total_files, 1);
}

#[tokio::test]
async fn coverage_health_is_directional_and_distinct_content_weighted() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("coverage-source");
  let source_a = source.join("a");
  let source_b = source.join("b");
  let target = fixture.mkdir("coverage-target");
  fs::create_dir(&source_a).unwrap();
  fs::create_dir(&source_b).unwrap();
  fs::write(source_a.join("shared.bin"), b"1234567890").unwrap();
  fs::write(source_b.join("shared-copy.bin"), b"1234567890").unwrap();
  fs::write(source_b.join("missing.bin"), b"12345").unwrap();
  fs::write(target.join("shared.bin"), b"1234567890").unwrap();
  fs::write(target.join("target-only.bin"), b"12345678901234567890").unwrap();

  fixture.create_site("source-health").await;
  fixture.create_site("target-health").await;
  fixture
    .add_site_folder("source-health", &source, HiddenPolicy::Include)
    .await;
  fixture
    .add_site_folder("target-health", &target, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();

  let forward = fixture
    .repo
    .storage_tree_with_coverage("source-health", "target-health", 8, 32)
    .await
    .unwrap();
  assert_eq!(forward.coverage_target.as_ref().unwrap().name, "target-health");
  assert_health(forward.root.coverage_health, 1000.0 / 15.0);
  let source_root = &forward.root.children[0];
  assert_health(child_named(source_root, "a").coverage_health, 100.0);
  assert_health(child_named(source_root, "b").coverage_health, 1000.0 / 15.0);
  assert_health(
    child_named(child_named(source_root, "b"), "missing.bin").coverage_health,
    0.0,
  );

  let reverse = fixture
    .repo
    .storage_tree_with_coverage("target-health", "source-health", 8, 32)
    .await
    .unwrap();
  assert_health(reverse.root.coverage_health, 1000.0 / 30.0);
}

#[tokio::test]
async fn coverage_health_distinguishes_never_scanned_and_scanned_empty_targets() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("scan-state-source");
  let target = fixture.mkdir("scan-state-target");
  fs::write(source.join("known.bin"), b"known").unwrap();
  fixture.create_site("known-source").await;
  fixture.create_site("empty-target").await;
  fixture
    .add_site_folder("known-source", &source, HiddenPolicy::Include)
    .await;
  fixture
    .add_site_folder("empty-target", &target, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_site("known-source").await.unwrap();

  let unknown = fixture
    .repo
    .storage_tree_with_coverage("known-source", "empty-target", 4, 32)
    .await
    .unwrap();
  assert_eq!(unknown.root.coverage_health, None);
  assert_eq!(
    fixture.repo.site_overview("empty-target").await.unwrap().latest_scan_at,
    None
  );

  fixture.repo.scan_site("empty-target").await.unwrap();
  assert!(
    fixture
      .repo
      .site_overview("empty-target")
      .await
      .unwrap()
      .latest_scan_at
      .is_some()
  );
  let missing = fixture
    .repo
    .storage_tree_with_coverage("known-source", "empty-target", 4, 32)
    .await
    .unwrap();
  assert_health(missing.root.coverage_health, 0.0);
}

#[tokio::test]
async fn coverage_health_is_unknown_when_sites_use_incompatible_hash_algorithms() {
  let cache = tempfile::tempdir().unwrap();
  let source = cache.path().join("algorithm-source");
  let target = cache.path().join("algorithm-target");
  fs::create_dir(&source).unwrap();
  fs::create_dir(&target).unwrap();
  fs::write(source.join("source.bin"), b"source").unwrap();
  fs::write(target.join("target.bin"), b"target").unwrap();
  let cache_path = cache.path().join("algorithm-health.sqlite3");

  let first_byte_repo = Repository::open(RepositoryOptions {
    cache_path: cache_path.clone(),
    hash_algorithm: Some(Arc::new(FirstByteHashAlgorithm)),
  })
  .await
  .unwrap();
  first_byte_repo.create_site("algorithm-source").await.unwrap();
  first_byte_repo.create_site("algorithm-target").await.unwrap();
  first_byte_repo
    .add_site_folder(
      "algorithm-source",
      AddSiteFolderRequest {
        path: source,
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  first_byte_repo
    .add_site_folder(
      "algorithm-target",
      AddSiteFolderRequest {
        path: target,
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  first_byte_repo.scan_site("algorithm-source").await.unwrap();

  let blake3_repo = Repository::open(RepositoryOptions {
    cache_path,
    hash_algorithm: None,
  })
  .await
  .unwrap();
  blake3_repo.scan_site("algorithm-target").await.unwrap();

  let tree = blake3_repo
    .storage_tree_with_coverage("algorithm-source", "algorithm-target", 4, 32)
    .await
    .unwrap();
  assert_eq!(tree.root.coverage_health, None);
  assert_eq!(tree.root.children[0].children[0].coverage_health, None);
}

#[tokio::test]
async fn cancelled_empty_scan_does_not_mark_site_as_scanned() {
  let fixture = Fixture::new().await;
  let empty = fixture.mkdir("cancelled-empty");
  fixture.create_site("cancelled-empty").await;
  fixture
    .add_site_folder("cancelled-empty", &empty, HiddenPolicy::Include)
    .await;

  let result = fixture
    .repo
    .scan_site_with_progress_and_cancellation("cancelled-empty", None, Some(Arc::new(|| true)))
    .await;

  assert!(matches!(result, Err(NafmError::ScanCancelled)));
  assert_eq!(
    fixture
      .repo
      .site_overview("cancelled-empty")
      .await
      .unwrap()
      .latest_scan_at,
    None
  );
}

#[tokio::test]
async fn opening_an_existing_database_backfills_scan_completion_state() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("backfill-source");
  fs::write(source.join("known.bin"), b"known").unwrap();
  fixture.create_site("backfilled").await;
  fixture
    .add_site_folder("backfilled", &source, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_site("backfilled").await.unwrap();
  let expected = fixture.repo.site_overview("backfilled").await.unwrap().latest_scan_at;
  let db_path = fixture.repo.db_path().to_path_buf();
  rusqlite::Connection::open(&db_path)
    .unwrap()
    .execute("drop table site_scan_state", [])
    .unwrap();

  let reopened = Repository::open(RepositoryOptions {
    cache_path: db_path,
    hash_algorithm: None,
  })
  .await
  .unwrap();

  assert_eq!(
    reopened.site_overview("backfilled").await.unwrap().latest_scan_at,
    expected
  );
}

#[tokio::test]
async fn known_zero_byte_content_uses_count_weighted_health_fallbacks() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("zero-source");
  let target = fixture.mkdir("zero-target");
  fs::write(source.join("empty-a.bin"), b"").unwrap();
  fs::write(source.join("empty-b.bin"), b"").unwrap();
  fs::write(target.join("empty.bin"), b"").unwrap();
  fixture.create_site("zero-source").await;
  fixture.create_site("zero-target").await;
  fixture
    .add_site_folder("zero-source", &source, HiddenPolicy::Include)
    .await;
  fixture
    .add_site_folder("zero-target", &target, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();

  let tree = fixture
    .repo
    .storage_tree_with_coverage("zero-source", "zero-target", 4, 32)
    .await
    .unwrap();
  assert_health(tree.root.space_health, 50.0);
  assert_health(tree.root.coverage_health, 100.0);
  assert_health(tree.root.children[0].children[0].space_health, 50.0);
}

#[tokio::test]
async fn storage_tree_keeps_health_correct_when_children_are_consolidated() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("bounded-health-source");
  let target = fixture.mkdir("bounded-health-target");
  for (directory, contents) in [
    ("large", b"1234567890".as_slice()),
    ("small", b"12345".as_slice()),
    ("tiny", b"12".as_slice()),
  ] {
    let folder = source.join(directory);
    fs::create_dir(&folder).unwrap();
    fs::write(folder.join("file.bin"), contents).unwrap();
  }
  fs::write(target.join("large.bin"), b"1234567890").unwrap();
  fixture.create_site("bounded-source").await;
  fixture.create_site("bounded-target").await;
  fixture
    .add_site_folder("bounded-source", &source, HiddenPolicy::Include)
    .await;
  fixture
    .add_site_folder("bounded-target", &target, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();

  let tree = fixture
    .repo
    .storage_tree_with_coverage("bounded-source", "bounded-target", 4, 2)
    .await
    .unwrap();
  assert_health(tree.root.coverage_health, 1000.0 / 17.0);
  let consolidated = &tree.root.children[0].children[1];
  assert_eq!(consolidated.kind, StorageNodeKind::SmallerItems);
  assert_health(consolidated.space_health, 100.0);
  assert_health(consolidated.coverage_health, 0.0);
}

#[tokio::test]
async fn storage_children_pages_direct_items_independently_of_map_bounds() {
  let fixture = Fixture::new().await;
  let source = fixture.mkdir("children-source");
  let target = fixture.mkdir("children-target");
  for (directory, contents) in [
    ("large", b"1234567890".as_slice()),
    ("medium", b"123456".as_slice()),
    ("small", b"123".as_slice()),
    ("tiny", b"1".as_slice()),
  ] {
    fs::create_dir(source.join(directory)).unwrap();
    fs::write(source.join(directory).join("clip.bin"), contents).unwrap();
  }
  fs::write(target.join("large.bin"), b"1234567890").unwrap();
  fixture.create_site("children-source").await;
  fixture.create_site("children-target").await;
  fixture
    .add_site_folder("children-source", &source, HiddenPolicy::Include)
    .await;
  fixture
    .add_site_folder("children-target", &target, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_all().await.unwrap();

  let bounded_tree = fixture
    .repo
    .storage_tree_with_coverage("children-source", "children-target", 4, 2)
    .await
    .unwrap();
  let source_root = &bounded_tree.root.children[0];
  assert_eq!(source_root.children.len(), 2);
  let smaller_items = source_root
    .children
    .iter()
    .find(|child| child.kind == StorageNodeKind::SmallerItems)
    .unwrap();

  let page = fixture
    .repo
    .storage_children_with_coverage("children-source", "children-target", &source_root.id, 1, 2)
    .await
    .unwrap();
  assert_eq!(page.site.name, "children-source");
  assert_eq!(page.coverage_target.unwrap().name, "children-target");
  assert_eq!(page.parent.id, source_root.id);
  assert!(page.parent.children.is_empty());
  assert_eq!(page.total_children, 4);
  assert_eq!(page.offset, 1);
  assert_eq!(page.limit, 2);
  assert_eq!(
    page
      .children
      .iter()
      .map(|child| child.name.as_str())
      .collect::<Vec<_>>(),
    vec!["medium", "small"]
  );
  assert!(page.children.iter().all(|child| child.children.is_empty()));
  assert_health(page.children[0].coverage_health, 0.0);

  let capped = fixture
    .repo
    .storage_children("children-source", &source_root.id, 0, u64::MAX)
    .await
    .unwrap();
  assert_eq!(capped.limit, 200);
  assert_eq!(capped.children.len(), 4);
  assert!(capped.coverage_target.is_none());
  assert_eq!(capped.parent.coverage_total_files, 0);

  let file_id = page.children[0].id.clone();
  let file_page = fixture
    .repo
    .storage_children("children-source", &file_id, 0, 20)
    .await
    .unwrap();
  assert_eq!(file_page.parent.kind, StorageNodeKind::Directory);
  assert_eq!(file_page.total_children, 1);
  let leaf_page = fixture
    .repo
    .storage_children("children-source", &file_page.children[0].id, 0, 20)
    .await
    .unwrap();
  assert_eq!(leaf_page.parent.kind, StorageNodeKind::File);
  assert_eq!(leaf_page.total_children, 0);
  assert!(leaf_page.children.is_empty());

  let aggregate_page = fixture
    .repo
    .storage_children("children-source", &smaller_items.id, 0, 20)
    .await
    .unwrap();
  assert_eq!(aggregate_page.parent.id, smaller_items.id);
  assert_eq!(aggregate_page.parent.kind, StorageNodeKind::SmallerItems);
  assert_eq!(aggregate_page.parent.total_bytes, smaller_items.total_bytes);
  assert_eq!(aggregate_page.total_children, 0);
  assert!(aggregate_page.children.is_empty());

  let error = fixture
    .repo
    .storage_children("children-source", "storage:unknown", 0, 20)
    .await
    .unwrap_err();
  assert!(matches!(error, NafmError::StorageNodeNotFound(node_id) if node_id == "storage:unknown"));
}

#[tokio::test]
async fn adds_smb_site_folder_with_saved_credentials() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://NAS.EXAMPLE.TEST/Media/", "sample-user", "secret")
    .unwrap();
  let repo = Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    },
    credential_store,
  )
  .await
  .unwrap();
  repo.create_site("network").await.unwrap();

  let folder = repo
    .add_site_folder(
      "network",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://nas.example.test/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  assert_eq!(folder.kind, SiteFolderKind::Smb);
  assert_eq!(folder.path, PathBuf::from("smb://nas.example.test/Media"));
  assert_eq!(
    repo.list_site_folders(Some("network")).await.unwrap()[0].kind,
    SiteFolderKind::Smb
  );
}

#[tokio::test]
async fn adds_nested_smb_site_folder_with_share_credentials() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://nas.example.test/share", "sample-user", "secret")
    .unwrap();
  let repo = Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    },
    credential_store,
  )
  .await
  .unwrap();
  repo.create_site("network").await.unwrap();

  let folder = repo
    .add_site_folder(
      "network",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://nas.example.test/share/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  assert_eq!(folder.kind, SiteFolderKind::Smb);
  assert_eq!(folder.path, PathBuf::from("smb://nas.example.test/share/Media"));
}

#[tokio::test]
async fn adding_smb_site_folder_requires_saved_credentials() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let repo = Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    },
    CredentialStore::new(credentials_root.path().join("nafm")),
  )
  .await
  .unwrap();
  repo.create_site("network").await.unwrap();

  let error = repo
    .add_site_folder(
      "network",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://nas.example.test/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap_err();

  assert_eq!(
    error.to_string(),
    "no saved credentials for SMB location: smb://nas.example.test/Media"
  );
}

#[tokio::test]
async fn migrates_existing_site_folders_to_local_kind() {
  let cache = tempfile::tempdir().unwrap();
  let db_path = cache.path().join("nafm.sqlite3");
  let conn = rusqlite::Connection::open(&db_path).unwrap();
  conn
    .execute_batch(
      "create table sites (
        id text primary key not null,
        name text not null unique,
        added_at text not null
      );
      create table site_folders (
        id text primary key not null,
        site_id text not null references sites(id) on delete cascade,
        path text not null unique,
        hidden_policy text not null,
        added_at text not null
      );
      insert into sites values ('site-1', 'local', '2026-01-01T00:00:00Z');
      insert into site_folders values ('folder-1', 'site-1', '/tmp/local', 'include', '2026-01-01T00:00:00Z');",
    )
    .unwrap();
  drop(conn);

  let repo = Repository::open(RepositoryOptions {
    cache_path: db_path,
    hash_algorithm: None,
  })
  .await
  .unwrap();

  let folders = repo.list_site_folders(Some("local")).await.unwrap();
  assert_eq!(folders.len(), 1);
  assert_eq!(folders[0].kind, SiteFolderKind::Local);
}

#[tokio::test]
async fn stages_tracked_smb_files_without_local_path_canonicalization() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://nas.example.test/Media", "sample-user", "secret")
    .unwrap();
  let repo = Repository::open_with_credential_store(
    RepositoryOptions {
      cache_path: cache.path().join("nafm.sqlite3"),
      hash_algorithm: None,
    },
    credential_store,
  )
  .await
  .unwrap();
  let site = repo.create_site("network").await.unwrap();
  let folder = repo
    .add_site_folder(
      "network",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://nas.example.test/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  let conn = rusqlite::Connection::open(repo.db_path()).unwrap();
  for (id, path) in [
    ("file-1", "smb://nas.example.test/Media/a.mp4"),
    ("file-2", "smb://nas.example.test/Media/b.mp4"),
  ] {
    conn
      .execute(
        "insert into file_records (
          id, site_id, site_folder_id, path, size_bytes, modified_unix_nanos,
          hash_algorithm, content_hash, last_seen_at
        ) values (?1, ?2, ?3, ?4, 4, 0, 'blake3', 'same-hash', '2026-01-01T00:00:00Z')",
        rusqlite::params![id, &site.id, &folder.id, path],
      )
      .unwrap();
  }
  drop(conn);

  let added = repo
    .stage_add_path(Path::new("smb://nas.example.test/Media/a.mp4"))
    .await
    .unwrap();
  assert_eq!(added.staged_files.len(), 1);
  assert_eq!(
    added.staged_files[0].path,
    PathBuf::from("smb://nas.example.test/Media/a.mp4")
  );

  let removed = repo
    .stage_remove_path(Path::new("smb://nas.example.test/Media/a.mp4"))
    .await
    .unwrap();
  assert_eq!(removed.removed_files.len(), 1);
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
async fn scan_site_resumes_from_durable_scan_cache() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("a.txt"), "same").unwrap();
  fs::write(docs.join("b.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  let conn = rusqlite::Connection::open(fixture.repo.db_path()).unwrap();
  conn
    .execute(
      "insert into scan_cache_entries (
        site_id, site_folder_id, path, size_bytes, modified_unix_nanos, hash_algorithm, content_hash, cached_at
      )
      select site_id, site_folder_id, path, size_bytes, modified_unix_nanos, hash_algorithm, content_hash, datetime('now')
      from file_records
      where site_id = (select id from sites where name = 'docs')
      order by path
      limit 1",
      [],
    )
    .unwrap();
  conn
    .execute(
      "delete from file_records where site_id = (select id from sites where name = 'docs')",
      [],
    )
    .unwrap();

  let seen = Arc::new(Mutex::new(Vec::new()));
  let seen_clone = seen.clone();
  let summary = fixture
    .repo
    .scan_site_with_progress(
      "docs",
      Some(Arc::new(move |progress| {
        seen_clone
          .lock()
          .unwrap()
          .push((progress.files_scanned, progress.files_reused, progress.total_files));
      })),
    )
    .await
    .unwrap();

  assert_eq!(summary.files_hashed, 1);
  assert_eq!(summary.files_reused, 1);
  assert_eq!(&*seen.lock().unwrap(), &[(1, 1, 2)]);
}

#[tokio::test]
async fn scan_site_caches_hash_before_reporting_progress() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("a.txt"), "alpha").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Include).await;

  let db_path = fixture.repo.db_path().to_path_buf();
  let cache_was_visible = Arc::new(Mutex::new(Vec::new()));
  let cache_was_visible_clone = cache_was_visible.clone();
  fixture
    .repo
    .scan_site_with_progress(
      "docs",
      Some(Arc::new(move |progress| {
        let conn = rusqlite::Connection::open(&db_path).unwrap();
        let is_cached = conn
          .query_row(
            "select exists(
              select 1 from scan_cache_entries where site_id = ?1 and path = ?2
            )",
            rusqlite::params![progress.site_id, progress.current_path.to_string_lossy()],
            |row| row.get::<_, bool>(0),
          )
          .unwrap();
        cache_was_visible_clone.lock().unwrap().push(is_cached);
      })),
    )
    .await
    .unwrap();

  assert_eq!(&*cache_was_visible.lock().unwrap(), &[true]);
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
  let mut scanned_counts = seen
    .iter()
    .map(|(_, files_scanned, _)| *files_scanned)
    .collect::<Vec<_>>();
  scanned_counts.sort_unstable();
  assert_eq!(scanned_counts, vec![1, 2]);
  assert!(seen.iter().all(|(_, _, total_files)| *total_files == 2));
  assert!(seen.iter().any(|(path, _, _)| path.ends_with("a.txt")));
  assert!(seen.iter().any(|(path, _, _)| path.ends_with("b.txt")));
}

#[tokio::test]
async fn scan_site_progress_skips_cached_files() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("a.txt"), "alpha").unwrap();
  fs::write(docs.join("b.txt"), "beta").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  let seen = Arc::new(Mutex::new(Vec::new()));
  let seen_clone = seen.clone();
  let summary = fixture
    .repo
    .scan_site_with_progress(
      "docs",
      Some(Arc::new(move |progress| {
        seen_clone.lock().unwrap().push(progress.clone());
      })),
    )
    .await
    .unwrap();

  assert_eq!(summary.files_hashed, 0);
  assert_eq!(summary.files_reused, 2);
  assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn scan_site_cancellation_preserves_completed_hashes_for_resume() {
  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  for index in 0..12 {
    fs::write(
      root.path().join(format!("file-{index:02}.bin")),
      format!("content-{index}"),
    )
    .unwrap();
  }

  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(SlowHashAlgorithm {
      current: Arc::new(AtomicUsize::new(0)),
      max: Arc::new(AtomicUsize::new(0)),
      delay: Duration::from_millis(20),
    })),
  })
  .await
  .unwrap();
  repo.create_site("media").await.unwrap();
  repo
    .add_site_folder(
      "media",
      AddSiteFolderRequest {
        path: root.path().to_path_buf(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
  let cancelled_from_progress = cancelled.clone();
  let cancelled_for_scan = cancelled.clone();
  let result = repo
    .scan_site_with_progress_and_cancellation(
      "media",
      Some(Arc::new(move |_| {
        cancelled_from_progress.store(true, Ordering::SeqCst);
      })),
      Some(Arc::new(move || cancelled_for_scan.load(Ordering::SeqCst))),
    )
    .await;

  assert!(matches!(result, Err(NafmError::ScanCancelled)));
  let cached_count = rusqlite::Connection::open(repo.db_path())
    .unwrap()
    .query_row("select count(*) from scan_cache_entries", [], |row| {
      row.get::<_, u64>(0)
    })
    .unwrap();
  assert!(
    cached_count > 0,
    "completed hashes should remain durable after cancellation"
  );
  assert!(
    cached_count < 12,
    "cancellation should stop before every file is cached"
  );

  let summary = repo.scan_site("media").await.unwrap();
  assert_eq!(summary.files_seen, 12);
  assert_eq!(summary.files_reused, cached_count);
  assert_eq!(summary.files_hashed, 12 - cached_count);
}

#[tokio::test]
async fn scan_site_honors_cancellation_before_hashing() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("file.bin"), b"content").unwrap();
  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Include).await;

  let result = fixture
    .repo
    .scan_site_with_progress_and_cancellation("docs", None, Some(Arc::new(|| true)))
    .await;

  assert!(matches!(result, Err(NafmError::ScanCancelled)));
  let cache_count = rusqlite::Connection::open(fixture.repo.db_path())
    .unwrap()
    .query_row("select count(*) from scan_cache_entries", [], |row| {
      row.get::<_, u64>(0)
    })
    .unwrap();
  assert_eq!(cache_count, 0);
}

#[tokio::test]
async fn scan_site_cancels_during_one_large_local_file_without_publishing_it() {
  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  fs::write(root.path().join("large.bin"), vec![0x5a; 4 * 64 * 1024]).unwrap();

  let hashing_started = Arc::new(AtomicBool::new(false));
  let hash_cancellation_checks = Arc::new(AtomicUsize::new(0));
  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(ChunkCancellationHashAlgorithm {
      hashing_started: hashing_started.clone(),
    })),
  })
  .await
  .unwrap();
  repo.create_site("media").await.unwrap();
  repo
    .add_site_folder(
      "media",
      AddSiteFolderRequest {
        path: root.path().to_path_buf(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  let hashing_started_for_scan = hashing_started.clone();
  let hash_cancellation_checks_for_scan = hash_cancellation_checks.clone();
  let result = repo
    .scan_site_with_progress_and_cancellation(
      "media",
      None,
      Some(Arc::new(move || {
        if !hashing_started_for_scan.load(Ordering::SeqCst) {
          return false;
        }
        hash_cancellation_checks_for_scan.fetch_add(1, Ordering::SeqCst) >= 1
      })),
    )
    .await;

  assert!(matches!(result, Err(NafmError::ScanCancelled)));
  assert!(hashing_started.load(Ordering::SeqCst));
  assert_eq!(
    hash_cancellation_checks.load(Ordering::SeqCst),
    2,
    "the first in-file check should continue and the next 64 KiB checkpoint should cancel"
  );
  let conn = rusqlite::Connection::open(repo.db_path()).unwrap();
  assert_eq!(
    conn
      .query_row("select count(*) from scan_cache_entries", [], |row| row
        .get::<_, u64>(0))
      .unwrap(),
    0,
    "a partial file hash must not enter the resume cache"
  );
  assert_eq!(
    conn
      .query_row("select count(*) from file_records", [], |row| row.get::<_, u64>(0))
      .unwrap(),
    0,
    "a cancelled scan must not publish a partial file set"
  );
  drop(conn);
  assert_eq!(repo.site_overview("media").await.unwrap().latest_scan_at, None);

  let summary = repo.scan_site("media").await.unwrap();
  assert_eq!(summary.files_seen, 1);
  assert_eq!(summary.files_hashed, 1);
  assert!(repo.site_overview("media").await.unwrap().latest_scan_at.is_some());
  let conn = rusqlite::Connection::open(repo.db_path()).unwrap();
  assert_eq!(
    conn
      .query_row("select count(*) from scan_cache_entries", [], |row| row
        .get::<_, u64>(0))
      .unwrap(),
    0,
    "a successful publication should clear its resume cache"
  );
  assert_eq!(
    conn
      .query_row("select count(*) from file_records", [], |row| row.get::<_, u64>(0))
      .unwrap(),
    1
  );
}

#[tokio::test]
async fn cancellable_scan_preserves_custom_hash_file_overrides() {
  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  fs::write(root.path().join("custom.bin"), b"content").unwrap();
  let hash_file_calls = Arc::new(AtomicUsize::new(0));
  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(OverrideTrackingHashAlgorithm {
      hash_file_calls: hash_file_calls.clone(),
    })),
  })
  .await
  .unwrap();
  repo.create_site("custom").await.unwrap();
  repo
    .add_site_folder(
      "custom",
      AddSiteFolderRequest {
        path: root.path().to_path_buf(),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  let summary = repo
    .scan_site_with_progress_and_cancellation("custom", None, Some(Arc::new(|| false)))
    .await
    .unwrap();

  assert_eq!(summary.files_hashed, 1);
  assert_eq!(hash_file_calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn scan_site_honors_cancellation_requested_from_final_progress() {
  let fixture = Fixture::new().await;
  let docs = fixture.mkdir("docs");
  fs::write(docs.join("file.bin"), b"content").unwrap();
  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &docs, HiddenPolicy::Include).await;

  let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
  let cancelled_from_progress = cancelled.clone();
  let cancelled_for_scan = cancelled.clone();
  let result = fixture
    .repo
    .scan_site_with_progress_and_cancellation(
      "docs",
      Some(Arc::new(move |_| {
        cancelled_from_progress.store(true, Ordering::SeqCst);
      })),
      Some(Arc::new(move || cancelled_for_scan.load(Ordering::SeqCst))),
    )
    .await;

  assert!(matches!(result, Err(NafmError::ScanCancelled)));
  let conn = rusqlite::Connection::open(fixture.repo.db_path()).unwrap();
  assert_eq!(
    conn
      .query_row("select count(*) from scan_cache_entries", [], |row| row
        .get::<_, u64>(0))
      .unwrap(),
    1,
    "the completed hash should remain available for resume"
  );
  assert_eq!(
    conn
      .query_row("select count(*) from file_records", [], |row| row.get::<_, u64>(0))
      .unwrap(),
    0,
    "a cancelled scan should not publish its new file set"
  );
}

#[tokio::test]
async fn concurrent_site_scans_use_independent_cancellation_callbacks() {
  let fixture = Fixture::new().await;
  for site_name in ["cancelled", "continuing"] {
    let folder = fixture.mkdir(site_name);
    fs::write(folder.join("file.bin"), site_name).unwrap();
    fixture.create_site(site_name).await;
    fixture.add_site_folder(site_name, &folder, HiddenPolicy::Include).await;
  }

  let (cancelled, continuing) = tokio::join!(
    fixture
      .repo
      .scan_site_with_progress_and_cancellation("cancelled", None, Some(Arc::new(|| true))),
    fixture.repo.scan_site("continuing"),
  );

  assert!(matches!(cancelled, Err(NafmError::ScanCancelled)));
  let continuing = continuing.unwrap();
  assert_eq!(continuing.site_name, "continuing");
  assert_eq!(continuing.files_seen, 1);
  assert_eq!(continuing.files_hashed, 1);
}

#[tokio::test]
async fn scan_all_cancellation_does_not_publish_site_summaries() {
  let fixture = Fixture::new().await;
  for site_name in ["alpha", "beta"] {
    let folder = fixture.mkdir(site_name);
    fs::write(folder.join("file.bin"), site_name).unwrap();
    fixture.create_site(site_name).await;
    fixture.add_site_folder(site_name, &folder, HiddenPolicy::Include).await;
  }

  let events = Arc::new(Mutex::new(Vec::new()));
  let events_for_callback = events.clone();
  let result = fixture
    .repo
    .scan_all_with_events_and_cancellation(
      Some(Arc::new(move |event| {
        events_for_callback.lock().unwrap().push(event.clone());
      })),
      Some(Arc::new(|| true)),
    )
    .await;

  assert!(matches!(result, Err(NafmError::ScanCancelled)));
  let events = events.lock().unwrap();
  assert_eq!(
    events
      .iter()
      .filter(|event| matches!(event, ScanEvent::Started(_)))
      .count(),
    2
  );
  assert!(!events.iter().any(|event| matches!(event, ScanEvent::Summary(_))));
}

#[tokio::test]
async fn scan_all_cancellation_waits_for_every_site_worker_to_finish() {
  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  let cancelling = root.path().join("cancelling");
  let draining = root.path().join("draining");
  fs::create_dir(&cancelling).unwrap();
  fs::create_dir(&draining).unwrap();
  fs::write(cancelling.join("cancel.bin"), b"cancel").unwrap();
  fs::write(draining.join("drain.bin"), b"drain").unwrap();

  let cancelled = Arc::new(std::sync::atomic::AtomicBool::new(false));
  let active = Arc::new(AtomicUsize::new(0));
  let completed = Arc::new(AtomicUsize::new(0));
  let cancellation_observations = Arc::new(AtomicUsize::new(0));
  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(CancellingHashAlgorithm {
      rendezvous: Arc::new(std::sync::Barrier::new(2)),
      cancelled: cancelled.clone(),
      active: active.clone(),
      completed: completed.clone(),
      drain_delay: Duration::from_millis(500),
    })),
  })
  .await
  .unwrap();
  for (site_name, folder) in [("cancelling", cancelling), ("draining", draining)] {
    repo.create_site(site_name).await.unwrap();
    repo
      .add_site_folder(
        site_name,
        AddSiteFolderRequest {
          path: folder,
          hidden_policy: HiddenPolicy::Include,
        },
      )
      .await
      .unwrap();
  }

  let cancelled_for_scan = cancelled.clone();
  let cancellation_observations_for_scan = cancellation_observations.clone();
  let result = repo
    .scan_all_with_events_and_cancellation(
      None,
      Some(Arc::new(move || {
        let cancelled = cancelled_for_scan.load(Ordering::SeqCst);
        if cancelled {
          cancellation_observations_for_scan.fetch_add(1, Ordering::SeqCst);
        }
        cancelled
      })),
    )
    .await;

  assert!(matches!(result, Err(NafmError::ScanCancelled)));
  assert_eq!(active.load(Ordering::SeqCst), 0, "no hash worker may outlive scan all");
  assert_eq!(
    completed.load(Ordering::SeqCst),
    2,
    "scan all must drain the non-abortable blocking worker before returning"
  );
  assert!(
    cancellation_observations.load(Ordering::SeqCst) >= 2,
    "each site worker must observe shared cancellation before scan all returns"
  );
}

#[tokio::test]
async fn scan_all_emits_each_site_summary_as_it_completes() {
  let root = tempfile::tempdir().unwrap();
  let cache = tempfile::tempdir().unwrap();
  let cached = root.path().join("cached");
  let slow = root.path().join("slow");
  fs::create_dir(&cached).unwrap();
  fs::create_dir(&slow).unwrap();
  fs::write(cached.join("a.txt"), "cached").unwrap();
  fs::write(slow.join("b.txt"), "slow").unwrap();

  let repo = Repository::open(RepositoryOptions {
    cache_path: cache.path().join("nafm.sqlite3"),
    hash_algorithm: Some(Arc::new(SlowHashAlgorithm {
      current: Arc::new(AtomicUsize::new(0)),
      max: Arc::new(AtomicUsize::new(0)),
      delay: Duration::from_millis(250),
    })),
  })
  .await
  .unwrap();
  repo.create_site("cached").await.unwrap();
  repo
    .add_site_folder(
      "cached",
      AddSiteFolderRequest {
        path: cached,
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  repo.scan_site("cached").await.unwrap();

  repo.create_site("slow").await.unwrap();
  repo
    .add_site_folder(
      "slow",
      AddSiteFolderRequest {
        path: slow,
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  let events = Arc::new(Mutex::new(Vec::new()));
  let events_clone = events.clone();
  repo
    .scan_all_with_events(Some(Arc::new(move |event| {
      let event = match event {
        ScanEvent::Started(started) => format!("started:{}", started.site_name),
        ScanEvent::Progress(progress) => format!("progress:{}", progress.site_name),
        ScanEvent::Summary(summary) => format!("summary:{}", summary.site_name),
      };
      events_clone.lock().unwrap().push(event);
    })))
    .await
    .unwrap();

  let events = events.lock().unwrap();
  assert!(events.iter().any(|event| event == "started:cached"));
  assert!(events.iter().any(|event| event == "started:slow"));
  let cached_summary = events
    .iter()
    .position(|event| event == "summary:cached")
    .expect("cached site should emit a summary");
  let slow_progress = events
    .iter()
    .position(|event| event == "progress:slow")
    .expect("slow site should emit progress");
  assert!(
    cached_summary < slow_progress,
    "cached site summary should arrive before the slow site finishes hashing: {events:?}"
  );
  assert_eq!(
    events
      .iter()
      .filter_map(|event| event.strip_prefix("summary:"))
      .collect::<Vec<_>>(),
    ["cached", "slow"]
  );
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
      delay: Duration::from_millis(25),
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
  assert!(
    report
      .warnings
      .iter()
      .any(|warning| warning.path.ends_with("two.txt") || warning.path.ends_with("one.txt"))
  );
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

#[tokio::test]
async fn stage_add_unique_only_folder_warns_instead_of_failing() {
  let fixture = Fixture::new().await;
  let root = fixture.mkdir("root");
  fs::write(root.join("only.txt"), "unique").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &root, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  assert!(fixture.repo.stage_add_path(&root).await.is_err());
}

#[tokio::test]
async fn stage_remove_non_staged_tracked_file_warns() {
  let fixture = Fixture::new().await;
  let root = fixture.mkdir("root");
  let other = fixture.mkdir("other");
  let target = root.join("dup.txt");
  fs::write(&target, "same").unwrap();
  fs::write(other.join("peer.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &root, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &other, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  let report = fixture.repo.stage_remove_path(&target).await.unwrap();
  assert!(report.removed_files.is_empty());
  assert_eq!(report.warnings.len(), 1);
  assert!(matches!(report.warnings[0].reason, StageWarningReason::NotStaged));
}

#[tokio::test]
async fn stage_remove_non_staged_tracked_folder_warns() {
  let fixture = Fixture::new().await;
  let root = fixture.mkdir("root");
  let dup = root.join("dup");
  fs::create_dir(&dup).unwrap();
  fs::write(dup.join("file.txt"), "same").unwrap();
  let other = fixture.mkdir("other");
  fs::write(other.join("peer.txt"), "same").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &root, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &other, HiddenPolicy::Include).await;
  fixture.repo.scan_site("docs").await.unwrap();

  let report = fixture.repo.stage_remove_path(&dup).await.unwrap();
  assert!(report.removed_files.is_empty());
  assert_eq!(report.warnings.len(), 1);
  assert!(matches!(report.warnings[0].reason, StageWarningReason::NotStaged));
}

#[tokio::test]
async fn stage_undo_and_redo_fail_at_history_boundaries() {
  let fixture = Fixture::new().await;
  assert!(fixture.repo.stage_undo().await.is_err());
  assert!(fixture.repo.stage_redo().await.is_err());
}

#[tokio::test]
async fn stage_redo_is_cleared_by_new_mutation_after_undo() {
  let fixture = build_stage_matrix_fixture().await;
  let alpha_one = fixture.path("alpha", "one.txt");
  let beta_one = fixture.path("beta", "one.txt");
  let gamma_one = fixture.path("gamma", "one.txt");

  fixture.repo().stage_add_path(&alpha_one).await.unwrap();
  fixture.repo().stage_add_path(&beta_one).await.unwrap();
  fixture.repo().stage_undo().await.unwrap();
  fixture.repo().stage_add_path(&gamma_one).await.unwrap();

  assert!(fixture.repo().stage_redo().await.is_err());
  assert_eq!(fixture.stage_paths().await, BTreeSet::from([alpha_one, gamma_one]));
}

#[tokio::test]
async fn stage_randomized_sequence_matches_model() {
  let fixture = build_stage_matrix_fixture().await;
  let alpha_dir = fixture.dir("alpha");
  let beta_dir = fixture.dir("beta");
  let gamma_dir = fixture.dir("gamma");
  let unique_dir = fixture.dir("unique");
  let alpha_one = fixture.path("alpha", "one.txt");
  let beta_one = fixture.path("beta", "one.txt");
  let gamma_one = fixture.path("gamma", "one.txt");
  let beta_two = fixture.path("beta", "two.txt");
  let gamma_two = fixture.path("gamma", "two.txt");
  let unique = fixture.path("unique", "only.txt");

  let groups = vec![
    vec![alpha_one.clone(), beta_one.clone(), gamma_one.clone()],
    vec![beta_two.clone(), gamma_two.clone()],
  ];
  let tracked_files = vec![
    alpha_one.clone(),
    beta_one.clone(),
    gamma_one.clone(),
    beta_two.clone(),
    gamma_two.clone(),
    unique.clone(),
  ];
  let dir_members = BTreeMap::from([
    (alpha_dir.clone(), vec![alpha_one.clone()]),
    (beta_dir.clone(), vec![beta_one.clone(), beta_two.clone()]),
    (gamma_dir.clone(), vec![gamma_one.clone(), gamma_two.clone()]),
    (unique_dir.clone(), vec![unique.clone()]),
  ]);

  let mut model = StageModel::new(groups, tracked_files, dir_members);
  let mut rng = Lcg::new(0x5eed_1234_abcd_7788);
  let add_targets = vec![
    alpha_one.clone(),
    beta_one.clone(),
    gamma_one.clone(),
    beta_two.clone(),
    gamma_two.clone(),
    unique.clone(),
    alpha_dir.clone(),
    beta_dir.clone(),
    gamma_dir.clone(),
    unique_dir.clone(),
  ];
  let remove_targets = add_targets.clone();

  for _step in 0..200 {
    match rng.next_u64() % 6 {
      0 => {
        let target = add_targets[rng.index(add_targets.len())].clone();
        let model_report = model.add_path(&target);
        let repo_result = fixture.repo().stage_add_path(&target).await;
        assert_eq!(repo_result.is_err(), model_report.expect_error);
        if let Ok(repo_report) = repo_result {
          assert_eq!(
            sorted_paths(repo_report.staged_files.iter().map(|file| &file.path)),
            model_report.changed_paths
          );
          assert_eq!(sorted_warning_reasons(&repo_report), model_report.warning_reasons);
        }
      }
      1 => {
        let target = remove_targets[rng.index(remove_targets.len())].clone();
        let repo_report = fixture.repo().stage_remove_path(&target).await.unwrap();
        let model_report = model.remove_path(&target);
        assert_eq!(
          sorted_paths(repo_report.removed_files.iter().map(|file| &file.path)),
          model_report.changed_paths
        );
        assert_eq!(
          sorted_warning_reasons_remove(&repo_report),
          model_report.warning_reasons
        );
      }
      2 => {
        let repo_report = fixture.repo().stage_reset().await.unwrap();
        let model_report = model.reset();
        assert_eq!(
          sorted_paths(repo_report.removed_files.iter().map(|file| &file.path)),
          model_report.changed_paths
        );
      }
      3 => {
        let repo_result = fixture.repo().stage_undo().await;
        let model_result = model.undo();
        assert_eq!(repo_result.is_ok(), model_result.is_some());
        if let (Ok(repo_report), Some(expected)) = (repo_result, model_result) {
          assert_eq!(
            sorted_paths(repo_report.restored_files.iter().map(|file| &file.path)),
            expected
          );
        }
      }
      4 => {
        let repo_result = fixture.repo().stage_redo().await;
        let model_result = model.redo();
        assert_eq!(repo_result.is_ok(), model_result.is_some());
        if let (Ok(repo_report), Some(expected)) = (repo_result, model_result) {
          assert_eq!(
            sorted_paths(repo_report.restored_files.iter().map(|file| &file.path)),
            expected
          );
        }
      }
      _ => {
        let repo_stage = fixture.stage_paths().await;
        assert_eq!(repo_stage, model.stage);
      }
    }

    let repo_stage = fixture.stage_paths().await;
    assert_eq!(repo_stage, model.stage);
  }
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

  async fn stage_paths(&self) -> BTreeSet<PathBuf> {
    self
      .repo
      .stage_commit_dry_run()
      .await
      .unwrap()
      .staged_files
      .into_iter()
      .map(|file| file.path)
      .collect()
  }
}

struct StageMatrixFixture {
  fixture: Fixture,
  dirs: BTreeMap<&'static str, PathBuf>,
  paths: BTreeMap<(&'static str, &'static str), PathBuf>,
}

impl StageMatrixFixture {
  fn repo(&self) -> &Repository {
    &self.fixture.repo
  }

  fn dir(&self, key: &'static str) -> PathBuf {
    self.dirs.get(key).unwrap().clone()
  }

  fn path(&self, dir: &'static str, file: &'static str) -> PathBuf {
    self.paths.get(&(dir, file)).unwrap().clone()
  }

  async fn stage_paths(&self) -> BTreeSet<PathBuf> {
    self.fixture.stage_paths().await
  }
}

async fn build_stage_matrix_fixture() -> StageMatrixFixture {
  let fixture = Fixture::new().await;
  let alpha = fixture.mkdir("alpha");
  let beta = fixture.mkdir("beta");
  let gamma = fixture.mkdir("gamma");
  let unique_dir = fixture.mkdir("unique");
  let alpha_one = alpha.join("one.txt");
  let beta_one = beta.join("one.txt");
  let gamma_one = gamma.join("one.txt");
  let beta_two = beta.join("two.txt");
  let gamma_two = gamma.join("two.txt");
  let unique = unique_dir.join("only.txt");
  fs::write(&alpha_one, "group-one").unwrap();
  fs::write(&beta_one, "group-one").unwrap();
  fs::write(&gamma_one, "group-one").unwrap();
  fs::write(&beta_two, "group-two").unwrap();
  fs::write(&gamma_two, "group-two").unwrap();
  fs::write(&unique, "unique").unwrap();

  fixture.create_site("docs").await;
  fixture.add_site_folder("docs", &alpha, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &beta, HiddenPolicy::Include).await;
  fixture.add_site_folder("docs", &gamma, HiddenPolicy::Include).await;
  fixture
    .add_site_folder("docs", &unique_dir, HiddenPolicy::Include)
    .await;
  fixture.repo.scan_site("docs").await.unwrap();

  let alpha = fs::canonicalize(alpha).unwrap();
  let beta = fs::canonicalize(beta).unwrap();
  let gamma = fs::canonicalize(gamma).unwrap();
  let unique_dir = fs::canonicalize(unique_dir).unwrap();
  let alpha_one = fs::canonicalize(alpha_one).unwrap();
  let beta_one = fs::canonicalize(beta_one).unwrap();
  let gamma_one = fs::canonicalize(gamma_one).unwrap();
  let beta_two = fs::canonicalize(beta_two).unwrap();
  let gamma_two = fs::canonicalize(gamma_two).unwrap();
  let unique = fs::canonicalize(unique).unwrap();

  StageMatrixFixture {
    fixture,
    dirs: BTreeMap::from([
      ("alpha", alpha),
      ("beta", beta),
      ("gamma", gamma),
      ("unique", unique_dir),
    ]),
    paths: BTreeMap::from([
      (("alpha", "one.txt"), alpha_one),
      (("beta", "one.txt"), beta_one),
      (("gamma", "one.txt"), gamma_one),
      (("beta", "two.txt"), beta_two),
      (("gamma", "two.txt"), gamma_two),
      (("unique", "only.txt"), unique),
    ]),
  }
}

fn sorted_paths<'a>(paths: impl IntoIterator<Item = &'a PathBuf>) -> Vec<PathBuf> {
  let mut values = paths.into_iter().cloned().collect::<Vec<_>>();
  values.sort();
  values
}

fn sorted_warning_reasons(report: &nafm_core::StageAddReport) -> Vec<(PathBuf, StageWarningReason)> {
  let mut values = report
    .warnings
    .iter()
    .map(|warning| (warning.path.clone(), warning.reason.clone()))
    .collect::<Vec<_>>();
  values.sort_by(|left, right| left.0.cmp(&right.0));
  values
}

fn sorted_warning_reasons_remove(report: &nafm_core::StageRemoveReport) -> Vec<(PathBuf, StageWarningReason)> {
  let mut values = report
    .warnings
    .iter()
    .map(|warning| (warning.path.clone(), warning.reason.clone()))
    .collect::<Vec<_>>();
  values.sort_by(|left, right| left.0.cmp(&right.0));
  values
}

struct StageModel {
  groups: Vec<Vec<PathBuf>>,
  tracked_files: BTreeSet<PathBuf>,
  dir_members: BTreeMap<PathBuf, Vec<PathBuf>>,
  stage: BTreeSet<PathBuf>,
  snapshots: Vec<BTreeSet<PathBuf>>,
  cursor: usize,
}

impl StageModel {
  fn new(groups: Vec<Vec<PathBuf>>, tracked_files: Vec<PathBuf>, dir_members: BTreeMap<PathBuf, Vec<PathBuf>>) -> Self {
    Self {
      groups,
      tracked_files: tracked_files.into_iter().collect(),
      dir_members,
      stage: BTreeSet::new(),
      snapshots: vec![BTreeSet::new()],
      cursor: 0,
    }
  }

  fn add_path(&mut self, path: &Path) -> ModelMutation {
    if path.is_dir() {
      self.add_dir(path)
    } else {
      self.add_file(path)
    }
  }

  fn remove_path(&mut self, path: &Path) -> ModelMutation {
    if path.is_dir() {
      self.remove_dir(path)
    } else {
      self.remove_file(path)
    }
  }

  fn reset(&mut self) -> ModelMutation {
    let changed_paths = self.stage.iter().cloned().collect::<Vec<_>>();
    if !changed_paths.is_empty() {
      self.stage.clear();
      self.push_snapshot();
    }
    ModelMutation {
      changed_paths: sorted_paths(changed_paths.iter()),
      warning_reasons: Vec::new(),
      expect_error: false,
    }
  }

  fn undo(&mut self) -> Option<Vec<PathBuf>> {
    if self.cursor == 0 {
      return None;
    }
    self.cursor -= 1;
    self.stage = self.snapshots[self.cursor].clone();
    Some(sorted_paths(self.stage.iter().collect::<Vec<_>>().iter().copied()))
  }

  fn redo(&mut self) -> Option<Vec<PathBuf>> {
    if self.cursor + 1 >= self.snapshots.len() {
      return None;
    }
    self.cursor += 1;
    self.stage = self.snapshots[self.cursor].clone();
    Some(sorted_paths(self.stage.iter().collect::<Vec<_>>().iter().copied()))
  }

  fn add_file(&mut self, path: &Path) -> ModelMutation {
    let mut warning_reasons = Vec::new();
    let mut changed_paths = Vec::new();
    let path = path.to_path_buf();
    if !self.tracked_files.contains(&path) {
      return ModelMutation {
        changed_paths,
        warning_reasons,
        expect_error: false,
      };
    }
    let Some(group_index) = self.group_index_for(&path) else {
      return ModelMutation {
        changed_paths,
        warning_reasons,
        expect_error: false,
      };
    };
    if self.stage.contains(&path) {
      warning_reasons.push((path, StageWarningReason::AlreadyStaged));
      return ModelMutation {
        changed_paths,
        warning_reasons,
        expect_error: false,
      };
    }
    let group = &self.groups[group_index];
    let unstaged_count = group
      .iter()
      .filter(|candidate| !self.stage.contains(*candidate))
      .count();
    if unstaged_count > 1 {
      self.stage.insert(path.clone());
      changed_paths.push(path);
      self.push_snapshot();
    } else {
      warning_reasons.push((path, StageWarningReason::WouldRemoveLastCopy));
    }
    ModelMutation {
      changed_paths: sorted_paths(changed_paths.iter()),
      warning_reasons: sort_model_warnings(warning_reasons),
      expect_error: false,
    }
  }

  fn add_dir(&mut self, path: &Path) -> ModelMutation {
    let Some(tracked_descendants) = self.dir_members.get(path) else {
      return ModelMutation {
        changed_paths: Vec::new(),
        warning_reasons: Vec::new(),
        expect_error: false,
      };
    };
    let mut warnings = Vec::new();
    let duplicate_candidates = tracked_descendants
      .iter()
      .filter(|candidate| self.group_index_for(candidate).is_some())
      .cloned()
      .collect::<Vec<_>>();
    if duplicate_candidates.is_empty() {
      return ModelMutation {
        changed_paths: Vec::new(),
        warning_reasons: sort_model_warnings(warnings),
        expect_error: true,
      };
    }

    let mut requested_by_group = BTreeMap::<usize, Vec<PathBuf>>::new();
    for candidate in duplicate_candidates {
      if self.stage.contains(&candidate) {
        warnings.push((candidate, StageWarningReason::AlreadyStaged));
      } else {
        requested_by_group
          .entry(self.group_index_for(&candidate).unwrap())
          .or_default()
          .push(candidate);
      }
    }

    let mut changed_paths = Vec::new();
    for (group_index, mut requested) in requested_by_group {
      let group = &self.groups[group_index];
      let mut unstaged_group = group
        .iter()
        .filter(|candidate| !self.stage.contains(*candidate))
        .cloned()
        .collect::<Vec<_>>();
      unstaged_group.sort();
      requested.sort();
      let requested_set = requested.iter().cloned().collect::<BTreeSet<_>>();
      let outside_requested_count = unstaged_group
        .iter()
        .filter(|candidate| !requested_set.contains(*candidate))
        .count();
      let allowed = if outside_requested_count > 0 {
        requested.len()
      } else {
        requested.len().saturating_sub(1)
      };
      for (index, file) in requested.into_iter().enumerate() {
        if index < allowed {
          self.stage.insert(file.clone());
          changed_paths.push(file);
        } else {
          warnings.push((file, StageWarningReason::WouldRemoveLastCopy));
        }
      }
    }

    if !changed_paths.is_empty() {
      self.push_snapshot();
    }

    ModelMutation {
      changed_paths: sorted_paths(changed_paths.iter()),
      warning_reasons: sort_model_warnings(warnings),
      expect_error: false,
    }
  }

  fn remove_file(&mut self, path: &Path) -> ModelMutation {
    let path = path.to_path_buf();
    if self.stage.remove(&path) {
      let changed_paths = vec![path];
      self.push_snapshot();
      return ModelMutation {
        changed_paths,
        warning_reasons: Vec::new(),
        expect_error: false,
      };
    }

    let reason = if self.tracked_files.contains(&path) {
      StageWarningReason::NotStaged
    } else {
      StageWarningReason::NotTracked
    };
    ModelMutation {
      changed_paths: Vec::new(),
      warning_reasons: vec![(path, reason)],
      expect_error: false,
    }
  }

  fn remove_dir(&mut self, path: &Path) -> ModelMutation {
    let Some(tracked_descendants) = self.dir_members.get(path) else {
      return ModelMutation {
        changed_paths: Vec::new(),
        warning_reasons: Vec::new(),
        expect_error: false,
      };
    };
    let removed = tracked_descendants
      .iter()
      .filter(|candidate| self.stage.contains(*candidate))
      .cloned()
      .collect::<Vec<_>>();
    if removed.is_empty() {
      return ModelMutation {
        changed_paths: Vec::new(),
        warning_reasons: vec![(path.to_path_buf(), StageWarningReason::NotStaged)],
        expect_error: false,
      };
    }

    for candidate in &removed {
      self.stage.remove(candidate);
    }
    self.push_snapshot();
    ModelMutation {
      changed_paths: sorted_paths(removed.iter()),
      warning_reasons: Vec::new(),
      expect_error: false,
    }
  }

  fn group_index_for(&self, path: &Path) -> Option<usize> {
    self
      .groups
      .iter()
      .position(|group| group.iter().any(|candidate| candidate == path))
  }

  fn push_snapshot(&mut self) {
    self.snapshots.truncate(self.cursor + 1);
    self.snapshots.push(self.stage.clone());
    self.cursor = self.snapshots.len() - 1;
  }
}

struct ModelMutation {
  changed_paths: Vec<PathBuf>,
  warning_reasons: Vec<(PathBuf, StageWarningReason)>,
  expect_error: bool,
}

fn sort_model_warnings(mut warnings: Vec<(PathBuf, StageWarningReason)>) -> Vec<(PathBuf, StageWarningReason)> {
  warnings.sort_by(|left, right| left.0.cmp(&right.0));
  warnings
}

struct Lcg {
  state: u64,
}

impl Lcg {
  fn new(seed: u64) -> Self {
    Self { state: seed }
  }

  fn next_u64(&mut self) -> u64 {
    self.state = self
      .state
      .wrapping_mul(6364136223846793005)
      .wrapping_add(1442695040888963407);
    self.state
  }

  fn index(&mut self, len: usize) -> usize {
    (self.next_u64() as usize) % len
  }
}

fn child_named<'a>(node: &'a nafm_core::StorageNode, name: &str) -> &'a nafm_core::StorageNode {
  node
    .children
    .iter()
    .find(|child| child.name == name)
    .unwrap_or_else(|| panic!("missing child {name:?} under {:?}", node.name))
}

fn find_node<'a>(node: &'a nafm_core::StorageNode, id: &str) -> Option<&'a nafm_core::StorageNode> {
  if node.id == id {
    return Some(node);
  }
  node.children.iter().find_map(|child| find_node(child, id))
}

fn assert_storage_metrics_equal(left: &nafm_core::StorageNode, right: &nafm_core::StorageNode) {
  assert_eq!(left.id, right.id);
  assert_eq!(left.kind, right.kind);
  assert_eq!(left.total_bytes, right.total_bytes);
  assert_eq!(left.file_count, right.file_count);
  assert_eq!(left.duplicate_bytes, right.duplicate_bytes);
  assert_eq!(left.duplicate_file_count, right.duplicate_file_count);
  assert_eq!(left.space_health, right.space_health);
  assert_eq!(
    left.space_healthy_file_equivalents,
    right.space_healthy_file_equivalents
  );
  assert_eq!(left.space_total_files, right.space_total_files);
  assert_eq!(left.coverage_health, right.coverage_health);
  assert_eq!(left.coverage_covered_files, right.coverage_covered_files);
  assert_eq!(left.coverage_total_files, right.coverage_total_files);
}

fn assert_health(actual: Option<f64>, expected: f64) {
  let actual = actual.expect("health should be known");
  assert!(
    (actual - expected).abs() < 1e-9,
    "expected health {expected}, got {actual}"
  );
}

struct FirstByteHashAlgorithm;

impl HashAlgorithm for FirstByteHashAlgorithm {
  fn name(&self) -> &'static str {
    "first_byte"
  }

  fn new_hasher(&self) -> Box<dyn ContentHasher> {
    Box::new(FirstByteContentHasher(None))
  }
}

struct FirstByteContentHasher(Option<u8>);

impl ContentHasher for FirstByteContentHasher {
  fn update(&mut self, bytes: &[u8]) {
    if self.0.is_none() {
      self.0 = bytes.first().copied();
    }
  }

  fn finalize(self: Box<Self>) -> String {
    self.0.unwrap_or_default().to_string()
  }
}

struct SlowHashAlgorithm {
  current: Arc<AtomicUsize>,
  max: Arc<AtomicUsize>,
  delay: Duration,
}

impl HashAlgorithm for SlowHashAlgorithm {
  fn name(&self) -> &'static str {
    "slow_hash"
  }

  fn new_hasher(&self) -> Box<dyn ContentHasher> {
    Box::new(ByteCountContentHasher(0))
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

    std::thread::sleep(self.delay);
    let bytes = fs::read(path)?;
    self.current.fetch_sub(1, Ordering::SeqCst);
    Ok(bytes.len().to_string())
  }
}

struct CancellingHashAlgorithm {
  rendezvous: Arc<std::sync::Barrier>,
  cancelled: Arc<std::sync::atomic::AtomicBool>,
  active: Arc<AtomicUsize>,
  completed: Arc<AtomicUsize>,
  drain_delay: Duration,
}

struct ChunkCancellationHashAlgorithm {
  hashing_started: Arc<AtomicBool>,
}

impl HashAlgorithm for ChunkCancellationHashAlgorithm {
  fn name(&self) -> &'static str {
    "instrumented_blake3"
  }

  fn new_hasher(&self) -> Box<dyn ContentHasher> {
    Blake3HashAlgorithm.new_hasher()
  }

  fn hash_file_with_cancellation(
    &self,
    path: &Path,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
  ) -> nafm_core::Result<String> {
    self.hashing_started.store(true, Ordering::SeqCst);
    Blake3HashAlgorithm.hash_file_with_cancellation(path, is_cancelled)
  }
}

struct OverrideTrackingHashAlgorithm {
  hash_file_calls: Arc<AtomicUsize>,
}

impl HashAlgorithm for OverrideTrackingHashAlgorithm {
  fn name(&self) -> &'static str {
    "override_tracking"
  }

  fn new_hasher(&self) -> Box<dyn ContentHasher> {
    Box::new(ByteCountContentHasher(0))
  }

  fn hash_file(&self, path: &Path) -> nafm_core::Result<String> {
    self.hash_file_calls.fetch_add(1, Ordering::SeqCst);
    Ok(fs::metadata(path)?.len().to_string())
  }
}

impl HashAlgorithm for CancellingHashAlgorithm {
  fn name(&self) -> &'static str {
    "cancelling_hash"
  }

  fn new_hasher(&self) -> Box<dyn ContentHasher> {
    Box::new(ByteCountContentHasher(0))
  }

  fn hash_file(&self, path: &Path) -> nafm_core::Result<String> {
    self.active.fetch_add(1, Ordering::SeqCst);
    self.rendezvous.wait();

    if path.file_name().is_some_and(|name| name == "cancel.bin") {
      self.cancelled.store(true, Ordering::SeqCst);
    } else {
      std::thread::sleep(self.drain_delay);
    }

    self.active.fetch_sub(1, Ordering::SeqCst);
    self.completed.fetch_add(1, Ordering::SeqCst);
    Ok(fs::metadata(path)?.len().to_string())
  }
}

struct ByteCountContentHasher(u64);

impl ContentHasher for ByteCountContentHasher {
  fn update(&mut self, bytes: &[u8]) {
    self.0 += bytes.len() as u64;
  }

  fn finalize(self: Box<Self>) -> String {
    self.0.to_string()
  }
}
