use std::{
  io::{Read, Write},
  net::{SocketAddr, TcpStream},
  sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
  },
  time::Duration,
};

use serde::{Deserialize, Serialize};
use tokio::{
  io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
  net::TcpListener,
  process::Command,
};
use uuid::Uuid;
use zeroize::Zeroizing;

use super::prompts::PromptHub;

const ADDRESS: &str = "NAFM_ASKPASS_ADDRESS";
const TOKEN: &str = "NAFM_ASKPASS_TOKEN";

#[derive(Serialize, Deserialize)]
struct Request {
  token: String,
  message: String,
  confirmation: bool,
}

pub struct Broker {
  task: tokio::task::JoinHandle<()>,
  address: SocketAddr,
  token: String,
  pub cancelled: Arc<AtomicBool>,
}

impl Broker {
  pub async fn start(hub: Arc<PromptHub>, target: String) -> Result<Self, String> {
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
      .await
      .map_err(|error| error.to_string())?;
    let address = listener.local_addr().map_err(|error| error.to_string())?;
    let token = format!("{}{}", Uuid::new_v4(), Uuid::new_v4());
    let expected = token.clone();
    let cancelled = Arc::new(AtomicBool::new(false));
    let cancel = cancelled.clone();
    let task = tokio::spawn(async move {
      loop {
        let Ok((stream, _)) = listener.accept().await else {
          break;
        };
        let mut reader = BufReader::new(stream);
        let mut input = Vec::new();
        // Bound unauthenticated input before exposing any prompt to the UI.
        let read = tokio::time::timeout(Duration::from_secs(2), async {
          loop {
            let bytes = reader.fill_buf().await?;
            if bytes.is_empty() {
              return Ok::<_, std::io::Error>(false);
            }
            let count = bytes
              .iter()
              .position(|byte| *byte == b'\n')
              .map_or(bytes.len(), |index| index + 1);
            if input.len() + count > 16384 {
              return Ok(false);
            }
            input.extend_from_slice(&bytes[..count]);
            reader.consume(count);
            if input.last() == Some(&b'\n') {
              return Ok(true);
            }
          }
        })
        .await;
        if !matches!(read, Ok(Ok(true))) {
          continue;
        }
        let Ok(request) = serde_json::from_slice::<Request>(&input) else {
          continue;
        };
        if request.token != expected || request.message.len() > 8192 {
          continue;
        }
        if cancel.load(Ordering::SeqCst) {
          break;
        }
        let message = request
          .message
          .chars()
          .filter(|ch| !ch.is_control() || *ch == '\n')
          .collect();
        let response = hub.ask(&target, message, request.confirmation).await;
        let mut stream = reader.into_inner();
        match response {
          Some(response) => {
            let _ = stream.write_u8(1).await;
            let _ = stream.write_u32(response.len() as u32).await;
            let _ = stream.write_all(response.as_bytes()).await;
          }
          None => {
            cancel.store(true, Ordering::SeqCst);
            let _ = stream.write_u8(0).await;
            break;
          }
        }
      }
    });
    Ok(Self {
      task,
      address,
      token,
      cancelled,
    })
  }

  pub fn configure(&self, command: &mut Command) -> Result<(), String> {
    command
      .env(
        "SSH_ASKPASS",
        std::env::current_exe().map_err(|error| error.to_string())?,
      )
      .env("SSH_ASKPASS_REQUIRE", "force")
      .env(ADDRESS, self.address.to_string())
      .env(TOKEN, &self.token);
    Ok(())
  }
}

impl Drop for Broker {
  fn drop(&mut self) {
    self.task.abort();
  }
}

