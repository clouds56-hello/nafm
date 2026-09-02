//! Explicit, user-scoped installation. No sudo, daemon, PATH edits, or automatic writes during scans.
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use base64::{Engine, engine::general_purpose::STANDARD};
use nafm_bundle::{AgentManifest, TARGETS, target_for};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use crate::{NafmError, REMOTE_AGENT_PROTOCOL_VERSION, RemoteAgentRequest, RemoteAgentResponse, RemoteMachine, Result};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AgentInstallation {
  pub target: String,
  pub agent_version: String,
  pub executable_path: String,
  pub executable_hash: String,
}

fn remote_error(error: impl std::fmt::Display) -> NafmError {
  NafmError::RemoteAgent(error.to_string())
}

pub(crate) fn agent_command(machine: &RemoteMachine) -> Result<String> {
  let Some(installation) = &machine.agent_installation else {
    return Ok("nafm-agent".into());
  };
  if installation.executable_path.chars().any(char::is_control) {
    return Err(remote_error("invalid managed agent path"));
  }
  match installation.target.as_str() {
    "x86_64-pc-windows-msvc" => Ok(powershell_command(&format!(
      "$ErrorActionPreference = 'Stop'; $OutputEncoding = New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding = $OutputEncoding; [Console]::OutputEncoding = $OutputEncoding; $request = [Console]::In.ReadToEnd(); $request | & {}; exit $LASTEXITCODE",
      quote_powershell(&installation.executable_path)
    ))),
    "x86_64-unknown-linux-musl" | "aarch64-apple-darwin" => Ok(quote_posix(&installation.executable_path)),
    _ => Err(remote_error("unsupported managed agent target")),
  }
}

fn quote_posix(value: &str) -> String {
  format!("'{}'", value.replace('\'', "'\\''"))
}

fn quote_powershell(value: &str) -> String {
  format!("'{}'", value.replace('\'', "''"))
}

fn powershell_command(script: &str) -> String {
  let bytes: Vec<u8> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
  format!(
    "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {}",
    STANDARD.encode(bytes)
  )
}

/// One bounded SSH operation. stdin and both output streams are serviced concurrently.
async fn ssh(machine: &RemoteMachine, script: &str, input: &[u8], duration: Duration) -> Result<String> {
  crate::remote::validate_ssh_target(&machine.ssh_target)?;
  tokio::time::timeout(duration, async {
    let mut child = Command::new("ssh")
      .args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        &machine.ssh_target,
        script,
      ])
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .kill_on_drop(true)
      .spawn()
      .map_err(remote_error)?;
    let mut stdin = child.stdin.take().unwrap();
    let mut stdout = child.stdout.take().unwrap().take(65537);
    let mut stderr = child.stderr.take().unwrap().take(65537);
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let send = async {
      stdin.write_all(input).await?;
      stdin.shutdown().await?;
      drop(stdin);
      Ok::<_, std::io::Error>(())
    };
    let (_, _, _, status) = tokio::try_join!(
      send,
      stdout.read_to_end(&mut output),
      stderr.read_to_end(&mut errors),
      child.wait()
    )?;
    if !status.success() {
      return Err(remote_error(format!(
        "SSH operation failed ({status}): {}",
        String::from_utf8_lossy(&errors).trim()
      )));
    }
    if output.len() > 65536 || errors.len() > 65536 {
      return Err(remote_error("SSH output exceeded limit"));
    }
    String::from_utf8(output).map_err(remote_error)
  })
  .await
  .map_err(|_| remote_error("SSH operation timed out; verify connectivity and retry"))?
}

fn parse_platform(output: &str) -> Result<&'static str> {
  let line = output
    .lines()
    .find_map(|line| line.strip_prefix("NAFM_PLATFORM\t"))
    .ok_or_else(|| remote_error("SSH did not return a platform identifier"))?;
  let (os, arch) = line
    .trim()
    .split_once('\t')
    .ok_or_else(|| remote_error("invalid platform identifier"))?;
  target_for(os, arch).map_err(remote_error)
}

