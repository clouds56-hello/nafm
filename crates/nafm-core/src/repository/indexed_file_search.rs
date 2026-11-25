use std::borrow::Cow;
use std::path::Path;

use percent_encoding::percent_decode_str;
use rusqlite::functions::FunctionFlags;
use rusqlite::{Connection, OptionalExtension, params};

use crate::{AdjacentFileDirection, IndexedFileMatch, IndexedFileSearchPage, Result};

const MAX_SEARCH_PAGE_SIZE: u64 = 200;
const MATCHING_FILES: &str = "
  from file_records file
  join sites site on site.id = file.site_id
  join site_scan_state scan on scan.site_id = file.site_id
  where scan.inventory_completed_at is not null
    and file.inventory_revision = scan.inventory_revision
    and indexed_file_name_matches(file.path)";
const MATCH_ORDER: &str = "site.name, file.path, file.id";

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

pub(super) fn search(
  conn: &Connection,
  query: String,
  offset: u64,
  limit: u64,
  anchor_file_id: Option<&str>,
  anchor_direction: Option<AdjacentFileDirection>,
) -> Result<IndexedFileSearchPage> {
  let mut page = IndexedFileSearchPage {
    matches: Vec::new(),
    total_matches: 0,
    offset,
    limit: limit.clamp(1, MAX_SEARCH_PAGE_SIZE),
    anchor_index: None,
    neighbor_index: None,
  };
  if query.is_empty() {
    if anchor_file_id.is_some() {
      page.offset = 0;
    }
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
  let anchor_key: Option<(String, String, String)> = match anchor_file_id {
    Some(file_id) => conn
      .query_row(
        &format!("select {MATCH_ORDER} {MATCHING_FILES} and file.id = ?1"),
        [file_id],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
      )
      .optional()?,
    None => None,
  };
  (page.total_matches, page.anchor_index) = match anchor_key {
    Some((site_name, path, file_id)) => conn.query_row(
      &format!("select count(*), count(case when ({MATCH_ORDER}) < (?1, ?2, ?3) then 1 end) {MATCHING_FILES}"),
      params![site_name, path, file_id],
      |row| Ok((row.get(0)?, Some(row.get(1)?))),
    )?,
    None => (
      conn.query_row(&format!("select count(*) {MATCHING_FILES}"), [], |row| row.get(0))?,
      None,
    ),
  };
  page.neighbor_index = match (page.anchor_index, anchor_direction) {
    (Some(index), Some(AdjacentFileDirection::Previous)) => index.checked_sub(1),
    (Some(index), Some(AdjacentFileDirection::Next)) if index + 1 < page.total_matches => Some(index + 1),
    _ => None,
  };
  if anchor_file_id.is_some() {
    page.offset = match page.neighbor_index.or(page.anchor_index) {
      Some(index) => index / page.limit * page.limit,
      None => offset.min(page.total_matches.saturating_sub(1) / page.limit * page.limit),
    };
  }
  if page.offset >= page.total_matches {
    return Ok(page);
  }

  let mut statement = conn.prepare(&format!(
    "select file.id, file.site_id, site.name, file.path, file.size_bytes,
            coalesce(file.content_hash is not null and file.hash_revision = file.inventory_revision, false)
     {MATCHING_FILES}
     order by {MATCH_ORDER}
     limit ?1 offset ?2"
  ))?;
  page.matches = statement
    .query_map(params![page.limit, page.offset], |row| {
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
