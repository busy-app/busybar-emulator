// The supervisor and the server process: the server runs inside the supervisor's process (EMU-239), and it and
// everything it started go when the shell asks, when the shell dies, when the supervisor dies, and when both die at
// once.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, test } from "node:test";

import { serverEnvironment, startServerProcess } from "../../src/server-process.mjs";
import { NODE_ENVIRONMENT_UNSET } from "../../src/install-files.mjs";
import { alive, APP_DIR, endOnExit, FAKE_SERVER, listening, NODE, PORTS, removeFolder, SUPERVISOR, survivors, temporaryFolder, until } from "../helpers.mjs";

const PORT = PORTS.unit;
const posix = process.platform !== "win32";
let folder;
let started;

beforeEach(() => {
  folder = temporaryFolder();
  started = [];
});
afterEach(async () => {
  // Whatever a failed test left running.
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Gone, as it should be.
    }
  }
  assert.deepEqual(await survivors(started), [], "processes left behind");
  assert.equal(await listening(PORT), false, "the port is still taken");
  await removeFolder(folder);
});

const report = () => path.join(folder, "report.json");
const readReport = () => until(() => existsSync(report()) && JSON.parse(readFileSync(report(), "utf8")), "the fake server's report");
const stoppedThroughStop = () => existsSync(`${report()}.stopped`);

function startFake(extraEnv = {}, options = {}) {
  const lines = [];
  const ready = [];
  const run = startServerProcess({
    nodePath: NODE,
    supervisorPath: SUPERVISOR,
    serverEntry: FAKE_SERVER,
    serverOptions: { port: PORT, dataDir: folder, ...options },
    env: { ...process.env, FAKE_SERVER_REPORT: report(), FAKE_SERVER_CHILD: "1", ...extraEnv },
    onLine: (line, stream) => lines.push(`${stream}:${line}`),
    onReady: (facts) => ready.push(facts),
  });
  started.push(run.pid);
  return { run, lines, ready };
}

/** A parent that plays the shell, in a process group of its own on macOS and Linux. */
async function startParent(extraEnv = {}) {
  const parent = endOnExit(
    spawn(NODE, [path.join(APP_DIR, "test", "fixtures", "parent.mjs"), NODE, SUPERVISOR, FAKE_SERVER, String(PORT), folder], {
      env: { ...process.env, FAKE_SERVER_REPORT: report(), FAKE_SERVER_CHILD: "1", ...extraEnv },
      stdio: ["ignore", "pipe", "inherit"],
      detached: posix,
    }),
  );
  started.push(parent.pid);
  let out = "";
  parent.stdout.setEncoding("utf8").on("data", (chunk) => (out += chunk));
  const { supervisor } = await until(() => out.includes("\n") && JSON.parse(out), "the parent's line");
  const { pid, child } = await readReport();
  started.push(supervisor, child);
  assert.equal(pid, supervisor, "the server runs in the supervisor's process");
  assert.ok(alive(supervisor) && alive(child));
  return { parent, supervisor, child };
}

test("the server runs in the supervisor's process and says it is ready with its port, over the channel", async () => {
  const { run, lines, ready } = startFake({ FAKE_SERVER_CONTROL_PORT: "8769" });
  const { pid, child, options } = await readReport();
  started.push(child);
  assert.equal(pid, run.pid, "no second process: the server is the supervisor's");
  await until(() => ready.length, "the ready message");
  assert.deepEqual(ready[0], { type: "ready", port: PORT, url: `http://127.0.0.1:${PORT}`, dataDir: folder, apiVersion: "0.0.0", controlPort: 8769, controlUrl: "http://127.0.0.1:8769", firmware: "fake" });
  // The supervisor adds only what cannot pass as data: among it `askPerson`, the server's way to a question that
  // the shell asks the person (person-question.test.mjs).
  assert.deepEqual(options.sort(), ["askPerson", "dataDir", "log", "onError", "port", "signal"]);
  await until(() => lines.some((line) => line.startsWith(`out:BUSY Bar emulator: http://127.0.0.1:${PORT}`)), "the first line");
  assert.ok(lines.some((line) => /^out:\d\d:\d\d:\d\d the fake bar is up$/.test(line)), lines.join("|"));
  await run.stop();
});

test("the options are passed to startServer as they are, whatever they are", async () => {
  const { run } = startFake({}, { barSpeed: false, firmware: "dev", controlKey: "k" });
  const { child, options } = await readReport();
  started.push(child);
  assert.deepEqual(options.sort(), ["askPerson", "barSpeed", "controlKey", "dataDir", "firmware", "log", "onError", "port", "signal"]);
  await run.stop();
});

test("stop goes through the server's stop(), and what the server started goes with it", async () => {
  const { run } = startFake({ FAKE_SERVER_CHILD: "stubborn" });
  const { child } = await readReport();
  started.push(child);
  await run.stop();
  const end = await run.exited;
  assert.deepEqual({ code: end.code, stopped: end.stopped, said: end.said }, { code: 0, stopped: true, said: true });
  assert.ok(stoppedThroughStop(), "the server's stop() did not run");
  assert.deepEqual(await survivors([run.pid, child]), [], "the child the server forgot outlived the stop");
});

