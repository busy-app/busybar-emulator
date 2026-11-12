// The launcher at the fixed path, the pointer file and the mirror of the state (src/install-files.mjs).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { launcherPathIn } from "../../src/config.mjs";
import { macLauncherScript, ownDataFolder, pointerContent, removeRunState, shellQuote, windowsLaunchContent, WINDOWS_LAUNCH_FILE, writeInstallFiles, writeRunState } from "../../src/install-files.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const posix = process.platform !== "win32";
// A name with what shells and file systems make hard: spaces, a quote, Cyrillic, a dollar sign.
const HARD = "Φάκελος with 'quotes' $HOME";

/** A stand-in for the command line: prints its arguments and how it was called, as JSON. */
function echoScript(folder) {
  const file = path.join(folder, "echo cli.mjs");
  writeFileSync(file, "console.log(JSON.stringify({ args: process.argv.slice(2), calledAs: process.env.BUSY_EMULATOR_CLI_PATH ?? null, cwd: process.cwd(), nodeOptions: process.env.NODE_OPTIONS ?? null }));\n");
  return file;
}

function layout(folder, platform = process.platform) {
  const home = path.join(folder, HARD, "home");
  const data = path.join(folder, HARD, "data");
  const resources = path.join(folder, HARD, "BUSY Bar Emulator.app", "Contents", "Resources");
  mkdirSync(resources, { recursive: true });
  return {
    launcher: launcherPathIn(home, platform),
    pointer: path.join(data, "install.json"),
    appPath: path.dirname(path.dirname(resources)),
    node: process.execPath,
    cli: echoScript(folder),
    inAppLauncher: path.join(resources, "bin", "busy-emulator.exe"),
  };
}

test("a word of the shell stays one word whatever it holds", { skip: !posix && "POSIX shell" }, () => {
  for (const text of [HARD, "", "a'b''c", "x\ny", "$(echo no)", "`no`", "\\"]) {
    const said = execFileSync("/bin/sh", ["-c", `printf %s ${shellQuote(text)}`], { encoding: "utf8" });
    assert.equal(said, text);
  }
});

test("the pointer file has exactly the three fields of ADR-0002, section 7", () => {
  const content = JSON.parse(pointerContent({ appPath: "/A/B.app", launcher: "/h/.busy-emulator/bin/busy-emulator", version: "1.2.3" }));
  assert.deepEqual(content, { app: "/A/B.app", cli: "/h/.busy-emulator/bin/busy-emulator", version: "1.2.3" });
});

test("the Windows launcher's file names the Node and then the script, one per line", () => {
  assert.equal(windowsLaunchContent({ node: "C:\\Program Files\\A b\\node.exe", cli: "C:\\Program Files\\A b\\cli.mjs" }), "C:\\Program Files\\A b\\node.exe\r\nC:\\Program Files\\A b\\cli.mjs\r\n");
});

test("macOS: the launcher runs this copy's command line with every argument as given, with an empty PATH", { skip: !posix && "macOS launcher" }, async () => {
  const folder = temporaryFolder();
  try {
    const files = layout(folder, "darwin");
    assert.deepEqual(writeInstallFiles(files, { platform: "darwin", version: "1.2.3" }), { ok: true });
    assert.equal(statSync(files.launcher).mode & 0o777, 0o755);
    assert.equal(readFileSync(files.launcher, "utf8"), macLauncherScript(files));
    const args = ["a b", "&", "%PATH%", "^", '"', "'", "$HOME", "*", "", "Γειά フォルダ", "--json"];
    const run = spawnSync(files.launcher, args, { encoding: "utf8", env: { PATH: "" }, cwd: folder });
    assert.equal(run.status, 0, run.stderr);
    const said = JSON.parse(run.stdout);
    assert.deepEqual(said.args, args);
    assert.equal(said.calledAs, files.launcher);
    // The command line runs where it was called from: relative paths in its arguments mean what the caller meant.
    assert.equal(realpathSync(said.cwd), realpathSync(folder));
    assert.deepEqual(JSON.parse(readFileSync(files.pointer, "utf8")), { app: files.appPath, cli: files.launcher, version: "1.2.3" });
  } finally {
    await removeFolder(folder);
  }
});

