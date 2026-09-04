use std::{io::Read, path::Path};

use nafm_protocol::{RemoteAgentResponse, RemoteFileMetadata};
use walkdir::WalkDir;

/// Bounded sample, not a full permissions audit. Never returns file contents.
pub(super) fn preview(remote_root: &Path) -> Result<RemoteAgentResponse, Box<dyn std::error::Error>> {
  let root = super::canonical_root(remote_root)?;
  let mut files = Vec::new();
  let mut truncated = false;
  // Do not sort: sorting buffers a whole directory before the entry limit applies.
  for (index, entry) in WalkDir::new(&root).follow_links(false).into_iter().enumerate() {
    if index >= 1000 || files.len() >= 5 {
      truncated = true;
      break;
    }
    let entry = entry?;
    if !entry.file_type().is_file() {
      continue;
    }
    let mut file = std::fs::File::open(entry.path())?;
    let metadata = file.metadata()?;
    let bytes_read = file.read(&mut [0_u8; 1])?;
    if bytes_read == 0 && metadata.len() > 0 {
      return Err("file changed during preview; retry".into());
    }
    files.push(RemoteFileMetadata {
      relative_path: super::relative_path_to_string(entry.path().strip_prefix(&root)?)?,
      size_bytes: metadata.len(),
      modified_unix_nanos: super::modified_unix_nanos(metadata.modified()?)?,
    });
  }
  Ok(RemoteAgentResponse::Preview { files, truncated })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn empty_and_bounded_samples() {
    let root = tempfile::tempdir().unwrap();
    assert!(
      matches!(preview(root.path()).unwrap(), RemoteAgentResponse::Preview { files, truncated: false } if files.is_empty())
    );
    for index in 0..7 {
      std::fs::write(root.path().join(format!("sample-{index}")), b"abc").unwrap();
    }
    assert!(
      matches!(preview(root.path()).unwrap(), RemoteAgentResponse::Preview { files, truncated: true } if files.len() == 5)
    );
  }

  #[test]
  fn missing_root_fails() {
    let root = tempfile::tempdir().unwrap();
    assert!(preview(&root.path().join("missing")).is_err());
  }
}
