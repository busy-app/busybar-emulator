// The app laid out as a packaged one (tools/stage-resources.mjs, in a temporary folder with spaces and Cyrillic in
// its path): the server runs on the Node inside it, the app writes the launcher and the pointer at every start, and
// the command line sees, starts and quits it. Hidden, as every launch in this suite.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, realpathSync, renameSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { appPathOf, launcherPathIn } from "../../src/config.mjs";
import { WINDOWS_LAUNCH_FILE } from "../../src/install-files.mjs";
import { HARD_NAME, layOutApp, PIN, readJson, resourcesIn } from "../fixtures/layout.mjs";
import { alive, FAKE_SERVER, listening, PORTS, removeFolder, sleep, survivors, temporaryFolder, until } from "../helpers.mjs";
import { ELECTRON, HAS_REAL_SERVER, launch, QUIET_ENV } from "./harness.mjs";

let folder;
let laidOut;
let home;
let app = null;
const others = [];
const windows = process.platform === "win32";
let outputs = 0;

before(async () => {
  // By its real path: the app sees itself by its real path (on macOS the temporary folder lies behind a link).
  folder = realpathSync(temporaryFolder());
  laidOut = await layOutApp(folder);
  // Outside the app's folder, which the last test moves.
  home = path.join(folder, "Σπίτι with spaces");
});

afterEach(async () => {
  await app?.close();
  app = null;
  // Anything a command line started that a test did not end.
  for (const pid of others.splice(0)) {
    if (alive(pid)) process.kill(pid, "SIGKILL");
  }
});

after(async () => {
  if (folder) await removeFolder(folder);
});

/** The packaged-like app: its own Node (BUSY_EMULATOR_NODE is not given), the launcher and pointer under `home`. */
function launchLaidOut(extra = {}) {
  return launch({ appDir: laidOut.appDir, env: { BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_USER_HOME: home, ...extra } });
}

const launcher = () => launcherPathIn(home, process.platform);
/** The app as the pointer file and the command line name it: the bundle on macOS, the executable on Windows. */
const appPath = () => appPathOf(laidOut.resources, process.platform);

/**
 * Runs a command line as an agent would and waits for its process, without blocking this one. Its output goes to
 * files, not to pipes: the test's launch of `start` is the app itself, started by the command's own process, and on
 * Windows such a child takes the handles of the command's output with it. With pipes their end never came while the
 * app ran, and a test that waited for it hung. (A release starts the app through Explorer, which passes nothing on.)
 */
function runCommand(program, args, env) {
  const base = path.join(folder, `output-${++outputs}`);
  const files = [openSync(`${base}.out`, "w"), openSync(`${base}.err`, "w")];
  // With no mirror the command line looks at the bar's own port; the test's is named so that 8640 is never touched.
  const child = spawn(program, args, { env: { ...process.env, BUSY_EMULATOR_PORT: String(PORTS.other), ...env }, stdio: ["ignore", ...files] });
  for (const file of files) closeSync(file);
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => {
      const stdout = readFileSync(`${base}.out`, "utf8");
      const stderr = readFileSync(`${base}.err`, "utf8");
      resolve({ code, stdout, stderr, json: args.includes("--json") && stdout.trim() ? JSON.parse(stdout.trim()) : null });
    });
  });
}

/** The launcher at the fixed path. */
const cli = (args, env = {}) => runCommand(launcher(), args, env);

test("the server runs on the Node inside the app", async () => {
  app = await launchLaidOut();
  await app.waitWindow("device");
  const nodePath = await app.run((shell) => shell.config.nodePath);
  assert.equal(nodePath, path.join(laidOut.resources, "node", process.platform === "win32" ? "node.exe" : path.join("bin", "node")));
  const report = await app.fakeReport();
  assert.equal(realpathSync(report.node), realpathSync(nodePath));
  assert.equal(report.version, `v${PIN.version}`);
  assert.equal(await app.run((shell) => shell.config.kind), "test");
});

