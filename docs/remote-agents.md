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

1. Establish working non-interactive SSH and accept the host key outside NAFM.
2. In Connections, register the SSH alias or user@host.
3. Click **Install agent** (or **Update agent**).
4. Map an SMB URL to an absolute native remote path, e.g. `/volume1/Media`,
   `C:\Media`, or a UNC share. Mapping creation probes the path on that machine.

Installation detects the native remote OS/architecture without needing an agent.
It uploads only the selected binary over SSH into a fresh private directory:

- POSIX: `$HOME/.local/share/nafm/agents/<unique-id>/nafm-agent`
- Windows: `%LOCALAPPDATA%\nafm\agents\<unique-id>\nafm-agent.exe`

The app verifies platform, agent version, protocol, BLAKE3 support, and executable
checksum before saving the managed path in the workspace. It never edits PATH,
requests sudo, starts a daemon, or replaces the currently selected executable.
Test and scan actions never install anything. Installed paths also work from the
CLI when using the same workspace.

Failures preserve the previous selection. Interrupted/failed uploads can leave
an unselected directory; retry uses a new one. Old directories are deliberately
retained, and removing a machine only removes local configuration. Remove unused
directories manually once you know no scan uses them.

Installation phases are shown in Connections. Each detection attempt is limited
to 20 seconds, transfer to 180 seconds, and verification to 30 seconds. No password
prompts are supported. Windows uses UTF-8 protocol text through PowerShell.

Manual installation remains possible: build for the **remote** target and put
`nafm-agent` on its non-interactive SSH PATH. Protocol 2 requires agent 0.2.0;
the original protocol-1 agent must be upgraded. The protocol crate is independent
of nafm-core, SQLite, SMB and desktop libraries.

## Validation boundaries

Compile success is not a deployment test. `scripts/test-agent.ts` exercises probe,
Unicode filenames, discovery, BLAKE3 hashes, mutation detection, path traversal
and protocol mismatch on the real binary. CI runs it on each native OS.
Real SSH configuration, remote directory permissions, antivirus/quarantine and
unusual NAS shells still need testing against the intended machines.
