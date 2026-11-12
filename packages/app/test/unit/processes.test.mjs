// What the desktop app starts and which of its modules write files (ADR-0012 §6, EMU-010): the app's short list of
// programs (src/processes.mjs) is enforced where they start, and no other module of src/ imports node:child_process.
// Which names a module imports is read by the JavaScript engine (packages/engine/test/imported-names.mjs); a load the
// engine cannot see before it runs (a dynamic import of a value) is refused for src/ by boundaries.test.mjs.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { importedNames } from "../../../engine/test/imported-names.mjs";
import { shellProgram, startShellProgram, runShellProgram } from "../../src/processes.mjs";
import { releaseFiles } from "../../tools/release-files.mjs";

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("the app's programs: its Node, the terminal, PowerShell on Windows; nothing else", () => {
  const mac = { nodes: ["/Applications/BUSY Bar Emulator.app/Contents/Resources/node/bin/node"] };
  const win = { nodes: ["C:\\Program Files\\BUSY Bar Emulator\\resources\\node\\node.exe"], windowsDir: "C:\\Windows" };
  const id = (file, platform) => shellProgram(file, platform, platform === "win32" ? win : mac)?.id ?? null;
  assert.equal(id("/Applications/BUSY Bar Emulator.app/Contents/Resources/node/bin/node", "darwin"), "node");
  assert.equal(id("C:\\program files\\BUSY Bar Emulator\\resources\\node\\node.exe", "win32"), "node");
  assert.equal(id("/opt/elsewhere/node", "darwin"), null, "a file named node elsewhere");
  assert.equal(id("/usr/bin/open", "darwin"), "terminal");
  assert.equal(id("C:\\WINDOWS\\System32\\cmd.exe", "win32"), "terminal");
  assert.equal(id("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), "powershell");
  for (const [file, platform] of [["node", "darwin"], ["/bin/sh", "darwin"], ["/usr/bin/open", "win32"], ["D:\\Windows\\System32\\cmd.exe", "win32"], ["C:\\Program Files\\x\\System32\\cmd.exe", "win32"], ["git", "win32"], ["C:\\Program Files\\GitHub CLI\\gh.exe", "win32"]]) assert.equal(id(file, platform), null, `${file} on ${platform}`);
  assert.equal(shellProgram("/Applications/BUSY Bar Emulator.app/Contents/Resources/gh/bin/gh", "darwin", { ...mac, gh: "/Applications/BUSY Bar Emulator.app/Contents/Resources/gh/bin/gh" })?.id, "gh", "the app's GitHub CLI");
  assert.equal(shellProgram("/usr/local/bin/gh", "darwin", { ...mac, gh: "/Applications/BUSY Bar Emulator.app/Contents/Resources/gh/bin/gh" }), null, "another gh");
  assert.equal(shellProgram("/Applications/BUSY Bar Emulator.app/Contents/Resources/gh/bin/gh", "darwin", mac), null, "no gh configured");
  assert.equal(shellProgram(process.execPath)?.id, "node", "the Node this runs on");
  // The built-in update's: ditto, plutil and codesign on macOS; on Windows the copy of the app's Node it made, by its path.
  for (const file of ["/usr/bin/ditto", "/usr/bin/plutil", "/usr/bin/codesign"]) assert.equal(id(file, "darwin"), "update", file);
  for (const file of ["/bin/ditto", "/usr/bin/xattr"]) assert.equal(id(file, "darwin"), null, file);
  assert.equal(id("/usr/bin/ditto", "win32"), null);
  assert.equal(shellProgram("C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator\\tmp\\update-0.1.0\\node.exe", "win32", { ...win, updateNodes: ["C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator\\tmp\\update-0.1.0\\node.exe"] })?.id, "update-node");
  assert.equal(shellProgram("C:\\Users\\you\\Downloads\\node.exe", "win32", { ...win, updateNodes: ["C:\\Users\\you\\AppData\\Local\\BUSY Bar Emulator\\tmp\\update-0.1.0\\node.exe"] }), null, "another node.exe");
  assert.throws(() => startShellProgram("/bin/sh", ["-c", "true"]), (e) => e.code === "program_not_allowed");
  assert.throws(() => runShellProgram(process.execPath, ["-e", ""], { shell: true }), /through a shell/);
});

/** The modules of src/ that write files, each with what it writes; a new one is added on purpose, in review. */
const WRITERS = {
  "src/actions.mjs": "a new project's icons in the data folder's tmp/; the folder for new projects",
  "src/build-feed.mjs": "the build feed in the data folder",
  "src/capture-actions.mjs": "screenshots and clips: in a project's screenshots/ or where the person chose in the save dialog",
  "src/capture-window.mjs": "a clip the server asked for, in the data folder's captures/",
  "src/github/publish-flow.mjs": "the GitHub sign-in note in the data folder",
  "src/github/publish-record.mjs": "the publish record in the data folder",
  "src/install-files.mjs": "the command line's launcher and the pointer file (ADR-0002 §7)",
  "src/main.mjs": "GitHub CLI's state, data and cache folders in the data folder",
  "src/log.mjs": "the app's log in the data folder",
  "src/report-actions.mjs": "Report a Bug's diagnostics archive, where the person chose in the save dialog",
  "src/terminal.mjs": "the console's script for Terminal in the data folder",
  "src/update-check.mjs": "the app's settings in the data folder",
  "src/updater.mjs": "the update's download, plan and helper in the data folder's tmp/update-<version>/; the new bundle unpacked beside the app (macOS), checked by path-boundary.mjs",
  "src/update-helper.mjs": "the update's result and log in its tmp/update-<version>/ folder; on macOS it renames the app's bundle and the new one (the plan's paths, checked against each other)",
};
const FS = /^(node:)?fs(\/promises)?$/;
const WRITES = /^(?:write|writev|writeFile|append|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|truncate|ftruncate|open|createWriteStream|chmod|fchmod|lchmod|utimes|futimes|lutimes|chown|fchown|lchown)(?:Sync)?$|^(?:promises|default|\*)$/;

describe("the modules of the app's archive", () => {
  const modules = releaseFiles(APP).filter((p) => /^src\/.*\.mjs$/.test(p));
  const names = importedNames(modules.map((p) => path.join(APP, p)));
  const of = (file) => path.relative(APP, file).split(path.sep).join("/");

  // The update's helper is the one other: the app does not import it, it runs on plain Node after the app has quit
  // (updater.mjs copies it out) and starts only the setup and the app the plan names, by full path with a list.
  test("only src/processes.mjs imports node:child_process, and the update's helper, which the app never imports", () => {
    assert.ok(modules.includes("src/main.mjs") && modules.includes("src/processes.mjs"), "the list sees the archive");
    const found = [];
    for (const [file, imports] of Object.entries(names)) {
      for (const specifier of Object.keys(imports)) if (/update-helper\.mjs$/.test(specifier)) found.push(`${of(file)}: imports the update's helper`);
      if (of(file) === "src/processes.mjs" || of(file) === "src/update-helper.mjs") continue;
      for (const specifier of Object.keys(imports)) if (/^(node:)?child_process$/.test(specifier)) found.push(`${of(file)}: imports ${specifier}`);
    }
    assert.deepEqual(found, []);
  });

  test("write files only where WRITERS says", () => {
    const writers = new Set();
    for (const [file, imports] of Object.entries(names)) {
      const written = Object.entries(imports).filter(([specifier]) => FS.test(specifier)).flatMap(([, imported]) => imported.filter((n) => WRITES.test(n)));
      if (written.length || /import\(\s*["'](node:)?fs/.test(readFileSync(file, "utf8"))) writers.add(of(file));
    }
    assert.deepEqual([...writers].filter((one) => !(one in WRITERS)), [], "a module that writes files: add it to WRITERS, saying what it writes, and check its paths with src/path-boundary.mjs");
    assert.deepEqual(Object.keys(WRITERS).filter((one) => !writers.has(one)), [], "WRITERS names a module that writes nothing any more");
  });
});