/// Invoked by OpenSSH, before desktop initialization. Never logs prompts/secrets.
pub fn run_helper() -> Option<i32> {
  let address = std::env::var(ADDRESS).ok()?;
  let result = (|| -> Result<(), Box<dyn std::error::Error>> {
    let address: SocketAddr = address.parse()?;
    if !address.ip().is_loopback() {
      return Err("invalid broker address".into());
    }
    let token = std::env::var(TOKEN)?;
    let message = std::env::args().nth(1).ok_or("missing prompt")?;
    if message.len() > 8192 {
      return Err("prompt too long".into());
    }
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))?;
    stream.set_read_timeout(Some(Duration::from_secs(185)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let request = Request {
      token,
      message,
      confirmation: std::env::var("SSH_ASKPASS_PROMPT").is_ok_and(|value| value == "confirm"),
    };
    serde_json::to_writer(&mut stream, &request)?;
    stream.write_all(b"\n")?;
    let mut status = [0_u8];
    stream.read_exact(&mut status)?;
    if status[0] != 1 {
      return Err("cancelled".into());
    }
    let mut length = [0_u8; 4];
    stream.read_exact(&mut length)?;
    let length = u32::from_be_bytes(length) as usize;
    if length > 8192 {
      return Err("invalid response length".into());
    }
    let mut answer = Zeroizing::new(vec![0_u8; length]);
    stream.read_exact(&mut answer)?;
    let mut stdout = std::io::stdout().lock();
    stdout.write_all(&answer)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
  })();
  Some(if result.is_ok() { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::io::{AsyncReadExt, AsyncWriteExt};

  async fn send(broker: &Broker, token: &str) -> tokio::net::TcpStream {
    let mut stream = tokio::net::TcpStream::connect(broker.address).await.unwrap();
    let request = Request {
      token: token.into(),
      message: "Password:".into(),
      confirmation: false,
    };
    let mut bytes = serde_json::to_vec(&request).unwrap();
    bytes.push(b'\n');
    stream.write_all(&bytes).await.unwrap();
    stream
  }

  async fn pending(hub: &PromptHub) -> String {
    tokio::time::timeout(Duration::from_secs(3), async {
      loop {
        if let Some(prompt) = hub.list().unwrap().first() {
          return prompt.prompt_id.clone();
        }
        tokio::task::yield_now().await;
      }
    })
    .await
    .unwrap()
  }

  #[tokio::test]
  async fn broker_authenticates_requests_and_delivers_one_shot_secrets() {
    let hub = PromptHub::for_test();
    let broker = Broker::start(hub.clone(), "test-target".into()).await.unwrap();
    let mut invalid = send(&broker, "wrong-token").await;
    assert_eq!(
      tokio::time::timeout(Duration::from_secs(3), invalid.read(&mut [0]))
        .await
        .unwrap()
        .unwrap(),
      0
    );
    assert!(hub.list().unwrap().is_empty());
    let mut stream = send(&broker, &broker.token).await;
    let id = pending(&hub).await;
    let public = serde_json::to_string(&hub.list().unwrap()).unwrap();
    assert!(public.contains("test-target"));
    assert!(!public.contains("test-secret"));
    hub.reply(&id, Some(Zeroizing::new("test-secret".into()))).unwrap();
    assert_eq!(stream.read_u8().await.unwrap(), 1);
    let length = stream.read_u32().await.unwrap();
    let mut value = Zeroizing::new(vec![0; length as usize]);
    stream.read_exact(&mut value).await.unwrap();
    assert_eq!(&**value, b"test-secret");
    assert!(hub.reply(&id, None).is_err());
    assert!(hub.list().unwrap().is_empty());
  }

  #[tokio::test]
  async fn cancel_stops_authentication_and_drop_removes_pending_prompt() {
    let hub = PromptHub::for_test();
    let broker = Broker::start(hub.clone(), "cancel-target".into()).await.unwrap();
    let mut stream = send(&broker, &broker.token).await;
    let id = pending(&hub).await;
    hub.reply(&id, None).unwrap();
    assert_eq!(stream.read_u8().await.unwrap(), 0);
    assert!(broker.cancelled.load(Ordering::SeqCst));
    let broker = Broker::start(hub.clone(), "drop-target".into()).await.unwrap();
    let _stream = send(&broker, &broker.token).await;
    pending(&hub).await;
    drop(broker);
    tokio::time::timeout(Duration::from_secs(3), async {
      while !hub.list().unwrap().is_empty() {
        tokio::task::yield_now().await;
      }
    })
    .await
    .unwrap();
  }
}