test("the real server runs on the Node inside the app and its bar answers", { skip: !HAS_REAL_SERVER && "the firmware's files are not here" }, async () => {
  app = await launch({ appDir: laidOut.appDir, server: "real", env: { BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_USER_HOME: home } });
  await app.waitWindow("device");
  assert.equal(await app.page("fetch('/api/status').then((r) => r.ok)"), true);
  const { server } = await app.run((shell) => shell.keeper.pids());
  const status = await cli(["status", "--json"], { BUSY_EMULATOR_DATA: app.folder });
  assert.equal(status.json.running, true);
  assert.equal(status.json.answering, true);
  assert.ok(alive(server));
});

test("at start the app writes the launcher and the pointer naming this copy, and the mirror of its state", async () => {
  app = await launchLaidOut();
  await app.waitWindow("device");
  // The app's own version, whatever it is: a release raises it.
  const own = readJson(path.join(import.meta.dirname, "..", "..", "package.json")).version;
  assert.deepEqual(readJson(path.join(app.folder, "install.json")), { app: appPath(), cli: launcher(), version: own });
  const state = readJson(path.join(app.folder, "run", "emulator.json"));
  assert.equal(state.state, "ready");
  assert.equal(state.port, app.port);
  assert.equal(state.pid, app.pid);
  const version = await cli(["version", "--json"]);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.json.cli.path, launcher());
  assert.equal(version.json.node, PIN.version);
  assert.match(app.log(), /\[shell\] command line: /);
});

test("the command line sees the running app, and quits it: nothing is left, the mirror is gone", async () => {
  app = await launchLaidOut();
  await app.waitWindow("device");
  const status = await cli(["status", "--json"], { BUSY_EMULATOR_DATA: app.folder });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(status.json.running, true);
  assert.equal(status.json.state, "ready");
  assert.equal(status.json.url, `http://127.0.0.1:${app.port}`);
  const pids = await app.pids();
  const quit = await cli(["quit", "--json"], { BUSY_EMULATOR_DATA: app.folder });
  assert.equal(quit.code, 0, quit.stderr);
  assert.deepEqual(quit.json, { ok: true, command: "quit", was_running: true });
  if (windows) {
    // Windows has no signal an app takes as Quit: the command ends the app's process (exit code 1, as the system
    // gives it), the server goes with it through its supervisor, and the command removes what the app would have.
    assert.deepEqual(await app.exited, { code: 1, signal: null });
  } else {
    // Quit as from the menu: the server was asked to stop, and the app ended on its own.
    assert.deepEqual(await app.exited, { code: 0, signal: null });
  }
  assert.deepEqual(await survivors(pids), []);
  assert.equal(await listening(app.port), false);
  assert.equal(existsSync(path.join(app.folder, "run", "emulator.json")), false);
  if (!windows) assert.match(app.log(), /\[shell\] quitting[\s\S]*server: stopped/);
  assert.equal((await cli(["status", "--json"], { BUSY_EMULATOR_DATA: app.folder })).json.running, false);
});

