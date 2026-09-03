use nafm_bundle::{AgentArtifact, AgentManifest, Result, TARGETS, artifact_name, checksum, source_hash};
use std::path::Path;
use std::process::Command;

fn main() -> Result<()> {
  let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize()?;
  let destination = root.join("apps/nafm-desktop/src-tauri/resources/agents");
  match std::env::args().nth(1).as_deref() {
    Some("check-agents") => {
      let manifest = AgentManifest::load(&destination)?;
      manifest.validate_source(&root)?;
      println!("Verified all three bundled agents.");
    }
    Some("build-agents") => {
      if std::env::consts::OS != "macos" {
        return Err(
          "build-agents requires a macOS builder with the Apple SDK; consume its output on other desktop build hosts"
            .into(),
        );
      }
      let initial_hash = source_hash(&root)?;
      std::fs::create_dir_all(&destination)?;
      let staging = tempfile::tempdir_in(destination.parent().unwrap())?;
      let target_directory = root.join("target/agents");
      let mut artifacts = Vec::new();
      for target in TARGETS {
        let mut command = Command::new("cargo");
        command.current_dir(&root);
        command.env_remove("CARGO_ENCODED_RUSTFLAGS").env("RUSTFLAGS", "");
        match target {
          "x86_64-unknown-linux-musl" => {
            command.arg("zigbuild");
          }
          "x86_64-pc-windows-msvc" => {
            command.args(["xwin", "build"]);
            command.env("RUSTFLAGS", "-C target-feature=+crt-static");
          }
          _ => {
            command.arg("build");
            // blake3's C build does not track MACOSX_DEPLOYMENT_TARGET changes.
            // Set a tracked target-specific C flag as well as the Rust deployment target.
            command.env("CFLAGS_aarch64_apple_darwin", "-mmacosx-version-min=11.0");
          }
        }
        command
          .args([
            "--locked",
            "--release",
            "-p",
            "nafm-agent",
            "--target",
            target,
            "--target-dir",
          ])
          .arg(&target_directory)
          .env("MACOSX_DEPLOYMENT_TARGET", "11.0");
        println!("Building {target}");
        if !command.status()?.success() {
          return Err(format!("failed to build {target}; see docs/remote-agents.md for prerequisites").into());
        }
        let file_name = artifact_name(target);
        let binary = staging.path().join(&file_name);
        let executable = if target.contains("windows") {
          "nafm-agent.exe"
        } else {
          "nafm-agent"
        };
        std::fs::copy(target_directory.join(target).join("release").join(executable), &binary)?;
        nafm_bundle::validate_binary(&binary, target)?;
        artifacts.push(AgentArtifact {
          target: target.into(),
          file_name,
          blake3: checksum(&binary)?,
          size_bytes: binary.metadata()?.len(),
        });
      }
      if initial_hash != source_hash(&root)? {
        return Err("source changed during build; run again".into());
      }
      let manifest = AgentManifest {
        agent_version: nafm_bundle::AGENT_VERSION.into(),
        protocol_version: nafm_protocol::REMOTE_AGENT_PROTOCOL_VERSION,
        source_hash: initial_hash,
        artifacts,
      };
      std::fs::write(
        staging.path().join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
      )?;
      AgentManifest::load(staging.path())?;
      // Publish the manifest last: an interrupted copy cannot pass bundle validation.
      for entry in &manifest.artifacts {
        std::fs::copy(
          staging.path().join(&entry.file_name),
          destination.join(&entry.file_name),
        )?;
      }
      std::fs::copy(staging.path().join("manifest.json"), destination.join("manifest.json"))?;
      println!("Built and verified {}", destination.display());
    }
    _ => return Err("usage: cargo run -p nafm-xtask -- <build-agents|check-agents>".into()),
  }
  Ok(())
}
