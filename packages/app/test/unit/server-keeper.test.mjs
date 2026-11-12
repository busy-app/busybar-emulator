// The life of the server as the shell keeps it, on plain Node with the stand-in server.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { resolveConfig } from "../../src/config.mjs";
import { createRestartPolicy } from "../../src/restart-policy.mjs";
import { createServerKeeper, probePort } from "../../src/server-keeper.mjs";
import { alive, APP_DIR, FAKE_SERVER, HAS_REAL_SERVER, listening, NODE, occupy, PORTS, REAL_SERVER, removeFolder, sleep, survivors, temporaryFolder, until } from "../helpers.mjs";

const PORT = PORTS.unit;
let folder;
let keeper;
let seen;
let lines;

function make(fakeEnv = {}, change = {}, keeperOptions = {}) {
  const config = {
    ...resolveConfig({
      env: { BUSY_EMULATOR_PORT: String(PORT), BUSY_EMULATOR_DATA: folder, BUSY_EMULATOR_NODE: NODE, BUSY_EMULATOR_SERVER_ENTRY: FAKE_SERVER },
      platform: process.platform,
      kind: "development",
      testVariant: true,
      appDir: APP_DIR,
      appDataDir: folder,
      homeDir: folder,
    }),
    ...change,
  };
  seen = [];
  lines = [];
  keeper = createServerKeeper({
    config,
    env: { ...process.env, FAKE_SERVER_REPORT: path.join(folder, "report.json"), ...fakeEnv },
    log: (line) => lines.push(line),
    policy: change.policy,
    ...keeperOptions,
  });
  keeper.on("state", (state) => seen.push(state.name));
  return keeper;
}
const state = (name, timeoutMs) => until(() => keeper.state.name === name, `the state "${name}" (now "${keeper.state.name}"; log: ${lines.slice(-5).join(" | ")})`, timeoutMs);
const serverPid = () => until(() => keeper.pids()?.server, "the server's process id");

beforeEach(() => {
  folder = temporaryFolder();
});
afterEach(async () => {
  const pids = keeper?.pids();
  await keeper?.stop();
  if (pids) assert.deepEqual(await survivors([pids.supervisor, pids.server].filter(Boolean)), []);
  assert.equal(await listening(PORT), false, "the port is still taken");
  keeper = null;
  await removeFolder(folder);
});

test("start leads to ready once the server has said so, with its port, not before", async () => {
  // No slow start in between: on a loaded machine the two processes of a start take more than the 2 s by themselves.
  make({ FAKE_SERVER_DELAY_MS: "600" }, {}, { slowAfterMs: 600_000 });
  const started = Date.now();
  keeper.start();
  await state("starting");
  await sleep(300);
  assert.equal(keeper.state.name, "starting");
  await state("ready");
  assert.ok(Date.now() - started >= 600);
  assert.equal(keeper.state.address, `http://127.0.0.1:${PORT}`);
  assert.equal(keeper.state.port, PORT);
  assert.equal(await listening(PORT), true);
  assert.deepEqual(seen, ["starting", "ready"]);
  assert.equal(keeper.starts, 1);
});

test("the ready state has what the server said: a management port it names is there", async () => {
  make({ FAKE_SERVER_CONTROL_PORT: "8768" });
  keeper.start();
  await state("ready");
  assert.equal(keeper.state.controlPort, 8768);
});

test("a start that has had no answer for a while says so in its state; the answer then makes it ready", async () => {
  // The server answers when the test lets it, after the slow state was seen.
  const answer = path.join(folder, "answer-now");
  make({ FAKE_SERVER_WAIT_FOR: answer }, {}, { slowAfterMs: 300 });
  keeper.start();
  await until(() => keeper.state.slow === true, "the slow start");
  assert.equal(keeper.state.name, "starting");
  assert.ok(lines.includes("[shell] server: starting (no answer yet after 0.3 s)"), lines.join(" | "));
  writeFileSync(answer, "");
  await state("ready");
  assert.deepEqual(seen, ["starting", "starting", "ready"]);
});

test("a start that is answered in time never says it is slow", async () => {
  make({}, {}, { slowAfterMs: 1500 });
  keeper.start();
  await state("ready");
  await sleep(1700);
  assert.deepEqual(seen, ["starting", "ready"]);
});