test("start launches the app, without arguments, and waits until its bar answers; a second start brings it forward", async () => {
  // The command line's own launch would go through the system and put a window on the screen; the test's launch
  // starts the same hidden app the harness starts. What it gets is only what start gives: the program, no arguments.
  app = await launchLaidOut();
  await app.waitWindow("device");
  const env = { BUSY_EMULATOR_DATA: app.folder, BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([ELECTRON, laidOut.appDir]) };
  const again = await cli(["start", "--json"], { ...env, ...QUIET_ENV, BUSY_EMULATOR_PORT: String(app.port), BUSY_EMULATOR_USER_HOME: home, BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_SERVER_ENTRY: FAKE_SERVER, BUSY_EMULATOR_TEST_HOOK: "" });
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.already_running, true);
  await until(() => app.run((shell) => shell.secondLaunches === 1), "the second launch to arrive");
  await app.quit();
  await app.close();
  app = null;

  // Not running: start starts it, detached from the command line, and waits for its bar.
  const data = temporaryFolder();
  try {
    const startEnv = { ...QUIET_ENV, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(PORTS.cli), BUSY_EMULATOR_USER_HOME: home, BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_SERVER_ENTRY: FAKE_SERVER, BUSY_EMULATOR_TEST_HOOK: "", BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([ELECTRON, laidOut.appDir]) };
    const started = await cli(["start", "--json"], startEnv);
    assert.equal(started.code, 0, started.stderr);
    assert.equal(started.json.already_running, false);
    assert.equal(started.json.url, `http://127.0.0.1:${PORTS.cli}`);
    others.push(started.json.pid);
    assert.ok(alive(started.json.pid), "the app outlives the command that started it");
    assert.equal(await listening(PORTS.cli), true);
    const quit = await cli(["quit", "--json"], startEnv);
    assert.equal(quit.json.was_running, true);
    assert.deepEqual(await survivors([started.json.pid]), []);
    assert.equal(await listening(PORTS.cli), false);
  } finally {
    await removeFolder(data);
  }
});

test("quit racing a start that is still under way: nothing is left running, and the start ends at once instead of waiting a minute", async () => {
  // The launcher is written by the app at a start; one start so that it is there.
  app = await launchLaidOut();
  await app.waitWindow("device");
  await app.quit();
  await app.close();
  app = null;

  // Three moments of a start (the release rehearsal): before its process has done anything (the quit finds nothing
  // and leaves its note), once it has left its mark but the app has not named itself, and with the app's mirror there.
  for (const delay of [0, 200, 600]) {
    const data = temporaryFolder();
    try {
      const env = { ...QUIET_ENV, BUSY_EMULATOR_DATA: data, BUSY_EMULATOR_PORT: String(PORTS.cli), BUSY_EMULATOR_USER_HOME: home, BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_SERVER_ENTRY: FAKE_SERVER, BUSY_EMULATOR_TEST_HOOK: "", BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([ELECTRON, laidOut.appDir]) };
      const mirror = path.join(data, "run", "emulator.json");
      const began = Date.now();
      const starting = cli(["start", "--json"], env);
      // The app's process, whenever its mirror shows it, so that a test that fails leaves nothing behind either.
      const watch = setInterval(() => {
        try {
          const { pid } = readJson(mirror);
          if (!others.includes(pid)) others.push(pid);
        } catch {
          // Not there yet, or gone.
        }
      }, 20);
      await sleep(delay);
      const quit = await cli(["quit", "--json"], env);
      const started = await starting;
      clearInterval(watch);
      const took = Date.now() - began;
      assert.equal(quit.code, 0, quit.stderr);
      const what = `quit ${delay} ms after start: start ${JSON.stringify(started.json)}, quit ${JSON.stringify(quit.json)}`;
      // Either the start was over before the quit looked (then the quit ended a running emulator), or the start says
      // that it was interrupted; never a wait for the bar of an app that is gone.
      if (started.code === 0) assert.equal(quit.json.was_running, true, what);
      else assert.equal(started.json.code, "start_interrupted", what);
      assert.ok(took < 30_000, `${what}: took ${took} ms`);
      // Nothing is left: no app, nobody at the port, no mirror, and status agrees.
      assert.deepEqual(await survivors(others), [], what);
      assert.equal(await listening(PORTS.cli), false, what);
      assert.equal(existsSync(mirror), false, what);
      assert.equal((await cli(["status", "--json"], env)).json.running, false, what);
      await sleep(1500);
      assert.equal(await listening(PORTS.cli), false, `${what}: an emulator came up afterwards`);
    } finally {
      await removeFolder(data);
    }
  }
});

