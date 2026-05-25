# NAFM

NAFM is a Rust CLI and core SDK for site-aware duplicate management. It tracks
logical sites, scans their folders for exact-content matches, reports duplicate
content within a site, and reports content that is missing across sites.

## Workspace

- `nafm-core`: async Rust library/SDK with replaceable hash algorithms.
- `nafm-cli`: non-TUI command line interface.

## Quick start

```sh
cargo run -p nafm-cli -- site create laptop
cargo run -p nafm-cli -- site add laptop ~/Downloads
cargo run -p nafm-cli -- scan laptop
cargo run -p nafm-cli -- duplicates laptop
```

To compare sites for missing content:

```sh
cargo run -p nafm-cli -- site create backup
cargo run -p nafm-cli -- site add backup /Volumes/Backup/Downloads
cargo run -p nafm-cli -- scan all
cargo run -p nafm-cli -- missing laptop --against backup
```
