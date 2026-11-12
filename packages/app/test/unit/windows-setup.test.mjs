// setup.exe (installer/windows/setup.cs), on a small stand-in app: the installer is the release's own, the payload is
// a few files. Windows only; nothing is installed outside a temporary folder and no Start menu shortcut is made,
// except by the one test that BUSY_EMULATOR_TEST_START_MENU=1 switches on (it removes its shortcut).
//
// The silent runs are started with the rights of a standard user (test/fixtures/windows/standard-user.cs: the
// caller's own token cut down the way UAC cuts down an administrator's), so that "no administrator rights" is what
// the test sees, not only what the setup says. A setup that asked anything in silent mode would wait for an answer
// nobody gives: the runs have a time limit.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { compileCSharp } from "../../tools/windows-launcher.mjs";
import { stubProblems } from "../../tools/packaging/windows-check.mjs";
import { buildSetup, INSTALL_MARKER, payloadOf, UNINSTALLER } from "../../tools/packaging/windows.mjs";
import { APP_DIR, removeFolder, temporaryFolder } from "../helpers.mjs";

const skip = process.platform !== "win32" && "Windows only";
const EXE = "BUSY Bar Emulator.exe";
const LIMIT_MS = 60_000;

let folder;
let setup;
let standardUser;
/** What an install holds: the app's files, the setup's own marker and the uninstaller (windows-uninstall.test.mjs). */
const installed = () => [...Object.keys(appFiles), INSTALL_MARKER, UNINSTALLER].sort();
const appFiles = {
  [EXE]: "the app",
  "resources/app.asar": "an archive",
  // Deeper than 260 characters once the install folder is a long one.
  [`resources/node/${"deep-folder-name/".repeat(8)}last.js`]: "deep",
};

before(() => {
  if (skip) return;
  folder = temporaryFolder();
  const app = path.join(folder, "app", "BUSY Bar Emulator");
  for (const [name, text] of Object.entries(appFiles)) {
    mkdirSync(path.dirname(path.join(app, ...name.split("/"))), { recursive: true });
    writeFileSync(path.join(app, ...name.split("/")), text);
  }
  const work = path.join(folder, "work");
  mkdirSync(work, { recursive: true });
  setup = path.join(folder, "busybar-emulator-win-x64-setup.exe");
  buildSetup({ appFolder: app, work, out: setup, version: "1.2.3" });
  standardUser = compileCSharp(path.join(APP_DIR, "test", "fixtures", "windows", "standard-user.cs"), path.join(folder, "standard-user.exe"));
});

after(async () => {
  if (skip) return;
  await removeFolder(folder);
});

/** Runs the setup (as a standard user unless told otherwise) and gives its exit code and log. */
function runSetup(args, { asStandardUser = true, program = setup, logFile = path.join(folder, `setup-${Date.now()}.log`) } = {}) {
  const line = [`/LOG=${logFile}`, ...args];
  return new Promise((resolve) => {
    const [file, list] = asStandardUser ? [standardUser, [program, ...line]] : [program, line];
    // The setup's own temporary folder is the test's: a log it writes there by default is not left in the user's.
    execFile(file, list, { timeout: LIMIT_MS, windowsHide: true, env: { ...process.env, TEMP: folder, TMP: folder } }, (error) => {
      resolve({ code: error ? (error.killed ? "timeout" : error.code) : 0, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" });
    });
  });
}

function installedFiles(at) {
  const out = [];
  const walk = (p, prefix) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(p, e.name), rel);
      else out.push(rel);
    }
  };
  walk(`\\\\?\\${at}`, "");
  return out.sort();
}

