use nafm_protocol::RemoteAgentResponse;
use std::{
  fs, io,
  path::{MAIN_SEPARATOR, Path},
};

/// Only this machine interprets separators, drives, and UNC prefixes.
pub(crate) fn complete(input: &str) -> io::Result<RemoteAgentResponse> {
  if input.len() > 8192 || input.contains('\0') {
    return Err(io::Error::new(io::ErrorKind::InvalidInput, "Invalid directory prefix"));
  }
  let default_root = if cfg!(windows) { "C:\\" } else { "/" };
  let input = if input.is_empty() { default_root } else { input };
  let path = Path::new(input);
  if !path.is_absolute() {
    return Err(io::Error::new(
      io::ErrorKind::InvalidInput,
      "Enter an absolute directory path",
    ));
  }
  let (parent, prefix) = if input.ends_with(std::path::is_separator) {
    (path, "")
  } else {
    (
      path.parent().unwrap_or(path),
      path.file_name().and_then(|name| name.to_str()).unwrap_or(""),
    )
  };
  let mut paths = Vec::new();
  let mut truncated = false;
  for (index, entry) in fs::read_dir(parent)?.enumerate() {
    if index == 1000 || paths.len() == 50 {
      truncated = true;
      break;
    }
    let entry = entry?;
    let name = entry.file_name();
    let Some(name) = name.to_str() else { continue };
    let matches = if cfg!(windows) {
      name.to_lowercase().starts_with(&prefix.to_lowercase())
    } else {
      name.starts_with(prefix)
    };
    // Symlink directories are deliberately excluded; no recursive traversal or file reads.
    if matches
      && entry.file_type()?.is_dir()
      && let Some(value) = entry.path().to_str()
    {
      paths.push(format!("{value}{MAIN_SEPARATOR}"));
    }
  }
  paths.sort();
  Ok(RemoteAgentResponse::PathCompletion { paths, truncated })
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn completes_only_matching_directories_and_preserves_unicode() {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("媒体 folder")).unwrap();
    fs::create_dir(root.path().join("other")).unwrap();
    fs::write(root.path().join("媒体 file"), "x").unwrap();
    let input = root.path().join("媒体").to_str().unwrap().to_owned();
    let RemoteAgentResponse::PathCompletion { paths, truncated } = complete(&input).unwrap() else {
      panic!()
    };
    assert_eq!(
      paths,
      vec![format!("{}{MAIN_SEPARATOR}", root.path().join("媒体 folder").display())]
    );
    assert!(!truncated);
    assert!(complete("relative/path").is_err());
  }

  #[test]
  fn bounds_results() {
    let root = tempfile::tempdir().unwrap();
    for index in 0..60 {
      fs::create_dir(root.path().join(index.to_string())).unwrap();
    }
    let RemoteAgentResponse::PathCompletion { paths, truncated } =
      complete(&format!("{}{MAIN_SEPARATOR}", root.path().display())).unwrap()
    else {
      panic!()
    };
    assert_eq!(paths.len(), 50);
    assert!(truncated);
  }
}