test("an app that must be moved writes neither launcher nor pointer, and the command line says why", { skip: process.platform !== "darwin" && "macOS only" }, async () => {
  const fresh = path.join(folder, "home-of-a-moved-app");
  app = await launch({ appDir: laidOut.appDir, env: { BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_USER_HOME: fresh, BUSY_EMULATOR_APP_LOCATION: path.join(folder, "AppTranslocation", "X", "d", "BUSY Bar Emulator.app") } });
  await app.waitWindow("message");
  assert.equal(existsSync(fresh), false, "nothing written for a random place");
  assert.equal(existsSync(path.join(app.folder, "install.json")), false);
  assert.equal(readJson(path.join(app.folder, "run", "emulator.json")).state, "move-app");
  const env = { BUSY_EMULATOR_DATA: app.folder, BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([process.execPath, "-e", ""]) };
  const status = await runInApp(["status", "--json"], env);
  assert.equal(status.json.state, "move-app");
  const start = await runInApp(["start", "--json"], env);
  assert.equal(start.code, 1);
  assert.equal(start.json.code, "move_app");
});

/** The command line inside the app, by its full path. */
const runInApp = (args, env) => runCommand(laidOut.launcher, args, env);

// Last: it moves the laid-out app.
test("moved to another folder, the app rewrites the launcher and the pointer at its next start", async (t) => {
  // One data folder for both starts, as a user's is.
  const data = temporaryFolder();
  t.after(() => removeFolder(data));
  app = await launch({ appDir: laidOut.appDir, dataDir: data, env: { BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_USER_HOME: home } });
  await app.waitWindow("device");
  const before = readJson(path.join(data, "install.json")).app;
  await app.quit();
  await app.close();
  app = null;

  const moved = path.join(folder, `${HARD_NAME} (moved)`);
  renameSync(laidOut.place, moved);
  laidOut = { ...laidOut, place: moved, resources: resourcesIn(moved), appDir: path.join(resourcesIn(moved), "app"), launcher: path.join(resourcesIn(moved), "bin", path.basename(laidOut.launcher)) };
  // The old launcher now names a copy that is gone, and says so.
  const stale = await cli(["version"]);
  assert.equal(stale.code, 1);
  // The sh script names the app's old place; the .exe on Windows names the Node its launch file points to.
  assert.match(stale.stderr, windows ? /no longer where this command expects it/ : /no longer at/);
  assert.ok(stale.stderr.includes(windows ? before.slice(0, before.lastIndexOf(path.sep)) : before), stale.stderr);

  app = await launch({ appDir: laidOut.appDir, dataDir: data, env: { BUSY_EMULATOR_NODE: "", BUSY_EMULATOR_USER_HOME: home } });
  await app.waitWindow("device");
  const pointer = readJson(path.join(data, "install.json"));
  assert.notEqual(pointer.app, before);
  assert.equal(pointer.app, appPath());
  assert.equal(pointer.cli, launcher());
  const version = await cli(["version", "--json"]);
  assert.equal(version.code, 0, version.stderr);
  assert.equal(version.json.app, appPathOf(resourcesIn(realpathSync(moved)), process.platform));
  // What says which copy the launcher runs: the sh script itself on macOS, the file beside the .exe on Windows.
  const launcherFolder = path.dirname(launcher());
  if (windows) {
    // An .exe that was running when the app wrote the new one may still lie there under its old-<pid> name.
    assert.deepEqual(readdirSync(launcherFolder).filter((name) => !/\.old-\d+$/.test(name)).sort(), [path.basename(launcher()), WINDOWS_LAUNCH_FILE].sort());
    assert.ok(readFileSync(path.join(launcherFolder, WINDOWS_LAUNCH_FILE), "utf8").includes("(moved)"));
  } else {
    assert.deepEqual(readdirSync(launcherFolder).sort(), [path.basename(launcher())]);
    assert.ok(readFileSync(launcher(), "utf8").includes("(moved)"));
  }
});
