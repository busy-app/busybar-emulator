// The bundled Node and the command line in a packaged app's layout, without Electron: the command line runs on the
// Node inside the app, with an empty PATH, from paths with spaces and non-Latin letters, through zsh, PowerShell and cmd.
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, test } from "node:test";
import { pathToFileURL } from "node:url";

import { resolveConfig } from "../../src/config.mjs";
import { writeInstallFiles } from "../../src/install-files.mjs";
import { layoutOf } from "../../tools/bundled-node.mjs";
import { emulatorFiles, missingImports, workingFiles } from "../../tools/packaging/composition.mjs";
import { HARD_NAME, layOutApp, PIN, readJson, TARGET } from "../fixtures/layout.mjs";
import { removeFolder, temporaryFolder } from "../helpers.mjs";

const windows = process.platform === "win32";
const SYSTEM_ROOT = process.env.SystemRoot || "C:\\Windows";
const POWERSHELL = path.join(SYSTEM_ROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const CMD = path.join(SYSTEM_ROOT, "System32", "cmd.exe");

let folder;
let app;
let files;
let home;

before(async () => {
  folder = temporaryFolder();
  app = await layOutApp(folder);
  // The shell's own rules for this layout, as the app computes them at start.
  home = path.join(folder, HARD_NAME, "home");
  const config = resolveConfig({
    env: { BUSY_EMULATOR_USER_HOME: home, BUSY_EMULATOR_DATA: path.join(folder, HARD_NAME, "data") },
    platform: process.platform,
    kind: "test",
    testVariant: true,
    appDir: app.appDir,
    appDataDir: path.join(folder, "appData"),
    homeDir: path.join(folder, "home-not-used"),
  });
  files = config.installFiles;
  assert.deepEqual(writeInstallFiles(files, { platform: process.platform, version: "0.0.0" }), { ok: true });
});

after(async () => {
  if (folder) await removeFolder(folder);
});

test("the laid-out app holds what a release holds under emulator/, and every module it imports is there", () => {
  const emulator = path.join(app.resources, "emulator");
  const laid = [];
  const walk = (dir, rel = "") => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else laid.push(r);
    }
  };
  walk(emulator);
  assert.deepEqual(laid.sort(), emulatorFiles({ list: workingFiles }));
  assert.deepEqual(missingImports({ folder: emulator, files: laid }), []);
  // The commands that once failed in a layout of hand-picked files (publish, check): their modules load there, on the
  // app's own Node.
  for (const command of ["publish", "check", "screenshot", "submit", "record"]) {
    const module = path.join(emulator, "packages", "server", "cli", "commands", `${command}.mjs`);
    const run = spawnSync(app.node, ["--import", pathToFileURL(module).href, "-e", ""], { encoding: "utf8", cwd: folder });
    assert.equal(run.status, 0, `${command}.mjs: ${run.stderr}`);
  }
});

/**
 * The environment of a clean shell with an empty PATH and nothing of ours. On macOS nothing else is needed. On
 * Windows the system's own variables stay: without PATHEXT, for one, PowerShell does not run an .exe at all.
 */
function emptyEnvironment() {
  // An empty PATH, not a missing one: without PATH a shell falls back to a default list of folders.
  if (!windows) return { HOME: path.join(folder, "home-not-used"), PATH: "" };
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(path|busy_.*|node_.*)$/i.test(name)));
  return { ...env, PATH: "", LOCALAPPDATA: path.join(folder, "local") };
}

function runJson(program, args, env = emptyEnvironment()) {
  const run = spawnSync(program, args, { encoding: "utf8", env, cwd: folder });
  assert.equal(run.error, undefined, String(run.error));
  const json = args.includes("--json") && run.stdout.trim() ? JSON.parse(run.stdout.trim().split(/\r?\n/).pop()) : null;
  return { status: run.status, json, stderr: run.stderr, stdout: run.stdout };
}

test("the bundled Node is the pinned version, with npm and Node's license, and without links or extra scripts", () => {
  const layout = layoutOf(TARGET);
  const nodeDir = path.join(app.resources, "node");
  assert.equal(execFileSync(path.join(nodeDir, layout.node), ["--version"], { encoding: "utf8" }).trim(), `v${PIN.version}`);
  assert.ok(existsSync(path.join(nodeDir, layout.npmCli)));
  assert.match(readFileSync(path.join(nodeDir, "LICENSE"), "utf8"), /Node\.js is licensed for use as follows/);
  const top = readdirSync(nodeDir).sort();
  assert.deepEqual(top, windows ? ["LICENSE", "node.exe", "node_modules"] : ["LICENSE", "bin", "lib"]);
  if (!windows) assert.deepEqual(readdirSync(path.join(nodeDir, "bin")), ["node"]);
  const links = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) links.push(full);
      else if (stat.isDirectory()) walk(full);
    }
  };
  walk(nodeDir);
  assert.deepEqual(links, []);
});

