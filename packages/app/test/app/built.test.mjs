// The app as tools/dist.mjs builds it, in its test variant: the same Electron, fuses, archive and integrity record as
// the release, with the test entry and a bundle identifier of its own (tools/packaging/macos.mjs). The release itself
// is never started here: it shows its window and uses the user's own folders (that is EMU-017's smoke test).
//
//   node tools/dist.mjs build --kind test --allow-uncommitted       then
//   BUSY_EMULATOR_TEST_BUILT=<out>/test-variant/<target>/<app> npm run test:app
//
// What the fuses close is tried against the built app: ELECTRON_RUN_AS_NODE, NODE_OPTIONS, --inspect, an app/ folder
// in place of the archive. An archive changed after the build is refused; one changed together with the hash the app
// records starts — the integrity check protects a signed build only (ADR-0016). Hidden, as every launch in this suite.
import assert from "node:assert/strict";
import { constants, cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, afterEach, before, test } from "node:test";

import { writeAppArchive } from "../../tools/packaging/app-archive.mjs";
import { archiveEntries } from "../../tools/packaging/composition.mjs";
import { readFuseWire, fuseFileOf, RELEASE_WIRE } from "../../tools/packaging/fuses.mjs";
import { markerBytes } from "../../tools/packaging/resources.mjs";
import { listening, PORTS, removeFolder, temporaryFolder, until } from "../helpers.mjs";
import { launch } from "./harness.mjs";

const BUILT = process.env.BUSY_EMULATOR_TEST_BUILT;
const skip = !BUILT && "needs the built test variant: BUSY_EMULATOR_TEST_BUILT=<path of the app tools/dist.mjs built with --kind test>";
const darwin = process.platform === "darwin";
/** A launch that waits for something the fuses should prevent must fail, not wait for ever. */
const LIMIT = 120_000;

/** The executable and the resources folder of a built app (the .app on macOS, the folder on Windows). */
function partsOf(app) {
  return darwin
    ? { executable: path.join(app, "Contents", "MacOS", "BUSY Bar Emulator"), resources: path.join(app, "Contents", "Resources") }
    : { executable: path.join(app, "BUSY Bar Emulator.exe"), resources: path.join(app, "resources") };
}

let folder;
let running = null;

before(() => {
  if (skip) return;
  folder = temporaryFolder();
});

afterEach(async () => {
  await running?.close();
  running = null;
});

after(async () => {
  if (folder) await removeFolder(folder);
});

