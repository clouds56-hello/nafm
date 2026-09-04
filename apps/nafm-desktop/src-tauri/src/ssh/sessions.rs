use std::{
  collections::HashMap,
  future::Future,
  path::{Path, PathBuf},
  pin::Pin,
  process::Stdio,
  sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
  },
  time::Duration,
};

use nafm_core::{NafmError, SshConnection, SshConnector};
use tokio::{
  process::Command,
  sync::{Mutex as AsyncMutex, Notify},
};

use super::{askpass::Broker, prompts::PromptHub};

pub struct Sessions {
  program: PathBuf,
  hub: Arc<PromptHub>,
  gates: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
  #[cfg(unix)]
  owned: Mutex<HashMap<String, OwnedMaster>>,
  closed: AtomicBool,
  stopping: Notify,
}

#[cfg(unix)]
struct OwnedMaster {
  child: tokio::process::Child,
  stderr_reader: tokio::task::JoinHandle<()>,
  directory: tempfile::TempDir,
}

#[cfg(unix)]
impl Drop for OwnedMaster {
  fn drop(&mut self) {
    let _ = self.child.start_kill();
    self.stderr_reader.abort();
  }
}

fn error(value: impl ToString) -> NafmError {
  NafmError::SshConnection(value.to_string())
}

fn ssh(program: &Path, interactive: bool) -> Command {
  let mut command = Command::new(program);
  command
    .args([
      "-T",
      "-o",
      if interactive { "BatchMode=no" } else { "BatchMode=yes" },
      "-o",
      if interactive {
        "StrictHostKeyChecking=ask"
      } else {
        "StrictHostKeyChecking=yes"
      },
      "-o",
      "FingerprintHash=sha256",
      "-o",
      "VisualHostKey=no",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "AddKeysToAgent=no",
    ])
    .env("LC_ALL", "C")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::piped())
    .kill_on_drop(true);
  #[cfg(target_os = "macos")]
  command.args(["-o", "UseKeychain=no"]);
  command
}

async fn master_exists(program: &Path, target: &str, path: Option<&Path>) -> bool {
  let mut command = ssh(program, false);
  if let Some(path) = path {
    command.arg("-S").arg(path);
  }
  command.args(["-O", "check", target]).stderr(Stdio::null());
  matches!(tokio::time::timeout(Duration::from_secs(3), command.status()).await, Ok(Ok(status)) if status.success())
}

fn leased(command: Command, session: &'static str) -> SshConnection {
  SshConnection {
    command,
    session,
    minimum_timeout: Duration::ZERO,
    guard: None,
    cancelled: None,
  }
}

impl Sessions {
  pub fn new(hub: Arc<PromptHub>) -> Self {
    Self {
      program: PathBuf::from("ssh"),
      hub,
      gates: Mutex::new(HashMap::new()),
      #[cfg(unix)]
      owned: Mutex::new(HashMap::new()),
      closed: AtomicBool::new(false),
      stopping: Notify::new(),
    }
  }

  pub fn shutdown(&self) {
    self.closed.store(true, Ordering::SeqCst);
    self.stopping.notify_waiters();
    // Only these children and private socket directories belong to NAFM.
    #[cfg(unix)]
    if let Ok(mut masters) = self.owned.lock() {
      masters.clear();
    }
  }

  async fn prepare(&self, target: &str) -> nafm_core::Result<SshConnection> {
    self.prepare_mode(target, true).await
  }

  async fn prepare_mode(&self, target: &str, interactive: bool) -> nafm_core::Result<SshConnection> {
    let gate = self
      .gates
      .lock()
      .map_err(error)?
      .entry(target.into())
      .or_default()
      .clone();
    let _lock = gate.lock().await;
    if self.closed.load(Ordering::SeqCst) {
      return Err(error("SSH sessions are closing"));
    }
    if master_exists(&self.program, target, None).await {
      // No exit/check-in mutation of somebody else's master. OpenSSH resolves its configured path.
      let mut command = ssh(&self.program, false);
      command.args(["-o", "ControlMaster=no"]);
      return Ok(leased(command, "existing_master"));
    }
    #[cfg(unix)]
    {
      let path = {
        let mut owned = self.owned.lock().map_err(error)?;
        let path = if let Some(master) = owned.get_mut(target) {
          if master.child.try_wait().map_err(error)?.is_none() {
            Some(master.directory.path().join("s"))
          } else {
            None
          }
        } else {
          None
        };
        if path.is_none() {
          owned.remove(target);
        }
        path
      };
      if let Some(path) = path {
        if master_exists(&self.program, target, Some(&path)).await {
          return Ok(owned_connection(&self.program, &path));
        }
        self.owned.lock().map_err(error)?.remove(target);
      }
      if interactive {
        self.start_master(target).await
      } else {
        Ok(leased(ssh(&self.program, false), "system_ssh"))
      }
    }
    #[cfg(not(unix))]
    {
      if !interactive {
        return Ok(leased(ssh(&self.program, false), "system_ssh"));
      }
      // Windows OpenSSH clients do not consistently implement multiplexing.
      // Preserve configured reuse if supported; otherwise prompt per connection.
      let broker = Broker::start(self.hub.clone(), target.into()).await.map_err(error)?;
      let mut command = ssh(&self.program, true);
      broker.configure(&mut command).map_err(error)?;
      Ok(SshConnection {
        command,
        session: "new_connection",
        minimum_timeout: Duration::from_secs(185),
        cancelled: Some(broker.cancelled.clone()),
        guard: Some(Box::new(broker)),
      })
    }
  }