test("the marker lies in the resources folder and in the app's folder, and both say the same", () => {
  const marker = readJson(path.join(app.resources, "build.json"));
  // The app's own version, whatever it is: a release raises it (docs/release.md in the internal repository).
  const version = readJson(path.join(import.meta.dirname, "..", "..", "package.json")).version;
  assert.deepEqual(marker, { kind: "test", version, node: PIN.version });
  assert.deepEqual(readJson(path.join(app.appDir, "build.json")), marker);
});

test("the command line inside the app runs on the bundled Node by its full path, with an empty PATH", () => {
  const { status, json, stderr } = runJson(app.launcher, ["version", "--json"]);
  assert.equal(status, 0, stderr);
  assert.equal(json.node, PIN.version);
  assert.equal(json.kind, "test");
  assert.equal(json.cli.path, app.launcher);
  // The app around it, by its real path (the temporary folder on macOS lies behind a link).
  assert.equal(json.app, windows ? path.join(realpathSync(app.place), "BUSY Bar Emulator", "BUSY Bar Emulator.exe") : path.join(realpathSync(app.place), "BUSY Bar Emulator.app"));
});

test("the launcher at the fixed path runs this copy's command line on its Node, with an empty PATH", () => {
  const { status, json, stderr } = runJson(files.launcher, ["version", "--json"]);
  assert.equal(status, 0, stderr);
  assert.equal(json.node, PIN.version);
  assert.equal(json.cli.path, files.launcher);
  assert.deepEqual(readJson(files.pointer), { app: files.appPath, cli: files.launcher, version: "0.0.0" });
});

test("exit codes come through the launcher: 0 done, 2 a wrong call", () => {
  assert.equal(runJson(files.launcher, ["version"]).status, 0);
  assert.equal(runJson(files.launcher, ["no-such-command", "--json"]).status, 2);
  assert.equal(runJson(files.launcher, []).status, 2);
});

// What a person or an agent does: read the path from the pointer file, call it, look at the exit code.
test("zsh: the path from the pointer file runs, with spaces and non-Latin letters in it, and the exit code comes back", { skip: windows && "zsh is macOS's" }, () => {
  const script = [
    `cli=$(/usr/bin/plutil -extract cli raw -o - "$POINTER")`,
    `"$cli" version --json || exit 10`,
    `"$cli" 'no such&command' --json; echo "exit=$?"`,
  ].join("\n");
  const run = spawnSync("/bin/zsh", ["-f", "-c", script], { encoding: "utf8", env: { ...emptyEnvironment(), POINTER: files.pointer } });
  assert.equal(run.status, 0, run.stderr);
  const [version, wrong, exit] = run.stdout.trim().split("\n");
  assert.equal(JSON.parse(version).cli.path, files.launcher);
  assert.equal(JSON.parse(wrong).argument, "no such&command");
  assert.equal(exit, "exit=2");
});

test("zsh: the path the command prints for pasting runs as printed", { skip: windows && "zsh is macOS's" }, () => {
  const printed = runJson(app.launcher, ["version", "--json"]).json.cli.sh;
  assert.ok(printed.startsWith("'") && printed.includes("Φάκελος with '\\''quotes'\\'' フォルダ"), printed);
  const run = spawnSync("/bin/zsh", ["-f", "-c", `${printed} version --json`], { encoding: "utf8", env: emptyEnvironment() });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).cli.path, app.launcher);
});

test("PowerShell: the path from the pointer file runs, with spaces and non-Latin letters in it, and the exit code comes back", { skip: !windows && "Windows" }, () => {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$cli = (Get-Content -Raw -Encoding UTF8 -LiteralPath $env:POINTER | ConvertFrom-Json).cli",
    "& $cli version --json",
    "& $cli 'no such&command' --json",
    "\"exit=$LASTEXITCODE\"",
  ].join("; ");
  const run = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...emptyEnvironment(), POINTER: files.pointer } });
  assert.equal(run.status, 0, run.stderr);
  const [version, wrong, exit] = run.stdout.trim().split(/\r?\n/);
  assert.equal(JSON.parse(version).cli.path, files.launcher);
  assert.equal(JSON.parse(wrong).argument, "no such&command");
  assert.equal(exit, "exit=2");
});

