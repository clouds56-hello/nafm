use std::path::PathBuf;
use std::process::Stdio;

use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;

use crate::error::{NafmError, Result};
use crate::model::{HiddenPolicy, RemoteMachine};

pub const REMOTE_AGENT_PROTOCOL_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RemoteFileMetadata {
  pub relative_path: String,
  pub size_bytes: u64,
  pub modified_unix_nanos: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
pub enum RemoteAgentRequest {
  Probe {
    protocol_version: u32,
    remote_root: Option<PathBuf>,
  },
  Discover {
    protocol_version: u32,
    remote_root: PathBuf,
    hidden_policy: HiddenPolicy,
  },
  Hash {
    protocol_version: u32,
    remote_root: PathBuf,
    hash_algorithm: String,
    files: Vec<RemoteFileMetadata>,
  },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RemoteAgentResponse {
  Ready {
    protocol_version: u32,
    agent_version: String,
    hash_algorithms: Vec<String>,
  },
  File {
    file: RemoteFileMetadata,
  },
  DiscoveryComplete {
    file_count: u64,
  },
  Hash {
    relative_path: String,
    content_hash: String,
  },
  HashComplete {
    file_count: u64,
  },
  Error {
    message: String,
  },
}

pub(crate) async fn execute_remote_agent(
  machine: &RemoteMachine,
  request: &RemoteAgentRequest,
) -> Result<Vec<RemoteAgentResponse>> {
  execute_remote_agent_cancellable(machine, request, None).await
}

pub(crate) async fn execute_remote_agent_cancellable(
  machine: &RemoteMachine,
  request: &RemoteAgentRequest,
  cancellation_callback: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<Vec<RemoteAgentResponse>> {
  let mut responses = Vec::new();
  execute_remote_agent_with_handler(machine, request, cancellation_callback, |response| {
    responses.push(response);
    Ok(())
  })
  .await?;
  Ok(responses)
}

pub(crate) async fn execute_remote_agent_with_handler(
  machine: &RemoteMachine,
  request: &RemoteAgentRequest,
  cancellation_callback: Option<&(dyn Fn() -> bool + Send + Sync)>,
  mut response_handler: impl FnMut(RemoteAgentResponse) -> Result<()> + Send,
) -> Result<()> {
  validate_ssh_target(&machine.ssh_target)?;
  let mut child = Command::new("ssh")
    .args([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      &machine.ssh_target,
      "nafm-agent",
    ])
    .stdin(Stdio::piped())
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .kill_on_drop(true)
    .spawn()
    .map_err(|error| NafmError::RemoteAgent(format!("failed to start ssh: {error}")))?;

  let mut input = child.stdin.take().expect("piped ssh stdin should be available");
  let mut payload = serde_json::to_vec(request)?;
  payload.push(b'\n');
  input.write_all(&payload).await?;
  input.shutdown().await?;
  drop(input);

  let stdout = child.stdout.take().expect("piped ssh stdout should be available");
  let mut stderr = child.stderr.take().expect("piped ssh stderr should be available");
  let stderr_task = tokio::spawn(async move {
    let mut bytes = Vec::new();
    stderr.read_to_end(&mut bytes).await.map(|_| bytes)
  });
  let mut lines = BufReader::new(stdout).lines();
  loop {
    tokio::select! {
      line = lines.next_line() => {
        let Some(line) = line? else {
          break;
        };
        if line.trim().is_empty() {
          continue;
        }
        let response: RemoteAgentResponse = serde_json::from_str(&line)
          .map_err(|error| NafmError::RemoteAgent(format!("invalid agent response: {error}")))?;
        if let RemoteAgentResponse::Error { message } = &response {
          let _ = child.kill().await;
          stderr_task.abort();
          return Err(NafmError::RemoteAgent(message.clone()));
        }
        response_handler(response)?;
      }
      () = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
        if cancellation_callback.is_some_and(|is_cancelled| is_cancelled()) {
          let _ = child.kill().await;
          let _ = child.wait().await;
          stderr_task.abort();
          return Err(NafmError::ScanCancelled);
        }
      }
    }
  }
  let status = child.wait().await?;
  let stderr_bytes = stderr_task.await??;
  let stderr = String::from_utf8_lossy(&stderr_bytes).trim().to_owned();
  if !status.success() {
    let message = if stderr.is_empty() {
      format!("ssh exited with status {status}")
    } else {
      stderr
    };
    return Err(NafmError::RemoteAgent(message));
  }
  Ok(())
}

fn validate_ssh_target(value: &str) -> Result<()> {
  if value.is_empty()
    || value.starts_with('-')
    || value
      .chars()
      .any(|character| character.is_whitespace() || character.is_control())
  {
    return Err(NafmError::InvalidSshTarget(value.to_owned()));
  }
  Ok(())
}
