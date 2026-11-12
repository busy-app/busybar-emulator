// uninstall.exe (installer/windows/uninstall.cs, EMU-218), on a small stand-in app whose three programs are real
// executables (test/fixtures/windows/uninstall-stand-in.cs): the app, its command line and a command that runs from
// the folder. Windows only. Every install here is a copy that is not the user's own (/NoShortcut, a temporary
// folder): its uninstaller touches nothing of the user's — no shortcut, no entry in Settings, no data folder, no
// command line's folder — which the tests rely on. The one test that makes a real install for the user (the entry in
// Settings -> Apps, the Start menu shortcut, the folders under %LOCALAPPDATA%) runs only with
// BUSY_EMULATOR_TEST_START_MENU=1 and only when none of these is there; it removes what it made.
//
// The runs are silent and have a time limit: an uninstaller that asked anything would wait for an answer nobody gives.
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn } from "node:child_process";
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { compileCSharp } from "../../tools/windows-launcher.mjs";
import { buildSetup, INSTALL_MARKER, payloadOf, UNINSTALLER } from "../../tools/packaging/windows.mjs";
import { APP_DIR, removeFolder, sleep, temporaryFolder } from "../helpers.mjs";

const skip = process.platform !== "win32" && "Windows only";
const EXE = "BUSY Bar Emulator.exe";
const CLI = "resources/bin/busy-emulator.exe";
const COMMAND = "resources/node/node.exe";
const LIMIT_MS = 90_000;

let folder;
let setup;
let standardUser;
let runs = 0;
const started = [];

before(() => {
  if (skip) return;
  folder = temporaryFolder();
  const standIn = compileCSharp(path.join(APP_DIR, "test", "fixtures", "windows", "uninstall-stand-in.cs"), path.join(folder, "stand-in.exe"));
  const app = path.join(folder, "app", "BUSY Bar Emulator");
  for (const name of [EXE, CLI, COMMAND]) {
    mkdirSync(path.dirname(path.join(app, ...name.split("/"))), { recursive: true });
    copyFileSync(standIn, path.join(app, ...name.split("/")));
  }
  writeFileSync(path.join(app, "resources", "app.asar"), "an archive");
  const work = path.join(folder, "work");
  mkdirSync(work, { recursive: true });
  setup = path.join(folder, "busybar-emulator-win-x64-setup.exe");
  buildSetup({ appFolder: app, work, out: setup, version: "1.2.3" });
  standardUser = compileCSharp(path.join(APP_DIR, "test", "fixtures", "windows", "standard-user.cs"), path.join(folder, "standard-user.exe"));
});

after(async () => {
  if (skip) return;
  // Processes this file started itself, by their handles.
  for (const child of started) if (child.exitCode === null) child.kill();
  await removeFolder(folder);
});

/** Runs the setup or an uninstaller as a standard user; gives its exit code and its log (named with /LOG=). */
function run(program, args, { temp = folder } = {}) {
  const logFile = path.join(folder, `run-${++runs}.log`);
  return new Promise((resolve) => {
    // The program's temporary folder is the test's: its default log and the uninstaller's moved file go there.
    execFile(standardUser, [program, `/LOG=${logFile}`, ...args], { timeout: LIMIT_MS, windowsHide: true, env: { ...process.env, TEMP: temp, TMP: temp } }, (error) => {
      resolve({ code: error ? (error.killed ? "timeout" : error.code) : 0, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" });
    });
  });
}

/** A copy that is not the user's own, in a folder of this test. */
async function install(name) {
  const to = path.join(folder, name, "BUSY Bar Emulator");
  const result = await run(setup, ["/S", "/NoShortcut", `/D=${to}`]);
  assert.equal(result.code, 0, result.log);
  return to;
}

function filesOf(at) {
  const out = [];
  const walk = (p, prefix) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), rel);
      else out.push(rel);
    }
  };
  walk(at, "");
  return out.sort();
}
const WHOLE = [EXE, CLI, COMMAND, "resources/app.asar", INSTALL_MARKER, UNINSTALLER].sort();

/** Starts a program of an install and waits until it runs. */
async function start(file) {
  const child = spawn(file, [], { stdio: "ignore", windowsHide: true });
  started.push(child);
  await new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  return child;
}
const ended = (child) => (child.exitCode !== null ? Promise.resolve(child.exitCode) : new Promise((resolve) => child.once("exit", (code) => resolve(code))));