test("a stop asked during the start calls the start off: no ready, a clean end", async () => {
  const { run, ready } = startFake({ FAKE_SERVER_DELAY_MS: "5000" });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await run.stop();
  const end = await run.exited;
  assert.deepEqual({ code: end.code, stopped: end.stopped, said: end.said }, { code: 0, stopped: true, said: true });
  assert.equal(ready.length, 0);
});

test("a stop() that never ends is not waited for: the process ends with an error after a few seconds", async () => {
  const { run } = startFake({ FAKE_SERVER_HANG_STOP: "1" });
  const { child } = await readReport();
  started.push(child);
  await run.stop();
  const end = await run.exited;
  // Said by the supervisor itself (the shell's force comes later and says nothing).
  assert.deepEqual({ code: end.code, said: end.said }, { code: 1, said: true });
  assert.match(end.error, /did not stop within 4 s/);
});

test("a server that cannot start is reported with its reason and its code", async () => {
  const { run, lines, ready } = startFake({ FAKE_SERVER_FAIL: "Port is in use, says the fake", FAKE_SERVER_FAIL_CODE: "EADDRINUSE" });
  const end = await run.exited;
  assert.deepEqual({ code: end.code, said: end.said, error: end.error, errorCode: end.errorCode }, { code: 1, said: true, error: "Port is in use, says the fake", errorCode: "EADDRINUSE" });
  assert.ok(lines.includes("err:Port is in use, says the fake"), lines.join("|"));
  assert.equal(ready.length, 0);
});

test("a module without startServer is a failed start that says so", async () => {
  const module = path.join(folder, "not-a-server.mjs");
  writeFileSync(module, "export const nothing = 1;\n");
  const run = startServerProcess({ nodePath: NODE, supervisorPath: SUPERVISOR, serverEntry: module, serverOptions: { port: PORT, dataDir: folder }, env: process.env, onLine: () => {} });
  started.push(run.pid);
  const end = await run.exited;
  assert.equal(end.code, 1);
  assert.match(end.error, /has no startServer/);
});

test("the server's process ends by itself: its exit code is reported, and what it started goes with it", async () => {
  const { run } = startFake({ FAKE_SERVER_DIE_AFTER_MS: "200", FAKE_SERVER_CHILD: "stubborn" });
  const { child } = await readReport();
  started.push(child);
  const end = await run.exited;
  assert.deepEqual({ code: end.code, signal: end.signal, stopped: end.stopped, said: end.said }, { code: 3, signal: null, stopped: false, said: false });
  // On Windows the child ends with the Node that started it; elsewhere the shell ends the supervisor's group.
  assert.deepEqual(await survivors([run.pid, child]), []);
});

test("an error nobody caught ends the server: said, and nothing it started is left", async () => {
  const { run, lines } = startFake({ FAKE_SERVER_THROW_AFTER_MS: "200", FAKE_SERVER_CHILD: "stubborn" });
  const { child } = await readReport();
  started.push(child);
  const end = await run.exited;
  assert.deepEqual({ code: end.code, stopped: end.stopped, said: end.said }, { code: 1, stopped: false, said: true });
  assert.match(end.error, /the fake failed by itself/);
  assert.ok(lines.some((line) => line.startsWith("err:supervisor: uncaughtException: Error: the fake failed by itself")), lines.join("|"));
  assert.deepEqual(await survivors([run.pid, child]), []);
});

test("the shell is killed: the server and everything it started end by themselves", async () => {
  const { parent, supervisor, child } = await startParent({ FAKE_SERVER_CHILD: "stubborn" });
  parent.kill("SIGKILL");
  assert.deepEqual(await survivors([parent.pid, supervisor, child]), [], "left after the parent was killed");
  // On Windows the job object of the killed parent takes the supervisor at once, without a stop; elsewhere the
  // supervisor sees its standard input close and stops the server itself.
  if (posix) assert.ok(stoppedThroughStop(), "the server was not stopped through its stop()");
  assert.equal(await listening(PORT), false);
});

test("the shell and the supervisor are killed at once: the port is free and nothing is left", async () => {
  // The server is the supervisor's process, so there is nothing to outlive it but what the server started, and a
  // helper that minds its parent ends with it. (One that does not would outlive it on macOS and Linux: no process is
  // left to end it. The server starts none.)
  const { parent, supervisor, child } = await startParent();
  process.kill(parent.pid, "SIGKILL");
  process.kill(supervisor, "SIGKILL");
  assert.deepEqual(await survivors([parent.pid, supervisor, child]), [], "left after both were killed");
  assert.equal(await listening(PORT), false);
});

