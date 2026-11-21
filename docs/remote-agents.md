# Bundled SSH agents

Every desktop bundle contains these three **resources**, not local sidecars:

| Remote system | Rust target | Runtime requirement |
| --- | --- | --- |
| Linux x64 | x86_64-unknown-linux-musl | Linux supported by Rust; static musl, POSIX shell and base64 |
| Windows x64 | x86_64-pc-windows-msvc | Windows supported by Rust, OpenSSH Server and Windows PowerShell |
| macOS ARM64 | aarch64-apple-darwin | macOS 11+, SSH enabled |

Other architectures (including Linux ARM64 and Intel Macs) are rejected explicitly.
Windows ARM64 emulation is not selected as an x64 host.

## Build locally on a Mac

Install Xcode command-line tools, LLVM, Zig, cargo-zigbuild and cargo-xwin:

```sh
rustup target add x86_64-unknown-linux-musl x86_64-pc-windows-msvc aarch64-apple-darwin
brew install llvm
cargo install --locked cargo-zigbuild --version 0.23.3
cargo install --locked cargo-xwin --version 0.23.0
# Ensure LLVM and Zig are on PATH. CI pins Zig 0.16.0 via the ziglang package.
cd apps/nafm-desktop
pnpm agents:build
pnpm tauri build
```

cargo-xwin downloads Microsoft's CRT/SDK and its use constitutes acceptance of
[Microsoft's license](https://go.microsoft.com/fwlink/?LinkId=2086102).
See the [cargo-xwin prerequisites](https://github.com/rust-cross/cargo-xwin)
and [cargo-zigbuild setup](https://github.com/rust-cross/cargo-zigbuild).
No compiler or SDK is shipped to remote machines.

The Rust build tool writes ignored binaries plus a manifest under
`apps/nafm-desktop/src-tauri/resources/agents/`. It validates executable
machine types, Linux static linking, sizes, BLAKE3 checksums and protocol/version.
The source fingerprint includes agent/protocol/build-tool sources and Cargo.lock.
Desktop packaging runs `agents:check` and refuses missing, corrupt or stale bundles.
Run `agents:build` after changing those inputs; ordinary frontend development
does not require the bundle unless you test installation.

Other desktop build hosts consume the same directory produced on the Mac.
CI cross-builds on macOS, then runs the actual artifacts on Linux, Windows and
macOS before desktop packaging. Artifact transport restores executable bits.

## Install and use

1. Configure system SSH. Verify a new host fingerprint through a trusted
   channel before adding it to the known-hosts file.
2. Put the matching `nafm-agent` binary on the remote non-interactive SSH path.
3. Register the SSH target with `nafm-cli remote add`, check it with
   `nafm-cli remote probe`, and save a mapping with `nafm-cli remote map`.
   See [Remote hashing over SSH](../README.md#remote-hashing-over-ssh) for an example.
4. Start a scan from the desktop app or CLI. Both use the mapping saved in the
   active workspace.

Configure key authentication or an existing system SSH control master so a scan
can connect unattended. Prepare host trust and unlock any required keys in
system SSH before opening the desktop app.

Build for the **remote** target. Agent 0.3.0 adds the `path_preview`
capability to protocol 2. Agent 0.2.0 remains usable for existing scans, but must
be updated before creating mappings with preview. The original protocol-1 agent
must be upgraded. The protocol crate is independent
of nafm-core, SQLite, SMB and desktop libraries.

## Validation boundaries

Compile success is not a deployment test. `scripts/test-agent.ts` exercises probe,
empty and bounded path previews,
Unicode filenames, discovery, BLAKE3 hashes, mutation detection, path traversal
and protocol mismatch on the real binary. CI runs it on each native OS.
Real SSH configuration, remote directory permissions, antivirus/quarantine and
unusual NAS shells still need testing against the intended machines.

SSH broker tests use loopback sockets and an offline process fixture to cover
one-shot replies, cancellation, master reuse and owned-session cleanup.
`scripts/test-ssh-askpass.ts <desktop-executable>` exercises the actual executable's
helper entry point without initializing the desktop. CI runs the desktop SSH
tests and helper smoke test on macOS and Windows; these do not substitute for
testing a real server's password/MFA policy or Windows OpenSSH configuration.

For the first real-host acceptance test, supply an SSH alias, SMB root, and native
directory. Compare local/remote BLAKE3 on known files, check transfer volume and
elapsed time, and exercise cancellation, disconnect/retry, permission failure,
and an agent update. Native CI smoke tests do not establish those results.
