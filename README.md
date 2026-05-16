# NAFM

NAFM is a Rust file management CLI and core SDK for registering folders, scanning
them for exact duplicate files, caching scan metadata, and safely moving selected
duplicates to the platform trash.

## Workspace

- `nafm-core`: async Rust library/SDK.
- `nafm-cli`: non-TUI command line interface.

## Quick start

```sh
cargo run -p nafm-cli -- folder add ~/Downloads --alias downloads
cargo run -p nafm-cli -- scan downloads
cargo run -p nafm-cli -- duplicates downloads
```
