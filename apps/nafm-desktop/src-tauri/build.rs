fn main() {
  if std::env::var("PROFILE").as_deref() == Ok("release") {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let directory = root.join("apps/nafm-desktop/src-tauri/resources/agents");
    let manifest = nafm_bundle::AgentManifest::load(&directory)
      .expect("release builds require a complete agent bundle; run pnpm agents:build");
    manifest.validate_source(&root).expect("agent bundle is stale");
    println!("cargo:rerun-if-changed={}", directory.display());
    for input in [
      "Cargo.toml",
      "Cargo.lock",
      "crates/nafm-agent",
      "crates/nafm-protocol",
      "crates/nafm-bundle",
      "crates/nafm-xtask",
    ] {
      println!("cargo:rerun-if-changed={}", root.join(input).display());
    }
  }
  tauri_build::build()
}