test("the real server is started in the supervisor's process with the port and the data folder and becomes ready", { skip: !HAS_REAL_SERVER && "the server is not beside this package" }, async () => {
  make({}, { serverEntry: REAL_SERVER });
  keeper.start();
  await state("ready", 30_000);
  const answer = await fetch(`http://127.0.0.1:${PORT}/api/status`);
  assert.equal(answer.status, 200);
  assert.equal(keeper.state.port, PORT);
  // The management address the server took (EMU-009) is in the state, from the server's own word.
  assert.ok(Number.isInteger(keeper.state.controlPort) && keeper.state.controlPort !== PORT, `controlPort ${keeper.state.controlPort}`);
  // The lock of the data folder names the one process: the server is the supervisor's.
  assert.equal(JSON.parse(readFileSync(path.join(folder, "run", "server.lock"), "utf8")).pid, keeper.pids().supervisor);
  assert.ok(lines.some((line) => line.startsWith("[server] BUSY Bar emulator: ")));
  // The server has the whole data folder, laid out as architecture.md section 4 says (EMU-005).
  for (const entry of ["format", path.join("run", "server.lock"), path.join("bar", "1.3.1", "ext", "user_assets")]) {
    assert.ok(existsSync(path.join(folder, entry)), `${entry} in the data folder`);
  }
  assert.ok(!existsSync(path.join(folder, "bar", "bar")) && !existsSync(path.join(folder, "bar", "format")), "not a data folder inside bar/");
});

test("a dead server is started again, with nobody asking", async () => {
  make();
  keeper.start();
  await state("ready");
  const first = await serverPid();
  process.kill(first, "SIGKILL");
  await until(() => keeper.state.name === "ready" && keeper.pids()?.server && keeper.pids().server !== first, "the second server");
  assert.equal(keeper.starts, 2);
  assert.equal(alive(first), false);
  assert.deepEqual(seen, ["starting", "ready", "starting", "ready"]);
  assert.equal(await listening(PORT), true);
});

test("the third death within a minute is the last: no fourth start, and the state says so", async () => {
  make({ FAKE_SERVER_DIE_AFTER_MS: "150" });
  keeper.start();
  await state("gave-up");
  assert.equal(keeper.starts, 3);
  assert.deepEqual(seen, ["starting", "ready", "starting", "ready", "starting", "ready", "gave-up"]);
  assert.equal(keeper.state.deaths, 3);
  assert.match(keeper.state.detail, /exit code 3/);
  await sleep(500);
  assert.equal(keeper.starts, 3, "it was started again after giving up");
  assert.equal(keeper.pids(), null);
});

test("deaths far apart do not stop the restarts", async () => {
  let clock = 0;
  make({ FAKE_SERVER_DIE_AFTER_MS: "100" }, { policy: createRestartPolicy({ now: () => (clock += 31_000) }) });
  keeper.start();
  await until(() => keeper.starts >= 5, "the fifth start");
  assert.notEqual(keeper.state.name, "gave-up");
});

test("after giving up, retry starts the server and the count over", async () => {
  make({ FAKE_SERVER_DIE_AFTER_MS: "150" });
  keeper.start();
  await state("gave-up");
  keeper.retry();
  await until(() => keeper.starts === 4, "the fourth start");
  await state("gave-up");
  assert.equal(keeper.starts, 6);
});

test("a port in use is its own state, without a single start of the server", async () => {
  const other = await occupy(PORT);
  try {
    make();
    await keeper.start();
    assert.equal(keeper.state.name, "port-busy");
    assert.equal(keeper.state.port, PORT);
    assert.equal(keeper.starts, 0);
    await sleep(300);
    assert.deepEqual(seen, ["starting", "port-busy"]);
  } finally {
    await other.close();
  }
  // The port is free again: retry works.
  keeper.retry();
  await state("ready");
  assert.equal(keeper.starts, 1);
});

test("the server's own refusal of the port (something listens on another address) is a port in use too", async () => {
  make({ FAKE_SERVER_FAIL: "Port in use, the server says", FAKE_SERVER_FAIL_CODE: "EADDRINUSE" });
  await keeper.start();
  assert.equal(keeper.state.name, "port-busy");
  assert.equal(keeper.state.port, PORT);
  assert.equal(keeper.starts, 1);
  await sleep(300);
  assert.deepEqual(seen, ["starting", "port-busy"]);
});