/** A copy of the built app to change, as a copy-on-write clone where the disk can do that. */
function copyOfApp(name) {
  const to = path.join(folder, name, path.basename(BUILT));
  mkdirSync(path.dirname(to), { recursive: true });
  cpSync(BUILT, to, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
  return to;
}

test("the built app has the release's fuses, starts from its archive, runs the server on its own Node and shows its window", { skip, timeout: LIMIT }, async () => {
  assert.equal(readFuseWire(fuseFileOf(darwin ? BUILT : partsOf(BUILT).executable)).wire, RELEASE_WIRE);
  running = await launch({ executable: partsOf(BUILT).executable, server: "bundled" });
  const seen = await running.run((shell, electron) => ({ appPath: electron.app.getAppPath(), kind: shell.config.kind, node: shell.config.nodePath, server: shell.config.serverEntry }));
  assert.equal(path.basename(seen.appPath), "app.asar");
  assert.equal(seen.kind, "test");
  assert.equal(seen.node, path.join(partsOf(BUILT).resources, "node", darwin ? "bin/node" : "node.exe"));
  assert.equal(seen.server, path.join(partsOf(BUILT).resources, "emulator", "packages", "server", "server.mjs"));
  await running.waitState("ready");
  await running.waitWindow("device");
});

test("the built app's window has its actions: the main window's preload is in the archive and they run the bundled command line", { skip, timeout: LIMIT }, async () => {
  running = await launch({ executable: partsOf(BUILT).executable, server: "bundled" });
  await running.waitState("ready");
  await running.waitWindow("device");
  const cli = await running.run((shell) => shell.config.cliEntry);
  assert.equal(cli, path.join(partsOf(BUILT).resources, "emulator", "packages", "server", "cli", "busy-emulator.mjs"));
  assert.ok(existsSync(cli), cli);
  assert.deepEqual(await running.page("window.emulatorActions.available()"), { shell: true });
  // Both read actions are runs of the bundled command line (actions.mjs); neither needs a click.
  const list = await running.page("window.emulatorActions.projects.list().then((value) => ({ value }), (e) => ({ error: e.code + ': ' + e.message }))");
  assert.deepEqual(list, { value: [] });
  const examples = await running.page("window.emulatorActions.projects.examples().then((value) => ({ value }), (e) => ({ error: e.code + ': ' + e.message }))");
  assert.equal(examples.error, undefined, examples.error);
  assert.ok(Array.isArray(examples.value) && examples.value.length > 0, JSON.stringify(examples));
});

test("ELECTRON_RUN_AS_NODE does not make the built app a Node: it starts as the app and runs no script", { skip, timeout: LIMIT }, async () => {
  const witness = path.join(folder, "run-as-node.txt");
  running = await launch({
    executable: partsOf(BUILT).executable,
    server: "fake",
    env: { ELECTRON_RUN_AS_NODE: "1" },
    args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(witness)}, "ran as node")`],
  });
  assert.equal(await running.run((_shell, electron) => typeof electron.app.getAppPath), "function");
  assert.equal(existsSync(witness), false);
});

test("NODE_OPTIONS does not reach the main process, even under Electron's own name", { skip, timeout: LIMIT }, async () => {
  // Electron itself ignores most of NODE_OPTIONS in an app it takes for packaged, by the executable's name: a copy
  // named as Electron's own executable is what the fuse alone has to close.
  const app = copyOfApp("named-electron");
  const { executable } = partsOf(app);
  const renamed = path.join(path.dirname(executable), darwin ? "Electron" : "electron.exe");
  renameSync(executable, renamed);
  const witness = path.join(folder, "node-options.txt");
  const script = path.join(folder, "node-options.cjs");
  writeFileSync(script, `require("node:fs").writeFileSync(${JSON.stringify(witness)}, "required")\n`);
  running = await launch({ executable: renamed, server: "fake", env: { NODE_OPTIONS: `--require=${script}` } });
  await running.waitState("ready");
  assert.equal(await running.run((_shell, electron) => electron.app.isPackaged), false, "the copy is taken for Electron's own executable");
  assert.equal(existsSync(witness), false);
});

test("--inspect opens no inspector in the built app", { skip, timeout: LIMIT }, async () => {
  const port = PORTS.other;
  running = await launch({ executable: partsOf(BUILT).executable, server: "fake", args: [`--inspect=127.0.0.1:${port}`] });
  await running.waitState("ready");
  assert.equal(await listening(port), false);
  assert.doesNotMatch(running.stderr(), /Debugger listening/);
});

// Without the archive, Electron looks for an app/ folder; with OnlyLoadAppFromAsar it must not run one, and it ends
// (on macOS it may say so in a system window, so there the test runs only when asked, as the crash below).
const failingStartSkip = skip || (darwin && process.env.BUSY_EMULATOR_TEST_FAILING_STARTS !== "1" && "a start that fails may show a system window on macOS: BUSY_EMULATOR_TEST_FAILING_STARTS=1");
test("an app/ folder in place of the archive is not run", { skip: failingStartSkip, timeout: LIMIT }, async () => {
  const app = copyOfApp("app-folder");
  const witness = path.join(folder, "app-folder.txt");
  const { resources, executable } = partsOf(app);
  rmSync(path.join(resources, "app.asar"));
  const beside = path.join(resources, "app");
  mkdirSync(beside, { recursive: true });
  writeFileSync(path.join(beside, "package.json"), JSON.stringify({ name: "not-the-app", main: "main.js" }));
  writeFileSync(path.join(beside, "build.json"), markerBytes("test"));
  writeFileSync(path.join(beside, "main.js"), `require("node:fs").writeFileSync(${JSON.stringify(witness)}, "the folder ran"); require("electron").app.quit();\n`);
  running = await launch({ executable, server: "fake", hook: false });
  const ended = await Promise.race([running.exited, new Promise((resolve) => setTimeout(() => resolve(null), 20_000))]);
  assert.ok(ended, "the app without its archive is still running");
  assert.equal(existsSync(witness), false, "the app/ folder ran");
});

test("an archive changed together with the hash the app records is run: the check protects a signed build only", { skip, timeout: LIMIT }, async () => {
  const app = copyOfApp("changed-with-hash");
  const witness = path.join(folder, "changed-with-hash.txt");
  const entries = archiveEntries({ kind: "test", marker: markerBytes("test") }).map((entry) =>
    entry.name === "src/main.mjs" ? { name: entry.name, bytes: Buffer.concat([Buffer.from(`import { writeFileSync as witness } from "node:fs";\nwitness(${JSON.stringify(witness)}, "changed code ran");\n`), readFileSync(entry.file)]) } : entry,
  );
  const archive = await writeAppArchive(path.join(partsOf(app).resources, "app.asar"), entries);
  if (darwin) {
    const { readPlist, writePlist } = await import("../../tools/packaging/macos.mjs");
    const plist = path.join(app, "Contents", "Info.plist");
    const value = readPlist(plist);
    value.ElectronAsarIntegrity["Resources/app.asar"].hash = archive.headerHash;
    writePlist(plist, value);
  } else {
    const { patchExecutable } = await import("../../tools/packaging/windows.mjs");
    await patchExecutable(partsOf(app).executable, { version: "0.0.0", headerHash: archive.headerHash });
  }
  running = await launch({ executable: partsOf(app).executable, server: "fake" });
  await until(() => existsSync(witness), "the changed code to run");
});

// Electron ends a process whose archive fails the check with a crash. On macOS the system may show its "quit
// unexpectedly" window for it, so there the test runs only when asked; on Windows over SSH nothing can appear.
test("an archive changed after the build is refused: the app ends before any of its code runs", { skip: failingStartSkip, timeout: LIMIT }, async () => {
  const app = copyOfApp("changed");
  const archive = path.join(partsOf(app).resources, "app.asar");
  const bytes = readFileSync(archive);
  // A byte of src/main.mjs, past the header: the header still matches the recorded hash, the file's blocks do not.
  const at = bytes.indexOf(Buffer.from("main process of the desktop shell"));
  assert.ok(at > 0, "the archive holds main.mjs as text");
  bytes[at] ^= 0x20;
  writeFileSync(archive, bytes);
  running = await launch({ executable: partsOf(app).executable, server: "fake", hook: false });
  const ended = await Promise.race([running.exited, new Promise((resolve) => setTimeout(() => resolve(null), 20_000))]);
  assert.ok(ended, "the app with a changed archive is still running");
  assert.equal(running.hooked(), false, "the changed app connected to the test entry: its code ran");
  assert.notEqual(ended.code, 0);
});
