use super::*;
use crate::{FolderContentSummary, FolderSimilarityAnchor, FolderSimilarityMatch, FolderSimilarityPage};
use std::time::Instant;

struct Bucket {
  summary: FolderContentSummary,
  contents: BTreeSet<StorageContentKey>,
}

impl Bucket {
  fn new(site: &Site, node_id: String, path: PathBuf, inventory_ready: bool) -> Self {
    Self {
      summary: FolderContentSummary {
        site_id: site.id.clone(),
        site_name: site.name.clone(),
        node_id,
        path,
        file_count: 0,
        verified_file_count: 0,
        pending_hash_count: 0,
        distinct_content_count: 0,
        distinct_bytes: 0,
        extra_copy_count: 0,
        inventory_ready,
      },
      contents: BTreeSet::new(),
    }
  }

  fn add(&mut self, content: Option<&StorageContentKey>) {
    self.summary.file_count += 1;
    if let Some(content) = content {
      self.summary.verified_file_count += 1;
      if self.contents.insert(content.clone()) {
        self.summary.distinct_content_count += 1;
        self.summary.distinct_bytes = self.summary.distinct_bytes.saturating_add(content.size_bytes);
      } else {
        self.summary.extra_copy_count += 1;
      }
    } else {
      self.summary.pending_hash_count += 1;
    }
  }
}

/// Compare a single source against folder aggregates, never all folder pairs.
/// One read transaction keeps discovery revisions and hashes from different scans apart.
pub(super) fn search(
  conn: &Connection,
  site_id: &str,
  node_id: &str,
  offset: u64,
  limit: u64,
  anchor: Option<&FolderSimilarityAnchor>,
) -> Result<FolderSimilarityPage> {
  let started = Instant::now();
  let mut memberships = 0;
  let mut folders = BTreeMap::<(String, String), Bucket>::new();
  let mut workspace_pending_hash_count = 0;
  let mut workspace_incomplete_site_count = 0;
  for site in list_sites(conn)? {
    let inventory_ready = site_published_inventory_revision(conn, &site.id)?.is_some();
    if !inventory_ready {
      workspace_incomplete_site_count += 1;
    }
    let roots = list_site_folders(conn, Some(&site.id))?
      .into_iter()
      .map(|folder| (folder.id.clone(), folder))
      .collect::<BTreeMap<_, _>>();
    for root in roots.values() {
      let id = format!("site_folder:{}", root.id);
      folders.insert(
        (site.id.clone(), id.clone()),
        Bucket::new(&site, id, root.path.clone(), inventory_ready),
      );
    }
    let mut statement = conn.prepare(
      "select file.site_folder_id, file.path, file.size_bytes, file.hash_algorithm, file.content_hash,
       coalesce(state.inventory_completed_at is not null and file.inventory_revision = state.inventory_revision
         and file.hash_revision = file.inventory_revision and file.hash_algorithm = state.hash_algorithm
         and file.content_hash is not null, false)
       from file_records file left join site_scan_state state on state.site_id = file.site_id
       where file.site_id = ?1",
    )?;
    let mut rows = statement.query([&site.id])?;
    while let Some(row) = rows.next()? {
      if started.elapsed() > Duration::from_secs(10) {
        return Err(NafmError::FolderSimilarityLimit);
      }
      let path = PathBuf::from(row.get::<_, String>(1)?);
      let root_id: String = row.get(0)?;
      let Some(owner) = roots.get(&root_id) else { continue };
      let verified: bool = row.get(5)?;
      if !verified {
        workspace_pending_hash_count += 1;
      }
      let content = if verified {
        Some(StorageContentKey {
          size_bytes: row.get(2)?,
          hash_algorithm: row.get(3)?,
          content_hash: row.get(4)?,
        })
      } else {
        None
      };
      // Scans assign a file to only one registered root. Physical folder contents
      // still include files owned by a nested root, so aggregate every containing root.
      for root in roots.values() {
        if root.kind != owner.kind {
          continue;
        }
        if root.kind == SiteFolderKind::Local && !path.starts_with(&root.path) {
          continue;
        }
        let segments = storage_relative_segments(root, &path)?;
        // Each indexed file contributes to its containing directories, never to a file-shaped candidate.
        for depth in 0..segments.len() {
          memberships += 1;
          if memberships > 1_000_000 || started.elapsed() > Duration::from_secs(10) {
            return Err(NafmError::FolderSimilarityLimit);
          }
          let directory = storage_child_path(root, &segments[..depth])?;
          let id = if depth == 0 {
            format!("site_folder:{}", root.id)
          } else {
            format!("storage:{}:{}", root.id, directory.display())
          };
          folders
            .entry((site.id.clone(), id.clone()))
            .or_insert_with(|| Bucket::new(&site, id, directory, inventory_ready))
            .add(content.as_ref());
        }
      }
    }
  }
  let source = folders
    .get(&(site_id.to_owned(), node_id.to_owned()))
    .ok_or_else(|| NafmError::StorageNodeNotFound(node_id.into()))?;
  let mut matches = Vec::new();
  let mut matched_paths = BTreeSet::new();
  for target in folders.values() {
    if started.elapsed() > Duration::from_secs(10) {
      return Err(NafmError::FolderSimilarityLimit);
    }
    // Avoid trivial self/ancestor/descendant matches within one site, including overlapping roots.
    if source.summary.site_id == target.summary.site_id
      && (source.summary.path.starts_with(&target.summary.path)
        || target.summary.path.starts_with(&source.summary.path))
    {
      continue;
    }
    if let Some(result) = compare(source, target)
      && matched_paths.insert((result.folder.site_id.clone(), result.folder.path.clone()))
    {
      matches.push(result);
    }
  }
  matches.sort_by(|left, right| {
    right
      .similarity
      .total_cmp(&left.similarity)
      .then_with(|| right.shared_bytes.cmp(&left.shared_bytes))
      .then_with(|| left.folder.site_id.cmp(&right.folder.site_id))
      .then_with(|| left.folder.node_id.cmp(&right.folder.node_id))
  });
  let total_matches = matches.len() as u64;
  let limit = limit.clamp(1, 50);
  let offset = anchor
    .and_then(|anchor| {
      matches
        .iter()
        .position(|item| item.folder.site_id == anchor.site_id && item.folder.node_id == anchor.node_id)
    })
    .map_or(offset, |index| index as u64 / limit * limit);
  Ok(FolderSimilarityPage {
    source: source.summary.clone(),
    matches: matches
      .into_iter()
      .skip(usize::try_from(offset).unwrap_or(usize::MAX))
      .take(limit as usize)
      .collect(),
    total_matches,
    offset,
    limit,
    workspace_pending_hash_count,
    workspace_incomplete_site_count,
    generated_at: Utc::now(),
  })
}

