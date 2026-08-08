use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use percent_encoding::percent_decode_str;
use serde::{Deserialize, Serialize};
use url::{Host, Url};
use uuid::Uuid;

use crate::error::{NafmError, Result};
use crate::workspace::app_root_dir;

const CREDENTIALS_SCHEMA_VERSION: u32 = 1;
const CREDENTIALS_FILE_NAME: &str = "credentials.json";

#[derive(Clone, Debug)]
pub struct CredentialStore {
  root_dir: PathBuf,
}

impl CredentialStore {
  pub fn new(root_dir: PathBuf) -> Self {
    Self { root_dir }
  }

  pub fn from_default_root() -> Result<Self> {
    Ok(Self::new(app_root_dir()?))
  }

  pub fn path(&self) -> PathBuf {
    self.root_dir.join(CREDENTIALS_FILE_NAME)
  }

  pub fn save_smb_credential(&self, url: &str, username: &str, password: &str) -> Result<SavedSmbCredential> {
    let location = SmbLocation::parse(url)?;
    let username = validate_username(username)?;
    validate_password(password)?;

    let mut document = self.load_document()?;
    document
      .credentials
      .retain(|credential| credential.url != location.normalized_url);
    document.credentials.push(StoredCredential {
      url: location.normalized_url.clone(),
      username: username.clone(),
      password: password.to_owned(),
    });
    document.credentials.sort_by(|left, right| left.url.cmp(&right.url));
    self.store_document(&document)?;

    Ok(SavedSmbCredential {
      url: location.normalized_url,
      username,
    })
  }

  pub fn load_smb_credential(&self, url: &str) -> Result<Option<SmbCredential>> {
    let location = SmbLocation::parse(url)?;
    let matching_credential = self
      .load_document()?
      .credentials
      .into_iter()
      .map(|credential| {
        let credential_location = SmbLocation::parse(&credential.url)?;
        Ok::<_, NafmError>(
          smb_location_is_ancestor(&credential_location, &location).then_some((
            credential_location
              .relative_path
              .split('/')
              .filter(|segment| !segment.is_empty())
              .count(),
            credential,
          )),
        )
      })
      .collect::<Result<Vec<_>>>()?
      .into_iter()
      .flatten()
      .max_by_key(|(path_depth, _)| *path_depth);
    Ok(matching_credential.map(|(_, credential)| SmbCredential {
      url: credential.url,
      username: credential.username,
      password: credential.password,
    }))
  }

  pub fn list_smb_credentials(&self) -> Result<Vec<SavedSmbCredential>> {
    let mut credentials = self
      .load_document()?
      .credentials
      .into_iter()
      .map(|credential| SavedSmbCredential {
        url: credential.url,
        username: credential.username,
      })
      .collect::<Vec<_>>();
    credentials.sort_by(|left, right| left.url.cmp(&right.url));
    Ok(credentials)
  }

  fn load_document(&self) -> Result<CredentialsDocument> {
    ensure_secure_root(&self.root_dir)?;
    let path = self.path();
    if !path.exists() {
      return Ok(CredentialsDocument::default());
    }

    let metadata = fs::symlink_metadata(&path)?;
    if !metadata.file_type().is_file() {
      return Err(NafmError::InvalidCredentialsPath(path));
    }
    set_file_permissions(&path)?;

    let document = serde_json::from_slice::<CredentialsDocument>(&fs::read(path)?)?;
    if document.schema_version != CREDENTIALS_SCHEMA_VERSION {
      return Err(NafmError::UnsupportedCredentialsSchema(document.schema_version));
    }
    Ok(document)
  }

