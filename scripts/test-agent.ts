import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

interface RemoteFile {
  relative_path: string;
  size_bytes: number;
  modified_unix_nanos: string;
}
type AgentEvent =
  | { event: "path_completion"; paths: string[]; truncated: boolean }
  | { event: "ready"; protocol_version: number; agent_version: string; capabilities: string[]; hash_algorithms: string[]; executable_hash: string; os: string; arch: string }
  | { event: "preview"; files: RemoteFile[]; truncated: boolean }
  | { event: "file"; file: RemoteFile }
  | { event: "discovery_complete" | "hash_complete"; file_count: number }
  | { event: "hash"; relative_path: string; content_hash: string }
  | { event: "error"; message: string };

assert.ok(process.argv[2], "Pass the agent executable path");
const binary = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), "nafm-agent-smoke-"));
const protocol_version = 2;

function request(payload: object, succeeds = true): AgentEvent[] {
  // Keep i64 timestamps exact across the JS boundary.
  const input = JSON.stringify({ protocol_version, ...payload })
    .replace(/("modified_unix_nanos":)"(-?\d+)"/g, "$1$2");
  const result = spawnSync(binary, [], { input, encoding: "utf8", timeout: 15_000 });
  assert.ifError(result.error);
  assert.equal(result.status === 0, succeeds, result.stdout + result.stderr);
  const responses: AgentEvent[] = result.stdout.trim().split(/\r?\n/).map((line) =>
    JSON.parse(line.replace(/("modified_unix_nanos":)(-?\d+)/g, '$1"$2"')));
  if (!succeeds) assert.equal(responses.at(-1)?.event, "error");
  return responses;
}

try {
  const [ready] = request({ command: "probe", remote_root: root });
  assert.ok(ready.event === "ready");
  assert.equal(ready.protocol_version, protocol_version);
  assert.equal(ready.agent_version, "0.4.0");
  assert.ok(ready.capabilities.includes("path_preview"));
  assert.ok(ready.capabilities.includes("path_completion"));
  const directory = join(root, "媒体 folder");
  mkdirSync(directory);
  writeFileSync(join(root, "媒体 file"), "");
  assert.deepEqual(request({ command: "complete_path", path: join(root, "媒体") }), [{ event: "path_completion", paths: [directory + sep], truncated: false }]);
  assert.deepEqual(request({ command: "complete_path", path: directory + sep }), [{ event: "path_completion", paths: [], truncated: false }]);
  request({ command: "complete_path", path: "relative/path" }, false);
  request({ command: "complete_path", path: join(root, "missing") + sep }, false);
  rmSync(directory, { recursive: true });
  rmSync(join(root, "媒体 file"));
  assert.deepEqual(request({ command: "preview", remote_root: root }), [{ event: "preview", files: [], truncated: false }]);
  assert.ok(ready.hash_algorithms.includes("blake3"));
  assert.match(ready.executable_hash, /^[a-f0-9]{64}$/);
  const file_name = "O'Neil & 照片.txt";
  writeFileSync(join(root, file_name), "abc");
  writeFileSync(join(root, ".hidden"), "");
  const [preview] = request({ command: "preview", remote_root: root });
  assert.ok(preview.event === "preview");
  assert.equal(preview.truncated, false);
  assert.equal(preview.files.length, 2);
  assert.ok(preview.files.some((file) => file.relative_path === file_name && file.size_bytes === 3));
  const discovery = request({ command: "discover", remote_root: root, hidden_policy: "skip" });
  assert.deepEqual(discovery.at(-1), { event: "discovery_complete", file_count: 1 });
  const discovered = discovery.find((event) => event.event === "file");
  assert.ok(discovered?.event === "file");
  assert.equal(discovered.file.relative_path, file_name);
  const hash_request = { command: "hash", remote_root: root, hash_algorithm: "blake3", files: [discovered.file] };
  const hashes = request(hash_request);
  assert.deepEqual(hashes, [
    { event: "hash", relative_path: file_name, content_hash: "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85" },
    { event: "hash_complete", file_count: 1 },
  ]);
  writeFileSync(join(root, file_name), "changed");
  const [changed] = request(hash_request, false);
  assert.ok(changed.event === "error");
  assert.match(changed.message, /file changed/);
  request({ command: "probe", remote_root: "relative/path" }, false);
  request({ command: "preview", remote_root: "relative/path" }, false);
  request({ command: "preview", remote_root: join(root, "missing") }, false);
  for (let index = 0; index < 6; index += 1) writeFileSync(join(root, `sample-${index}`), "abc");
  const [bounded] = request({ command: "preview", remote_root: root });
  assert.ok(bounded.event === "preview");
  assert.equal(bounded.files.length, 5);
  assert.equal(bounded.truncated, true);
  request({ protocol_version: 999, command: "probe", remote_root: null }, false);
  request({ command: "hash", remote_root: root, hash_algorithm: "blake3", files: [{ relative_path: "../escape", size_bytes: 0, modified_unix_nanos: "0" }] }, false);
  console.log(`Agent smoke test passed: ${ready.os}/${ready.arch}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