test("macOS: when the copy it names is gone, the launcher says so and fails", { skip: !posix && "macOS launcher" }, async () => {
  const folder = temporaryFolder();
  try {
    const files = { ...layout(folder, "darwin"), node: path.join(folder, "gone", "node") };
    writeInstallFiles(files, { platform: "darwin", version: "1.2.3" });
    const run = spawnSync(files.launcher, ["status"], { encoding: "utf8", env: { PATH: "" } });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /BUSY Bar Emulator is no longer at .*Open the emulator once/);
  } finally {
    await removeFolder(folder);
  }
});

test("every start rewrites the launcher and the pointer: they name the copy that started last", async () => {
  const folder = temporaryFolder();
  try {
    const first = layout(folder, "darwin");
    writeInstallFiles(first, { platform: "darwin", version: "1.0.0" });
    const moved = { ...first, appPath: path.join(folder, "Applications", "BUSY Bar Emulator.app"), cli: path.join(folder, "Applications", "cli.mjs") };
    writeInstallFiles(moved, { platform: "darwin", version: "1.1.0" });
    assert.equal(readFileSync(first.launcher, "utf8"), macLauncherScript(moved));
    assert.deepEqual(JSON.parse(readFileSync(first.pointer, "utf8")), { app: moved.appPath, cli: first.launcher, version: "1.1.0" });
    // Whole files only: no temporary file is left beside them.
    assert.deepEqual(readdirSync(path.dirname(first.launcher)), ["busy-emulator"]);
    assert.deepEqual(readdirSync(path.dirname(first.pointer)), ["install.json"]);
  } finally {
    await removeFolder(folder);
  }
});

test("Windows: the launcher is a copy of the app's executable with its .launch file; an equal copy is left alone", async () => {
  const folder = temporaryFolder();
  try {
    const files = layout(folder);
    mkdirSync(path.dirname(files.inAppLauncher), { recursive: true });
    writeFileSync(files.inAppLauncher, "first build");
    assert.deepEqual(writeInstallFiles(files, { platform: "win32", version: "1.2.3" }), { ok: true });
    assert.equal(readFileSync(files.launcher, "utf8"), "first build");
    assert.equal(readFileSync(path.join(path.dirname(files.launcher), WINDOWS_LAUNCH_FILE), "utf8"), windowsLaunchContent(files));
    const before = statSync(files.launcher).mtimeMs;
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeInstallFiles(files, { platform: "win32", version: "1.2.3" });
    assert.equal(statSync(files.launcher).mtimeMs, before, "the same bytes are not written again");
    writeFileSync(files.inAppLauncher, "second build");
    writeInstallFiles(files, { platform: "win32", version: "1.2.4" });
    assert.equal(readFileSync(files.launcher, "utf8"), "second build");
  } finally {
    await removeFolder(folder);
  }
});

test("a launcher that cannot be written is a failure the caller hears about, not an exception", async () => {
  const folder = temporaryFolder();
  try {
    const files = layout(folder, "darwin");
    // A file where the launcher's folder should be.
    mkdirSync(path.dirname(path.dirname(files.launcher)), { recursive: true });
    writeFileSync(path.dirname(files.launcher), "in the way");
    const result = writeInstallFiles(files, { platform: "darwin", version: "1.2.3" });
    assert.equal(result.ok, false);
    assert.ok(result.error);
    assert.equal(existsSync(files.pointer), false, "no pointer to a launcher that is not there");
  } finally {
    await removeFolder(folder);
  }
});

test("the mirror of the state is written whole and removed", async () => {
  const folder = temporaryFolder();
  try {
    const file = path.join(folder, "run", "emulator.json");
    writeRunState(file, { pid: 1, port: 2, state: "ready" });
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { pid: 1, port: 2, state: "ready" });
    writeRunState(file, { pid: 1, port: 2, state: "gave-up" });
    assert.equal(JSON.parse(readFileSync(file, "utf8")).state, "gave-up");
    assert.deepEqual(readdirSync(path.dirname(file)), ["emulator.json"]);
    removeRunState(file);
    removeRunState(file);
    assert.equal(existsSync(file), false);
  } finally {
    await removeFolder(folder);
  }
});

// ---------------------------------------------------------------- security S2, S4