  fn store_document(&self, document: &CredentialsDocument) -> Result<()> {
    ensure_secure_root(&self.root_dir)?;
    let path = self.path();
    if path.exists() && !fs::symlink_metadata(&path)?.file_type().is_file() {
      return Err(NafmError::InvalidCredentialsPath(path));
    }

    let temporary_path = self.root_dir.join(format!(".credentials.{}.tmp", Uuid::new_v4()));
    let result = write_credentials_file(&temporary_path, &path, document);
    if result.is_err() {
      let _ = fs::remove_file(&temporary_path);
    }
    result
  }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SavedSmbCredential {
  pub url: String,
  pub username: String,
}

pub struct SmbCredential {
  pub url: String,
  pub username: String,
  pub password: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SmbLocation {
  pub normalized_url: String,
  pub server_address: String,
  pub share: String,
  pub relative_path: String,
}

impl SmbLocation {
  pub fn parse(value: &str) -> Result<Self> {
    let mut url = Url::parse(value).map_err(|error| NafmError::InvalidSmbUrl(error.to_string()))?;
    if url.scheme() != "smb" {
      return Err(NafmError::InvalidSmbUrl("scheme must be smb://".to_owned()));
    }
    if !url.username().is_empty() || url.password().is_some() {
      return Err(NafmError::InvalidSmbUrl(
        "username and password must not be embedded in the URL".to_owned(),
      ));
    }
    if url.query().is_some() || url.fragment().is_some() {
      return Err(NafmError::InvalidSmbUrl(
        "query strings and fragments are not supported".to_owned(),
      ));
    }

    if let Some(Host::Domain(host)) = url.host() {
      let normalized_host = host.to_ascii_lowercase();
      url
        .set_host(Some(&normalized_host))
        .map_err(|_| NafmError::InvalidSmbUrl("server name is invalid".to_owned()))?;
    }
    let host = url
      .host()
      .ok_or_else(|| NafmError::InvalidSmbUrl("server name is required".to_owned()))?;
    let server_address = server_address(host, url.port().unwrap_or(445));
    let encoded_segments = url
      .path_segments()
      .ok_or_else(|| NafmError::InvalidSmbUrl("share name is required".to_owned()))?
      .filter(|segment| !segment.is_empty())
      .collect::<Vec<_>>();
    if encoded_segments.is_empty() {
      return Err(NafmError::InvalidSmbUrl("share name is required".to_owned()));
    }

    let segments = encoded_segments
      .iter()
      .map(|segment| {
        percent_decode_str(segment)
          .decode_utf8()
          .map(|segment| segment.into_owned())
          .map_err(|_| NafmError::InvalidSmbUrl("path contains invalid UTF-8".to_owned()))
      })
      .collect::<Result<Vec<_>>>()?;
    if segments
      .iter()
      .any(|segment| segment == "." || segment == ".." || segment.contains(['/', '\\']))
    {
      return Err(NafmError::InvalidSmbUrl("path contains an invalid segment".to_owned()));
    }

    {
      let mut path = url
        .path_segments_mut()
        .map_err(|_| NafmError::InvalidSmbUrl("URL cannot contain path segments".to_owned()))?;
      path.clear();
      path.extend(&segments);
    }
    let normalized_url = url.as_str().trim_end_matches('/').to_owned();

    Ok(Self {
      normalized_url,
      server_address,
      share: segments[0].clone(),
      relative_path: segments[1..].join("/"),
    })
  }

