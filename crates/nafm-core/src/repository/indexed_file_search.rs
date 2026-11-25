use std::borrow::Cow;
use std::path::Path;

use percent_encoding::percent_decode_str;
use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, params};

use crate::{IndexedFileMatch, IndexedFileSearchPage, Result};

const MAX_SEARCH_PAGE_SIZE: u64 = 200;
const MATCHING_FILES: &str = "
  from file_records file
  join sites site on site.id = file.site_id
  join site_scan_state scan on scan.site_id = file.site_id
  where scan.inventory_completed_at is not null
    and file.inventory_revision = scan.inventory_revision
    and indexed_file_name_matches(file.path)";

fn file_name(path: &str) -> Cow<'_, str> {
  let name = Path::new(path)
    .file_name()
    .and_then(|name| name.to_str())
    .unwrap_or(path);
  if path.starts_with("smb://") {
    return percent_decode_str(name).decode_utf8_lossy();
  }
  Cow::Borrowed(name)
}

pub(super) fn search(conn: &Connection, query: String, offset: u64, limit: u64) -> Result<IndexedFileSearchPage> {
  let mut page = IndexedFileSearchPage {
    matches: Vec::new(),
    total_matches: 0,
    offset,
    limit: limit.clamp(1, MAX_SEARCH_PAGE_SIZE),
  };
  if query.is_empty() {
    return Ok(page);
  }

  // Match the display name using Unicode lowercasing. SQL wildcards are ordinary characters.
  conn.create_scalar_function(
    "indexed_file_name_matches",
    1,
    FunctionFlags::SQLITE_UTF8 | FunctionFlags::SQLITE_DETERMINISTIC | FunctionFlags::SQLITE_DIRECTONLY,
    move |context| {
      let raw = context.get_raw(0);
      let path = raw
        .as_str()
        .map_err(|error| rusqlite::Error::FromSqlConversionFailure(0, raw.data_type(), error.into()))?;
      Ok(file_name(path).to_lowercase().contains(&query))
    },
  )?;
  page.total_matches = conn.query_row(&format!("select count(*) {MATCHING_FILES}"), [], |row| row.get(0))?;
  if offset >= page.total_matches {
    return Ok(page);
  }

  let mut statement = conn.prepare(&format!(
    "select file.id, file.site_id, site.name, file.path, file.size_bytes,
            coalesce(file.content_hash is not null and file.hash_revision = file.inventory_revision, false)
     {MATCHING_FILES}
     order by site.name, file.path, file.id
     limit ?1 offset ?2"
  ))?;
  page.matches = statement
    .query_map(params![page.limit, offset], |row| {
      let path: String = row.get(3)?;
      Ok(IndexedFileMatch {
        file_id: row.get(0)?,
        site_id: row.get(1)?,
        site_name: row.get(2)?,
        name: file_name(&path).into_owned(),
        path: path.into(),
        size_bytes: row.get(4)?,
        verified: row.get(5)?,
      })
    })?
    .collect::<rusqlite::Result<_>>()?;
  Ok(page)
}