async function until(what, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (!what()) {
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
  return true;
}

test("the setup puts itself, without the app, into the folder as the uninstaller", { skip }, async () => {
  const to = await install("written");
  assert.deepEqual(filesOf(to), WHOLE);
  assert.ok(readFileSync(path.join(to, UNINSTALLER)).equals(readFileSync(setup).subarray(0, payloadOf(setup).offset)));
});

test("a silent uninstall removes the folder whole, leaves nothing beside it or in the temporary folder, and says where the data are", { skip }, async () => {
  const to = await install("plain");
  const temp = path.join(folder, "temp-plain");
  mkdirSync(temp);
  writeFileSync(path.join(temp, "busybar-emulator-setup.log"), "the log of the setup that installed it\n");
  const result = await run(path.join(to, UNINSTALLER), ["/S"], { temp });
  assert.equal(result.code, 0, result.log);
  assert.equal(existsSync(to), false, "the app's folder is still there");
  assert.deepEqual(readdirSync(path.dirname(to)), [], "something is left beside the app's folder");
  assert.match(result.log, /removed the app's folder /);
  // Silent mode keeps the data unless told otherwise, and the log names the folder.
  assert.match(result.log, /the data folder is kept: .*\\BUSY Bar Emulator/);
  assert.equal(existsSync(path.join(temp, "busybar-emulator-setup.log")), false, "the setup's log in the temporary folder stayed");
  // The uninstaller moved out of the folder to remove it; its own file goes a moment after it ends.
  assert.ok(await until(() => readdirSync(temp).length === 0), `left in the temporary folder: ${readdirSync(temp).join(", ")}`);
});

test("the setup removes an install with /Uninstall", { skip }, async () => {
  const to = await install("by-setup");
  const result = await run(setup, ["/Uninstall", "/S", `/D=${to}`]);
  assert.equal(result.code, 0, result.log);
  assert.equal(existsSync(to), false);
});

test("only a folder the setup made is removed: anything else is refused with exit code 2, untouched", { skip }, async () => {
  const to = await install("not-an-install");
  const theirs = path.join(folder, "user", "Documents");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, "chapter-1.txt"), "a year of work");
  // Named with /D=, and the uninstaller copied into it and run from there.
  const named = await run(path.join(to, UNINSTALLER), ["/S", "/RemoveData", `/D=${theirs}`]);
  assert.equal(named.code, 2, named.log);
  assert.match(named.log, /is not an install of BUSY Bar Emulator made by its setup .*Nothing was removed/);
  copyFileSync(path.join(to, UNINSTALLER), path.join(theirs, UNINSTALLER));
  const copied = await run(path.join(theirs, UNINSTALLER), ["/S"]);
  assert.equal(copied.code, 2, copied.log);
  assert.deepEqual(readdirSync(theirs).sort(), ["chapter-1.txt", UNINSTALLER]);
  assert.deepEqual(filesOf(to), WHOLE);
  const missing = await run(path.join(to, UNINSTALLER), ["/S", `/D=${path.join(folder, "no-such-folder")}`]);
  assert.equal(missing.code, 2, missing.log);
  assert.match(missing.log, /is not installed in /);
});

test("the arguments of the other program, both data switches at once and unknown ones are refused with exit code 2", { skip }, async () => {
  const to = await install("arguments");
  for (const args of [["/S", "/KeepData", "/RemoveData"], ["/S", "/NoShortcut"], ["/S", "/Quiet"]]) {
    const result = await run(path.join(to, UNINSTALLER), args);
    assert.equal(result.code, 2, `${args.join(" ")}: ${result.log}`);
    assert.deepEqual(filesOf(to), WHOLE, args.join(" "));
  }
  // The setup never touches the data folder: a data switch without /Uninstall is a mistake, and nothing is installed.
  const fresh = path.join(folder, "arguments-fresh", "BUSY Bar Emulator");
  const result = await run(setup, ["/S", "/NoShortcut", "/RemoveData", `/D=${fresh}`]);
  assert.equal(result.code, 2, result.log);
  assert.equal(existsSync(fresh), false);
});

