# NAFM

NAFM is a Rust desktop app, CLI, and core SDK for site-aware duplicate management. It tracks
logical sites, scans their folders for exact-content matches, reports duplicate
content within a site, and reports content that is missing across sites.

NAFM stores its configuration, credentials, and workspace databases under
`~/.tokn/nafm`.

## Workspace

- `nafm-core`: async Rust library/SDK with replaceable hash algorithms.
- `nafm-cli`: non-TUI command line interface.
- `nafm-desktop`: Tauri 2 + React desktop interface with a bounded radial
  storage map, live multi-site scans, and safe cleanup staging.

## Desktop app

The first desktop release reads the same active workspace as the CLI. It can
scan all sites concurrently, cancel scans cooperatively, explore a radial map
of used and safely reclaimable space, and stage duplicate copies for a cleanup
preview. Deletion is deliberately disabled in this release.

```sh
cd apps/nafm-desktop
pnpm install
pnpm tauri dev
```

Configure sites and SMB credentials with the CLI first; the desktop app picks
them up from `~/.tokn/nafm`.

## SMB credentials

Save credentials for an SMB share with:

```sh
cargo run -p nafm-cli -- connect smb://nas.example.test/Media --username alice
```

NAFM prompts for the password without echoing it, verifies that the server and
share are accessible, and then saves the credential to
`~/.tokn/nafm/credentials.json`. The file contains plaintext credentials and is
restricted to the current user with mode `0600` on Unix platforms.

Register and scan the connected share as a site:

```sh
cargo run -p nafm-cli -- site create omv
cargo run -p nafm-cli -- site add omv smb://nas.example.test/Media
cargo run -p nafm-cli -- scan omv
```

SMB files are streamed into the configured content hasher and are not copied
into NAFM's data directory. A credential saved for a share also authorizes
site folders beneath that share, such as `smb://nas.example.test/Media/Family Videos`.

## Status

Show the application root, current workspace, workspace database, registered
sites and folders, and saved SMB connections:

```sh
cargo run -p nafm-cli -- status
```

`status` reads local state only and does not contact saved SMB servers. Add
`--json` for machine-readable output.

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

In human-readable mode, `scan all` displays one independently updated progress
line per site and marks each site complete immediately. JSON mode emits
`started`, `progress`, and `summary` events as JSON Lines.