fn percent(shared_bytes: u64, total_bytes: u64, shared_count: u64, total_count: u64) -> f64 {
  if total_bytes > 0 {
    100.0 * shared_bytes as f64 / total_bytes as f64
  } else if total_count > 0 {
    100.0 * shared_count as f64 / total_count as f64
  } else {
    0.0
  }
}

fn compare(source: &Bucket, target: &Bucket) -> Option<FolderSimilarityMatch> {
  let mut shared_content_count = 0;
  let mut shared_bytes = 0_u64;
  let (smaller, larger) = if source.contents.len() < target.contents.len() {
    (&source.contents, &target.contents)
  } else {
    (&target.contents, &source.contents)
  };
  for key in smaller.iter().filter(|key| larger.contains(*key)) {
    shared_content_count += 1;
    shared_bytes = shared_bytes.saturating_add(key.size_bytes);
  }
  if shared_content_count == 0 {
    return None;
  }
  let a = &source.summary;
  let b = &target.summary;
  let union_bytes = a
    .distinct_bytes
    .saturating_add(b.distinct_bytes)
    .saturating_sub(shared_bytes);
  let union_count = a.distinct_content_count + b.distinct_content_count - shared_content_count;
  let partial = !a.inventory_ready || !b.inventory_ready || a.pending_hash_count > 0 || b.pending_hash_count > 0;
  Some(FolderSimilarityMatch {
    folder: b.clone(),
    similarity: percent(shared_bytes, union_bytes, shared_content_count, union_count),
    source_coverage: percent(
      shared_bytes,
      a.distinct_bytes,
      shared_content_count,
      a.distinct_content_count,
    ),
    target_coverage: percent(
      shared_bytes,
      b.distinct_bytes,
      shared_content_count,
      b.distinct_content_count,
    ),
    shared_content_count,
    shared_bytes,
    source_only_count: a.distinct_content_count - shared_content_count,
    target_only_count: b.distinct_content_count - shared_content_count,
    source_only_bytes: a.distinct_bytes.saturating_sub(shared_bytes),
    target_only_bytes: b.distinct_bytes.saturating_sub(shared_bytes),
    partial,
    identical_content: !partial && source.contents == target.contents,
  })
}
