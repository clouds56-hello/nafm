use nafm_core::{AddSiteFolderRequest, FolderSimilarityPage, HiddenPolicy, Repository, RepositoryOptions};
use rusqlite::params;
use std::{fs, path::PathBuf};

struct Fixture {
  directory: tempfile::TempDir,
  repo: Repository,
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
    Self { directory, repo }
  }

  async fn folder(&self, name: &str, files: &[(&str, &str)]) -> (String, String, PathBuf) {
    let site = self.repo.create_site(name).await.unwrap();
    let directory = self.directory.path().join(name);
    fs::create_dir(&directory).unwrap();
    for (path, contents) in files {
      let path = directory.join(path);
      fs::create_dir_all(path.parent().unwrap()).unwrap();
      fs::write(path, contents).unwrap();
    }
    let folder = self
      .repo
      .add_site_folder(
        name,
        AddSiteFolderRequest {
          path: directory.clone(),
          hidden_policy: HiddenPolicy::Include,
        },
      )
      .await
      .unwrap();
    self.repo.scan_site(name).await.unwrap();
    (site.id, format!("site_folder:{}", folder.id), folder.path)
  }

  async fn search(&self, source: &(String, String, PathBuf)) -> FolderSimilarityPage {
    self.repo.folder_similarity(&source.0, &source.1, 0, 50).await.unwrap()
  }
}

#[tokio::test]
async fn renamed_reorganized_and_repeated_files_have_identical_distinct_content() {
  let fixture = Fixture::new().await;
  let source = fixture
    .folder("source", &[("a", "alpha"), ("b", "beta"), ("copy/a", "alpha")])
    .await;
  let target = fixture
    .folder("target", &[("renamed/deeper/x", "beta"), ("elsewhere/y", "alpha")])
    .await;
  let result = fixture.search(&source).await;
  assert_eq!(result.source.extra_copy_count, 1);
  assert_eq!(result.source.distinct_content_count, 2);
  assert_eq!(result.source.distinct_bytes, 9);
  let matched = result
    .matches
    .iter()
    .find(|matched| matched.folder.node_id == target.1)
    .unwrap();
  assert_eq!(matched.similarity, 100.0);
  assert!(matched.identical_content);
  assert!(!matched.partial);
  assert_eq!((matched.source_coverage, matched.target_coverage), (100.0, 100.0));
  assert!(result.matches.iter().all(|matched| matched.folder.site_id != source.0));
}

#[tokio::test]
async fn containment_is_directional_and_similarity_uses_union_bytes() {
  let fixture = Fixture::new().await;
  let source = fixture.folder("source", &[("a", "aaaa")]).await;
  let target = fixture.folder("target", &[("x", "aaaa"), ("y", "bbbbbbbbbbbb")]).await;
  let page = fixture.search(&source).await;
  let matched = page
    .matches
    .iter()
    .find(|matched| matched.folder.node_id == target.1)
    .unwrap();
  assert_eq!(matched.similarity, 25.0);
  assert_eq!(matched.source_coverage, 100.0);
  assert_eq!(matched.target_coverage, 25.0);
  assert_eq!((matched.source_only_bytes, matched.target_only_bytes), (0, 12));
  assert!(!matched.identical_content);
}

#[tokio::test]
async fn stale_hashes_and_invalidated_inventories_never_claim_complete_matches() {
  let fixture = Fixture::new().await;
  let source = fixture.folder("source", &[("a", "alpha"), ("b", "beta")]).await;
  let target = fixture.folder("target", &[("x", "alpha"), ("y", "beta")]).await;
  let conn = rusqlite::Connection::open(fixture.repo.db_path()).unwrap();
  conn
    .execute(
      "update file_records set hash_revision = null where site_id = ?1 and path = ?2",
      params![target.0, target.2.join("y").to_string_lossy()],
    )
    .unwrap();
  let page = fixture.search(&source).await;
  let matched = page
    .matches
    .iter()
    .find(|matched| matched.folder.node_id == target.1)
    .unwrap();
  assert!(matched.partial);
  assert!(!matched.identical_content);
  assert_eq!(matched.shared_content_count, 1);
  assert_eq!(page.workspace_pending_hash_count, 1);
  conn
    .execute(
      "update site_scan_state set inventory_completed_at = null where site_id = ?1",
      [&target.0],
    )
    .unwrap();
  let page = fixture.search(&source).await;
  assert!(page.matches.is_empty());
  assert_eq!(page.workspace_incomplete_site_count, 1);
  assert_eq!(page.workspace_pending_hash_count, 2);
}

#[tokio::test]
async fn empty_files_use_count_fallback_but_empty_folders_have_no_score() {
  let fixture = Fixture::new().await;
  let empty = fixture.folder("empty", &[]).await;
  assert!(fixture.search(&empty).await.matches.is_empty());
  let source = fixture.folder("source", &[("zero", "")]).await;
  let target = fixture.folder("target", &[("renamed", ""), ("copy", "")]).await;
  let page = fixture.search(&source).await;
  assert_eq!(page.matches.len(), 1);
  assert_eq!(page.matches[0].folder.node_id, target.1);
  assert_eq!(page.matches[0].similarity, 100.0);
  assert!(page.matches[0].identical_content);
  assert_eq!(page.matches[0].folder.extra_copy_count, 1);
}

