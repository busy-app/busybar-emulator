// Where the command line finds things, and the pieces of system.mjs that can run on any machine.
import assert from "node:assert/strict";
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { spawnProgram } from "../../../engine/programs.mjs";
import { resolveContext } from "../context.mjs";
import { npmWatch } from "../project.mjs";
import { alive, launchApp, probe, processInfo, readRunState, removeRunStateOf, samePath } from "../system.mjs";
// The shell writes what the command line reads: both must name the same places.
import { resolveConfig } from "../../../app/src/config.mjs";

// Run beside the server's tests (npm run test:unit). Where EMU_TEST_PORTS names the ports to use, those tests take its
// first ones and these its last two, one per file; otherwise a port that was free a moment ago (freePort()).
const PORT = process.env.EMU_TEST_PORTS ? Number(process.env.EMU_TEST_PORTS.split("-")[1]) : null;

/** PORT, or a port that nobody listened on a moment ago: two runs of the tests on one machine do not meet. */
async function freePort() {
  if (PORT) return PORT;
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function files(map) {
  return (file) => {
    const normal = file.replace(/\\/g, "/");
    if (normal in map) return map[normal];
    throw Object.assign(new Error(`ENOENT ${file}`), { code: "ENOENT" });
  };
}

const MAC_SCRIPT = "/Applications/BUSY Bar Emulator.app/Contents/Resources/emulator/packages/server/cli/busy-emulator.mjs";
const WIN_SCRIPT = "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\resources\\emulator\\packages\\server\\cli\\busy-emulator.mjs";
const base = { homeDir: "/Users/you", execPath: "/x/node", nodeVersion: "24.22.2" };
const testEnv = { BUSY_EMULATOR_DATA: "/tmp/data", BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify(["/x/electron", "/x/app"]) };

test("inside a release: the app around it, the user's data folder, nothing from BUSY_EMULATOR_* but the path it was called by", () => {
  const read = files({ "/Applications/BUSY Bar Emulator.app/Contents/Resources/build.json": JSON.stringify({ kind: "release", version: "1.2.3", node: "24.22.2" }) });
  const ctx = resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: { ...testEnv, BUSY_EMULATOR_CLI_PATH: "/Users/you/.busy-emulator/bin/busy-emulator" }, read });
  assert.equal(ctx.kind, "release");
  assert.equal(ctx.appPath, "/Applications/BUSY Bar Emulator.app");
  assert.equal(ctx.version, "1.2.3");
  assert.equal(ctx.dataDir, "/Users/you/Library/Application Support/BUSY Bar Emulator");
  assert.equal(ctx.runStateFile, "/Users/you/Library/Application Support/BUSY Bar Emulator/run/emulator.json");
  assert.equal(ctx.testLaunch, null);
  assert.deepEqual(ctx.calledAs, ["/Users/you/.busy-emulator/bin/busy-emulator"]);
});

test("inside the test variant: the data folder and the way of launching come from the environment", () => {
  const read = files({ "/Applications/BUSY Bar Emulator.app/Contents/Resources/build.json": JSON.stringify({ kind: "test", version: "1.2.3" }) });
  const ctx = resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: testEnv, read });
  assert.equal(ctx.kind, "test");
  assert.equal(ctx.dataDir, "/tmp/data");
  assert.deepEqual(ctx.testLaunch, ["/x/electron", "/x/app"]);
  assert.deepEqual(ctx.calledAs, ["/x/node", MAC_SCRIPT]);
  for (const bad of ["not json", "[]", "[1]", '"x"']) {
    assert.equal(resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: { BUSY_EMULATOR_TEST_LAUNCH: bad }, read }).testLaunch, null, bad);
  }
});

test("a marker that cannot be read makes a release", () => {
  const read = files({ "/Applications/BUSY Bar Emulator.app/Contents/Resources/build.json": "{ broken" });
  const ctx = resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: testEnv, read });
  assert.equal(ctx.kind, "release");
  assert.equal(ctx.testLaunch, null);
  assert.equal(ctx.dataDir, "/Users/you/Library/Application Support/BUSY Bar Emulator");
});

