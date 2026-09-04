import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";

assert.ok(process.argv[2], "Pass the desktop executable path");
const binary = resolve(process.argv[2]);

async function check(cancel: boolean) {
  const token = "offline-smoke-token";
  const server = createServer((socket) => {
    socket.setTimeout(10_000, () => socket.destroy());
    let input = "";
    socket.on("data", (bytes) => {
      input += bytes.toString("utf8");
      if (!input.includes("\n")) return;
      const request = JSON.parse(input);
      assert.equal(request.token, token);
      assert.equal(request.message, "Test password:");
      if (cancel) { socket.end(Buffer.from([0])); return; }
      const value = Buffer.from("offline-test-answer", "utf8");
      const header = Buffer.alloc(5);
      header[0] = 1;
      header.writeUInt32BE(value.length, 1);
      socket.end(Buffer.concat([header, value]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const child = spawn(binary, ["Test password:"], {
      env: { ...process.env, NAFM_ASKPASS_ADDRESS: `127.0.0.1:${address.port}`, NAFM_ASKPASS_TOKEN: token },
      stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
    });
    let output = "";
    let errors = "";
    child.stdout.on("data", (bytes) => { output += bytes.toString(); });
    child.stderr.on("data", (bytes) => { errors += bytes.toString(); });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", resolve);
    });
    assert.equal(code, cancel ? 1 : 0);
    assert.equal(output, cancel ? "" : "offline-test-answer\n");
    assert.equal(errors, "");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

await check(false);
await check(true);
console.log("SSH askpass executable smoke test passed (answer and cancellation).");