test("a port the system refuses to the server (EACCES: reserved, as Windows keeps ranges back) is a port that is not available", async () => {
  make({ FAKE_SERVER_FAIL: "listen EACCES: permission denied 127.0.0.1", FAKE_SERVER_FAIL_CODE: "EACCES" });
  await keeper.start();
  assert.equal(keeper.state.name, "port-busy");
  assert.equal(keeper.state.reserved, true);
  assert.equal(keeper.state.port, PORT);
  assert.equal(keeper.starts, 1);
});

test("probePort tells a free port from a taken one", async () => {
  assert.deepEqual(await probePort(PORT), { free: true });
  const other = await occupy(PORT);
  try {
    const probe = await probePort(PORT);
    assert.equal(probe.free, false);
    assert.equal(probe.busy, true);
  } finally {
    await other.close();
  }
  assert.deepEqual(await probePort(PORT), { free: true });
});

test("a server that refuses to start is a failed start: one start, its reason kept", async () => {
  make({ FAKE_SERVER_FAIL: "Something is wrong with the fake" });
  await keeper.start();
  assert.equal(keeper.state.name, "failed");
  assert.equal(keeper.state.cause, "refused");
  assert.equal(keeper.state.detail, "Something is wrong with the fake");
  assert.equal(keeper.starts, 1);
  await sleep(300);
  assert.deepEqual(seen, ["starting", "failed"]);
});

test("a server whose process ends before it is ready is a failed start that says it ended", async () => {
  make({}, { serverEntry: path.join(APP_DIR, "test", "fixtures", "exits-at-once.mjs") });
  await keeper.start();
  assert.equal(keeper.state.name, "failed");
  assert.equal(keeper.state.cause, "ended");
  assert.match(keeper.state.detail, /^exit code 5: the module ended its process/);
});

test("a server that never says it is ready is stopped after the wait and is a failed start", async () => {
  make({ FAKE_SERVER_SILENT: "1" }, { startTimeoutMs: 700 });
  keeper.start();
  const pid = await serverPid();
  await state("failed");
  assert.equal(keeper.state.cause, "no-answer");
  assert.match(keeper.state.detail, /no answer in 1 s/);
  assert.deepEqual(await survivors([pid]), []);
  assert.equal(keeper.starts, 1);
});

test("a missing Node or a missing server is a failed start that says what is missing", async () => {
  make({}, { nodePath: path.join(folder, "no-node") });
  await keeper.start();
  assert.equal(keeper.state.name, "failed");
  assert.equal(keeper.state.cause, "no-node");
  assert.match(keeper.state.detail, /Node was not found at .*no-node/);
  assert.equal(keeper.starts, 0);

  make({}, { nodePath: null });
  await keeper.start();
  assert.match(keeper.state.detail, /Node was not found/);

  make({}, { serverEntry: path.join(folder, "no-server.mjs") });
  await keeper.start();
  assert.equal(keeper.state.cause, "no-server");
  assert.match(keeper.state.detail, /The server was not found at .*no-server\.mjs/);
});

test("stop ends the server and nothing starts it again", async () => {
  make({ FAKE_SERVER_CHILD: "stubborn" });
  keeper.start();
  await state("ready");
  const { pid, child } = JSON.parse(readFileSync(path.join(folder, "report.json"), "utf8"));
  const { supervisor } = keeper.pids();
  assert.equal(pid, supervisor);
  await keeper.stop();
  assert.equal(keeper.state.name, "stopped");
  assert.deepEqual(await survivors([supervisor, pid, child]), []);
  await sleep(300);
  assert.equal(keeper.starts, 1);
  assert.deepEqual(seen, ["starting", "ready", "stopped"]);
});

test("stop during the start leaves nothing running", async () => {
  make({ FAKE_SERVER_DELAY_MS: "400" });
  keeper.start();
  const pid = await serverPid();
  await keeper.stop();
  assert.deepEqual(await survivors([pid]), []);
  assert.equal(keeper.state.name, "stopped");
});

test("the server's output and the state changes are in the log", async () => {
  make({ FAKE_SERVER_FAIL: "Told on stderr" });
  await keeper.start();
  assert.ok(lines.includes("[shell] server: starting"));
  assert.ok(lines.includes("[server!] Told on stderr"));
  assert.ok(lines.includes("[shell] server ended: Told on stderr"));
  assert.ok(lines.includes("[shell] server: failed (Told on stderr)"));
});