test("a silent setup run as a standard user installs the app without asking anything and without elevation", { skip }, async () => {
  const to = path.join(folder, "plain", "BUSY Bar Emulator");
  const result = await runSetup(["/S", "/NoShortcut", `/D=${to}`]);
  assert.equal(result.code, 0, result.log);
  assert.match(result.log, /administrator: no/);
  assert.deepEqual(installedFiles(to), installed());
  assert.equal(readFileSync(path.join(to, EXE), "utf8"), "the app");
  assert.deepEqual(readdirSync(path.dirname(to)), ["BUSY Bar Emulator"], "nothing is left beside the app's folder");
});

test("the setup's manifest asks to run as invoked and is aware of long paths; its version information names the app, the company and the version", { skip }, async () => {
  // A 32-bit program named "setup" without such a manifest is taken by Windows for an installer that needs
  // administrator rights; ours is 64-bit, so the manifest is the second line, and the check of a release reads it.
  const { problems, manifest, version } = await stubProblems(setup, payloadOf(setup).offset, { version: "1.2.3" });
  assert.deepEqual(problems, []);
  assert.match(manifest, /<ws2:longPathAware>true<\/ws2:longPathAware>/);
  // Its version information, from the assembly attributes (the release dry run: empty, 0.0.0.0).
  assert.deepEqual([version.ProductName, version.CompanyName, version.FileDescription, version.ProductVersion, version.FileVersion, version.OriginalFilename], ["BUSY Bar Emulator", "Flipper FZCO", "BUSY Bar Emulator Setup", "1.2.3", "1.2.3.0", "busybar-emulator-win-x64-setup.exe"]);
});

test("the folder may have spaces, quoted as a whole, or unquoted as the last argument; the app's paths may pass 260 characters", { skip }, async () => {
  const deep = path.join(folder, "long", "a folder with spaces".padEnd(60, "x"), "and another one".padEnd(60, "y"), "BUSY Bar Emulator");
  const quoted = await runSetup(["/S", "/NoShortcut", `/D=${deep}`]);
  assert.equal(quoted.code, 0, quoted.log);
  assert.ok(installedFiles(deep).some((f) => path.join(deep, f).length > 260), "the test reaches past 260 characters");
  assert.deepEqual(installedFiles(deep), installed());

  // As an agent's PowerShell or cmd line would have it: /D= last, spaces unquoted.
  const unquoted = path.join(folder, "un quoted", "BUSY Bar Emulator");
  const logFile = path.join(folder, "unquoted.log");
  const line = await new Promise((resolve) => {
    const child = execFile(standardUser, [`"${setup}" /S /NoShortcut /LOG=${logFile} /D=${unquoted}`], { timeout: LIMIT_MS, windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, TEMP: folder, TMP: folder } }, () => {});
    child.on("exit", resolve);
  });
  assert.equal(line, 0, existsSync(logFile) ? readFileSync(logFile, "utf8") : "no log");
  assert.deepEqual(installedFiles(unquoted), installed());
});

test("a second setup replaces the folder whole: what the old version had and the new one has not is gone", { skip }, async () => {
  const to = path.join(folder, "upgrade", "BUSY Bar Emulator");
  assert.equal((await runSetup(["/S", "/NoShortcut", `/D=${to}`])).code, 0);
  writeFileSync(path.join(to, "resources", "left-by-the-old-version.txt"), "old");
  const again = await runSetup(["/S", "/NoShortcut", `/D=${to}`]);
  assert.equal(again.code, 0, again.log);
  assert.deepEqual(installedFiles(to), installed());
  assert.deepEqual(readdirSync(path.dirname(to)), ["BUSY Bar Emulator"]);
});

