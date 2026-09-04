use std::process::Stdio;

pub use nafm_protocol::{REMOTE_AGENT_PROTOCOL_VERSION, RemoteAgentRequest, RemoteAgentResponse, RemoteFileMetadata};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::error::{NafmError, Result};
use crate::model::RemoteMachine;

pub(crate) async fn execute_remote_agent(
  machine: &RemoteMachine,
  request: &RemoteAgentRequest,
) -> Result<Vec<RemoteAgentResponse>> {
  execute_remote_agent_mode(machine, request, true).await
}

pub(crate) async fn execute_remote_agent_mode(
  machine: &RemoteMachine,
  request: &RemoteAgentRequest,
  interactive: bool,
) -> Result<Vec<RemoteAgentResponse>> {
  let connection = if interactive {
    crate::ssh::connect_mode(machine, true).await?
  } else {
    // Completion must not sit behind another operation's interactive setup indefinitely.
    tokio::time::timeout(
      std::time::Duration::from_secs(10),
      crate::ssh::connect_mode(machine, false),
    )
    .await
    .map_err(|_| NafmError::SshConnection("SSH session lookup timed out; reconnect for suggestions".into()))??
  };
  let duration = std::time::Duration::from_secs(30).max(connection.minimum_timeout);
  let mut responses = Vec::new();
  tokio::time::timeout(
    duration,
    execute_connected(
      machine,
      request,
      None,
      |response| {
        responses.push(response);
        Ok(())
      },
      connection,
    ),
  )
  .await
  .map_err(|_| NafmError::RemoteAgent("agent request timed out".to_owned()))??;
  Ok(responses)
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
  response_handler: impl FnMut(RemoteAgentResponse) -> Result<()> + Send,
) -> Result<()> {
  let connection = crate::ssh::connect(machine);
  tokio::pin!(connection);
  let connection = loop {
    tokio::select! {
      result = &mut connection => break result?,
      () = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
        if cancellation_callback.is_some_and(|cancelled| cancelled()) { return Err(NafmError::ScanCancelled); }
      }
    }
  };
  execute_connected(machine, request, cancellation_callback, response_handler, connection).await
}

async fn execute_connected(
  machine: &RemoteMachine,
  request: &RemoteAgentRequest,
  cancellation_callback: Option<&(dyn Fn() -> bool + Send + Sync)>,
  response_handler: impl FnMut(RemoteAgentResponse) -> Result<()> + Send,
  connection: crate::SshConnection,
) -> Result<()> {
  crate::ssh::cancellable(
    connection.cancelled.clone(),
    cancellation_callback,
    execute_process(machine, request, cancellation_callback, response_handler, connection),
  )
  .await
}

async fn execute_process(
  machine: &RemoteMachine,
  request: &RemoteAgentRequest,
  cancellation_callback: Option<&(dyn Fn() -> bool + Send + Sync)>,
  mut response_handler: impl FnMut(RemoteAgentResponse) -> Result<()> + Send,
  mut connection: crate::SshConnection,
) -> Result<()> {
  validate_ssh_target(&machine.ssh_target)?;
  let agent_command = crate::installer::agent_command(machine)?;
  let mut child = connection
    .command
    .args([&machine.ssh_target, &agent_command])
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
  // Aborting the operation (timeout, prompt cancellation, scan cancellation)
  // must not leave a detached pipe reader behind.
  struct AbortReader(tokio::task::AbortHandle);
  impl Drop for AbortReader {
    fn drop(&mut self) {
      self.0.abort();
    }
  }
  let _reader = AbortReader(stderr_task.abort_handle());
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

pub(crate) fn validate_ssh_target(value: &str) -> Result<()> {
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
