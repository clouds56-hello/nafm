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

The desktop app shares workspace and credential state with the CLI. It can
create and switch workspaces, manage multi-root sites, verify SMB connections,
scan all sites concurrently, cancel scans cooperatively, explore a radial map
of space and cross-site coverage health, and stage duplicate copies for a
cleanup preview. Deletion is deliberately disabled in this release.

```sh
cd apps/nafm-desktop
pnpm install
pnpm tauri dev
```

Use the workspace chip for quick switching, the **+** shortcut in the Sites
rail to add a site, or the header settings button to open the Management
Center. The Management Center exposes workspaces, every root belonging to a
site, and SMB connections. Unregistering a site or root removes only NAFM's
index and cached scan data; it never deletes source files.

The CLI remains available for the same setup and automation workflows.

## Desktop releases

Pull requests and pushes to `main` run Rust formatting, tests, Clippy, and the
frontend production build. Pushing a version tag builds native desktop
installers and attaches them to a draft GitHub Release:

- macOS DMGs for Apple Silicon and Intel
- a Windows x64 NSIS installer
- Linux x64 AppImage and Debian packages

Before tagging, keep the version in these files synchronized:

- `apps/nafm-desktop/src-tauri/tauri.conf.json`
- `apps/nafm-desktop/src-tauri/Cargo.toml`
- `apps/nafm-desktop/package.json`

Then create and push the matching tag:

```sh
git tag v0.1.0
git push origin v0.1.0
```

The release workflow reruns the CI quality gate and rejects a tag that does not
match all three application versions before starting native builds. Releases
remain drafts because the current bundles are not notarized for macOS or signed
for Windows. Configure platform signing before publishing a release to end
users.

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

## Remote hashing over SSH

When an SMB server, NAS, or nearby Linux machine can read the share through a
native filesystem path, NAFM can discover and hash the files there instead of
transferring every byte over SMB. The desktop keeps ownership of the workspace
database; the remote machine runs a stateless `nafm-agent` process on demand.

The desktop bundles agents for Linux x64, Windows x64, and macOS ARM64.
Register an SSH target in Connections, click **Install agent**, then add the
path mapping. Installation detects the remote platform and verifies the uploaded
binary before selecting it. No service, sudo, or manual PATH changes are needed.

For local cross-build prerequisites, compatibility requirements, and manual CLI
installation, see [Bundled SSH agents](docs/remote-agents.md).

Use an existing alias from `~/.ssh/config`, or a normal `user@host` target.
NAFM delegates keys, host verification, proxying, and ports to the system SSH
client and never stores SSH credentials.

```sh
cargo run -p nafm-cli -- remote add nas --ssh-target nas
cargo run -p nafm-cli -- remote probe nas
cargo run -p nafm-cli -- remote map nas smb://nas.example.test/Media /volume1/Media
cargo run -p nafm-cli -- remote list
```

Mappings use the longest matching SMB URL prefix, so the example also maps
`smb://nas.example.test/Media/Family Videos` to
`/volume1/Media/Family Videos`. Mapping creation verifies the SSH connection,
agent protocol, hash algorithm, and remote directory before saving it. An SMB
root without a mapping continues to use the regular SMB connection. Remote
paths must be absolute on the remote OS; POSIX, Windows drive paths and UNC paths
are supported independently of the desktop OS.

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
line per site and marks each site complete independently. Each site is scanned
in two durable passes:

1. discover every file and atomically publish its current size and modification
   metadata;
2. hash only files whose content has not been verified for that inventory.

Unchanged local and direct-SMB files reuse verified hashes when size, modification
time, algorithm, and source identity match. Completed SMB hashes also survive an
interrupted scan and are reused on resume. SMB entries with unavailable modification
times are rehashed. Remote-agent hashes additionally require the same path mapping.
Already-stale hashes are not automatically promoted to verified: they still need
rehashing because their original verification metadata may no longer be available.

If only a file's modification time changes, NAFM retains the previous digest as
stale information but does not use it for duplicate, health, coverage, or
cleanup decisions until the file is hashed again. A cancellation during
discovery keeps the previous inventory untouched. A cancellation during
hashing keeps the newly published inventory and every completed hash, so the
next scan can reuse that work. While hashes are pending, the desktop shows a
live health estimate: verified content contributes normally, pending content
contributes zero, and each partially verified map segment fills from its inner
edge outward while the pending remainder stays neutral gray. Fully unverified
folders remain gray. Duplicate and cleanup actions stay suspended until
verification finishes.

JSON mode emits `started`, `progress`, and `summary` events as JSON Lines.
Progress events identify the current `discovering`, `publishing_metadata`,
`hashing`, or `finalizing` phase.
