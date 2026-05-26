use std::collections::BTreeMap;
use std::path::Path;

use anyhow::{Error, Result};
use indicatif::{ProgressBar, ProgressStyle};
use nafm_core::DuplicateGroup;
use serde::Serialize;
use serde_json::Value;

pub fn print_json_or<T, F>(json: bool, value: &T, human: F) -> Result<()>
where
  T: Serialize,
  F: FnOnce(),
{
  if json {
    print!("{}", format_json_output(value)?);
  } else {
    human();
  }
  Ok(())
}

pub fn print_json_line<T>(value: &T) -> Result<()>
where
  T: Serialize,
{
  println!("{}", serde_json::to_string(value)?);
  Ok(())
}

pub fn format_json_output<T>(value: &T) -> Result<String>
where
  T: Serialize,
{
  format_json_value(&serde_json::to_value(value)?)
}

pub fn format_json_error(error: &Error) -> Result<String> {
  let causes = error
    .chain()
    .skip(1)
    .map(|cause| cause.to_string())
    .collect::<Vec<_>>();
  if causes.is_empty() {
    serde_json::to_string(&serde_json::json!({
      "error": error.to_string(),
    }))
    .map(|line| format!("{line}\n"))
    .map_err(Into::into)
  } else {
    serde_json::to_string(&serde_json::json!({
      "error": error.to_string(),
      "causes": causes,
    }))
    .map(|line| format!("{line}\n"))
    .map_err(Into::into)
  }
}

fn format_json_value(value: &Value) -> Result<String> {
  match value {
    Value::Array(values) => {
      let lines = values
        .iter()
        .map(serde_json::to_string)
        .collect::<std::result::Result<Vec<_>, _>>()?;
      if lines.is_empty() {
        Ok(String::new())
      } else {
        Ok(format!("{}\n", lines.join("\n")))
      }
    }
    _ => serde_json::to_string(value)
      .map(|line| format!("{line}\n"))
      .map_err(Into::into),
  }
}

pub fn spinner(json: bool, message: &'static str) -> ProgressBar {
  if json {
    return ProgressBar::hidden();
  }
  let spinner = ProgressBar::new_spinner();
  spinner.set_message(message);
  spinner
    .set_style(ProgressStyle::with_template("{spinner} {msg}").unwrap_or_else(|_| ProgressStyle::default_spinner()));
  spinner.enable_steady_tick(std::time::Duration::from_millis(120));
  spinner
}

pub fn site_folder_label(site: &str, path: &Path) -> String {
  format!("{site}:{}", path.display())
}

pub fn format_duplicate_groups_by_folder(
  groups: &[DuplicateGroup],
  file_counts_by_parent_folder: &BTreeMap<String, u64>,
) -> String {
  let mut folder_reports = BTreeMap::<String, FolderDuplicateReport>::new();

  for group in groups {
    for file in &group.files {
      let folder_path = parent_folder_label(file.path.as_path());
      let duplicates_with = group
        .files
        .iter()
        .filter(|other| other.file_id != file.file_id)
        .map(|other| duplicate_peer_label(other.path.as_path()))
        .collect::<Vec<_>>();
      let file_label = file_label(file.path.as_path());

      folder_reports
        .entry(folder_path.clone())
        .or_insert_with(|| FolderDuplicateReport {
          duplicate_count: 0,
          total_count: *file_counts_by_parent_folder.get(&folder_path).unwrap_or(&0),
          entries: Vec::new(),
        })
        .entries
        .push(DuplicateEntry {
          file_label,
          duplicates_with,
        });
    }
  }

  let mut output = String::new();
  for report in folder_reports.values_mut() {
    report
      .entries
      .sort_by(|left, right| left.file_label.cmp(&right.file_label));
    report
      .entries
      .dedup_by(|left, right| left.file_label == right.file_label);
    report.duplicate_count = report.entries.len() as u64;
  }

  for (folder_path, report) in folder_reports {
    output.push_str(&format!(
      "{} ({}/{}):\n",
      folder_path, report.duplicate_count, report.total_count
    ));
    for (index, entry) in report.entries.iter().enumerate() {
      output.push_str(&format!(
        "  [{}] {}, duplicates with: {}\n",
        index + 1,
        entry.file_label,
        entry.duplicates_with.join(", ")
      ));
    }
  }

  output.trim_end().to_owned()
}

#[derive(Debug)]
struct FolderDuplicateReport {
  duplicate_count: u64,
  total_count: u64,
  entries: Vec<DuplicateEntry>,
}

#[derive(Debug)]
struct DuplicateEntry {
  file_label: String,
  duplicates_with: Vec<String>,
}

fn file_label(path: &Path) -> String {
  path
    .file_name()
    .map(|name| name.to_string_lossy().to_string())
    .unwrap_or_else(|| path.display().to_string())
}

fn parent_folder_label(path: &Path) -> String {
  path.parent().unwrap_or_else(|| Path::new("")).display().to_string()
}

fn duplicate_peer_label(path: &Path) -> String {
  format!("{}/{}", parent_folder_label(path), file_label(path))
}

#[cfg(test)]
mod tests {
  use std::path::PathBuf;

  use nafm_core::DuplicateFile;

  use super::*;

  #[test]
  fn formats_arrays_as_jsonl() {
    let output = format_json_output(&vec![
      serde_json::json!({ "id": 1 }),
      serde_json::json!({ "id": 2 }),
    ])
    .unwrap();

    assert_eq!(output, "{\"id\":1}\n{\"id\":2}\n");
  }

  #[test]
  fn formats_objects_as_single_json_line() {
    let output = format_json_output(&serde_json::json!({ "ok": true })).unwrap();

    assert_eq!(output, "{\"ok\":true}\n");
  }

  #[test]
  fn formats_empty_arrays_as_empty_output() {
    let output = format_json_output(&Vec::<serde_json::Value>::new()).unwrap();

    assert!(output.is_empty());
  }

  #[test]
  fn formats_duplicates_grouped_by_folder() {
    let groups = vec![DuplicateGroup {
      group_id: "group-1".to_owned(),
      hash_algorithm: "blake3".to_owned(),
      hash: "hash".to_owned(),
      size_bytes: 4,
      files: vec![
        DuplicateFile {
          file_id: "file-1".to_owned(),
          site_id: "site-1".to_owned(),
          site_folder_id: "folder-1".to_owned(),
          path: PathBuf::from("/archive/a/cat.jpg"),
          size_bytes: 4,
          modified_unix_nanos: 0,
        },
        DuplicateFile {
          file_id: "file-2".to_owned(),
          site_id: "site-1".to_owned(),
          site_folder_id: "folder-2".to_owned(),
          path: PathBuf::from("/archive/b/cat-copy.jpg"),
          size_bytes: 4,
          modified_unix_nanos: 0,
        },
      ],
    }];
    let output = format_duplicate_groups_by_folder(
      &groups,
      &BTreeMap::from([("/archive/a".to_owned(), 3), ("/archive/b".to_owned(), 5)]),
    );

    assert!(output.contains("/archive/a (1/3):"));
    assert!(output.contains("[1] cat.jpg, duplicates with: /archive/b/cat-copy.jpg"));
    assert!(output.contains("/archive/b (1/5):"));
  }
}
