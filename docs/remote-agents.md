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

1. Configure system SSH. For an unknown host, verify the server fingerprint through
   a trusted channel before approving it in NAFM or recording it with system SSH.
2. In Connections, register the SSH alias or user@host.
3. Click **Check connection**. Separate results cover local SSH, connectivity,
   host-key trust, authentication, OS/architecture, selected agent and bundle
   integrity. Failed checks include suggested remedies; unconfirmed checks are
   not marked passed. This action never installs an agent.
4. Click **Install agent** (or **Update agent**), review the matching target and
   destination, then confirm. Rerun the connection check after installation.
5. Enter an SMB URL and an absolute native remote path, e.g. `/volume1/Media`,
   `C:\Media`, or a UNC share. Click **Preview path (read only)**, inspect the sample,
   then **Confirm and save mapping**. Editing any input invalidates the preview;
   saving repeats the remote checks before writing local configuration.

Interactive desktop connections use `StrictHostKeyChecking=ask`, with automatic
key updates disabled and fingerprints forced to SHA256. Unknown hosts produce a
separate fingerprint dialog showing the configured SSH target, the host/address
reported by OpenSSH, key type, and fingerprint. Compare it through an independent
trusted channel (for example, `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on
the server console), check the verification box, then choose **Trust fingerprint
and connect**. The backend accepts only the displayed fingerprint, not a generic
`yes`. OpenSSH performs the known-hosts write using its configured paths; NAFM
does not run ssh-keyscan, rewrite SSH config, or remove old keys. Cancelling before
approval does not authorize a known-hosts write.

Changed/revoked keys and unrecognized or incomplete trust challenges fail closed;
resolve those through system SSH after independently investigating the change.
Non-interactive operations retain `StrictHostKeyChecking=yes`. Password prompts
remain separate from host trust. Keys, aliases, ports, proxies and ssh-agent come
from system SSH. See [OpenSSH's host-key policy](https://man.openbsd.org/ssh_config#StrictHostKeyChecking).

The desktop first checks for an existing configured control master and reuses it
without closing or modifying it. Its original trust decision is retained; the
preflight reports **Using existing SSH session**, not a fresh host-key handshake.
On macOS/Linux desktop hosts, when no master exists NAFM creates its own private
master process and 0700 temporary socket directory. Concurrent operations for the
same SSH target share it. NAFM closes only its own masters on normal app exit;
dead sessions are recreated on the next operation. No SSH config is rewritten.
On Windows desktop hosts, configured reuse is attempted, but otherwise authentication
is per connection (the Windows client may lack multiplexing). This is independent
of the remote agent's OS: a Mac can reuse a master connected to a Windows server.

OpenSSH chooses the authentication methods. Its askpass requests open a cancellable
dialog for passwords, key passphrases, or MFA responses only when needed. A prompt
expires after three minutes. Answers travel through an authenticated loopback
broker to the askpass helper, never through command arguments, environment variables,
progress events, files, or logs. Rust answer buffers are zeroized; the frontend field
is cleared immediately (JavaScript/OS memory copies cannot be guaranteed erased).
NAFM does not add decrypted keys to ssh-agent or save passphrases to macOS Keychain.
Already-loaded ssh-agent keys remain usable. CLI operations remain non-interactive
and respect existing configured masters.

Error classification is best-effort: an unrecognized SSH error appears as a session
failure with other stages unconfirmed. Cancelling authentication does not trigger
a second attempt using another platform probe or weaker host-key policy.

Path preview traverses up to 1,000 entries, samples up to five regular files,
and reads at most one byte per sampled file without returning contents. It does
not follow directory symlinks. Empty/no-sample directories are explicitly reported:
file-read permissions cannot be confirmed there. A successful sample is not a
full permissions audit and does not prove the native root corresponds to the SMB
share; the user must confirm that mapping. Preview does not contact the SMB share.

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
to 20 seconds, transfer to 180 seconds, and verification to 30 seconds after session
setup. Interactive session setup has a separate 185-second limit. On desktop hosts
without app-owned multiplexing, bounded operations allow at least 185 seconds to
include authentication. Windows agents use UTF-8 protocol text through PowerShell.

Manual installation remains possible: build for the **remote** target and put
`nafm-agent` on its non-interactive SSH PATH. Agent 0.3.0 adds the `path_preview`
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