async fn detect_platform(machine: &RemoteMachine) -> Result<&'static str> {
  let posix = ssh(
    machine,
    "os=$(uname -s); arch=$(uname -m); if [ \"$os\" = Darwin ] && [ \"$(sysctl -n hw.optional.arm64 2>/dev/null)\" = 1 ]; then arch=arm64; fi; printf 'NAFM_PLATFORM\\t%s\\t%s\\n' \"$os\" \"$arch\"",
    &[],
    Duration::from_secs(20),
  )
  .await;
  match posix {
    Ok(output) if output.lines().any(|line| line.starts_with("NAFM_PLATFORM\t")) => parse_platform(&output),
    posix => {
      let script = "$arch = $env:PROCESSOR_ARCHITEW6432; if (!$arch) { $arch = $env:PROCESSOR_ARCHITECTURE }; [Console]::WriteLine(\"NAFM_PLATFORM`tWindows`t\" + $arch)";
      let windows = ssh(machine, &powershell_command(script), &[], Duration::from_secs(20)).await;
      match windows {
        Ok(output) => parse_platform(&output),
        Err(error) => Err(remote_error(format!(
          "Could not detect remote OS/architecture. POSIX probe: {posix:?}; Windows probe: {error}"
        ))),
      }
    }
  }
}

fn upload_script(target: &str, directory_id: &str) -> String {
  // directory_id is generated locally, not remote output or a user-supplied path.
  if target == TARGETS[1] {
    powershell_command(&format!(
      "$ErrorActionPreference = 'Stop'; [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); if (!$env:LOCALAPPDATA) {{ throw 'LOCALAPPDATA is unavailable' }}; $dir = Join-Path $env:LOCALAPPDATA 'nafm\\agents\\{directory_id}'; New-Item -ItemType Directory -Path $dir -ErrorAction Stop | Out-Null; $path = Join-Path $dir 'nafm-agent.exe'; $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); [IO.File]::WriteAllBytes($path + '.tmp', $bytes); Move-Item -LiteralPath ($path + '.tmp') -Destination $path; [Console]::WriteLine('NAFM_PATH' + [char]9 + $path)"
    ))
  } else {
    let decode = if target == TARGETS[2] {
      "/usr/bin/base64 -D"
    } else {
      "base64 -d"
    };
    format!(
      "set -eu; umask 077; test -n \"$HOME\"; dir=\"$HOME/.local/share/nafm/agents/{directory_id}\"; mkdir -p \"$HOME/.local/share/nafm/agents\"; mkdir \"$dir\"; {decode} > \"$dir/nafm-agent.tmp\"; chmod 700 \"$dir/nafm-agent.tmp\"; mv \"$dir/nafm-agent.tmp\" \"$dir/nafm-agent\"; printf 'NAFM_PATH\\t%s\\n' \"$dir/nafm-agent\""
    )
  }
}