test("PowerShell and cmd: the forms the command prints for pasting run as printed", { skip: !windows && "Windows" }, () => {
  const { cli } = runJson(app.launcher, ["version", "--json"]).json;
  const ps = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", `${cli.powershell} version --json`], { encoding: "utf8", env: emptyEnvironment() });
  assert.equal(ps.status, 0, ps.stderr);
  assert.equal(JSON.parse(ps.stdout.trim()).cli.path, app.launcher);
  const cmd = spawnSync(CMD, ["/d", "/s", "/c", `"${cli.cmd} version --json"`], { encoding: "utf8", env: emptyEnvironment(), windowsVerbatimArguments: true });
  assert.equal(cmd.status, 0, cmd.stderr);
  assert.equal(JSON.parse(cmd.stdout.trim()).cli.path, app.launcher);
});

test("cmd: arguments with & % ^ \" and spaces reach the command line unchanged through the .exe", { skip: !windows && "Windows" }, () => {
  // As a person types them in cmd: in double quotes, a quote inside doubled by \".
  const typed = String.raw`"${files.launcher}" version "a&b" "100%" "%NO_SUCH_VARIABLE%" "x^y" "say \"hi\"" "two words" "Γειά フォルダ" --json`;
  const run = spawnSync(CMD, ["/d", "/s", "/c", `"${typed}"`], { encoding: "utf8", env: emptyEnvironment(), windowsVerbatimArguments: true });
  assert.equal(run.status, 2, run.stderr);
  // cmd itself replaces a variable it knows (%PATH%) before any program runs; what it leaves reaches the command intact.
  assert.deepEqual(JSON.parse(run.stdout.trim()).arguments, ["a&b", "100%", "%NO_SUCH_VARIABLE%", "x^y", 'say "hi"', "two words", "Γειά フォルダ"]);
});

test("PowerShell: arguments with & % ^ and spaces reach the command line unchanged through the .exe", { skip: !windows && "Windows" }, () => {
  const script = `& $env:CLI version 'a&b' '100%' '%PATH%' 'x^y' 'two words' 'Γειά フォルダ' --json`;
  const run = spawnSync(POWERSHELL, ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", env: { ...emptyEnvironment(), CLI: files.launcher } });
  assert.deepEqual(JSON.parse(run.stdout.trim()).arguments, ["a&b", "100%", "%PATH%", "x^y", "two words", "Γειά フォルダ"]);
});

test("Windows: what the launcher itself prints names a path with letters outside the system's code page as it is", { skip: !windows && "Windows" }, () => {
  // The one message the .exe prints on its own, before any Node runs: its launch file names a Node that is gone.
  // Console.Error of .NET wrote it in the console's code page and turned every other letter into "?" (EMU-242).
  // Greek and Japanese from HARD_NAME, and Cyrillic made from its codes so that this file holds none: whatever the
  // code page of the machine is, some of the three are outside it.
  const cyrillic = String.fromCharCode(0x43f, 0x430, 0x43f, 0x43a, 0x430);
  const lost = path.join(folder, HARD_NAME, "lost");
  mkdirSync(lost, { recursive: true });
  const copy = path.join(lost, "busy-emulator.exe");
  copyFileSync(app.launcher, copy);
  const gone = path.join(folder, HARD_NAME, cyrillic, "node.exe");
  writeFileSync(path.join(lost, "busy-emulator.launch"), `${gone}\r\n${path.join(lost, "busy-emulator.mjs")}\r\n`);
  const run = spawnSync(copy, ["version"], { env: emptyEnvironment(), cwd: folder });
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 1);
  assert.equal(run.stdout.length, 0);
  // A pipe gets UTF-8, as from Node.
  const said = run.stderr.toString("utf8");
  assert.equal(said, `busy-emulator: BUSY Bar Emulator is no longer where this command expects it (${gone}). Open the emulator once and this command will find it again.\r\n`);
});