test("the shell's process group is killed: nothing is left", { skip: !posix && "process groups are of macOS and Linux" }, async () => {
  const { parent, supervisor, child } = await startParent({ FAKE_SERVER_CHILD: "stubborn" });
  process.kill(-parent.pid, "SIGKILL");
  assert.deepEqual(await survivors([parent.pid, supervisor, child]), [], "left after the group was killed");
  assert.equal(await listening(PORT), false);
});

test("the supervisor is killed: the shell ends what the server started", async () => {
  const { run } = startFake({ FAKE_SERVER_CHILD: "stubborn" });
  const { child } = await readReport();
  started.push(child);
  process.kill(run.pid, "SIGKILL");
  const end = await run.exited;
  assert.equal(end.stopped, false);
  assert.deepEqual(await survivors([run.pid, child]), []);
});

test("a terminate signal to the supervisor stops the server through its stop()", { skip: !posix && "Windows has no terminate signal to send" }, async () => {
  const { run } = startFake({ FAKE_SERVER_CHILD: "stubborn" });
  const { child } = await readReport();
  started.push(child);
  process.kill(run.pid, "SIGTERM");
  const end = await run.exited;
  assert.deepEqual({ code: end.code, stopped: end.stopped, said: end.said }, { code: 0, stopped: true, said: true });
  assert.ok(stoppedThroughStop());
  assert.deepEqual(await survivors([run.pid, child]), []);
});

test("the channel to the shell is closed with the standard input still open: the server stops", async () => {
  const child = spawn(NODE, [SUPERVISOR, FAKE_SERVER], { env: { ...process.env, FAKE_SERVER_REPORT: report() }, stdio: ["pipe", "ignore", "ignore", "ipc"], detached: posix });
  started.push(child.pid);
  const ready = new Promise((resolve) => child.on("message", (m) => m.type === "ready" && resolve()));
  child.send({ type: "start", options: { port: PORT, dataDir: folder } });
  await ready;
  child.disconnect();
  assert.deepEqual(await survivors([child.pid], 3000), [], "the supervisor did not notice the channel close");
  assert.ok(stoppedThroughStop());
  child.stdin.end();
});

test("a wrong call ends at once with exit code 2", () => {
  const noChannel = spawnSync(NODE, [SUPERVISOR, FAKE_SERVER], { encoding: "utf8", timeout: 15_000 });
  assert.equal(noChannel.status, 2);
  assert.match(noChannel.stderr, /without a channel/);
  const extra = spawnSync(NODE, [SUPERVISOR, FAKE_SERVER, "--port", "1"], { encoding: "utf8", timeout: 15_000 });
  assert.equal(extra.status, 2);
  assert.equal(spawnSync(NODE, [SUPERVISOR], { encoding: "utf8", timeout: 15_000 }).status, 2);
});

test("the server's environment has nothing that changes how Node starts, nothing of Electron's and none of the shell's own settings", async () => {
  assert.deepEqual(
    serverEnvironment({ PATH: "/bin", NODE_OPTIONS: "--require /x.js", Node_Options: "x", ELECTRON_RUN_AS_NODE: "1", BUSY_EMULATOR_PORT: "1", busy_emulator_data: "x", HOME: "/h" }),
    { PATH: "/bin", HOME: "/h" },
  );
  // The whole list the command line's launchers use (ADR-0016), and Electron's settings by their prefix; the tokens
  // the project's tools may need stay (EMU-201 security review, S9).
  const given = Object.fromEntries([...NODE_ENVIRONMENT_UNSET, "ELECTRON_ENABLE_LOGGING", "electron_log_file"].map((name) => [name, "x"]));
  assert.deepEqual(serverEnvironment({ ...given, GH_TOKEN: "t", NODE_ENV: "production" }), { GH_TOKEN: "t", NODE_ENV: "production" });
  const { run } = startFake({ NODE_OPTIONS: "--no-warnings", ELECTRON_RUN_AS_NODE: "1", BUSY_EMULATOR_TEST_HOOK: "x" });
  const { child, env } = await readReport();
  started.push(child);
  for (const name of ["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE", "BUSY_EMULATOR_TEST_HOOK"]) assert.ok(!env.includes(name), name);
  assert.ok(env.includes("FAKE_SERVER_CHILD"));
  await run.stop();
});

test("started by a path with a link in it, the supervisor does the same", async () => {
  // A link to a folder: a junction on Windows, which needs no privilege.
  const link = path.join(folder, "linked-app");
  symlinkSync(APP_DIR, link, "junction");
  const ready = [];
  const run = startServerProcess({
    nodePath: NODE,
    supervisorPath: path.join(link, "src", "supervisor.mjs"),
    serverEntry: path.join(link, "test", "fixtures", "fake-server.mjs"),
    serverOptions: { port: PORT, dataDir: folder },
    env: { ...process.env, FAKE_SERVER_REPORT: report() },
    onLine: () => {},
    onReady: (facts) => ready.push(facts),
  });
  started.push(run.pid);
  await until(() => ready.length, "the ready message");
  assert.equal(ready[0].port, PORT);
  await run.stop();
});
