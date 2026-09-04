use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub type Result<T> = std::result::Result<T, Box<dyn std::error::Error + Send + Sync>>;
pub const TARGETS: [&str; 3] = [
  "x86_64-unknown-linux-musl",
  "x86_64-pc-windows-msvc",
  "aarch64-apple-darwin",
];
pub const AGENT_VERSION: &str = "0.4.0";

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentArtifact {
  pub target: String,
  pub file_name: String,
  pub blake3: String,
  pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AgentManifest {
  pub agent_version: String,
  pub protocol_version: u32,
  pub source_hash: String,
  pub artifacts: Vec<AgentArtifact>,
}

pub fn artifact_name(target: &str) -> String {
  format!(
    "nafm-agent-{target}{}",
    if target.contains("windows") { ".exe" } else { "" }
  )
}

pub fn checksum(path: &Path) -> Result<String> {
  let mut hasher = blake3::Hasher::new();
  hasher.update_reader(std::fs::File::open(path)?)?;
  Ok(hasher.finalize().to_hex().to_string())
}

pub fn target_for(os: &str, arch: &str) -> Result<&'static str> {
  match (os, arch) {
    ("Linux" | "linux", "x86_64" | "amd64") => Ok(TARGETS[0]),
    ("Windows" | "windows", "AMD64" | "x86_64") => Ok(TARGETS[1]),
    ("Darwin" | "macos", "arm64" | "aarch64") => Ok(TARGETS[2]),
    _ => Err(format!("unsupported remote platform {os}/{arch}; supported: Linux x64, Windows x64, macOS ARM64").into()),
  }
}

impl AgentManifest {
  pub fn validate_source(&self, root: &Path) -> Result<()> {
    if self.source_hash != source_hash(root)? {
      return Err("agent bundle is stale; run pnpm agents:build".into());
    }
    Ok(())
  }

  pub fn load(directory: &Path) -> Result<Self> {
    let manifest: Self = serde_json::from_slice(&std::fs::read(directory.join("manifest.json"))?)?;
    if manifest.agent_version != AGENT_VERSION
      || manifest.protocol_version != nafm_protocol::REMOTE_AGENT_PROTOCOL_VERSION
      || manifest.artifacts.len() != TARGETS.len()
    {
      return Err("agent bundle version or target count mismatch; rebuild with pnpm agents:build".into());
    }
    for target in TARGETS {
      let matches: Vec<_> = manifest
        .artifacts
        .iter()
        .filter(|entry| entry.target == target)
        .collect();
      if matches.len() != 1 || matches[0].file_name != artifact_name(target) {
        return Err(format!("missing, duplicate or invalid artifact for {target}").into());
      }
      let entry = matches[0];
      let path = directory.join(&entry.file_name);
      if path.metadata()?.len() != entry.size_bytes || checksum(&path)? != entry.blake3 {
        return Err(format!("agent bundle checksum mismatch for {target}").into());
      }
      validate_binary(&path, target)?;
    }
    Ok(manifest)
  }
}

/// Check executable machine types without attempting to run foreign binaries.
pub fn validate_binary(path: &Path, target: &str) -> Result<()> {
  let bytes = std::fs::read(path)?;
  let valid = match target {
    "x86_64-unknown-linux-musl" => {
      // ELF64, little endian, AMD64; reject PT_INTERP (dynamic loader dependency).
      if bytes.len() < 64 || &bytes[..6] != b"\x7fELF\x02\x01" || bytes[18..20] != [62, 0] {
        false
      } else {
        let offset = u64::from_le_bytes(bytes[32..40].try_into()?) as usize;
        let width = u16::from_le_bytes(bytes[54..56].try_into()?) as usize;
        let count = u16::from_le_bytes(bytes[56..58].try_into()?) as usize;
        width >= 4
          && (0..count).all(|index| {
            offset
              .checked_add(index * width)
              .and_then(|start| start.checked_add(4).and_then(|end| bytes.get(start..end)))
              .is_some_and(|kind| kind != [3, 0, 0, 0])
          })
      }
    }
    "aarch64-apple-darwin" => bytes.get(..8) == Some(&[0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]),
    "x86_64-pc-windows-msvc" => {
      if bytes.len() < 64 || &bytes[..2] != b"MZ" {
        false
      } else {
        let offset = u32::from_le_bytes(bytes[60..64].try_into()?) as usize;
        bytes.get(offset..offset + 6) == Some(b"PE\0\0\x64\x86")
      }
    }
    _ => false,
  };
  if !valid {
    return Err(format!("invalid executable format or dynamic Linux binary: {target}").into());
  }
  Ok(())
}

/// Include build inputs (not git status/timestamps), so offline and CI checks agree.
pub fn source_hash(root: &Path) -> Result<String> {
  let mut files = vec![
    PathBuf::from("Cargo.toml"),
    PathBuf::from("Cargo.lock"),
    PathBuf::from("rust-toolchain.toml"),
  ];
  files.retain(|path| root.join(path).is_file());
  for directory in [
    "crates/nafm-agent",
    "crates/nafm-protocol",
    "crates/nafm-bundle",
    "crates/nafm-xtask",
  ] {
    collect_files(root, Path::new(directory), &mut files)?;
  }
  files.sort();
  let mut hasher = blake3::Hasher::new();
  for path in files {
    hasher.update(path.to_string_lossy().replace('\\', "/").as_bytes());
    hasher.update(&[0]);
    hasher.update(
      std::fs::read_to_string(root.join(path))?
        .replace("\r\n", "\n")
        .as_bytes(),
    );
    hasher.update(&[0]);
  }
  Ok(hasher.finalize().to_hex().to_string())
}

