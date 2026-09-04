use super::*;

struct Fixture {
  _directory: tempfile::TempDir,
  conn: Connection,
  site: Site,
  folders: Vec<SiteFolder>,
  files: Vec<FileProbe>,
}

impl Fixture {
  async fn new() -> Self {
    let directory = tempfile::tempdir().unwrap();
    let repo = Repository::open(RepositoryOptions {
      cache_path: directory.path().join("index.sqlite3"),
      hash_algorithm: None,
    })
    .await
    .unwrap();
    let site = repo.create_site("smb").await.unwrap();
    let conn = open_connection(repo.db_path()).unwrap();
    conn.execute("insert into site_folders (id, site_id, kind, path, hidden_policy, added_at) values ('folder', ?1, 'smb', 'smb://nas/share', 'include', ?2)", params![site.id, Utc::now()]).unwrap();
    let folders = list_site_folders(&conn, Some(&site.id)).unwrap();
    let files = ["a", "b"]
      .into_iter()
      .map(|name| FileProbe {
        site_folder_id: "folder".into(),
        path: PathBuf::from(format!("smb://nas/share/{name}")),
        size_bytes: 4,
        modified_unix_nanos: 1_700_000_000_000_000_000,
        source: FileSource::Smb {
          credential_url: "smb://nas/share".into(),
          remote_path: name.into(),
        },
      })
      .collect();
    Self {
      _directory: directory,
      conn,
      site,
      folders,
      files,
    }
  }

  fn publish(&self) -> ScanPreparation {
    let revision = self
      .conn
      .query_row(
        "select inventory_revision from site_scan_state where site_id = ?1",
        [&self.site.id],
        |row| row.get::<_, u64>(0),
      )
      .optional()
      .unwrap()
      .unwrap_or(0);
    publish_inventory_atomically(
      &self.conn,
      &self.site,
      &self.folders,
      revision,
      self.files.clone(),
      "blake3",
      Utc::now(),
    )
    .unwrap()
  }

  fn hash(&self, preparation: &ScanPreparation, count: usize) {
    for (_, file) in preparation.hash_targets.iter().take(count) {
      publish_hashed_file(
        &self.conn,
        &self.site.id,
        preparation.inventory_revision,
        file,
        "blake3",
        "verified-digest",
      )
      .unwrap();
    }
  }
}

#[tokio::test]
async fn smb_completed_rescan_reuses_unchanged_hashes() {
  let fixture = Fixture::new().await;
  let first = fixture.publish();
  fixture.hash(&first, 2);
  finalize_site_scan(
    &fixture.conn,
    &fixture.site,
    first.inventory_revision,
    "blake3",
    Utc::now(),
  )
  .unwrap();
  let next = fixture.publish();
  assert_eq!((next.files_reused, next.files_hashed), (2, 0));
  assert_eq!(
    pending_hash_count(&fixture.conn, &fixture.site.id, next.inventory_revision).unwrap(),
    0
  );
}

#[tokio::test]
async fn smb_interrupted_scan_keeps_completed_work_across_repeated_resumes() {
  let fixture = Fixture::new().await;
  let first = fixture.publish();
  fixture.hash(&first, 1); // Cancellation leaves the second file pending.
  let resumed = fixture.publish();
  assert_eq!((resumed.files_reused, resumed.files_hashed), (1, 1));
  let resumed_again = fixture.publish();
  assert_eq!((resumed_again.files_reused, resumed_again.files_hashed), (1, 1));
  fixture.hash(&resumed_again, 1);
  assert_eq!(fixture.publish().files_reused, 2);
}

#[tokio::test]
async fn smb_legacy_resume_cache_is_reused() {
  let fixture = Fixture::new().await;
  let file = &fixture.files[0];
  fixture.conn.execute("insert into scan_cache_entries (site_id, site_folder_id, path, size_bytes, modified_unix_nanos, hash_algorithm, content_hash, cached_at) values (?1, ?2, ?3, ?4, ?5, 'blake3', 'cached-digest', ?6)", params![fixture.site.id, file.site_folder_id, file.path.to_string_lossy(), file.size_bytes, file.modified_unix_nanos, Utc::now()]).unwrap();
  let next = fixture.publish();
  assert_eq!((next.files_reused, next.files_hashed), (1, 1));
}

#[tokio::test]
async fn smb_changed_metadata_and_unknown_timestamps_require_hashing() {
  for change in ["size", "timestamp", "unknown"] {
    let mut fixture = Fixture::new().await;
    if change == "unknown" {
      fixture.files[0].modified_unix_nanos = 0;
    }
    let first = fixture.publish();
    fixture.hash(&first, 2);
    match change {
      "size" => fixture.files[0].size_bytes += 1,
      "timestamp" => fixture.files[0].modified_unix_nanos += 100,
      _ => {}
    }
    let next = fixture.publish();
    assert_eq!((next.files_reused, next.files_hashed), (1, 1), "{change}");
    // A second scan must not turn a retained stale digest into a verified hash.
    assert_eq!(fixture.publish().files_hashed, 1);
  }
}

#[tokio::test]
async fn smb_reuse_does_not_bypass_source_algorithm_or_verification_checks() {
  for assignment in [
    "hash_source_key = 'different-remote-mapping'",
    "hash_algorithm = 'other'",
    "hash_revision = null",
  ] {
    let fixture = Fixture::new().await;
    let first = fixture.publish();
    fixture.hash(&first, 2);
    fixture
      .conn
      .execute(&format!("update file_records set {assignment}"), [])
      .unwrap();
    assert_eq!(fixture.publish().files_reused, 0, "{assignment}");
  }
}
