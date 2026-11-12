// What the emulator starts while it runs, and which of its modules write files (ADR-0012 §6, EMU-010): the list of
// programs in programs.mjs is enforced where they are started, and no module the app ships starts a program another
// way. Which names a module imports is read by the JavaScript engine (imported-names.mjs), not searched in the text.
//
//   node --test packages/engine/test/started-programs.test.mjs

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ENGINE_TAKEN, SERVER_LEFT_OUT } from "../../app/tools/packaging/composition.mjs";
import { ALLOWED_PROGRAMS, allowedProgram, ProgramNotAllowed, runProgram, runProgramLater, startProgram } from "../programs.mjs";
import { importedNames } from "./imported-names.mjs";

const EMULATOR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const rel = (file) => path.relative(EMULATOR, file).split(path.sep).join("/");

describe("the list of programs", () => {
  test("names what the server and the command line start, on each system, and nothing else", () => {
    const mac = { nodes: ["/opt/node/bin/node", "/Applications/BUSY Bar Emulator.app/Contents/Resources/node/bin/node"], resources: "/Applications/BUSY Bar Emulator.app/Contents/Resources", windowsDirs: [] };
    const win = { nodes: ["C:\\Program Files\\BUSY Bar Emulator\\resources\\node\\node.exe"], resources: "C:\\Program Files\\BUSY Bar Emulator\\resources", windowsDirs: ["C:\\Windows"] };
    const id = (file, platform) => allowedProgram(file, { platform, ...(platform === "win32" ? win : mac) })?.id ?? null;
    assert.equal(id("/Applications/BUSY Bar Emulator.app/Contents/Resources/node/bin/node", "darwin"), "node");
    assert.equal(id("/opt/node/bin/node", "darwin"), "node");
    assert.equal(id("C:\\PROGRAM FILES\\BUSY Bar Emulator\\resources\\node\\node.exe", "win32"), "node", "letter case aside on Windows");
    assert.equal(id("/opt/elsewhere/node", "darwin"), null, "a file named node elsewhere is not the emulator's Node");
    assert.equal(id("C:\\Program Files\\Other\\node.exe", "win32"), null);
    assert.equal(id("node", "darwin"), null, "a Node by name is whatever PATH holds");
    assert.equal(id("git", "darwin"), "git");
    assert.equal(id("git", "win32"), "git");
    assert.equal(id("/Applications/BUSY Bar Emulator.app/Contents/Resources/gh/bin/gh", "darwin"), "gh", "the place kept for the bundled gh");
    assert.equal(id("/usr/local/bin/gh", "darwin"), null, "a gh outside the app only by name");
    assert.equal(id("/usr/bin/open", "darwin"), "opener");
    assert.equal(id("C:\\WINDOWS\\explorer.exe", "win32"), "opener");
    assert.equal(id("D:\\Windows\\explorer.exe", "win32"), null, "not the Windows folder");
    assert.equal(id("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), "powershell");
    assert.equal(id("C:\\Program Files\\x\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32"), null, "the same tail elsewhere");
    assert.equal(id("C:\\Windows\\System32\\taskkill.exe", "win32"), "taskkill", "killTree on Windows");
    assert.equal(id("taskkill", "win32"), null, "taskkill by name is whatever PATH holds");
    assert.equal(id("/usr/bin/trash", "darwin"), "trash");
    assert.equal(id("/usr/bin/osascript", "darwin"), "trash");
    assert.equal(id("/bin/ps", "darwin"), "ps");
    assert.equal(id("/usr/bin/xattr", "darwin"), "xattr");
    for (const [file, platform] of [["/bin/sh", "darwin"], ["/bin/bash", "linux"], ["C:\\Windows\\System32\\cmd.exe", "win32"], ["tar", "darwin"], ["npm", "darwin"], ["npm.cmd", "win32"], ["/usr/local/bin/open", "darwin"], ["/usr/bin/xattr", "win32"], ["python", "win32"], ["", "darwin"]]) {
      assert.equal(id(file, platform), null, `${file} on ${platform}`);
    }
    assert.equal(allowedProgram(process.execPath)?.id, "node", "the Node this runs on");
    assert.ok(ALLOWED_PROGRAMS.every((entry) => entry.why), "every program says what it is started for");
  });

  test("the names that write files include fs.promises and writev", () => {
    for (const name of ["promises", "writev", "writevSync", "writeFile", "default", "*"]) assert.match(name, WRITES, name);
    for (const name of ["readFileSync", "statSync", "existsSync"]) assert.doesNotMatch(name, WRITES, name);
  });

  test("a program that is not on it is refused before anything starts, and so is a shell", async () => {
    assert.throws(() => startProgram("/bin/sh", ["-c", "echo started"]), (e) => e instanceof ProgramNotAllowed && e.code === "program_not_allowed");
    assert.throws(() => runProgram("tar", ["--version"]), ProgramNotAllowed);
    assert.throws(() => runProgram(process.execPath, ["-e", ""], { shell: true }), /through a shell/);
    const refused = await new Promise((resolve) => runProgramLater("/usr/bin/env", ["true"], {}, (error) => resolve(error)));
    assert.ok(refused instanceof ProgramNotAllowed);
    assert.equal(String(runProgram(process.execPath, ["-e", "process.stdout.write('ran')"])), "ran", "the Node this runs on starts");
    const unlisted = startProgram("/bin/sh", [], { stdio: "ignore" }, { unlisted: "a test" });
    await new Promise((resolve) => unlisted.on("exit", resolve).on("error", resolve));
  });
});

/** The modules the app ships of packages/server and packages/engine: what the packaging takes (composition.mjs). */
function shippedModules() {
  const walk = (dir, base = dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      if (entry.name.startsWith(".") || entry.name === "node_modules") return [];
      const full = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(full, base) : [path.relative(base, full).split(path.sep).join("/")];
    });
  const server = walk(path.join(EMULATOR, "packages", "server"))
    // legacy-window/ is the window's page: scripts of a browser, not modules of Node.
    .filter((p) => /\.(mjs|js)$/.test(p) && !p.startsWith("legacy-window/") && !SERVER_LEFT_OUT.some((rule) => rule.test(p)))
    .map((p) => path.join(EMULATOR, "packages", "server", p));
  const engine = ENGINE_TAKEN.map((rule) => ["checks.mjs", "programs.mjs"].find((p) => rule.test(p))).filter(Boolean).map((p) => path.join(EMULATOR, "packages", "engine", p));
  return [...server, ...engine];
}

const FS = /^(node:)?fs(\/promises)?$/;
const WRITES = /^(?:write|writev|writeFile|append|appendFile|mkdir|mkdtemp|rm|rmdir|unlink|rename|copyFile|cp|symlink|link|truncate|ftruncate|open|createWriteStream|chmod|fchmod|lchmod|utimes|futimes|lutimes|chown|fchown|lchown)(?:Sync)?$|^(?:promises|default|\*)$/;

/**
 * The modules of the server and the command line that write files, each with what it writes. A new one is added here
 * on purpose, in review: whatever it writes on behalf of a page, an app on the bar or an agent goes through
 * path-boundary.mjs. (Moving every write into one module is EMU-010's tail.)
 */
const WRITERS = {
  "packages/server/arguments.mjs": "a message to stderr (writeSync on the descriptor)",
  "packages/server/capture/record.mjs": "a recorded clip in the data folder's captures/",
  "packages/server/cli/build-feed.mjs": "the build feed's file in the data folder",
  "packages/server/cli/commands/catalog-texts.mjs": "catalog.json of a project of the list",
  "packages/server/cli/commands/check.mjs": "the details file of a project",
  "packages/server/cli/commands/create.mjs": "a new project, and the generator's folder in the data folder",
  "packages/server/cli/commands/icon.mjs": "the icons of a project",
  "packages/server/cli/commands/publish.mjs": "publishing's files in a project (node:fs imported when needed)",
  "packages/server/cli/commands/record.mjs": "a clip, where the person or agent running the command names it",
  "packages/server/cli/commands/screenshot.mjs": "a screenshot, where the person or agent running the command names it",
  "packages/server/cli/examples.mjs": "an example app copied into a new project",
  "packages/server/cli/system.mjs": "the run state and the start and quit marks in the data folder",
  "packages/server/data-folder.mjs": "the data folder itself and its lock",
  "packages/server/device.mjs": "the emulated bar's storage, in the data folder (device.local, insideData: path-boundary.mjs)",
  "packages/server/files-api.mjs": "the bar's storage API, through device.local",
  "packages/server/json-store.mjs": "the projects' list and the trusted folders, under a lock, in the data folder",
  "packages/server/old-files.mjs": "removes old clips and MCP screenshots from the data folder",
  "packages/server/projects/app-identity.mjs": "the app's id in a project the emulator created",
  "packages/server/projects/node-tools.mjs": "npm's cache and the tools' scripts in the data folder",
  "packages/server/projects/template-fixes.mjs": "fixes to a project the template made",
  "packages/server/publish/files.mjs": "publishing's files in a project of the list",
  "packages/server/readiness/submission.mjs": "the submission folder of a project",
  "packages/server/server-key.mjs": "the server key in the data folder",
  "packages/server/tar.mjs": "an app package unpacked into the bar's storage (inside the real path of the target)",
  "packages/server/volume.mjs": "a probe file in the data folder",
};

describe("the modules the app ships", () => {
  const files = shippedModules();
  const names = importedNames(files);

  test("the walk sees them", () => {
    for (const one of ["packages/server/server.mjs", "packages/server/cli/system.mjs", "packages/engine/programs.mjs", "packages/engine/checks.mjs"]) assert.ok(files.map(rel).includes(one), one);
    assert.ok(!files.map(rel).some((one) => one.includes("/test/")), "no tests");
  });

  test("start programs only through startProgram, runProgram or runProgramLater of programs.mjs", () => {
    const found = [];
    for (const [file, imports] of Object.entries(names)) {
      if (rel(file) === "packages/engine/programs.mjs") continue;
      for (const [specifier, imported] of Object.entries(imports)) {
        if (/^(node:)?child_process$/.test(specifier)) found.push(`${rel(file)}: imports ${specifier}`);
        if (/(^|\/)programs\.mjs$/.test(specifier)) for (const name of imported.filter((n) => ["execProgram", "spawnProgram", "programCommand", "batchCommandLine", "default", "*"].includes(n))) found.push(`${rel(file)}: imports ${name} from ${specifier}`);
      }
      const text = readFileSync(file, "utf8");
      if (/import\(\s*["'](node:)?child_process|createRequire/.test(text)) found.push(`${rel(file)}: loads child_process another way`);
      if (/\bunlisted:/.test(text) && rel(file) !== "packages/server/cli/system.mjs") found.push(`${rel(file)}: starts a program that is not on the list`);
    }
    assert.deepEqual(found, []);
  });

  test("write files only where WRITERS says", () => {
    const writers = new Set();
    for (const [file, imports] of Object.entries(names)) {
      const written = Object.entries(imports).filter(([specifier]) => FS.test(specifier)).flatMap(([, imported]) => imported.filter((n) => WRITES.test(n)));
      if (written.length || /import\(\s*["'](node:)?fs/.test(readFileSync(file, "utf8"))) writers.add(rel(file));
    }
    assert.deepEqual([...writers].filter((one) => !(one in WRITERS)), [], "a module that writes files: add it to WRITERS, saying what it writes, and check its paths with path-boundary.mjs");
    assert.deepEqual(Object.keys(WRITERS).filter((one) => !writers.has(one)), [], "WRITERS names a module that writes nothing any more");
  });
});
