use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use crate::error::Result;

pub trait ContentHasher: Send {
  fn update(&mut self, bytes: &[u8]);
  fn finalize(self: Box<Self>) -> String;
}

pub trait HashAlgorithm: Send + Sync {
  fn name(&self) -> &'static str;
  fn new_hasher(&self) -> Box<dyn ContentHasher>;

  fn hash_file(&self, path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = self.new_hasher();
    let mut buffer = [0; 1024 * 64];
    loop {
      let read = file.read(&mut buffer)?;
      if read == 0 {
        break;
      }
      hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize())
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