pub(crate) async fn install(
  machine: &RemoteMachine,
  bundle_directory: PathBuf,
  progress: &(dyn Fn(&str) + Send + Sync),
) -> Result<AgentInstallation> {
  progress("Checking bundled agents");
  let (manifest, bundle_directory) = tokio::task::spawn_blocking(move || {
    let manifest = AgentManifest::load(&bundle_directory).map_err(remote_error)?;
    Ok::<_, NafmError>((manifest, bundle_directory))
  })
  .await??;
  progress("Detecting remote OS and architecture");
  let target = detect_platform(machine).await?;
  let artifact = manifest.artifacts.iter().find(|entry| entry.target == target).unwrap();
  let bytes = tokio::fs::read(bundle_directory.join(&artifact.file_name)).await?;
  if bytes.len() > 32 * 1024 * 1024 || blake3::hash(&bytes).to_hex().as_str() != artifact.blake3 {
    return Err(remote_error("agent artifact changed or exceeds 32 MiB"));
  }
  progress(&format!("Uploading {target} to a private user directory"));
  let directory_id = uuid::Uuid::new_v4().to_string();
  let output = ssh(
    machine,
    &upload_script(target, &directory_id),
    STANDARD.encode(bytes).as_bytes(),
    Duration::from_secs(180),
  )
  .await?;
  let path = output
    .lines()
    .find_map(|line| line.strip_prefix("NAFM_PATH\t"))
    .ok_or_else(|| remote_error("installer did not return its executable path"))?
    .trim_end_matches('\r')
    .to_owned();
  if !is_remote_absolute(&path) {
    return Err(remote_error("installer returned a non-absolute path"));
  }
  let installation = AgentInstallation {
    target: target.into(),
    agent_version: manifest.agent_version,
    executable_path: path,
    executable_hash: artifact.blake3.clone(),
  };
  progress("Verifying remote executable, protocol and hash support");
  let mut candidate = machine.clone();
  candidate.agent_installation = Some(installation.clone());
  let responses = crate::remote::execute_remote_agent(
    &candidate,
    &RemoteAgentRequest::Probe {
      protocol_version: REMOTE_AGENT_PROTOCOL_VERSION,
      remote_root: None,
    },
  )
  .await?;
  let valid = responses.iter().any(|response| match response {
    RemoteAgentResponse::Ready {
      protocol_version,
      agent_version,
      hash_algorithms,
      os,
      arch,
      executable_hash,
    } => {
      *protocol_version == REMOTE_AGENT_PROTOCOL_VERSION
        && agent_version == &installation.agent_version
        && hash_algorithms.iter().any(|value| value == "blake3")
        && executable_hash == &installation.executable_hash
        && target_for(os, arch).ok() == Some(target)
    }
    _ => false,
  });
  if !valid {
    return Err(remote_error(
      "installed agent verification failed; previous installation remains selected",
    ));
  }
  Ok(installation)
}

