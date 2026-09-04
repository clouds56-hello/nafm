use std::{
  future::Future,
  pin::Pin,
  sync::{
    Arc, OnceLock,
    atomic::{AtomicBool, Ordering},
  },
  time::Duration,
};

use tokio::process::Command;

use crate::{RemoteMachine, Result};

/// A desktop adapter may attach a prompt broker whose lifetime follows this lease.
pub struct SshConnection {
  pub command: Command,
  pub session: &'static str,
  pub minimum_timeout: Duration,
  pub guard: Option<Box<dyn Send + Sync>>,
  pub cancelled: Option<Arc<AtomicBool>>,
}

pub trait SshConnector: Send + Sync {
  fn connect<'a>(&'a self, target: &'a str) -> Pin<Box<dyn Future<Output = Result<SshConnection>> + Send + 'a>>;
}

static CONNECTOR: OnceLock<Arc<dyn SshConnector>> = OnceLock::new();

pub fn set_ssh_connector(connector: Arc<dyn SshConnector>) -> bool {
  CONNECTOR.set(connector).is_ok()
}

/// CLI defaults remain non-interactive, but respect configured control sockets.
pub fn system_ssh_command() -> Command {
  let mut command = Command::new("ssh");
  command
    .args([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      "UpdateHostKeys=no",
      "-o",
      "ConnectTimeout=10",
    ])
    .env("LC_ALL", "C");
  command
}

pub(crate) async fn connect(machine: &RemoteMachine) -> Result<SshConnection> {
  crate::remote::validate_ssh_target(&machine.ssh_target)?;
  if let Some(connector) = CONNECTOR.get() {
    return connector.connect(&machine.ssh_target).await;
  }
  Ok(SshConnection {
    command: system_ssh_command(),
    session: "system_ssh",
    minimum_timeout: Duration::ZERO,
    guard: None,
    cancelled: None,
  })
}

pub(crate) async fn cancellable<T>(
  cancelled: Option<Arc<AtomicBool>>,
  scan_cancelled: Option<&(dyn Fn() -> bool + Send + Sync)>,
  operation: impl Future<Output = Result<T>>,
) -> Result<T> {
  tokio::pin!(operation);
  loop {
    if scan_cancelled.is_some_and(|check| check()) {
      return Err(crate::NafmError::ScanCancelled);
    }
    if cancelled.as_ref().is_some_and(|flag| flag.load(Ordering::SeqCst)) {
      return Err(crate::NafmError::SshConnection(
        "SSH authentication cancelled or timed out".into(),
      ));
    }
    tokio::select! {
      result = &mut operation => return result,
      _ = tokio::time::sleep(Duration::from_millis(100)) => {}
    }
  }
}

#[cfg(test)]
mod tests {
  #[tokio::test]
  async fn auth_cancellation_drops_the_in_flight_operation() {
    use super::*;
    let cancelled = Arc::new(AtomicBool::new(false));
    let dropped = Arc::new(AtomicBool::new(false));
    struct Guard(Arc<AtomicBool>);
    impl Drop for Guard {
      fn drop(&mut self) {
        self.0.store(true, Ordering::SeqCst);
      }
    }
    let signal = cancelled.clone();
    let operation = async {
      let _guard = Guard(dropped.clone());
      signal.store(true, Ordering::SeqCst);
      std::future::pending::<Result<()>>().await
    };
    assert!(cancellable(Some(cancelled), None, operation).await.is_err());
    assert!(dropped.load(Ordering::SeqCst));
  }

  #[test]
  fn strict_host_keys_do_not_disable_configured_masters() {
    let command = super::system_ssh_command();
    let args = command
      .as_std()
      .get_args()
      .map(|arg| arg.to_str().unwrap())
      .collect::<Vec<_>>();
    assert!(args.contains(&"StrictHostKeyChecking=yes"));
    assert!(args.contains(&"UpdateHostKeys=no"));
    assert!(!args.iter().any(|arg| arg.starts_with("Control")));
  }
}
