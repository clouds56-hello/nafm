use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use nafm_core::{
  AddSiteFolderRequest, ContentHasher, CredentialStore, HashAlgorithm, HiddenPolicy, Repository, RepositoryOptions,
  ScanEvent, SiteFolderKind, StageWarningReason,
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
async fn adds_smb_site_folder_with_saved_credentials() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://OMV.lan/Media/", "alice", "secret")
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
  repo.create_site("omv").await.unwrap();

  let folder = repo
    .add_site_folder(
      "omv",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://omv.lan/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();

  assert_eq!(folder.kind, SiteFolderKind::Smb);
  assert_eq!(folder.path, PathBuf::from("smb://omv.lan/Media"));
  assert_eq!(
    repo.list_site_folders(Some("omv")).await.unwrap()[0].kind,
    SiteFolderKind::Smb
  );
}

#[tokio::test]
async fn adds_nested_smb_site_folder_with_share_credentials() {
  let cache = tempfile::tempdir().unwrap();
  let credentials_root = tempfile::tempdir().unwrap();
  let credential_store = CredentialStore::new(credentials_root.path().join("nafm"));
  credential_store
    .save_smb_credential("smb://nas.example.test/share", "alice", "secret")
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
  repo.create_site("omv").await.unwrap();

  let folder = repo
    .add_site_folder(
      "omv",
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
  repo.create_site("omv").await.unwrap();

  let error = repo
    .add_site_folder(
      "omv",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://omv.lan/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap_err();

  assert_eq!(
    error.to_string(),
    "no saved credentials for SMB location: smb://omv.lan/Media"
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
    .save_smb_credential("smb://omv.lan/Media", "alice", "secret")
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
  let site = repo.create_site("omv").await.unwrap();
  let folder = repo
    .add_site_folder(
      "omv",
      AddSiteFolderRequest {
        path: PathBuf::from("smb://omv.lan/Media"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  let conn = rusqlite::Connection::open(repo.db_path()).unwrap();
  for (id, path) in [
    ("file-1", "smb://omv.lan/Media/a.mp4"),
    ("file-2", "smb://omv.lan/Media/b.mp4"),
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
    .stage_add_path(Path::new("smb://omv.lan/Media/a.mp4"))
    .await
    .unwrap();
  assert_eq!(added.staged_files.len(), 1);
  assert_eq!(added.staged_files[0].path, PathBuf::from("smb://omv.lan/Media/a.mp4"));

  let removed = repo
    .stage_remove_path(Path::new("smb://omv.lan/Media/a.mp4"))
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

struct ByteCountContentHasher(u64);

impl ContentHasher for ByteCountContentHasher {
  fn update(&mut self, bytes: &[u8]) {
    self.0 += bytes.len() as u64;
  }

  fn finalize(self: Box<Self>) -> String {
    self.0.to_string()
  }
}
