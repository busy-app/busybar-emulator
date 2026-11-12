// EMU-203 review, H2: setup.exe replaces whatever folder /D= names, and removes what lay there, without checking that
// it is an install of the app. Also: the leftovers sweep removes any sibling folder named "<name>.old-*" / ".new-*".
// Windows only. Put this file into emulator/packages/app/test/unit/ of a clone of emu-203-installers and run
//   node --test test/unit/setup-foreign-folder.test.mjs
// Everything happens in a temporary folder (TEMP of the run); no shortcut is made.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";

import { buildSetup } from "../../tools/packaging/windows.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const skip = process.platform !== "win32" && "Windows only";
let folder;
let setup;

before(() => {
  if (skip) return;
  folder = temporaryFolder();
  const app = path.join(folder, "app", "BUSY Bar Emulator");
  mkdirSync(path.join(app, "resources"), { recursive: true });
  writeFileSync(path.join(app, "BUSY Bar Emulator.exe"), "the app");
  writeFileSync(path.join(app, "resources", "app.asar"), "an archive");
  const work = path.join(folder, "work");
  mkdirSync(work, { recursive: true });
  setup = path.join(folder, "busybar-emulator-win-x64-setup.exe");
  buildSetup({ appFolder: app, work, out: setup, version: "1.2.3" });
});

after(async () => {
  if (!skip) await removeFolder(folder);
});

function runSetup(args) {
  const logFile = path.join(folder, `setup-${Date.now()}.log`);
  return new Promise((resolve) => {
    execFile(setup, [`/LOG=${logFile}`, ...args]  /* /D= last: it takes the rest of the line */, { timeout: 60_000, windowsHide: true, env: { ...process.env, TEMP: folder, TMP: folder } }, (error) => {
      resolve({ code: error ? (error.killed ? "timeout" : error.code) : 0, log: existsSync(logFile) ? readFileSync(logFile, "utf8") : "" });
    });
  });
}

test("H2a: /D= naming a folder of the user's own (not an install of the app) does not remove what is in it", { skip }, async () => {
  // As an agent or a person could write it: the app's data folder, Documents, a project folder.
  const theirs = path.join(folder, "user", "Documents");
  mkdirSync(path.join(theirs, "thesis"), { recursive: true });
  writeFileSync(path.join(theirs, "thesis", "chapter-1.txt"), "a year of work");
  const result = await runSetup(["/S", "/NoShortcut", `/D=${theirs}`]);
  console.log(`H2a: setup exit code ${result.code}; ${theirs} now holds: ${readdirSync(theirs).join(", ")}`);
  // Either refused (exit code 2, nothing touched) or installed beside the user's files — never their removal.
  assert.ok(existsSync(path.join(theirs, "thesis", "chapter-1.txt")), `the user's file is gone; setup said ${result.code}:\n${result.log}`);
});

test("H2b: the sweep of an earlier run's leftovers does not remove the user's folders that happen to be named <name>.old-*", { skip }, async () => {
  const parent = path.join(folder, "projects");
  const theirs = path.join(parent, "BUSY Bar Emulator.old-backup");
  mkdirSync(theirs, { recursive: true });
  writeFileSync(path.join(theirs, "keep.txt"), "mine");
  const result = await runSetup(["/S", "/NoShortcut", `/D=${path.join(parent, "BUSY Bar Emulator")}`]);
  assert.equal(result.code, 0, result.log);
  assert.ok(existsSync(path.join(theirs, "keep.txt")), `a folder the setup did not make is gone: ${readdirSync(parent).join(", ")}`);
});

test("control: /D= at a junction replaces the junction only, the folder it points to keeps its files", { skip }, async () => {
  const elsewhere = path.join(folder, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, "keep.txt"), "mine");
  const link = path.join(folder, "junction", "BUSY Bar Emulator");
  mkdirSync(path.dirname(link), { recursive: true });
  execFileSync(path.join(process.env.SystemRoot, "System32", "cmd.exe"), ["/d", "/c", "mklink", "/J", link, elsewhere], { windowsHide: true });
  const result = await runSetup(["/S", "/NoShortcut", `/D=${link}`]);
  assert.equal(result.code, 0, result.log);
  assert.ok(existsSync(path.join(elsewhere, "keep.txt")), "the junction's target lost its files");
  assert.ok(existsSync(path.join(link, "BUSY Bar Emulator.exe")));
});