test("while a busy-emulator command runs from the folder the uninstaller refuses with exit code 3 and removes nothing", { skip }, async () => {
  const to = await install("command-running");
  // As a project build is: the Node inside the app, started by somebody who is not the app.
  const command = await start(path.join(to, ...COMMAND.split("/")));
  try {
    const result = await run(path.join(to, UNINSTALLER), ["/S"]);
    assert.equal(result.code, 3, result.log);
    assert.match(result.log, new RegExp(`A busy-emulator command is running from .*: process ${command.pid} \\(.*node\\.exe\\)\\. Wait for it to end or stop it, then run the uninstaller again\\. Nothing was removed\\.`));
    assert.doesNotMatch(result.log, /busy-emulator quit/, "the emulator is not asked to quit before the refusal");
    assert.deepEqual(filesOf(to), WHOLE);
  } finally {
    command.kill();
    await ended(command);
  }
  const after = await run(path.join(to, UNINSTALLER), ["/S"]);
  assert.equal(after.code, 0, after.log);
  assert.equal(existsSync(to), false);
});

test("the running emulator is quit through its own command line, then removed", { skip }, async () => {
  const to = await install("app-running");
  const app = await start(path.join(to, EXE));
  const result = await run(path.join(to, UNINSTALLER), ["/S"]);
  assert.equal(result.code, 0, result.log);
  assert.match(result.log, new RegExp(`the emulator is running: process ${app.pid} `));
  assert.match(result.log, /busy-emulator quit: exit code 0/);
  // The stand-in app ends with 0 only when the command line's quit reached it; nobody ended its process.
  assert.equal(await ended(app), 0);
  assert.equal(existsSync(to), false);
});

test("an emulator that does not quit: exit code 3, nothing removed, the uninstaller still in its place", { skip }, async () => {
  const to = await install("app-stays");
  // No command line in this copy: nothing can ask the app to quit, and the uninstaller ends no process.
  rmSync(path.join(to, ...CLI.split("/")));
  const app = await start(path.join(to, EXE));
  try {
    const result = await run(path.join(to, UNINSTALLER), ["/S"]);
    assert.equal(result.code, 3, result.log);
    assert.match(result.log, new RegExp(`BUSY Bar Emulator is still running from .*: process ${app.pid} .*Nothing was removed\\.`));
    assert.equal(app.exitCode, null, "the app was ended");
    assert.deepEqual(filesOf(to), WHOLE.filter((f) => f !== CLI));
  } finally {
    app.kill();
    await ended(app);
  }
});

test("a file of the folder that is open: exit code 3, and the folder and the uninstaller are as they were", { skip }, async () => {
  const to = await install("file-open");
  const temp = path.join(folder, "temp-file-open");
  mkdirSync(temp);
  const held = openSync(path.join(to, "resources", "app.asar"), "r");
  try {
    const result = await run(path.join(to, UNINSTALLER), ["/S"], { temp });
    assert.equal(result.code, 3, result.log);
    assert.match(result.log, /a file in it is open .*Nothing was removed\./);
  } finally {
    closeSync(held);
  }
  assert.deepEqual(filesOf(to), WHOLE);
  assert.deepEqual(readdirSync(path.dirname(to)), ["BUSY Bar Emulator"], "a half-removed folder is left beside it");
  assert.deepEqual(readdirSync(temp), [], "the uninstaller did not move back into the folder");
});

// ------------------------------------------------------------------------------- the user's own install, for real

const reg = () => path.join(process.env.SystemRoot, "System32", "reg.exe");
const KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\app.busy.emulator";