  pub fn join_path_segments(&self, segments: &[String]) -> Result<String> {
    let mut url = Url::parse(&self.normalized_url).map_err(|error| NafmError::InvalidSmbUrl(error.to_string()))?;
    {
      let mut path = url
        .path_segments_mut()
        .map_err(|_| NafmError::InvalidSmbUrl("URL cannot contain path segments".to_owned()))?;
      path.extend(segments);
    }
    Ok(url.as_str().trim_end_matches('/').to_owned())
  }
}

fn smb_location_is_ancestor(candidate: &SmbLocation, requested: &SmbLocation) -> bool {
  if candidate.server_address != requested.server_address || !candidate.share.eq_ignore_ascii_case(&requested.share) {
    return false;
  }

  let candidate_segments = candidate
    .relative_path
    .split('/')
    .filter(|segment| !segment.is_empty())
    .collect::<Vec<_>>();
  let requested_segments = requested
    .relative_path
    .split('/')
    .filter(|segment| !segment.is_empty())
    .collect::<Vec<_>>();
  requested_segments.starts_with(&candidate_segments)
}

pub async fn verify_smb_connection(location: &SmbLocation, username: &str, password: &str) -> Result<()> {
  let username = validate_username(username)?;
  validate_password(password)?;

  let mut client = smb2::connect(&location.server_address, &username, password).await?;
  let mut tree = client.connect_share(&location.share).await?;
  if !location.relative_path.is_empty() {
    client.list_directory(&mut tree, &location.relative_path).await?;
  }
  client.disconnect_share(&tree).await?;
  Ok(())
}

#[derive(Deserialize, Serialize)]
struct CredentialsDocument {
  schema_version: u32,
  credentials: Vec<StoredCredential>,
}

impl Default for CredentialsDocument {
  fn default() -> Self {
    Self {
      schema_version: CREDENTIALS_SCHEMA_VERSION,
      credentials: Vec::new(),
    }
  }
}

#[derive(Deserialize, Serialize)]
struct StoredCredential {
  url: String,
  username: String,
  password: String,
}

fn validate_username(username: &str) -> Result<String> {
  let username = username.trim();
  if username.is_empty() {
    Err(NafmError::EmptySmbUsername)
  } else {
    Ok(username.to_owned())
  }
}

fn validate_password(password: &str) -> Result<()> {
  if password.is_empty() {
    Err(NafmError::EmptySmbPassword)
  } else {
    Ok(())
  }
}

fn server_address(host: Host<&str>, port: u16) -> String {
  match host {
    Host::Domain(host) => format!("{host}:{port}"),
    Host::Ipv4(host) => format!("{host}:{port}"),
    Host::Ipv6(host) => format!("[{host}]:{port}"),
  }
}

fn ensure_secure_root(root_dir: &Path) -> Result<()> {
  fs::create_dir_all(root_dir)?;
  let metadata = fs::symlink_metadata(root_dir)?;
  if !metadata.file_type().is_dir() {
    return Err(NafmError::InvalidCredentialsPath(root_dir.to_path_buf()));
  }
  set_directory_permissions(root_dir)
}

fn write_credentials_file(temporary_path: &Path, destination: &Path, document: &CredentialsDocument) -> Result<()> {
  let mut options = OpenOptions::new();
  options.write(true).create_new(true);
  set_create_file_mode(&mut options);
  let mut file = options.open(temporary_path)?;
  let mut contents = serde_json::to_vec_pretty(document)?;
  contents.push(b'\n');
  file.write_all(&contents)?;
  file.sync_all()?;
  drop(file);
  fs::rename(temporary_path, destination)?;
  set_file_permissions(destination)
}

#[cfg(unix)]
fn set_create_file_mode(options: &mut OpenOptions) {
  use std::os::unix::fs::OpenOptionsExt;

  options.mode(0o600);
}

#[cfg(not(unix))]
fn set_create_file_mode(_options: &mut OpenOptions) {}

#[cfg(unix)]
fn set_directory_permissions(path: &Path) -> Result<()> {
  use std::os::unix::fs::PermissionsExt;

  fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
  Ok(())
}

#[cfg(not(unix))]
fn set_directory_permissions(_path: &Path) -> Result<()> {
  Ok(())
}

#[cfg(unix)]
fn set_file_permissions(path: &Path) -> Result<()> {
  use std::os::unix::fs::PermissionsExt;

  fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
  Ok(())
}

#[cfg(not(unix))]
fn set_file_permissions(_path: &Path) -> Result<()> {
  Ok(())
}

#[cfg(test)]
mod tests {
  use std::fs;

  use super::{CredentialStore, SmbLocation};

  #[test]
  fn parses_and_normalizes_smb_locations() {
    let location = SmbLocation::parse("smb://OMV.lan:445/Media/Family%20Videos/").unwrap();

    assert_eq!(location.normalized_url, "smb://omv.lan:445/Media/Family%20Videos");
    assert_eq!(location.server_address, "omv.lan:445");
    assert_eq!(location.share, "Media");
    assert_eq!(location.relative_path, "Family Videos");
  }

