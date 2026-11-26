use std::collections::btree_map::Entry;

use super::*;

struct Comparison<'a> {
  target: &'a Site,
  revision: u64,
}

impl<'a> Comparison<'a> {
  fn read(conn: &Connection, source: &Site, target: Option<&'a Site>) -> Result<Option<Self>> {
    let Some(target) = target else { return Ok(None) };
    let source_algorithm = site_inventory_hash_algorithm(conn, &source.id)?;
    if source_algorithm.is_none() || source_algorithm != site_inventory_hash_algorithm(conn, &target.id)? {
      return Ok(None);
    }
    Ok(site_published_inventory_revision(conn, &target.id)?.map(|revision| Self { target, revision }))
  }
}

struct ContentStats {
  copies: u64,
  first_path: String,
  covered: Option<bool>,
}

/// Build only the parent and its immediate entries from the transaction's published inventory.
pub(super) fn read(
  conn: &Connection,
  site: &Site,
  coverage_target: Option<&Site>,
  node_id: &str,
) -> Result<Option<StorageNodeBuilder>> {
  let site_node_id = format!("site:{}", site.id);
  let analysis_ready = site_has_completed_scan(conn, &site.id)?;
  let comparison = Comparison::read(conn, site, coverage_target)?;
  let coverage_ready = match &comparison {
    Some(comparison) if analysis_ready => site_has_completed_scan(conn, &comparison.target.id)?,
    _ => false,
  };

  if node_id == site_node_id {
    let mut root = site_root(conn, site, comparison.as_ref(), site_node_id)?;
    root.set_analysis_ready(analysis_ready, coverage_ready);
    return Ok(Some(root));
  }

  let (root_id, path) = if let Some(id) = node_id.strip_prefix("site_folder:") {
    (id, None)
  } else if let Some((id, path)) = node_id.strip_prefix("storage:").and_then(|id| id.split_once(':')) {
    (id, Some(path))
  } else {
    return Ok(None);
  };
  let Some(folder) = find_site_folder(conn, root_id)?.filter(|folder| folder.site_id == site.id) else {
    return Ok(None);
  };
  let (mut parent, parent_segments) = match path {
    Some(path) => {
      let Ok(segments) = storage_relative_segments(&folder, Path::new(path)) else {
        return Ok(None);
      };
      let Some(name) = segments.last() else { return Ok(None) };
      if storage_child_path(&folder, &segments)?.as_os_str() != Path::new(path).as_os_str() {
        return Ok(None);
      }
      let builder = StorageNodeBuilder::new(
        node_id.to_owned(),
        name.clone(),
        Some(path.into()),
        StorageNodeKind::Directory,
      );
      (builder, segments)
    }
    None => (registered_root(&folder), Vec::new()),
  };

  if path.is_none() && only_registered_root(conn, &folder)? {
    // This root covers the entire site's inventory. Group content in bulk, then project the first level.
    for file in site_files(conn, site, comparison.as_ref())? {
      if file.site_folder_id != folder.id {
        continue;
      }
      let segments = storage_relative_segments(&folder, &file.path)?;
      if !segments.is_empty() {
        add_immediate_file(&mut parent, &folder, &segments, 0, &file.metrics)?;
      }
    }
  } else {
    read_folder(
      conn,
      &folder,
      &parent_segments,
      &mut parent,
      analysis_ready,
      comparison.as_ref(),
    )?;
  }
  if path.is_some() && parent.file_count == 0 {
    return Ok(None);
  }
  parent.set_analysis_ready(analysis_ready, coverage_ready);
  Ok(Some(parent))
}

fn registered_root(folder: &SiteFolder) -> StorageNodeBuilder {
  StorageNodeBuilder::new(
    format!("site_folder:{}", folder.id),
    storage_root_name(folder),
    Some(folder.path.clone()),
    match folder.kind {
      SiteFolderKind::Local => StorageNodeKind::LocalRoot,
      SiteFolderKind::Smb => StorageNodeKind::SmbRoot,
    },
  )
}

fn site_root(
  conn: &Connection,
  site: &Site,
  comparison: Option<&Comparison<'_>>,
  node_id: String,
) -> Result<StorageNodeBuilder> {
  let folders = list_site_folders(conn, Some(&site.id))?
    .into_iter()
    .map(|folder| (folder.id.clone(), folder))
    .collect::<BTreeMap<_, _>>();
  let mut root = StorageNodeBuilder::new(node_id, site.name.clone(), None, StorageNodeKind::Site);
  for (id, folder) in &folders {
    root.children.insert(id.clone(), registered_root(folder));
  }
  for file in site_files(conn, site, comparison)? {
    let Some(folder) = folders.get(&file.site_folder_id) else {
      continue;
    };
    if storage_relative_segments(folder, &file.path)?.is_empty() {
      continue;
    }
    root.add_file_metrics(&file.metrics);
    root
      .children
      .get_mut(&folder.id)
      .expect("site root should exist")
      .add_file_metrics(&file.metrics);
  }
  Ok(root)
}

fn only_registered_root(conn: &Connection, folder: &SiteFolder) -> Result<bool> {
  Ok(conn.query_row(
    "select not exists(select 1 from site_folders where site_id = ?1 and id <> ?2)",
    params![folder.site_id, folder.id],
    |row| row.get(0),
  )?)
}