test("one rule for the command line and the app shell: no marker inside an app is a release; a marker never says development (review H2, S3)", () => {
  // The packaging forgot the copy of the marker, or it was removed: the command line inside the app stays a release.
  const none = resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: testEnv, read: files({}), exists: () => true });
  assert.equal(none.kind, "release");
  assert.equal(none.testLaunch, null);
  assert.equal(none.dataDir, "/Users/you/Library/Application Support/BUSY Bar Emulator");
  const claims = files({ "/Applications/BUSY Bar Emulator.app/Contents/Resources/build.json": JSON.stringify({ kind: "development" }) });
  assert.equal(resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: testEnv, read: claims }).kind, "release");
  // A tree that looks like the sources but has a bundled Node is an app.
  const lookalike = files({ "/repo/emulator/packages/app/package.json": JSON.stringify({ version: "0.0.7" }) });
  assert.equal(resolveContext({ ...base, platform: "darwin", scriptPath: "/repo/emulator/packages/server/cli/busy-emulator.mjs", env: {}, read: lookalike, exists: () => true }).kind, "release");
});

test("a release takes the user's folders from the system, not from HOME or LOCALAPPDATA (security S1)", () => {
  const mac = files({ "/Applications/BUSY Bar Emulator.app/Contents/Resources/build.json": JSON.stringify({ kind: "release" }) });
  const ctx = resolveContext({ ...base, homeDir: "/tmp/project", systemHomeDir: "/Users/you", platform: "darwin", scriptPath: MAC_SCRIPT, env: {}, read: mac });
  assert.equal(ctx.dataDir, "/Users/you/Library/Application Support/BUSY Bar Emulator");
  const win = files({ "C:/Users/you/AppData/Local/Programs/BUSY Bar Emulator/resources/build.json": JSON.stringify({ kind: "release" }) });
  const w = resolveContext({ ...base, homeDir: "C:\\x", systemHomeDir: "C:\\Users\\you", platform: "win32", scriptPath: WIN_SCRIPT, env: { LOCALAPPDATA: "C:\\x\\project" }, read: win });
  assert.equal(w.dataDir, "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator");
  assert.equal(ctx.defaultPort, 8640);
  assert.equal(resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: { BUSY_EMULATOR_PORT: "8911" }, read: mac }).defaultPort, 8640);
});

test("from the source folder: development, no app, the version of the app's package", () => {
  const read = files({ "/repo/emulator/packages/app/package.json": JSON.stringify({ version: "0.0.7" }) });
  const ctx = resolveContext({ ...base, platform: "darwin", scriptPath: "/repo/emulator/packages/server/cli/busy-emulator.mjs", env: { BUSY_EMULATOR_PORT: "8911" }, read, exists: () => false });
  assert.equal(ctx.defaultPort, 8911);
  assert.equal(ctx.kind, "development");
  assert.equal(ctx.appPath, null);
  assert.equal(ctx.version, "0.0.7");
});

test("a test's time of npm's silence: for every npm run, or for the dependencies' installs only; never in a release", () => {
  const read = files({ "/repo/emulator/packages/app/package.json": JSON.stringify({ version: "0.0.7" }) });
  const at = (value) => resolveContext({ ...base, platform: "darwin", scriptPath: "/repo/emulator/packages/server/cli/busy-emulator.mjs", env: { BUSY_EMULATOR_TEST_NPM_QUIET: value }, read, exists: () => false });
  const quiet = (value, kind) => npmWatch(at(value), null, kind).quietMs;
  assert.deepEqual([quiet("4", null), quiet("4", "dependencies")], [4000, 4000]);
  assert.deepEqual([quiet("4:dependencies", null), quiet("4:dependencies", "dependencies")], [45_000, 4000], "the generator's npm keeps the real time");
  assert.deepEqual([quiet("4:other", "dependencies"), quiet("x", "dependencies")], [45_000, 45_000]);
  const release = resolveContext({ ...base, platform: "darwin", scriptPath: MAC_SCRIPT, env: { BUSY_EMULATOR_TEST_NPM_QUIET: "4" }, read: files({ "/Applications/BUSY Bar Emulator.app/Contents/Resources/build.json": JSON.stringify({ kind: "release", version: "1.2.3" }) }) });
  assert.equal(npmWatch(release, null, "dependencies").quietMs, 45_000);
});

