// The command line inside a real sandbox (macOS sandbox-exec, the mechanism under the sandboxes of desktop agents):
// it must name the sandbox — blocked_network, blocked_file — rather than say the emulator is not running (EMU-157).
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { spawnProgram } from "../../../engine/programs.mjs";

const CLI = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "busy-emulator.mjs");
// Run beside the server's tests (npm run test:unit). Where EMU_TEST_PORTS names the ports to use, those tests take its
// first ones and these its last two, one per file; otherwise the bar of this test takes any free port.
let PORT = process.env.EMU_TEST_PORTS ? Number(process.env.EMU_TEST_PORTS.split("-")[1]) - 1 : 0;
const SANDBOX = "/usr/bin/sandbox-exec";
const skip = (process.platform !== "darwin" || !existsSync(SANDBOX)) && "macOS sandbox-exec";

let folder;
let server;

before(async () => {
  if (skip) return;
  folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-cli-")));
  mkdirSync(path.join(folder, "run"));
  server = http.createServer((_req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  PORT = server.address().port;
  // A running emulator, as far as the command line can tell: this process, and a bar that answers.
  writeFileSync(path.join(folder, "run", "emulator.json"), JSON.stringify({ pid: process.pid, started: Date.now(), port: PORT, url: `http://127.0.0.1:${PORT}`, state: "ready" }));
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (folder) rmSync(folder, { recursive: true, force: true });
});

// Not spawnSync: the bar of this test answers from this process, which must keep running meanwhile.
function status(profile) {
  const command = profile ? [SANDBOX, "-p", profile, process.execPath, CLI] : [process.execPath, CLI];
  const child = spawnProgram(command[0], [...command.slice(1), "status", "--json"], { env: { ...process.env, BUSY_EMULATOR_DATA: folder } });
  let stdout = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, json: JSON.parse(stdout) })));
}

test("outside a sandbox the emulator is seen running", { skip }, async () => {
  const { code, json } = await status(null);
  assert.equal(code, 0);
  assert.equal(json.running, true);
  assert.equal(json.answering, true);
});

test("a sandbox that closes loopback: blocked_network, with what to do", { skip }, async () => {
  const { code, json } = await status('(version 1)(allow default)(deny network-outbound (remote ip "localhost:*"))');
  assert.equal(code, 1);
  assert.equal(json.code, "blocked_network");
  assert.match(json.message, new RegExp(`127\\.0\\.0\\.1:${PORT} \\(EPERM\\)`));
  assert.match(json.hint, /outside the sandbox/);
});

test("a sandbox that closes the data folder: blocked_file, with what to do", { skip }, async () => {
  const { code, json } = await status(`(version 1)(allow default)(deny file-read* (subpath "${path.join(folder, "run")}"))`);
  assert.equal(code, 1);
  assert.equal(json.code, "blocked_file");
  assert.match(json.hint, /outside the sandbox/);
});