test("Windows: a copy of the launcher outside the app without its .launch file runs no node.exe beside it (S8)", { skip: !windows && "Windows" }, () => {
  // As the launcher's place in %LOCALAPPDATA% would be if its .launch file were gone: bin\ with the .exe, and a
  // node\node.exe and the script's path above it, in a folder that is not the app's resources (no app.asar, no app\).
  const lone = path.join(folder, "lone");
  mkdirSync(path.join(lone, "bin"), { recursive: true });
  mkdirSync(path.join(lone, "node"), { recursive: true });
  mkdirSync(path.join(lone, "emulator", "packages", "server", "cli"), { recursive: true });
  const copy = path.join(lone, "bin", "busy-emulator.exe");
  copyFileSync(app.launcher, copy);
  copyFileSync(app.node, path.join(lone, "node", "node.exe"));
  const ran = path.join(lone, "ran.txt");
  writeFileSync(path.join(lone, "emulator", "packages", "server", "cli", "busy-emulator.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "ran");\n`);
  const run = spawnSync(copy, ["version"], { env: emptyEnvironment(), cwd: folder });
  assert.equal(run.error, undefined, String(run.error));
  assert.equal(run.status, 1);
  assert.equal(existsSync(ran), false, "the node.exe beside it did not run");
  assert.match(run.stderr.toString("utf8"), /busy-emulator\.launch is missing/);
  // The copy inside the app, beside app\, still finds its Node without the file.
  assert.equal(runJson(app.launcher, ["version", "--json"]).json.cli !== undefined, true);
});

test("Windows: a new launcher replaces one that is running at that moment, and the old copy goes at the next start", { skip: !windows && "Windows" }, async () => {
  // A command line that waits: start with a launch that never makes an emulator, so it waits for one.
  const waiting = spawn(files.launcher, ["start", "--json"], {
    env: { ...emptyEnvironment(), BUSY_EMULATOR_DATA: path.join(folder, "data-of-nobody"), BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([process.execPath, "-e", ""]) },
    stdio: "ignore",
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const changed = path.join(folder, "busy-emulator-new.exe");
    writeFileSync(changed, Buffer.concat([readFileSync(app.launcher), Buffer.from("\0new build")]));
    assert.deepEqual(writeInstallFiles({ ...files, inAppLauncher: changed }, { platform: "win32", version: "0.0.1" }), { ok: true });
    assert.ok(readFileSync(files.launcher).equals(readFileSync(changed)), "the new launcher is in place");
    const bin = path.dirname(files.launcher);
    assert.ok(readdirSync(bin).some((name) => name.startsWith("busy-emulator.exe.old-")), "the running one was moved aside");
  } finally {
    // The launcher and the Node it started, by their process ids.
    spawnSync(path.join(SYSTEM_ROOT, "System32", "taskkill.exe"), ["/T", "/F", "/PID", String(waiting.pid)]);
    await new Promise((resolve) => waiting.once("exit", resolve).once("error", resolve));
  }
  await new Promise((resolve) => setTimeout(resolve, 500));
  writeInstallFiles({ ...files, inAppLauncher: app.launcher }, { platform: "win32", version: "0.0.0" });
  assert.deepEqual(readdirSync(path.dirname(files.launcher)).sort(), ["busy-emulator.exe", "busy-emulator.launch"]);
  assert.equal(runJson(files.launcher, ["version", "--json"]).json.cli.path, files.launcher);
});

test("neither entry gives the bundled Node what the caller set to change how it starts (security S2)", () => {
  const planted = path.join(folder, "planted.cjs");
  const ran = path.join(folder, "planted-ran");
  writeFileSync(planted, `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "yes");\n`);
  for (const entry of [app.launcher, files.launcher]) {
    const run = spawnSync(entry, ["version", "--json"], { encoding: "utf8", env: { ...emptyEnvironment(), NODE_OPTIONS: `--require ${planted}`, NODE_PATH: folder } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).node, PIN.version);
    assert.equal(existsSync(ran), false, `NODE_OPTIONS reached Node through ${entry}`);
  }
});

test("without the copy of the marker the command line inside the app is a release (review H2, security S3)", () => {
  const marker = path.join(app.resources, "build.json");
  const saved = readFileSync(marker);
  rmSync(marker);
  try {
    const touched = path.join(folder, "launched");
    const env = { ...emptyEnvironment(), BUSY_EMULATOR_DATA: path.join(folder, "elsewhere"), BUSY_EMULATOR_TEST_LAUNCH: JSON.stringify([process.execPath, "-e", `require("node:fs").writeFileSync(${JSON.stringify(touched)}, "")`]) };
    const run = spawnSync(app.launcher, ["version", "--json"], { encoding: "utf8", env });
    assert.equal(JSON.parse(run.stdout.trim()).kind, "release");
  } finally {
    writeFileSync(marker, saved);
  }
});