// The public repository is the emulator's folder at its root, without emulator/ above packages/ (EMU-164): a run from
// a clone of it is a development run too, not a release that ignores BUSY_EMULATOR_* and takes the user's folders.
test("from the public repository's source folder, which has no emulator/ level: development as well", () => {
  for (const [platform, root] of [["darwin", "/home/me/busybar-emulator"], ["win32", "C:/src/busybar-emulator"]]) {
    const read = files({ [`${root}/packages/app/package.json`]: JSON.stringify({ version: "0.0.7" }) });
    const ctx = resolveContext({ ...base, platform, scriptPath: `${root}/packages/server/cli/busy-emulator.mjs`, env: { BUSY_EMULATOR_PORT: "8911" }, read, exists: () => false });
    assert.equal(ctx.kind, "development", platform);
    assert.equal(ctx.defaultPort, 8911, platform);
    assert.equal(ctx.appPath, null, platform);
    assert.equal(ctx.version, "0.0.7", platform);
  }
});

test("Windows: the app's executable beside its resources, the data folder under LOCALAPPDATA", () => {
  const read = files({ "C:/Users/you/AppData/Local/Programs/BUSY Bar Emulator/resources/build.json": JSON.stringify({ kind: "release", version: "1.2.3" }) });
  const ctx = resolveContext({ ...base, homeDir: "C:\\Users\\you", platform: "win32", scriptPath: WIN_SCRIPT, env: { LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" }, read });
  assert.equal(ctx.appPath, "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\BUSY Bar Emulator.exe");
  assert.equal(ctx.dataDir, "C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator");
});

test("the shell and the command line agree on the data folder, the mirror and the app", () => {
  const read = files({
    "/Applications/BUSY Bar Emulator.app/Contents/Resources/build.json": JSON.stringify({ kind: "release" }),
    "C:/Users/you/AppData/Local/Programs/BUSY Bar Emulator/resources/build.json": JSON.stringify({ kind: "release" }),
  });
  const cases = [
    { platform: "darwin", script: MAC_SCRIPT, appDir: "/Applications/BUSY Bar Emulator.app/Contents/Resources/app.asar", homeDir: "/Users/you", appDataDir: "/Users/you/Library/Application Support", env: {} },
    { platform: "win32", script: WIN_SCRIPT, appDir: "C:\\Users\\you\\AppData\\Local\\Programs\\BUSY Bar Emulator\\resources\\app.asar", homeDir: "C:\\Users\\you", appDataDir: "C:\\Users\\you\\AppData\\Roaming", env: { LOCALAPPDATA: "C:\\Users\\you\\AppData\\Local" } },
  ];
  for (const one of cases) {
    const shell = resolveConfig({ env: one.env, platform: one.platform, kind: "release", testVariant: false, appDir: one.appDir, appDataDir: one.appDataDir, homeDir: one.homeDir });
    const cli = resolveContext({ ...base, homeDir: one.homeDir, platform: one.platform, scriptPath: one.script, env: one.env, read });
    assert.equal(cli.dataDir, shell.dataDir, one.platform);
    assert.equal(cli.runStateFile, shell.runStateFile, one.platform);
    assert.equal(cli.pointerFile, shell.installFiles.pointer, one.platform);
    assert.equal(cli.appPath, shell.installFiles.appPath, one.platform);
    assert.equal(one.script, shell.installFiles.cli, one.platform);
  }
});

// ---------------------------------------------------------------- the system, for real

test("the mirror: missing, unreadable, broken and good files are told apart", { skip: process.platform === "win32" && "file modes" }, () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "busy-cli-"));
  try {
    const file = path.join(folder, "run", "emulator.json");
    assert.deepEqual(readRunState(file), { missing: true });
    mkdirSync(path.dirname(file));
    writeFileSync(file, "{ broken");
    assert.ok(readRunState(file).invalid);
    writeFileSync(file, JSON.stringify({ pid: "x", port: 1 }));
    assert.ok(readRunState(file).invalid);
    writeFileSync(file, JSON.stringify({ pid: 1, port: 2 }));
    assert.deepEqual(readRunState(file), { state: { pid: 1, port: 2 } });
    if (process.getuid?.() !== 0) {
      chmodSync(file, 0o000);
      assert.deepEqual(readRunState(file), { blocked: "EACCES" });
      chmodSync(file, 0o600);
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the bar's address: answering, refused", async () => {
  const port = await freePort();
  assert.deepEqual(await probe(port, 2000), { answering: false, code: "ECONNREFUSED" });
  const server = http.createServer((_req, res) => res.end("{}"));
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  try {
    assert.deepEqual(await probe(port, 2000), { answering: true });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a process, by the system's account: when it started and what it runs", () => {
  const mine = processInfo(process.pid);
  assert.ok(mine !== null, "the system describes this process");
  const age = Date.now() - mine.start;
  assert.ok(age >= -1500 && age < 10 * 60_000, `started ${age} ms ago`);
  assert.ok(samePath(mine.exe, process.execPath), `${mine.exe} is ${process.execPath}`);
  assert.equal(processInfo(2 ** 30), null);
  assert.equal(processInfo(0), null);
  assert.equal(alive(process.pid), true);
  assert.equal(alive(2 ** 30), false);
});

test("a process whose executable lies under a name outside Latin letters is described by its real path", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "busy-cli-"));
  const place = path.join(folder, "Φάκελος フォルダ");
  mkdirSync(place);
  const copy = path.join(place, path.basename(process.execPath));
  copyFileSync(process.execPath, copy, constants.COPYFILE_FICLONE);
  const child = spawnProgram(copy, ["-e", "setTimeout(() => {}, 20000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    const info = processInfo(child.pid);
    assert.ok(info, "described");
    assert.ok(samePath(info.exe, copy), `${info.exe} is ${copy}`);
  } finally {
    child.kill();
    await new Promise((resolve) => child.once("exit", resolve));
    rmSync(folder, { recursive: true, force: true, maxRetries: 10 });
  }
});

test("the mirror is removed only while it still names the process that was ended", () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "busy-cli-"));
  try {
    const file = path.join(folder, "emulator.json");
    writeFileSync(file, JSON.stringify({ pid: 10, port: 1 }));
    removeRunStateOf(file, 11);
    assert.equal(existsSync(file), true, "a newer emulator's mirror stays");
    removeRunStateOf(file, 10);
    assert.equal(existsSync(file), false);
    removeRunStateOf(file, 10);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a test's launch runs the given program and does not wait for it", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "busy-cli-"));
  try {
    const marker = path.join(folder, "launched");
    await launchApp({ testLaunch: [process.execPath, "-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "yes"); setTimeout(() => {}, 300)`] });
    for (let i = 0; i < 100 && !existsSync(marker); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(existsSync(marker));
    await assert.rejects(launchApp({ testLaunch: null, appPath: null, platform: process.platform }), /no app/);
    await assert.rejects(launchApp({ testLaunch: null, appPath: path.join(folder, "Nothing.app"), platform: process.platform }), /does not exist/);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 400));
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the app is started the system's way, and given no argument: open on macOS, Explorer from the system's Windows folder", async () => {
  const folder = mkdtempSync(path.join(os.tmpdir(), "busy-cli-"));
  try {
    const appPath = path.join(folder, "BUSY Bar Emulator.app");
    mkdirSync(appPath);
    const started = [];
    const stand = (exitCode) => (program, args, options) => {
      started.push({ program, args, detached: options.detached });
      const child = new EventEmitter();
      child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => child.stderr, destroy() {} });
      child.unref = () => {};
      setImmediate(() => (child.emit("spawn"), child.emit("exit", exitCode)));
      return child;
    };
    await launchApp({ platform: "darwin", appPath, testLaunch: null }, stand(0));
    await launchApp({ platform: "win32", appPath, testLaunch: null, windowsDir: "E:\\Windows" }, stand(1));
    assert.deepEqual(started, [
      { program: "/usr/bin/open", args: [appPath], detached: true },
      { program: "E:\\Windows\\explorer.exe", args: [appPath], detached: true },
    ]);
    // An open that fails says so; Explorer's exit code means nothing and is not read.
    await assert.rejects(launchApp({ platform: "darwin", appPath, testLaunch: null }, stand(1)), /open exited with 1/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the Windows folder is the one the Windows launcher hands over, never SystemRoot of the caller (security S5)", () => {
  const read = files({ "C:/Users/you/AppData/Local/Programs/BUSY Bar Emulator/resources/build.json": JSON.stringify({ kind: "release" }) });
  const ctx = (env) => resolveContext({ ...base, homeDir: "C:\\Users\\you", platform: "win32", scriptPath: WIN_SCRIPT, env, read }).windowsDir;
  assert.equal(ctx({ SystemRoot: "C:\\Users\\Public\\fake" }), "C:\\Windows");
  assert.equal(ctx({ BUSY_EMULATOR_WINDOWS_DIR: "D:\\WINNT", SystemRoot: "C:\\Users\\Public\\fake" }), "D:\\WINNT");
  assert.equal(ctx({ BUSY_EMULATOR_WINDOWS_DIR: "relative\\path" }), "C:\\Windows");
});