fn collect_files(root: &Path, directory: &Path, files: &mut Vec<PathBuf>) -> Result<()> {
  for entry in std::fs::read_dir(root.join(directory))? {
    let entry = entry?;
    let path = directory.join(entry.file_name());
    if entry.file_type()?.is_dir() {
      collect_files(root, &path, files)?;
    } else if entry.file_type()?.is_file() {
      files.push(path);
    }
  }
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn platform_selection_never_falls_back_to_host() {
    assert_eq!(target_for("Windows", "AMD64").unwrap(), TARGETS[1]);
    assert_eq!(target_for("Darwin", "arm64").unwrap(), TARGETS[2]);
    assert_eq!(target_for("Linux", "x86_64").unwrap(), TARGETS[0]);
    assert!(target_for("Linux", "aarch64").is_err());
    assert!(target_for("Darwin", "x86_64").is_err());
    assert!(target_for("Windows", "ARM64").is_err());
  }

  #[test]
  fn malformed_binary_is_rejected() {
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), b"not an executable").unwrap();
    for target in TARGETS {
      assert!(validate_binary(file.path(), target).is_err());
    }
  }

  fn fixture() -> (tempfile::TempDir, AgentManifest) {
    let directory = tempfile::tempdir().unwrap();
    let mut artifacts = Vec::new();
    for target in TARGETS {
      let mut bytes = vec![0; 128];
      match target {
        "x86_64-unknown-linux-musl" => {
          bytes[..6].copy_from_slice(b"\x7fELF\x02\x01");
          bytes[18] = 62;
          bytes[54] = 56;
        }
        "aarch64-apple-darwin" => bytes[..8].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]),
        _ => {
          bytes[..2].copy_from_slice(b"MZ");
          bytes[60] = 64;
          bytes[64..70].copy_from_slice(b"PE\0\0\x64\x86");
        }
      }
      let file_name = artifact_name(target);
      let path = directory.path().join(&file_name);
      std::fs::write(&path, bytes).unwrap();
      artifacts.push(AgentArtifact {
        target: target.into(),
        file_name,
        size_bytes: 128,
        blake3: checksum(&path).unwrap(),
      });
    }
    let manifest = AgentManifest {
      agent_version: AGENT_VERSION.into(),
      protocol_version: nafm_protocol::REMOTE_AGENT_PROTOCOL_VERSION,
      source_hash: "fixture".into(),
      artifacts,
    };
    std::fs::write(
      directory.path().join("manifest.json"),
      serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    (directory, manifest)
  }

  #[test]
  fn bundle_requires_every_target_and_matching_bytes() {
    let (directory, mut manifest) = fixture();
    AgentManifest::load(directory.path()).unwrap();
    std::fs::write(directory.path().join(&manifest.artifacts[0].file_name), b"corrupt").unwrap();
    assert!(AgentManifest::load(directory.path()).is_err());
    manifest.artifacts.pop();
    std::fs::write(
      directory.path().join("manifest.json"),
      serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(AgentManifest::load(directory.path()).is_err());
  }

  #[test]
  fn bundle_rejects_duplicate_targets_and_path_traversal() {
    let (directory, mut manifest) = fixture();
    manifest.artifacts[1] = manifest.artifacts[0].clone();
    std::fs::write(
      directory.path().join("manifest.json"),
      serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(AgentManifest::load(directory.path()).is_err());
    manifest.artifacts[0].file_name = "../outside".into();
    std::fs::write(
      directory.path().join("manifest.json"),
      serde_json::to_vec(&manifest).unwrap(),
    )
    .unwrap();
    assert!(AgentManifest::load(directory.path()).is_err());
  }

  #[test]
  fn linux_dynamic_loader_is_rejected() {
    let (directory, manifest) = fixture();
    let path = directory.path().join(&manifest.artifacts[0].file_name);
    let mut bytes = std::fs::read(&path).unwrap();
    bytes[32] = 64;
    bytes[56] = 1;
    bytes[64] = 3;
    std::fs::write(&path, bytes).unwrap();
    assert!(validate_binary(&path, TARGETS[0]).is_err());
  }

  #[test]
  fn source_fingerprint_detects_changes_but_ignores_checkout_line_endings() {
    let directory = tempfile::tempdir().unwrap();
    for package in ["nafm-agent", "nafm-protocol", "nafm-bundle", "nafm-xtask"] {
      std::fs::create_dir_all(directory.path().join("crates").join(package)).unwrap();
    }
    let input = directory.path().join("Cargo.toml");
    std::fs::write(&input, "first\nsecond\n").unwrap();
    let original = source_hash(directory.path()).unwrap();
    std::fs::write(&input, "first\r\nsecond\r\n").unwrap();
    assert_eq!(source_hash(directory.path()).unwrap(), original);
    std::fs::write(&input, "changed\n").unwrap();
    let manifest = AgentManifest {
      agent_version: AGENT_VERSION.into(),
      protocol_version: 2,
      source_hash: original,
      artifacts: vec![],
    };
    assert!(manifest.validate_source(directory.path()).is_err());
  }
}
