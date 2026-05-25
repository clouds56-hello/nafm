use std::fs::File;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use crate::error::Result;

pub trait HashAlgorithm: Send + Sync {
  fn name(&self) -> &'static str;
  fn hash_file(&self, path: &Path) -> Result<String>;
}

#[derive(Clone, Debug, Default)]
pub struct Blake3HashAlgorithm;

impl HashAlgorithm for Blake3HashAlgorithm {
  fn name(&self) -> &'static str {
    "blake3"
  }

  fn hash_file(&self, path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0; 1024 * 64];
    loop {
      let read = file.read(&mut buffer)?;
      if read == 0 {
        break;
      }
      hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
  }
}

pub fn default_hash_algorithm() -> Arc<dyn HashAlgorithm> {
  Arc::new(Blake3HashAlgorithm)
}