  #[cfg(unix)]
  async fn start_master(&self, target: &str) -> nafm_core::Result<SshConnection> {
    use tokio::io::AsyncReadExt;
    // Short path avoids sockaddr_un limits; tempfile creates a private 0700 directory.
    let directory = tempfile::Builder::new()
      .prefix("nafm-ssh-")
      .tempdir_in("/tmp")
      .map_err(error)?;
    let path = directory.path().join("s");
    let broker = Broker::start(self.hub.clone(), target.into()).await.map_err(error)?;
    let mut command = ssh(&self.program, true);
    broker.configure(&mut command).map_err(error)?;
    command
      .args([
        "-N",
        "-o",
        "ControlMaster=yes",
        "-o",
        "ControlPersist=no",
        "-o",
        "ForkAfterAuthentication=no",
        "-o",
        "RemoteCommand=none",
        "-o",
        "ClearAllForwardings=yes",
      ])
      .arg("-S")
      .arg(&path)
      .arg(target);
    let mut child = command.spawn().map_err(error)?;
    let mut stderr = child.stderr.take().ok_or_else(|| error("Missing SSH stderr"))?;
    let mut errors = Vec::new();
    let deadline = tokio::time::sleep(Duration::from_secs(185));
    tokio::pin!(deadline);
    loop {
      if broker.cancelled.load(Ordering::SeqCst) {
        return Err(error("SSH authentication cancelled or timed out"));
      }
      if let Some(status) = child.try_wait().map_err(error)? {
        // Bounded trailing diagnostics (not responses) help resolve host-key failures.
        let mut tail = Vec::new();
        let _ = tokio::time::timeout(Duration::from_secs(1), (&mut stderr).take(65536).read_to_end(&mut tail)).await;
        errors.extend(tail);
        errors.truncate(65536);
        return Err(error(format!(
          "SSH connection failed ({status}): {}",
          String::from_utf8_lossy(&errors)
        )));
      }
      if path.exists() && master_exists(&self.program, target, Some(&path)).await {
        let mut owned = self.owned.lock().map_err(error)?;
        if self.closed.load(Ordering::SeqCst) {
          return Err(error("SSH sessions are closing"));
        }
        let stderr_reader = tokio::spawn(async move {
          let _ = tokio::io::copy(&mut stderr, &mut tokio::io::sink()).await;
        });
        owned.insert(
          target.into(),
          OwnedMaster {
            child,
            stderr_reader,
            directory,
          },
        );
        return Ok(owned_connection(&self.program, &path));
      }
      let mut bytes = [0_u8; 4096];
      tokio::select! {
        _ = &mut deadline => return Err(error("SSH authentication timed out")),
        read = stderr.read(&mut bytes) => {
          let count = read.map_err(error)?;
          errors.extend_from_slice(&bytes[..count.min(65536_usize.saturating_sub(errors.len()))]);
          if count == 0 { tokio::time::sleep(Duration::from_millis(50)).await; }
        }
        _ = tokio::time::sleep(Duration::from_millis(100)) => {}
      }
    }
  }
}

#[cfg(unix)]
fn owned_connection(program: &Path, path: &Path) -> SshConnection {
  let mut command = ssh(program, false);
  command.args(["-o", "ControlMaster=no"]).arg("-S").arg(path);
  leased(command, "app_master")
}

