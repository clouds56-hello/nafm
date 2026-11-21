# NAFM

NAFM is a Rust desktop app, CLI, and core SDK for site-aware duplicate management. It tracks
logical sites, scans their folders for exact-content matches, reports duplicate
content within a site, and reports content that is missing across sites.

NAFM stores its configuration, credentials, and workspace databases under
`~/.tokn/nafm`.

## Workspace

- `nafm-core`: async Rust library/SDK with replaceable hash algorithms.
- `nafm-cli`: non-TUI command line interface.
- `nafm-desktop`: Tauri 2 + React desktop interface for scanning sources and
  exploring disk usage on a circular map.

## Desktop app

The desktop app shares workspaces with the CLI. Use the **Sites** rail to
switch sites, add a local folder or SMB share, and start or stop a scan.
Use **Scan all** to scan the workspace, and **Settings** to manage
workspaces, site folders, SMB connections, and remote SSH agents.

```sh
cd apps/nafm-desktop
pnpm install
pnpm tauri dev
```

Choose an arc to open a folder or select a file. Open **Contents** above the
map to browse the current folder and **Details** to inspect a selection or
open analysis actions. The arc length shows storage used, and each ring goes
one level deeper. Select **Space health** to see duplication or **Coverage**
to compare against another source. The details area opens similar folders or
exact copies and lets you stage verified duplicates. **Review** runs a cleanup
preview for staged copies.

### Interactive mock dashboard

From `apps/nafm-desktop`, run `pnpm mock` and open the
[local mock dashboard](http://localhost:14243/mock/).

The mock runs the same React frontend as the desktop app with synthetic sources
and file data. Switch between indexed, partially verified, empty, and scanning
workspaces to check the relevant UI. **Reset** reloads the current scenario, and
**App only** opens a preview without the scenario controls. Changes made in the
mock last until it reloads. Scans and SMB setup are simulated in the browser.

Use the mock for frontend review. Vite reloads it when the shared frontend
changes. Update the mock fixtures and command responses when a UI change needs
new data or a new Tauri command. The desktop production build uses its separate
entry point.

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

## Folder similarity

Choose **Similar folders** in the atlas details to rank indexed folders across
the active workspace. Select a match to see shared content, content unique to
each side, and directional coverage.

Comparison uses recursive sets of verified `(hash algorithm, content hash, size)`
identities. Names and directory structure do not affect the score. Repeated copies
count once for similarity; their extra-copy counts are shown separately.
The score is shared distinct bytes divided by union distinct bytes, as a percentage.
If both sets contain only zero-byte files, distinct-content counts are used instead.
An empty/unhashed source has no score. “Same content” requires equal sets and
complete verification, not just a rounded 100% byte score.

Only hashes verified for the published inventory are included. Partial comparisons
are marked explicitly; pending hashes and incomplete inventories may hide matches
or change scores. Results are read-only snapshots, not authorization to delete.
Self, same-site ancestors, and same-site descendants are excluded. Empty directories
not represented in the file index cannot be discovered by this feature.

Queries run in a background Rust task within one SQLite read transaction, without
SMB/SSH or source-file reads. Results are paginated (at most 50 per request), with a
cooperative 10-second analysis budget and a one-million file-to-folder membership limit.
Exceeding a budget returns an error rather than a silently truncated ranking.

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

Desktop releases bundle agents for Linux x64, Windows x64, and macOS ARM64.
Use **Settings** → **Connections** to register SSH targets, install an agent,
and verify the native path for an SMB share.

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