test("while the app runs from the folder (a file in it is open), the setup changes nothing and says so with exit code 3", { skip }, async () => {
  const to = path.join(folder, "running", "BUSY Bar Emulator");
  assert.equal((await runSetup(["/S", "/NoShortcut", `/D=${to}`])).code, 0);
  writeFileSync(path.join(to, "resources", "marker-of-the-installed-version.txt"), "installed");
  // A running executable is held open the same way: Windows refuses to move its folder.
  const held = openSync(path.join(to, EXE), "r");
  try {
    const result = await runSetup(["/S", "/NoShortcut", `/D=${to}`]);
    assert.equal(result.code, 3, result.log);
    assert.match(result.log, /is running from .*Quit it and run the setup again/);
  } finally {
    closeSync(held);
  }
  assert.ok(existsSync(path.join(to, "resources", "marker-of-the-installed-version.txt")), "the installed version is untouched");
  assert.deepEqual(readdirSync(path.dirname(to)), ["BUSY Bar Emulator"], "no half-made folder is left");
});

test("a damaged setup installs nothing: exit code 1 and a message to download it again", { skip }, async () => {
  const damaged = path.join(folder, "damaged-setup.exe");
  const bytes = readFileSync(setup);
  const { offset } = payloadOf(setup);
  bytes[offset + 40] ^= 0xff;
  writeFileSync(damaged, bytes);
  const to = path.join(folder, "damaged", "BUSY Bar Emulator");
  const result = await runSetup(["/S", "/NoShortcut", `/D=${to}`], { program: damaged });
  assert.equal(result.code, 1, result.log);
  assert.match(result.log, /damaged.*Download it again and check it against SHA256SUMS/);
  assert.equal(existsSync(path.dirname(to)), false);
});

test("an empty folder is taken; a folder that holds anything but an install is refused with exit code 2, untouched", { skip }, async () => {
  const empty = path.join(folder, "empty", "BUSY Bar Emulator");
  mkdirSync(empty, { recursive: true });
  const taken = await runSetup(["/S", "/NoShortcut", `/D=${empty}`]);
  assert.equal(taken.code, 0, taken.log);
  assert.deepEqual(installedFiles(empty), installed());

  // An install without the setup's marker is not an install to the setup: the files of the app alone prove nothing.
  const lookalike = path.join(folder, "lookalike", "BUSY Bar Emulator");
  mkdirSync(path.join(lookalike, "resources"), { recursive: true });
  writeFileSync(path.join(lookalike, EXE), "someone else's");
  const refused = await runSetup(["/S", "/NoShortcut", `/D=${lookalike}`]);
  assert.equal(refused.code, 2, refused.log);
  assert.match(refused.log, /holds files that are not an install of BUSY Bar Emulator/);
  assert.equal(readFileSync(path.join(lookalike, EXE), "utf8"), "someone else's");
  assert.deepEqual(readdirSync(path.dirname(lookalike)), ["BUSY Bar Emulator"], "nothing made beside it");
});

test("what a stopped setup left beside the app's folder goes; a folder of that name without the marker stays", { skip }, async () => {
  const to = path.join(folder, "leftovers", "BUSY Bar Emulator");
  for (const [name, marked] of [["BUSY Bar Emulator.new-4242", true], ["BUSY Bar Emulator.old-77", true], ["BUSY Bar Emulator.old-77x", true], ["BUSY Bar Emulator.new-9", false]]) {
    const left = path.join(path.dirname(to), name);
    mkdirSync(left, { recursive: true });
    writeFileSync(path.join(left, "half.txt"), "half");
    if (marked) writeFileSync(path.join(left, INSTALL_MARKER), '{"app":"app.busy.emulator","by":"setup","version":"0.0.0"}\r\n');
  }
  const result = await runSetup(["/S", "/NoShortcut", `/D=${to}`]);
  assert.equal(result.code, 0, result.log);
  assert.deepEqual(readdirSync(path.dirname(to)).sort(), ["BUSY Bar Emulator", "BUSY Bar Emulator.new-9", "BUSY Bar Emulator.old-77x"]);
});

