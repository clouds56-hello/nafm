use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use crate::error::{NafmError, Result};

pub trait ContentHasher: Send {
  fn update(&mut self, bytes: &[u8]);
  fn finalize(self: Box<Self>) -> String;
}

pub trait HashAlgorithm: Send + Sync {
  fn name(&self) -> &'static str;
  fn new_hasher(&self) -> Box<dyn ContentHasher>;

  fn hash_file(&self, path: &Path) -> Result<String> {
    hash_file_in_chunks(path, self.new_hasher(), None)
  }

  /// Hashes a file while observing a cooperative cancellation request.
  ///
  /// The default preserves custom [`Self::hash_file`] implementations and
  /// therefore checks only before and after the whole file. Algorithms with a
  /// long-running custom implementation should override this method to add
  /// finer-grained checkpoints.
  fn hash_file_with_cancellation(
    &self,
    path: &Path,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
  ) -> Result<String> {
    check_hash_cancelled(Some(is_cancelled))?;
    let content_hash = self.hash_file(path)?;
    check_hash_cancelled(Some(is_cancelled))?;
    Ok(content_hash)
  }
}

#[derive(Clone, Debug, Default)]
pub struct Blake3HashAlgorithm;

impl HashAlgorithm for Blake3HashAlgorithm {
  fn name(&self) -> &'static str {
    "blake3"
  }

  fn new_hasher(&self) -> Box<dyn ContentHasher> {
    Box::new(Blake3ContentHasher(blake3::Hasher::new()))
  }

  fn hash_file_with_cancellation(
    &self,
    path: &Path,
    is_cancelled: &(dyn Fn() -> bool + Send + Sync),
  ) -> Result<String> {
    hash_file_in_chunks(path, self.new_hasher(), Some(is_cancelled))
  }
}

struct Blake3ContentHasher(blake3::Hasher);

impl ContentHasher for Blake3ContentHasher {
  fn update(&mut self, bytes: &[u8]) {
    self.0.update(bytes);
  }

  fn finalize(self: Box<Self>) -> String {
    self.0.finalize().to_hex().to_string()
  }
}

pub fn default_hash_algorithm() -> Arc<dyn HashAlgorithm> {
  Arc::new(Blake3HashAlgorithm)
}

fn hash_file_in_chunks(
  path: &Path,
  mut hasher: Box<dyn ContentHasher>,
  cancellation_callback: Option<&(dyn Fn() -> bool + Send + Sync)>,
) -> Result<String> {
  check_hash_cancelled(cancellation_callback)?;
  let mut file = File::open(path)?;
  let mut buffer = [0; 1024 * 64];
  loop {
    let read = file.read(&mut buffer)?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
    check_hash_cancelled(cancellation_callback)?;
  }
  check_hash_cancelled(cancellation_callback)?;
  Ok(hasher.finalize())
}

fn check_hash_cancelled(cancellation_callback: Option<&(dyn Fn() -> bool + Send + Sync)>) -> Result<()> {
  if cancellation_callback.is_some_and(|is_cancelled| is_cancelled()) {
    Err(NafmError::ScanCancelled)
  } else {
    Ok(())
  }
}