test("macOS: the launcher gives Node nothing that changes how it starts, and its shell takes no code from the environment", { skip: !posix && "macOS launcher" }, async () => {
  const folder = temporaryFolder();
  try {
    const files = layout(folder, "darwin");
    writeInstallFiles(files, { platform: "darwin", version: "1.2.3" });
    const planted = path.join(folder, "planted.cjs");
    const ran = path.join(folder, "planted-ran");
    writeFileSync(planted, `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "yes");\n`);
    const run = spawnSync(files.launcher, ["x"], {
      encoding: "utf8",
      env: { PATH: "", NODE_OPTIONS: `--require ${planted}`, OPENSSL_CONF: planted, "BASH_FUNC_exec%%": `() { echo planted; }`, ENV: planted, BASH_ENV: planted },
    });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).nodeOptions, null);
    assert.equal(existsSync(ran), false, "NODE_OPTIONS reached Node");
    assert.doesNotMatch(run.stdout, /planted/);
  } finally {
    await removeFolder(folder);
  }
});

test("the launcher's folders are the user's alone, whatever the umask", { skip: !posix && "file modes" }, async () => {
  const folder = temporaryFolder();
  const before = process.umask(0o002);
  try {
    const files = layout(folder, "darwin");
    assert.deepEqual(writeInstallFiles(files, { platform: "darwin", version: "1.2.3" }), { ok: true });
    assert.equal(statSync(path.dirname(files.launcher)).mode & 0o777, 0o700);
    assert.equal(statSync(path.dirname(path.dirname(files.launcher))).mode & 0o777, 0o700);
    // Folders that were there with looser rights are set to it.
    const again = layout(path.join(folder, "again"), "darwin");
    mkdirSync(path.dirname(again.launcher), { recursive: true, mode: 0o777 });
    writeInstallFiles(again, { platform: "darwin", version: "1.2.3" });
    assert.equal(statSync(path.dirname(again.launcher)).mode & 0o777, 0o700);
  } finally {
    process.umask(before);
    await removeFolder(folder);
  }
});

test("the data folder is the user's alone, whatever the umask; one made 775 before is set to 0700; a link is left alone (EMU-242)", { skip: !posix && "file modes" }, async () => {
  const folder = temporaryFolder();
  const before = process.umask(0o002);
  try {
    const data = path.join(folder, "Application Support", "BUSY Bar Emulator");
    assert.equal(ownDataFolder(data), "made");
    assert.equal(statSync(data).mode & 0o777, 0o700);
    assert.equal(ownDataFolder(data), "kept");
    const older = path.join(folder, "older");
    mkdirSync(older, { mode: 0o775 });
    assert.equal(statSync(older).mode & 0o777, 0o775, "as an older version made it under umask 002");
    assert.equal(ownDataFolder(older), "tightened");
    assert.equal(statSync(older).mode & 0o777, 0o700);
    const elsewhere = path.join(folder, "elsewhere");
    mkdirSync(elsewhere, { mode: 0o775 });
    symlinkSync(elsewhere, path.join(folder, "linked"));
    assert.equal(ownDataFolder(path.join(folder, "linked")), "not_own");
    assert.equal(statSync(elsewhere).mode & 0o777, 0o775, "a link's target is not touched");
  } finally {
    process.umask(before);
    await removeFolder(folder);
  }
});

test("a link in the way is replaced, never written through; a linked folder is refused", { skip: !posix && "symbolic links" }, async () => {
  const folder = temporaryFolder();
  try {
    const files = layout(folder, "darwin");
    const victim = path.join(folder, "victim.txt");
    writeFileSync(victim, "untouched", { mode: 0o600 });
    mkdirSync(path.dirname(files.launcher), { recursive: true });
    symlinkSync(victim, files.launcher);
    assert.deepEqual(writeInstallFiles(files, { platform: "darwin", version: "1.2.3" }), { ok: true });
    assert.equal(lstatSync(files.launcher).isSymbolicLink(), false);
    assert.equal(readFileSync(victim, "utf8"), "untouched");
    assert.equal(statSync(victim).mode & 0o777, 0o600, "the link's target kept its rights");

    // bin is a link to a folder someone else chose: nothing is written there.
    const linked = layout(path.join(folder, "linked"), "darwin");
    const elsewhere = path.join(folder, "elsewhere");
    mkdirSync(elsewhere);
    mkdirSync(path.dirname(path.dirname(linked.launcher)), { recursive: true });
    symlinkSync(elsewhere, path.dirname(linked.launcher));
    const result = writeInstallFiles(linked, { platform: "darwin", version: "1.2.3" });
    assert.equal(result.ok, false);
    assert.match(result.error, /not a folder of its own/);
    assert.deepEqual(readdirSync(elsewhere), []);
    assert.equal(existsSync(linked.pointer), false);
  } finally {
    await removeFolder(folder);
  }
});