/** The values of the entry in Settings -> Apps, or null when there is none. */
function entry() {
  let text;
  try {
    text = execFileSync(reg(), ["query", KEY], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s{4}(\S+)\s{4}(REG_\w+)\s{4}(.*)$/.exec(line);
    if (match) values[match[1]] = match[2] === "REG_DWORD" ? Number(match[3]) : match[3];
  }
  return values;
}

test(
  "the user's own install is listed in Settings -> Apps, and its uninstaller removes it with its shortcut, its command line and, when told, its data",
  { skip: skip || (process.env.BUSY_EMULATOR_TEST_START_MENU !== "1" && "makes a real install for the user (Start menu, Settings -> Apps, %LOCALAPPDATA%): BUSY_EMULATOR_TEST_START_MENU=1") },
  async () => {
    const local = process.env.LOCALAPPDATA;
    const link = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "BUSY Bar Emulator.lnk");
    const launcher = path.join(local, "busy-emulator");
    const data = path.join(local, "BUSY Bar Emulator");
    for (const place of [link, launcher, data]) assert.equal(existsSync(place), false, `${place} is there already: the test does not touch what it did not make`);
    assert.equal(entry(), null, `${KEY} is there already: the test does not touch what it did not make`);
    const to = path.join(folder, "the user's own", "BUSY Bar Emulator");
    const temp = path.join(folder, "temp-own");
    mkdirSync(temp);
    /** What the app writes at its first start, as far as the uninstaller looks at it. */
    const firstStart = () => {
      mkdirSync(path.join(launcher, "bin"), { recursive: true });
      writeFileSync(path.join(launcher, "bin", "busy-emulator.launch"), `${path.join(to, ...COMMAND.split("/"))}\r\n${path.join(to, "resources", "cli.mjs")}\r\n`);
      copyFileSync(path.join(to, ...CLI.split("/")), path.join(launcher, "bin", "busy-emulator.exe"));
      writeFileSync(path.join(launcher, "bin", "busy-emulator.exe.old-4242"), "the launcher that ran during an update");
      mkdirSync(path.join(data, "bar", "1.3.1", "ext"), { recursive: true });
      mkdirSync(path.join(data, "projects"), { recursive: true });
      writeFileSync(path.join(data, "format"), "1\n");
      writeFileSync(path.join(data, "install.json"), JSON.stringify({ app: path.join(to, EXE), cli: path.join(launcher, "bin", "busy-emulator.exe"), version: "1.2.3" }, null, 2));
      writeFileSync(path.join(data, "bar", "1.3.1", "ext", "an-app.txt"), "an app on the emulated bar");
      writeFileSync(path.join(data, "projects", "trusted.json"), "[]");
    };
    try {
      const installed = await run(setup, ["/S", `/D=${to}`], { temp });
      assert.equal(installed.code, 0, installed.log);
      assert.ok(existsSync(link));
      const values = entry();
      assert.deepEqual(
        { ...values, EstimatedSize: undefined, InstallDate: undefined },
        {
          DisplayName: "BUSY Bar Emulator",
          DisplayVersion: "1.2.3",
          Publisher: "Flipper FZCO",
          InstallLocation: to,
          DisplayIcon: path.join(to, EXE),
          UninstallString: `"${path.join(to, UNINSTALLER)}"`,
          QuietUninstallString: `"${path.join(to, UNINSTALLER)}" /S`,
          NoModify: 1,
          NoRepair: 1,
          EstimatedSize: undefined,
          InstallDate: undefined,
        },
      );
      assert.ok(values.EstimatedSize >= 1, `EstimatedSize: ${values.EstimatedSize}`);
      assert.match(values.InstallDate, /^\d{8}$/);
      firstStart();

      // A second copy, not the user's own, comes and goes: the user's shortcut, entry, command line and data stay.
      const second = await install("a second copy");
      assert.equal((await run(path.join(second, UNINSTALLER), ["/S"], { temp })).code, 0);
      assert.ok(existsSync(link) && existsSync(path.join(launcher, "bin", "busy-emulator.launch")) && existsSync(path.join(data, "install.json")));
      assert.equal(entry()?.InstallLocation, to);

      // Silent, nothing said about the data: they stay, but for the pointer to the app that is gone.
      const kept = await run(path.join(to, UNINSTALLER), ["/S"], { temp });
      assert.equal(kept.code, 0, kept.log);
      assert.deepEqual([existsSync(to), existsSync(link), existsSync(launcher), entry()], [false, false, false, null], kept.log);
      assert.deepEqual(filesOf(data), ["bar/1.3.1/ext/an-app.txt", "format", "projects/trusted.json"], "the data folder is not as it was, but for install.json");
      assert.match(kept.log, new RegExp(`the data folder is kept: ${data.replace(/[\\.]/g, "\\$&")}`));

      // Installed again over the data that stayed, then removed with them.
      const again = await run(setup, ["/S", `/D=${to}`], { temp });
      assert.equal(again.code, 0, again.log);
      assert.equal(entry()?.InstallLocation, to);
      firstStart();
      const whole = await run(path.join(to, UNINSTALLER), ["/S", "/RemoveData"], { temp });
      assert.equal(whole.code, 0, whole.log);
      assert.deepEqual([existsSync(to), existsSync(link), existsSync(launcher), existsSync(data), entry()], [false, false, false, false, null], whole.log);
      assert.ok(await until(() => readdirSync(temp).length === 0), `left in the temporary folder: ${readdirSync(temp).join(", ")}`);
    } finally {
      // Whatever a failure left of what this test made.
      rmSync(link, { force: true });
      rmSync(launcher, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
      try {
        execFileSync(reg(), ["delete", KEY, "/f"], { windowsHide: true, stdio: "ignore" });
      } catch {
        // No entry: removed by the uninstaller, as it should be.
      }
    }
  },
);