test("/D= that is not last is refused with exit code 2: it would swallow /S and the setup would ask its questions", { skip }, async () => {
  const to = path.join(folder, "not-last", "BUSY Bar Emulator");
  const logFile = path.join(folder, "not-last.log");
  const code = await new Promise((resolve) => {
    const child = execFile(standardUser, [`"${setup}" /D=${to} /S /NoShortcut /LOG=${logFile}`], { timeout: LIMIT_MS, windowsHide: true, windowsVerbatimArguments: true, env: { ...process.env, TEMP: folder, TMP: folder } }, () => {});
    child.on("exit", resolve);
  });
  assert.equal(code, 2);
  assert.equal(existsSync(path.dirname(to)), false);
  assert.match(readFileSync(path.join(folder, "busybar-emulator-setup.log"), "utf8"), /\/D= must be the last argument/);
});

test("/LOG= adds to the file it names; it never overwrites it", { skip }, async () => {
  const logFile = path.join(folder, "someone-elses.txt");
  writeFileSync(logFile, "a file that was there before\n");
  const result = await runSetup(["/S", "/NoShortcut", `/D=${path.join(folder, "log-append", "BUSY Bar Emulator")}`], { logFile });
  assert.equal(result.code, 0, result.log);
  assert.ok(result.log.startsWith("a file that was there before\n"));
  assert.match(result.log, /installed/);
});

/** Grants a right on a folder of the test's (icacls, by its full path), as a careless parent folder would have it. */
function grant(folderPath, rule) {
  execFileSync(path.join(process.env.SystemRoot, "System32", "icacls.exe"), [folderPath, "/grant", rule], { windowsHide: true, stdio: "ignore" });
}

test("a folder others may change is refused with exit code 2 and the reason; nothing is made, nothing replaced", { skip }, async () => {
  // A parent where Everyone may change what is made in it, as C:\Temp or C:\ProgramData may be.
  const shared = path.join(folder, "shared");
  mkdirSync(shared, { recursive: true });
  grant(shared, "*S-1-1-0:(OI)(CI)M");
  const to = path.join(shared, "BUSY Bar Emulator");
  const refused = await runSetup(["/S", "/NoShortcut", `/D=${to}`]);
  assert.equal(refused.code, 2, refused.log);
  assert.match(refused.log, /can be changed by others: .* may write in /);
  assert.deepEqual(readdirSync(shared), [], "nothing made in the shared folder");

  // An install of the setup's own that has since been opened to the machine's users is not replaced either.
  const own = path.join(folder, "opened", "BUSY Bar Emulator");
  assert.equal((await runSetup(["/S", "/NoShortcut", `/D=${own}`])).code, 0);
  grant(own, "*S-1-5-32-545:(OI)(CI)M");
  writeFileSync(path.join(own, "resources", "marker-of-the-installed-version.txt"), "installed");
  const again = await runSetup(["/S", "/NoShortcut", `/D=${own}`]);
  assert.equal(again.code, 2, again.log);
  assert.ok(existsSync(path.join(own, "resources", "marker-of-the-installed-version.txt")), "the install was replaced");
});

/** A junction (no administrator rights needed), made with cmd.exe by its full path. */
function junction(link, target) {
  execFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), ["/d", "/c", "mklink", "/J", link, target], { windowsHide: true, stdio: "ignore" });
}

test("an old install or a leftover with a junction inside goes whole; what the junction points to is not touched", { skip }, async () => {
  const elsewhere = path.join(folder, "junction-target");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, "keep.txt"), "mine");
  const to = path.join(folder, "with-junction", "BUSY Bar Emulator");
  assert.equal((await runSetup(["/S", "/NoShortcut", `/D=${to}`])).code, 0);
  junction(path.join(to, "resources", "linked"), elsewhere);
  // A leftover of a stopped run, the setup's own, with a junction inside too.
  const left = path.join(path.dirname(to), "BUSY Bar Emulator.old-111");
  mkdirSync(left, { recursive: true });
  writeFileSync(path.join(left, INSTALL_MARKER), '{"app":"app.busy.emulator","by":"setup","version":"0.0.0"}\r\n');
  junction(path.join(left, "linked"), elsewhere);

  const again = await runSetup(["/S", "/NoShortcut", `/D=${to}`]);
  assert.equal(again.code, 0, again.log);
  assert.doesNotMatch(again.log, /could not remove/);
  assert.deepEqual(readdirSync(path.dirname(to)), ["BUSY Bar Emulator"], "an old install or a leftover stayed");
  assert.deepEqual(installedFiles(to), installed());
  assert.equal(readFileSync(path.join(elsewhere, "keep.txt"), "utf8"), "mine");
});

