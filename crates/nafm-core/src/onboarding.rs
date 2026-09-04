use std::{path::PathBuf, time::Duration};

use chrono::{DateTime, Utc};
use serde::Serialize;

use crate::{
  NafmError, REMOTE_AGENT_PROTOCOL_VERSION, RemoteAgentRequest, RemoteAgentResponse, RemoteFileMetadata, RemoteMachine,
  Result, SmbLocation,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CheckStatus {
  Passed,
  Failed,
  Skipped,
  Warning,
}

#[derive(Debug, Serialize)]
pub struct SetupCheck {
  pub stage: String,
  pub status: CheckStatus,
  pub message: String,
  pub remedy: Option<String>,
}

impl SetupCheck {
  fn new(stage: &str, status: CheckStatus, message: impl Into<String>, remedy: Option<&str>) -> Self {
    Self {
      stage: stage.into(),
      status,
      message: message.into(),
      remedy: remedy.map(str::to_owned),
    }
  }
}

#[derive(Serialize)]
pub struct PreflightReport {
  pub machine_id: String,
  pub ssh_target: String,
  pub checked_at: DateTime<Utc>,
  pub checks: Vec<SetupCheck>,
  pub target: Option<String>,
  pub can_install: bool,
  pub agent_ready: bool,
}

#[derive(Serialize)]
pub struct MappingPreview {
  pub smb_root: String,
  pub remote_root: PathBuf,
  pub checked_at: DateTime<Utc>,
  pub check: SetupCheck,
  pub files: Vec<RemoteFileMetadata>,
  pub truncated: bool,
}

fn connection_checks(result: std::result::Result<String, String>) -> Vec<SetupCheck> {
  let mut checks = ["connectivity", "host_key", "authentication"]
    .map(|stage| SetupCheck::new(stage, CheckStatus::Skipped, "Not confirmed", None))
    .into_iter()
    .collect::<Vec<_>>();
  let error = match result {
    Ok(output) if output.lines().any(|line| line.trim() == "NAFM_SSH_READY") => {
      for check in &mut checks {
        check.status = CheckStatus::Passed;
        check.message =
          "Confirmed by an authenticated SSH session; an existing master retains its original trust decision".into();
      }
      return checks;
    }
    Ok(_) => "SSH did not return the expected marker; check the remote login shell".into(),
    Err(error) => error,
  };
  let lower = error.to_ascii_lowercase();
  let (index, remedy) = if lower.contains("host key verification failed")
    || lower.contains("remote host identification has changed")
    || lower.contains("host key is known")
  {
    (
      Some(1),
      "Verify the server fingerprint through a trusted channel, then resolve its known_hosts entry using system SSH. NAFM never accepts keys automatically.",
    )
  } else if lower.contains("permission denied (")
    || lower.contains("authentication failed")
    || lower.contains("too many authentication failures")
  {
    (
      Some(2),
      "Check the SSH user, key, password, or MFA response. OpenSSH chooses authentication methods; cancelling a prompt stops this attempt.",
    )
  } else if lower.contains("ssh operation timed out") {
    (
      None,
      "SSH did not finish within the time limit. Check connectivity and whether the remote login shell can execute commands.",
    )
  } else if [
    "could not resolve",
    "connection refused",
    "timed out",
    "no route to host",
    "network is unreachable",
  ]
  .iter()
  .any(|text| lower.contains(text))
  {
    (
      Some(0),
      "Check the hostname, network/VPN, SSH port, and whether the SSH server is running.",
    )
  } else {
    (
      None,
      "Check this alias with system SSH and verify that its login shell permits commands. Unconfirmed stages are not necessarily failures.",
    )
  };
  let check = SetupCheck::new(
    index.map_or("ssh_session", |index| checks[index].stage.as_str()),
    CheckStatus::Failed,
    error,
    Some(remedy),
  );
  if let Some(index) = index {
    checks[index] = check;
  } else {
    checks.push(check);
  }
  checks
}

pub(crate) async fn preflight(
  machine: &RemoteMachine,
  directory: PathBuf,
  progress: &(dyn Fn(&str) + Send + Sync),
) -> PreflightReport {
  let mut report = PreflightReport {
    machine_id: machine.id.clone(),
    ssh_target: machine.ssh_target.clone(),
    checked_at: Utc::now(),
    checks: Vec::new(),
    target: None,
    can_install: false,
    agent_ready: false,
  };
  progress("Checking local SSH client");
  let local = tokio::time::timeout(
    Duration::from_secs(5),
    tokio::process::Command::new("ssh")
      .arg("-V")
      .kill_on_drop(true)
      .output(),
  )
  .await;
  if !matches!(local, Ok(Ok(ref output)) if output.status.success()) {
    report.checks.push(SetupCheck::new(
      "local_ssh",
      CheckStatus::Failed,
      "Cannot run system SSH",
      Some("Install OpenSSH and make ssh available on the desktop application's PATH."),
    ));
    for stage in [
      "connectivity",
      "host_key",
      "authentication",
      "platform",
      "agent",
      "bundle",
    ] {
      report.checks.push(SetupCheck::new(
        stage,
        CheckStatus::Skipped,
        "Requires a working local SSH client",
        None,
      ));
    }
    return report;
  }
  report.checks.push(SetupCheck::new(
    "local_ssh",
    CheckStatus::Passed,
    "System SSH is available",
    None,
  ));
  progress("Checking connectivity, host-key trust, and authentication");
  let connection = crate::installer::ssh_with_session(machine, "echo NAFM_SSH_READY", &[], Duration::from_secs(20))
    .await
    .map_err(|error| error.to_string());
  let session = connection.as_ref().ok().map(|(_, session)| *session);
  let checks = connection_checks(connection.map(|(output, _)| output));
  let connected = checks.iter().all(|check| check.status == CheckStatus::Passed);
  report.checks.extend(checks);
  if session == Some("existing_master")
    && let Some(check) = report.checks.iter_mut().find(|check| check.stage == "host_key")
  {
    check.status = CheckStatus::Warning;
    check.message = "Trust inherited from the existing SSH master; NAFM did not perform a fresh host-key check".into();
  }
  if let Some(session) = session {
    report.checks.push(SetupCheck::new(
      "session",
      CheckStatus::Passed,
      match session {
        "existing_master" => "Using existing SSH session; no fresh host-key handshake was performed",
        "app_master" => "Using NAFM-owned SSH session; retained until app exit",
        _ => "Using system SSH; host-key checks apply to new connections",
      },
      None,
    ));
  }
  if connected {
    progress("Detecting remote OS and architecture");
    match crate::installer::detect_platform(machine).await {
      Err(error @ NafmError::SshConnection(_)) => {
        report.checks.push(SetupCheck::new(
          "platform",
          CheckStatus::Failed,
          error.to_string(),
          Some("Connection interrupted or authentication cancelled. Retry when ready."),
        ));
        for stage in ["agent", "bundle"] {
          report.checks.push(SetupCheck::new(
            stage,
            CheckStatus::Skipped,
            "Preflight stopped after SSH connection failure",
            None,
          ));
        }
        report.checked_at = Utc::now();
        return report;
      }
      Ok(target) => {
        report.target = Some(target.into());
        report
          .checks
          .push(SetupCheck::new("platform", CheckStatus::Passed, target, None));
      }
      Err(error) => report.checks.push(SetupCheck::new(
        "platform",
        CheckStatus::Failed,
        error.to_string(),
        Some(
          "Bundled agents support Linux x64, Windows x64, and macOS ARM64. Check the remote shell and architecture.",
        ),
      )),
    }
    progress("Probing the selected agent (no installation)");
    let agent = crate::remote::execute_remote_agent(
      machine,
      &RemoteAgentRequest::Probe {
        protocol_version: REMOTE_AGENT_PROTOCOL_VERSION,
        remote_root: None,
      },
    )
    .await;
    let message = match agent {
      Ok(responses) => {
        report.agent_ready = responses.iter().any(|response| matches!(response, RemoteAgentResponse::Ready { protocol_version: REMOTE_AGENT_PROTOCOL_VERSION, hash_algorithms, capabilities, .. } if hash_algorithms.iter().any(|value| value == "blake3") && capabilities.iter().any(|value| value == "path_preview")));
        if report.agent_ready {
          "Agent supports hashing and path preview".into()
        } else {
          "Agent is missing required protocol, hash, or path-preview support".into()
        }
      }
      Err(error) => error.to_string(),
    };
    report.checks.push(SetupCheck::new(
      "agent",
      if report.agent_ready {
        CheckStatus::Passed
      } else {
        CheckStatus::Warning
      },
      message,
      if report.agent_ready {
        None
      } else {
        Some("Install or update the bundled agent after reviewing the detected target and destination.")
      },
    ));
  } else {
    for stage in ["platform", "agent"] {
      report.checks.push(SetupCheck::new(
        stage,
        CheckStatus::Skipped,
        "Requires a successful SSH session",
        None,
      ));
    }
  }
  progress("Verifying bundled agent artifacts");
  let bundle = tokio::task::spawn_blocking(move || nafm_bundle::AgentManifest::load(&directory)).await;
  let (valid, message) = match bundle {
    Ok(Ok(_)) => (true, "All bundled artifacts passed integrity checks".into()),
    Ok(Err(error)) => (false, error.to_string()),
    Err(error) => (false, error.to_string()),
  };
  report.checks.push(SetupCheck::new(
    "bundle",
    if valid {
      CheckStatus::Passed
    } else {
      CheckStatus::Failed
    },
    message,
    if valid {
      None
    } else {
      Some("Rebuild the agent bundle or reinstall a complete NAFM app.")
    },
  ));
  report.can_install = connected && report.target.is_some() && valid;
  report.checked_at = Utc::now();
  report
}

pub(crate) async fn preview(machine: &RemoteMachine, smb_root: &str, remote_root: PathBuf) -> Result<MappingPreview> {
  let location = SmbLocation::parse(smb_root)?;
  if !crate::installer::is_remote_absolute(&remote_root.to_string_lossy()) {
    return Err(NafmError::RemoteAgent(
      "Remote root must be an absolute native path".into(),
    ));
  }
  let mut preview = MappingPreview {
    smb_root: location.normalized_url,
    remote_root: remote_root.clone(),
    checked_at: Utc::now(),
    check: SetupCheck::new(
      "path",
      CheckStatus::Failed,
      "Agent returned no valid path preview",
      Some("Install/update the agent, then check the native directory and this SSH user's list/read permissions."),
    ),
    files: Vec::new(),
    truncated: false,
  };
  match crate::remote::execute_remote_agent(
    machine,
    &RemoteAgentRequest::Preview {
      protocol_version: REMOTE_AGENT_PROTOCOL_VERSION,
      remote_root,
    },
  )
  .await
  {
    Ok(responses) => {
      for response in responses {
        if let RemoteAgentResponse::Preview { files, truncated } = response {
          if files.len() > 5
            || files.iter().any(|file| {
              file.relative_path.is_empty()
                || file
                  .relative_path
                  .split('/')
                  .any(|part| part.is_empty() || part == "." || part == "..")
            })
          {
            break;
          }
          preview.files = files;
          preview.truncated = truncated;
          preview.check = SetupCheck::new(
            "path",
            CheckStatus::Passed,
            if preview.files.is_empty() {
              "Directory traversal succeeded; no file-read permissions sampled"
            } else {
              "Directory traversal and sampled file reads succeeded"
            },
            None,
          );
          break;
        }
      }
    }
    Err(error) => preview.check.message = error.to_string(),
  }
  preview.checked_at = Utc::now();
  Ok(preview)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn connection_requires_marker() {
    assert!(
      connection_checks(Ok("banner\nNAFM_SSH_READY\r\n".into()))
        .iter()
        .all(|check| check.status == CheckStatus::Passed)
    );
    assert!(
      !connection_checks(Ok("welcome".into()))
        .iter()
        .any(|check| check.status == CheckStatus::Passed)
    );
  }

  #[test]
  fn failures_do_not_claim_other_stages_passed() {
    for (error, stage) in [
      ("Host key verification failed.", "host_key"),
      ("Permission denied (publickey).", "authentication"),
      ("Connection refused", "connectivity"),
    ] {
      let checks = connection_checks(Err(error.into()));
      assert!(
        checks
          .iter()
          .any(|check| check.stage == stage && check.status == CheckStatus::Failed && check.remedy.is_some())
      );
      assert!(!checks.iter().any(|check| check.status == CheckStatus::Passed));
    }
  }

  #[test]
  fn command_timeout_is_not_claimed_as_connectivity_failure() {
    let checks = connection_checks(Err("SSH operation timed out; verify connectivity and retry".into()));
    assert!(
      checks
        .iter()
        .any(|check| check.stage == "ssh_session" && check.status == CheckStatus::Failed)
    );
    assert!(
      checks
        .iter()
        .any(|check| check.stage == "connectivity" && check.status == CheckStatus::Skipped)
    );
  }
}
