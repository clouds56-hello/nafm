use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HiddenPolicy {
  Include,
  Skip,
}

pub const REMOTE_AGENT_PROTOCOL_VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct RemoteFileMetadata {
  pub relative_path: String,
  pub size_bytes: u64,
  pub modified_unix_nanos: i64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "command", rename_all = "snake_case")]
/// Paths are opaque UTF-8 values on the client, interpreted only by the remote agent.
/// Client code must not canonicalize or join these using host-native path semantics.
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
    os: String,
    arch: String,
    executable_hash: String,
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