impl SshConnector for Sessions {
  fn connect_quiet<'a>(
    &'a self,
    target: &'a str,
  ) -> Pin<Box<dyn Future<Output = nafm_core::Result<SshConnection>> + Send + 'a>> {
    Box::pin(self.prepare_mode(target, false))
  }
  fn connect<'a>(
    &'a self,
    target: &'a str,
  ) -> Pin<Box<dyn Future<Output = nafm_core::Result<SshConnection>> + Send + 'a>> {
    Box::pin(async move {
      let stopping = self.stopping.notified();
      tokio::pin!(stopping);
      stopping.as_mut().enable();
      if self.closed.load(Ordering::SeqCst) {
        return Err(error("SSH sessions are closing"));
      }
      tokio::select! {
        _ = &mut stopping => Err(error("SSH sessions are closing")),
        result = self.prepare(target) => result,
      }
    })
  }
}

#[cfg(test)]
mod tests {
  #[cfg(unix)]
  fn fixture() -> (tempfile::TempDir, super::Sessions) {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let program = directory.path().join("ssh");
    std::fs::write(&program, include_str!("fixtures/ssh.sh")).unwrap();
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700)).unwrap();
    let mut sessions = super::Sessions::new(super::PromptHub::for_test());
    sessions.program = program;
    (directory, sessions)
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn reuses_external_and_owned_masters_and_cleans_only_owned_sockets() {
    use nafm_core::SshConnector;
    let (_directory, sessions) = fixture();
    assert_eq!(sessions.connect("external").await.unwrap().session, "existing_master");
    assert!(sessions.owned.lock().unwrap().is_empty());
    assert_eq!(sessions.connect("owned").await.unwrap().session, "app_master");
    let (pid, path) = {
      let owned = sessions.owned.lock().unwrap();
      let master = owned.get("owned").unwrap();
      (master.child.id(), master.directory.path().to_owned())
    };
    assert_eq!(sessions.connect("owned").await.unwrap().session, "app_master");
    assert_eq!(sessions.owned.lock().unwrap().get("owned").unwrap().child.id(), pid);
    sessions.shutdown();
    assert!(!path.exists());
    assert!(sessions.owned.lock().unwrap().is_empty());
    assert!(sessions.connect("owned").await.is_err());
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn rejected_hosts_are_not_retried_with_weaker_auth_and_shutdown_cancels_startup() {
    use nafm_core::SshConnector;
    let (_directory, sessions) = fixture();
    let error = sessions.connect("rejected").await.err().unwrap().to_string();
    assert!(error.contains("Host key verification failed"));
    assert!(sessions.hub.list().unwrap().is_empty());
    let connecting = sessions.connect("stalled");
    let close = async {
      tokio::time::sleep(std::time::Duration::from_millis(100)).await;
      sessions.shutdown();
    };
    let (result, ()) = tokio::join!(connecting, close);
    assert!(result.is_err());
    assert!(sessions.owned.lock().unwrap().is_empty());
  }

  #[test]
  fn interactive_auth_does_not_relax_host_keys_or_cache_secrets() {
    let command = super::ssh(std::path::Path::new("ssh"), true);
    let args = command
      .as_std()
      .get_args()
      .map(|arg| arg.to_str().unwrap())
      .collect::<Vec<_>>();
    for option in [
      "BatchMode=no",
      "StrictHostKeyChecking=ask",
      "UpdateHostKeys=no",
      "AddKeysToAgent=no",
    ] {
      assert!(args.contains(&option));
    }
    assert!(!args.iter().any(|value| value.starts_with("PreferredAuthentications=")));
    assert!(args.contains(&"FingerprintHash=sha256"));
    assert!(!args.contains(&"StrictHostKeyChecking=no"));
    assert!(!args.contains(&"StrictHostKeyChecking=accept-new"));
  }

  #[cfg(unix)]
  #[tokio::test]
  async fn quiet_completion_reuses_masters_without_creating_auth_prompts() {
    use nafm_core::SshConnector;
    let (_directory, sessions) = fixture();
    assert_eq!(
      sessions.connect_quiet("external").await.unwrap().session,
      "existing_master"
    );
    let connection = sessions.connect_quiet("owned").await.unwrap();
    assert_eq!(connection.session, "system_ssh");
    let args = connection
      .command
      .as_std()
      .get_args()
      .map(|value| value.to_str().unwrap())
      .collect::<Vec<_>>();
    assert!(args.contains(&"BatchMode=yes"));
    assert!(args.contains(&"StrictHostKeyChecking=yes"));
    assert!(sessions.owned.lock().unwrap().is_empty());
    assert!(sessions.hub.list().unwrap().is_empty());
    sessions.connect("owned").await.unwrap();
    assert_eq!(sessions.connect_quiet("owned").await.unwrap().session, "app_master");
    sessions.shutdown();
  }
}