fn site_files(conn: &Connection, site: &Site, comparison: Option<&Comparison<'_>>) -> Result<Vec<StorageFileRecord>> {
  let target_keys = comparison
    .map(|comparison| storage_content_keys(conn, &comparison.target.id))
    .transpose()?;
  storage_file_records(conn, &site.id, target_keys.as_ref())
}

fn read_folder(
  conn: &Connection,
  folder: &SiteFolder,
  parent_segments: &[String],
  parent: &mut StorageNodeBuilder,
  analysis_ready: bool,
  comparison: Option<&Comparison<'_>>,
) -> Result<()> {
  let revision = site_published_inventory_revision(conn, &folder.site_id)?;
  let fields = "select path, size_bytes, modified_unix_nanos, hash_algorithm, content_hash,
      coalesce(inventory_revision = ?3 and hash_revision = inventory_revision and content_hash is not null, false)
    from file_records where site_folder_id = ?1 and site_id = ?2";
  let mut statement;
  let mut rows = if !parent_segments.is_empty() {
    let path = parent
      .path
      .as_deref()
      .expect("nested node should have a path")
      .to_string_lossy();
    // A binary range on the native separator or the escaped SMB URL separator excludes siblings.
    let separator = if folder.kind == SiteFolderKind::Smb {
      '/'
    } else {
      std::path::MAIN_SEPARATOR
    };
    let first = format!("{path}{separator}");
    let end = format!("{path}{}", char::from(separator as u8 + 1));
    statement = conn.prepare(&format!(
      "{fields} and path = ?4 union all {fields} and path >= ?5 and path < ?6 order by path",
    ))?;
    statement.query(params![folder.id, folder.site_id, revision, path, first, end])?
  } else {
    statement = conn.prepare(&format!("{fields} order by path"))?;
    statement.query(params![folder.id, folder.site_id, revision])?
  };

  let live_content = "from file_records where site_id = ?1 and inventory_revision = ?2
    and hash_algorithm = ?3 and content_hash = ?4 and size_bytes = ?5
    and content_hash is not null and hash_revision = inventory_revision";
  let mut source = conn.prepare(&format!("select count(*), min(path) {live_content}"))?;
  let mut target = comparison
    .map(|_| conn.prepare(&format!("select exists (select 1 {live_content})")))
    .transpose()?;
  let mut content_stats = BTreeMap::<StorageContentKey, ContentStats>::new();
  while let Some(row) = rows.next()? {
    let stored_path: String = row.get(0)?;
    let segments = storage_relative_segments(folder, Path::new(&stored_path))?;
    if !segments.starts_with(parent_segments) || segments.is_empty() {
      continue;
    }

    let size_bytes = row.get(1)?;
    let modified = row.get(2)?;
    let hash_verified = row.get(5)?;
    let mut file = StorageFileMetrics {
      size_bytes,
      modified_unix_nanos: (folder.kind != SiteFolderKind::Smb || modified != 0).then_some(modified),
      hash_verified,
      ..StorageFileMetrics::default()
    };
    if hash_verified {
      let key = StorageContentKey {
        hash_algorithm: row.get(3)?,
        content_hash: row.get(4)?,
        size_bytes,
      };
      let stats = match content_stats.entry(key.clone()) {
        Entry::Occupied(entry) => entry.into_mut(),
        Entry::Vacant(entry) => {
          let (copies, first_path) = source.query_row(
            params![
              folder.site_id,
              revision,
              key.hash_algorithm,
              key.content_hash,
              size_bytes
            ],
            |row| Ok((row.get(0)?, row.get(1)?)),
          )?;
          let covered = match (comparison, &mut target) {
            (Some(comparison), Some(target)) => Some(target.query_row(
              params![
                comparison.target.id,
                comparison.revision,
                key.hash_algorithm,
                key.content_hash,
                size_bytes
              ],
              |row| row.get(0),
            )?),
            _ => None,
          };
          entry.insert(ContentStats {
            copies,
            first_path,
            covered,
          })
        }
      };
      file.source_copy_count = stats.copies;
      file.duplicate = analysis_ready && stats.copies > 1;
      file.reclaimable = file.duplicate && stored_path != stats.first_path;
      file.covered_by_target = stats.covered;
      file.content_key = Some(key);
    }

    add_immediate_file(parent, folder, &segments, parent_segments.len(), &file)?;
  }
  Ok(())
}

fn add_immediate_file(
  parent: &mut StorageNodeBuilder,
  folder: &SiteFolder,
  segments: &[String],
  parent_depth: usize,
  file: &StorageFileMetrics,
) -> Result<()> {
  if let Some(name) = segments.get(parent_depth) {
    let child = match parent.children.entry(name.clone()) {
      Entry::Occupied(entry) => entry.into_mut(),
      Entry::Vacant(entry) => {
        let kind = if segments.len() == parent_depth + 1 {
          StorageNodeKind::File
        } else {
          StorageNodeKind::Directory
        };
        let path = storage_child_path(folder, &segments[..=parent_depth])?;
        let id = format!("storage:{}:{}", folder.id, path.display());
        entry.insert(StorageNodeBuilder::new(id, name.clone(), Some(path), kind))
      }
    };
    child.add_file_metrics(file);
  } else {
    parent.kind = StorageNodeKind::File;
  }
  parent.add_file_metrics(file);
  Ok(())
}
