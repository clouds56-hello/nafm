use std::io::{self, BufReader, BufWriter, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use nafm_protocol::{
  HiddenPolicy, REMOTE_AGENT_PROTOCOL_VERSION, RemoteAgentRequest, RemoteAgentResponse, RemoteFileMetadata,
};
use walkdir::WalkDir;

mod completion;
mod preview;

fn main() {
  if let Err(error) = run() {
    let _ = write_response(&RemoteAgentResponse::Error {
      message: error.to_string(),
    });
    std::process::exit(1);
  }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
  let request: RemoteAgentRequest = serde_json::from_reader(BufReader::new(io::stdin().lock()))?;
  match request {
    RemoteAgentRequest::CompletePath { protocol_version, path } => {
      require_protocol(protocol_version)?;
      write_response(&completion::complete(&path)?)?;
    }
    RemoteAgentRequest::Preview {
      protocol_version,
      remote_root,
    } => {
      require_protocol(protocol_version)?;
      write_response(&preview::preview(&remote_root)?)?;
    }
    RemoteAgentRequest::Probe {
      protocol_version,
      remote_root,
    } => {
      require_protocol(protocol_version)?;
      if let Some(remote_root) = remote_root {
        canonical_root(&remote_root)?;
      }
      write_response(&RemoteAgentResponse::Ready {
        capabilities: vec!["path_preview".to_owned(), "path_completion".to_owned()],
        protocol_version: REMOTE_AGENT_PROTOCOL_VERSION,
        agent_version: env!("CARGO_PKG_VERSION").to_owned(),
        hash_algorithms: vec!["blake3".to_owned()],
        os: std::env::consts::OS.to_owned(),
        arch: std::env::consts::ARCH.to_owned(),
        executable_hash: {
          let mut hasher = blake3::Hasher::new();
          hasher.update_reader(std::fs::File::open(std::env::current_exe()?)?)?;
          hasher.finalize().to_hex().to_string()
        },
      })?;
    }
    RemoteAgentRequest::Discover {
      protocol_version,
      remote_root,
      hidden_policy,
    } => {
      require_protocol(protocol_version)?;
      discover(&remote_root, hidden_policy)?;
    }
    RemoteAgentRequest::Hash {
      protocol_version,
      remote_root,
      hash_algorithm,
      files,
    } => {
      require_protocol(protocol_version)?;
      if hash_algorithm != "blake3" {
        return Err(format!("unsupported hash algorithm: {hash_algorithm}").into());
      }
      hash_files(&remote_root, &files)?;
    }
  }
  Ok(())
}

fn require_protocol(protocol_version: u32) -> Result<(), Box<dyn std::error::Error>> {
  if protocol_version != REMOTE_AGENT_PROTOCOL_VERSION {
    return Err(
      format!("unsupported remote agent protocol {protocol_version}; expected {REMOTE_AGENT_PROTOCOL_VERSION}").into(),
    );
  }
  Ok(())
}

fn discover(remote_root: &Path, hidden_policy: HiddenPolicy) -> Result<(), Box<dyn std::error::Error>> {
  let root = canonical_root(remote_root)?;

  let walker = WalkDir::new(&root).follow_links(false).sort_by_file_name().into_iter();
  let mut file_count = 0_u64;
  for entry in walker.filter_entry(|entry| include_entry(entry.path(), &root, hidden_policy)) {
    let entry = entry?;
    if !entry.file_type().is_file() {
      continue;
    }
    let relative_path = entry.path().strip_prefix(&root)?;
    let metadata = entry.metadata()?;
    let file = RemoteFileMetadata {
      relative_path: relative_path_to_string(relative_path)?,
      size_bytes: metadata.len(),
      modified_unix_nanos: modified_unix_nanos(metadata.modified()?)?,
    };
    write_response(&RemoteAgentResponse::File { file })?;
    file_count += 1;
  }
  write_response(&RemoteAgentResponse::DiscoveryComplete { file_count })?;
  Ok(())
}

fn include_entry(path: &Path, root: &Path, hidden_policy: HiddenPolicy) -> bool {
  hidden_policy == HiddenPolicy::Include
    || path == root
    || path
      .file_name()
      .and_then(|name| name.to_str())
      .is_none_or(|name| !name.starts_with('.'))
}

fn hash_files(remote_root: &Path, files: &[RemoteFileMetadata]) -> Result<(), Box<dyn std::error::Error>> {
  let root = canonical_root(remote_root)?;
  if files.is_empty() {
    write_response(&RemoteAgentResponse::HashComplete { file_count: 0 })?;
    return Ok(());
  }

  let worker_count = std::thread::available_parallelism()
    .map(|parallelism| parallelism.get())
    .unwrap_or(1)
    .min(4)
    .min(files.len().max(1));
  let chunk_size = files.len().div_ceil(worker_count);
  let result = std::thread::scope(|scope| {
    let tasks = files
      .chunks(chunk_size)
      .map(|chunk| {
        let root = &root;
        scope.spawn(move || -> Result<(), String> {
          for expected in chunk {
            let path = resolve_relative_path(root, &expected.relative_path).map_err(|error| error.to_string())?;
            verify_metadata(&path, expected).map_err(|error| error.to_string())?;
            let mut hasher = blake3::Hasher::new();
            hasher
              .update_reader(std::fs::File::open(&path).map_err(|error| error.to_string())?)
              .map_err(|error| error.to_string())?;
            let content_hash = hasher.finalize().to_hex().to_string();
            verify_metadata(&path, expected).map_err(|error| error.to_string())?;
            write_response(&RemoteAgentResponse::Hash {
              relative_path: expected.relative_path.clone(),
              content_hash,
            })
            .map_err(|error| error.to_string())?;
          }
          Ok(())
        })
      })
      .collect::<Vec<_>>();
    for task in tasks {
      task.join().map_err(|_| "remote hash worker panicked".to_owned())??;
    }
    Ok::<(), String>(())
  });
  if let Err(error) = result {
    return Err(error.into());
  }
  write_response(&RemoteAgentResponse::HashComplete {
    file_count: files.len() as u64,
  })?;
  Ok(())
}

fn canonical_root(root: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
  if !root.is_absolute() {
    return Err("remote root must be absolute on the remote machine".into());
  }
  let root = root.canonicalize()?;
  if !root.is_dir() {
    return Err(format!("remote root is not a directory: {}", root.display()).into());
  }
  Ok(root)
}

fn resolve_relative_path(root: &Path, relative_path: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
  let relative = Path::new(relative_path);
  if relative.is_absolute()
    || relative
      .components()
      .any(|component| !matches!(component, Component::Normal(_)))
  {
    return Err(format!("invalid relative path: {relative_path}").into());
  }
  let path = root.join(relative);
  let canonical = path.canonicalize()?;
  if !canonical.starts_with(root) {
    return Err(format!("path escapes remote root: {relative_path}").into());
  }
  Ok(canonical)
}

fn verify_metadata(path: &Path, expected: &RemoteFileMetadata) -> Result<(), Box<dyn std::error::Error>> {
  let metadata = path.metadata()?;
  let modified = modified_unix_nanos(metadata.modified()?)?;
  if !metadata.is_file() || metadata.len() != expected.size_bytes || modified != expected.modified_unix_nanos {
    return Err(format!("file changed while it was being scanned: {}", path.display()).into());
  }
  Ok(())
}

fn relative_path_to_string(path: &Path) -> Result<String, Box<dyn std::error::Error>> {
  let mut result = String::new();
  for component in path.components() {
    let Component::Normal(segment) = component else {
      return Err(format!("invalid relative path: {}", path.display()).into());
    };
    let segment = segment
      .to_str()
      .ok_or_else(|| format!("remote path is not valid UTF-8: {}", path.display()))?;
    if !result.is_empty() {
      result.push('/');
    }
    result.push_str(segment);
  }
  Ok(result)
}

fn modified_unix_nanos(time: SystemTime) -> Result<i64, Box<dyn std::error::Error>> {
  let duration = time.duration_since(UNIX_EPOCH)?;
  Ok(i64::try_from(duration.as_nanos())?)
}

fn write_response(response: &RemoteAgentResponse) -> Result<(), Box<dyn std::error::Error>> {
  let stdout = io::stdout();
  let mut output = BufWriter::new(stdout.lock());
  serde_json::to_writer(&mut output, response)?;
  output.write_all(b"\n")?;
  output.flush()?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use std::fs;

  use nafm_protocol::RemoteFileMetadata;

  use super::{modified_unix_nanos, resolve_relative_path, verify_metadata};

  #[test]
  fn relative_paths_cannot_escape_the_remote_root() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("inside.txt"), b"inside").unwrap();
    let canonical_root = root.path().canonicalize().unwrap();

    assert_eq!(
      resolve_relative_path(&canonical_root, "inside.txt").unwrap(),
      canonical_root.join("inside.txt")
    );
    assert!(resolve_relative_path(&canonical_root, "../outside.txt").is_err());
    assert!(resolve_relative_path(&canonical_root, "/outside.txt").is_err());
  }

  #[test]
  fn metadata_verification_detects_content_length_changes() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("file.bin");
    fs::write(&path, b"first").unwrap();
    let metadata = path.metadata().unwrap();
    let expected = RemoteFileMetadata {
      relative_path: "file.bin".to_owned(),
      size_bytes: metadata.len(),
      modified_unix_nanos: modified_unix_nanos(metadata.modified().unwrap()).unwrap(),
    };

    verify_metadata(&path, &expected).unwrap();
    fs::write(&path, b"changed length").unwrap();
    assert!(verify_metadata(&path, &expected).is_err());
  }
}