  #[test]
  fn rejects_credentials_embedded_in_url() {
    let error = SmbLocation::parse("smb://alice:secret@omv.lan/Media").unwrap_err();

    assert_eq!(
      error.to_string(),
      "invalid SMB URL: username and password must not be embedded in the URL"
    );
  }

  #[test]
  fn joins_remote_path_segments_with_url_encoding() {
    let location = SmbLocation::parse("smb://omv.lan/Media").unwrap();

    let url = location
      .join_path_segments(&["Family Videos".to_owned(), "clip #1.mp4".to_owned()])
      .unwrap();

    assert_eq!(url, "smb://omv.lan/Media/Family%20Videos/clip%20%231.mp4");
  }

  #[test]
  fn saves_and_replaces_one_credential_per_url() {
    let temp = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(temp.path().join("nafm"));

    store
      .save_smb_credential("smb://OMV.lan/Media/", " alice ", "first")
      .unwrap();
    store
      .save_smb_credential("smb://omv.lan/Media", "bob", "second")
      .unwrap();

    let credential = store.load_smb_credential("smb://omv.lan/Media/").unwrap().unwrap();
    assert_eq!(credential.url, "smb://omv.lan/Media");
    assert_eq!(credential.username, "bob");
    assert_eq!(credential.password, "second");

    let contents = fs::read_to_string(store.path()).unwrap();
    assert!(!contents.contains("first"));
  }

  #[test]
  fn loads_the_most_specific_credential_for_nested_locations() {
    let temp = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(temp.path().join("nafm"));
    store
      .save_smb_credential("smb://nas.example.test/share", "root-user", "root-password")
      .unwrap();
    store
      .save_smb_credential("smb://nas.example.test/share/Media", "media-user", "media-password")
      .unwrap();

    let nested = store
      .load_smb_credential("smb://nas.example.test/share/Media/2026")
      .unwrap()
      .unwrap();
    assert_eq!(nested.url, "smb://nas.example.test/share/Media");
    assert_eq!(nested.username, "media-user");

    let sibling = store
      .load_smb_credential("smb://nas.example.test/share/Photos")
      .unwrap()
      .unwrap();
    assert_eq!(sibling.url, "smb://nas.example.test/share");
    assert_eq!(sibling.username, "root-user");

    assert!(
      store
        .load_smb_credential("smb://nas.example.test/share-archive/Photos")
        .unwrap()
        .is_none()
    );
  }

  #[test]
  fn lists_connection_metadata_without_passwords() {
    let temp = tempfile::tempdir().unwrap();
    let store = CredentialStore::new(temp.path().join("nafm"));
    store
      .save_smb_credential("smb://zeta.lan/Media", "alice", "first-secret")
      .unwrap();
    store
      .save_smb_credential("smb://alpha.lan/Archive", "bob", "second-secret")
      .unwrap();

    let credentials = store.list_smb_credentials().unwrap();

    assert_eq!(credentials.len(), 2);
    assert_eq!(credentials[0].url, "smb://alpha.lan/Archive");
    assert_eq!(credentials[0].username, "bob");
    let output = serde_json::to_string(&credentials).unwrap();
    assert!(!output.contains("first-secret"));
    assert!(!output.contains("second-secret"));
  }

  #[cfg(unix)]
  #[test]
  fn protects_credential_storage_with_owner_only_permissions() {
    use std::os::unix::fs::PermissionsExt;

    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("nafm");
    let store = CredentialStore::new(root.clone());
    store
      .save_smb_credential("smb://omv.lan/Media", "alice", "secret")
      .unwrap();

    assert_eq!(fs::metadata(root).unwrap().permissions().mode() & 0o777, 0o700);
    assert_eq!(fs::metadata(store.path()).unwrap().permissions().mode() & 0o777, 0o600);
  }
}