test("the setup makes System32 the only folder Windows loads DLLs from by name, before anything else", { skip }, async () => {
  const result = await runSetup(["/S", "/NoShortcut", `/D=${path.join(folder, "dll-search", "BUSY Bar Emulator")}`]);
  assert.equal(result.code, 0, result.log);
  assert.match(result.log, /DLLs from System32 only: yes/);
});

test("an unknown argument is refused with exit code 2, without a window in silent mode", { skip }, async () => {
  const result = await runSetup(["/S", "/Quiet"]);
  assert.equal(result.code, 2);
  // The log of a refused line goes to the default place: %TEMP% of the run, which runSetup makes the test's folder.
  const defaultLog = path.join(folder, "busybar-emulator-setup.log");
  assert.match(readFileSync(defaultLog, "utf8"), /Unknown argument: \/Quiet/);
});

/**
 * What a shortcut points to, read as Windows reads it (WScript.Shell, which also wrote it). Not by looking for the
 * path in the file's bytes: a .lnk does not always hold it in one piece (with C:\Users shared on the machine, the
 * file holds "C:\Users\", the share's name and the rest of the path apart, and the test failed there).
 */
function shortcutTarget(link) {
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = "[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false; (New-Object -ComObject WScript.Shell).CreateShortcut($env:BUSY_TEST_SHORTCUT).TargetPath";
  return execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, encoding: "utf8", env: { ...process.env, BUSY_TEST_SHORTCUT: link } }).trim();
}

/** Whether the user has an entry for the app in Settings -> Apps (the setup makes one with the shortcut). */
function hasEntry() {
  try {
    execFileSync(path.join(process.env.SystemRoot, "System32", "reg.exe"), ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\app.busy.emulator"], { windowsHide: true, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test(
  "without /NoShortcut the setup puts the app in the user's Start menu",
  { skip: skip || (process.env.BUSY_EMULATOR_TEST_START_MENU !== "1" && "makes a real Start menu shortcut and an entry in Settings -> Apps: BUSY_EMULATOR_TEST_START_MENU=1") },
  async () => {
    const programs = path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs");
    const link = path.join(programs, "BUSY Bar Emulator.lnk");
    assert.equal(existsSync(link), false, `${link} is there already: the test does not touch a shortcut it did not make`);
    assert.equal(hasEntry(), false, "the app has an entry in Settings -> Apps already: the test does not touch an entry it did not make");
    const to = path.join(folder, "shortcut", "BUSY Bar Emulator");
    try {
      const result = await runSetup(["/S", `/D=${to}`]);
      assert.equal(result.code, 0, result.log);
      assert.ok(existsSync(link));
      // The shortcut names the installed executable.
      assert.equal(shortcutTarget(link).toLowerCase(), path.join(to, EXE).toLowerCase());
      assert.equal(hasEntry(), true, "no entry in Settings -> Apps");
    } finally {
      // The install's own uninstaller takes the shortcut and the entry with it (windows-uninstall.test.mjs).
      const removed = existsSync(path.join(to, UNINSTALLER)) ? await runSetup(["/S"], { program: path.join(to, UNINSTALLER) }) : { code: "no uninstaller", log: "" };
      rmSync(link, { force: true });
      assert.equal(removed.code, 0, removed.log);
      assert.equal(hasEntry(), false, "the uninstaller left the entry in Settings -> Apps");
    }
  },
);