#[tokio::test]
async fn pagination_is_bounded_stable_and_rejects_file_nodes() {
  let fixture = Fixture::new().await;
  let source = fixture.folder("source", &[("a", "shared")]).await;
  for name in ["one", "two", "three"] {
    fixture.folder(name, &[("a", "shared")]).await;
  }
  let all = fixture.search(&source).await;
  let first = fixture
    .repo
    .folder_similarity(&source.0, &source.1, 0, 1)
    .await
    .unwrap();
  let second = fixture
    .repo
    .folder_similarity(&source.0, &source.1, 1, 1)
    .await
    .unwrap();
  assert_eq!(first.total_matches, 3);
  assert_eq!(first.matches[0].folder.node_id, all.matches[0].folder.node_id);
  assert_eq!(second.matches[0].folder.node_id, all.matches[1].folder.node_id);
  let beyond = fixture
    .repo
    .folder_similarity(&source.0, &source.1, u64::MAX, u64::MAX)
    .await
    .unwrap();
  assert!(beyond.matches.is_empty());
  assert_eq!(beyond.limit, 50);
  assert!(
    fixture
      .repo
      .folder_similarity(&source.0, "not-a-folder", 0, 10)
      .await
      .is_err()
  );
}

#[tokio::test]
async fn hash_algorithms_are_part_of_content_identity() {
  let fixture = Fixture::new().await;
  let source = fixture.folder("source", &[("a", "same")]).await;
  let target = fixture.folder("target", &[("b", "same")]).await;
  let conn = rusqlite::Connection::open(fixture.repo.db_path()).unwrap();
  conn
    .execute(
      "update file_records set hash_algorithm = 'other' where site_id = ?1",
      [&target.0],
    )
    .unwrap();
  conn
    .execute(
      "update site_scan_state set hash_algorithm = 'other' where site_id = ?1",
      [&target.0],
    )
    .unwrap();
  assert!(fixture.search(&source).await.matches.is_empty());
}

#[tokio::test]
async fn smb_urls_and_same_site_sibling_folders_compare_without_network_access() {
  let fixture = Fixture::new().await;
  let original = fixture
    .folder("nas", &[("one/a", "same"), ("two/renamed", "same")])
    .await;
  let conn = rusqlite::Connection::open(fixture.repo.db_path()).unwrap();
  let root_id = original.1.strip_prefix("site_folder:").unwrap();
  conn
    .execute(
      "update site_folders set kind = 'smb', path = 'smb://nas/Media' where id = ?1",
      [root_id],
    )
    .unwrap();
  for (old, new) in [("one/a", "one/a"), ("two/renamed", "two%20space/renamed")] {
    conn
      .execute(
        "update file_records set path = ?1 where site_id = ?2 and path = ?3",
        params![
          format!("smb://nas/Media/{new}"),
          original.0,
          original.2.join(old).to_string_lossy()
        ],
      )
      .unwrap();
  }
  let node_id = format!("storage:{root_id}:smb://nas/Media/one");
  let result = fixture
    .repo
    .folder_similarity(&original.0, &node_id, 0, 10)
    .await
    .unwrap();
  assert_eq!(result.matches.len(), 1);
  assert_eq!(
    result.matches[0].folder.path.to_string_lossy(),
    "smb://nas/Media/two%20space"
  );
  assert!(result.matches[0].identical_content);
}

#[tokio::test]
async fn overlapping_registered_roots_do_not_hide_recursive_contents() {
  let fixture = Fixture::new().await;
  let source = fixture
    .folder("source", &[("nested/a", "alpha"), ("nested/b", "beta")])
    .await;
  let target = fixture.folder("target", &[("x", "alpha"), ("y", "beta")]).await;
  fixture
    .repo
    .add_site_folder(
      "source",
      AddSiteFolderRequest {
        path: source.2.join("nested"),
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  fixture.repo.scan_site("source").await.unwrap();
  let page = fixture.search(&source).await;
  assert_eq!(page.source.file_count, 2);
  assert_eq!(page.source.distinct_content_count, 2);
  assert!(
    page
      .matches
      .iter()
      .find(|matched| matched.folder.node_id == target.1)
      .unwrap()
      .identical_content
  );
  let reverse = fixture.search(&target).await;
  let paths = reverse
    .matches
    .iter()
    .map(|matched| &matched.folder.path)
    .collect::<std::collections::BTreeSet<_>>();
  assert_eq!(paths.len(), reverse.matches.len());
}

#[tokio::test]
async fn mixed_local_and_smb_roots_do_not_parse_local_paths_as_urls() {
  let fixture = Fixture::new().await;
  let source = fixture.folder("mixed", &[("one", "same")]).await;
  let remote = fixture.directory.path().join("remote");
  fs::create_dir(&remote).unwrap();
  fs::write(remote.join("two"), "same").unwrap();
  let folder = fixture
    .repo
    .add_site_folder(
      "mixed",
      AddSiteFolderRequest {
        path: remote,
        hidden_policy: HiddenPolicy::Include,
      },
    )
    .await
    .unwrap();
  fixture.repo.scan_site("mixed").await.unwrap();
  let conn = rusqlite::Connection::open(fixture.repo.db_path()).unwrap();
  conn
    .execute(
      "update site_folders set kind = 'smb', path = 'smb://nas/Media' where id = ?1",
      [&folder.id],
    )
    .unwrap();
  conn
    .execute(
      "update file_records set path = 'smb://nas/Media/two' where site_folder_id = ?1",
      [&folder.id],
    )
    .unwrap();
  let page = fixture.search(&source).await;
  assert_eq!(page.matches.len(), 1);
  assert!(page.matches[0].identical_content);
  assert_eq!(page.matches[0].folder.path.to_string_lossy(), "smb://nas/Media");
}