/// Remote paths are opaque on the client. Validation here accepts both OS families;
/// the agent performs the definitive native absolute-path and directory checks.
pub(crate) fn is_remote_absolute(value: &str) -> bool {
  let bytes = value.as_bytes();
  !value.chars().any(char::is_control)
    && (value.starts_with('/')
      || (bytes.len() >= 3 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' && matches!(bytes[2], b'/' | b'\\'))
      || value.starts_with("\\\\"))
}

pub(crate) fn join_remote_path(root: &Path, segments: &[&str]) -> Result<PathBuf> {
  let mut result = root
    .to_str()
    .ok_or_else(|| remote_error("remote root is not UTF-8"))?
    .to_owned();
  for segment in segments {
    if segment.is_empty() || matches!(*segment, "." | "..") || segment.contains(['/', '\\', ':']) {
      return Err(remote_error("unsafe path segment in SMB mapping"));
    }
    // Both Windows and POSIX accept forward slash; never use client-side Path::join.
    if !result.ends_with('/') && !result.ends_with('\\') {
      result.push('/');
    }
    result.push_str(segment);
  }
  Ok(PathBuf::from(result))
}

#[cfg(test)]
mod tests {
  use super::*;

  fn run_local_script(script: &str, payload: &[u8], test_home: &Path) -> std::process::Output {
    use std::io::Write;
    let mut command = if cfg!(windows) {
      let mut command = std::process::Command::new("powershell.exe");
      command.args(script.strip_prefix("powershell.exe ").unwrap().split_whitespace());
      command
    } else {
      let mut command = std::process::Command::new("sh");
      command.args(["-c", script]);
      command
    };
    let mut child = command
      .env("NAFM_TEST_HOME", test_home)
      .stdin(Stdio::piped())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .unwrap();
    let mut input = child.stdin.take().unwrap();
    input.write_all(payload).unwrap();
    drop(input);
    child.wait_with_output().unwrap()
  }

  #[test]
  #[ignore = "requires NAFM_TEST_AGENT pointing to the native cross-built artifact"]
  fn native_install_scripts_round_trip_agent() {
    let binary = std::env::var("NAFM_TEST_AGENT").expect("set NAFM_TEST_AGENT");
    let binary = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").join(binary);
    let target = target_for(std::env::consts::OS, std::env::consts::ARCH).unwrap();
    let root = tempfile::tempdir().unwrap();
    let test_home = root.path().join("O'Neil & 照片");
    std::fs::create_dir(&test_home).unwrap();
    let script = upload_script(target, "test-install");
    // Redirect only this script's install root into a fixture, never the real profile.
    let script = if cfg!(windows) {
      let encoded = script.split_whitespace().last().unwrap();
      let bytes = STANDARD.decode(encoded).unwrap();
      let utf16: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
      powershell_command(
        &String::from_utf16(&utf16)
          .unwrap()
          .replace("$env:LOCALAPPDATA", "$env:NAFM_TEST_HOME"),
      )
    } else {
      script.replace("$HOME", "$NAFM_TEST_HOME")
    };
    let bytes = std::fs::read(binary).unwrap();
    let output = run_local_script(&script, STANDARD.encode(&bytes).as_bytes(), &test_home);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let stdout = String::from_utf8(output.stdout).unwrap();
    let executable_path = stdout
      .lines()
      .find_map(|line| line.strip_prefix("NAFM_PATH\t"))
      .unwrap()
      .to_owned();
    assert_eq!(std::fs::read(&executable_path).unwrap(), bytes);
    let machine = RemoteMachine {
      id: "test".into(),
      name: "test".into(),
      ssh_target: "unused".into(),
      added_at: chrono::Utc::now(),
      agent_installation: Some(AgentInstallation {
        target: target.into(),
        executable_path,
        executable_hash: String::new(),
        agent_version: String::new(),
      }),
    };
    let payload = serde_json::to_vec(&RemoteAgentRequest::Probe {
      protocol_version: REMOTE_AGENT_PROTOCOL_VERSION,
      remote_root: Some(test_home.clone()),
    })
    .unwrap();
    let output = run_local_script(&agent_command(&machine).unwrap(), &payload, &test_home);
    assert!(output.status.success(), "{}", String::from_utf8_lossy(&output.stderr));
    let response: RemoteAgentResponse = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
      matches!(response, RemoteAgentResponse::Ready { executable_hash, .. } if executable_hash == blake3::hash(&bytes).to_hex().as_str())
    );
  }

  #[test]
  fn remote_paths_do_not_depend_on_client_os() {
    for path in ["/volume1/Media", "C:\\Media", "D:/Photos", "\\\\server\\share"] {
      assert!(is_remote_absolute(path));
    }
    for path in ["relative", "C:relative", "~/.media", "/bad\npath"] {
      assert!(!is_remote_absolute(path));
    }
    assert_eq!(
      join_remote_path(Path::new("C:\\Media"), &["Photos", "2026"])
        .unwrap()
        .to_str()
        .unwrap(),
      "C:\\Media/Photos/2026"
    );
    assert!(join_remote_path(Path::new("/media"), &[".."]).is_err());
    assert!(join_remote_path(Path::new("/media"), &["C:evil"]).is_err());
  }

  #[test]
  fn scripts_quote_apostrophes_and_metacharacters() {
    assert_eq!(quote_posix("/home/o'neil/$bin"), "'/home/o'\\''neil/$bin'");
    assert_eq!(quote_powershell("C:\\O'Neil\\$bin.exe"), "'C:\\O''Neil\\$bin.exe'");
    assert_eq!(
      parse_platform("banner\nNAFM_PLATFORM\tWindows\tAMD64\r\n").unwrap(),
      TARGETS[1]
    );
    assert!(parse_platform("NAFM_PLATFORM\tLinux\taarch64").is_err());
  }
}
