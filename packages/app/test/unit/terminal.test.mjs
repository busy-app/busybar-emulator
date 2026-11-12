// "Open in Terminal" / "Open in cmd" of the window's console (terminal.mjs): the command the shell builds for a state
// of the window, on both systems; what it refuses; how it opens the terminal. No terminal is opened here: the scripts
// and command lines run in this test's own process, with a stand-in for the command line, and the system's terminal
// is replaced by a record of what it would have got.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUILD_FEED_PARTS, createBuildFeed, KEEP, MAX_LINES } from "../../src/build-feed.mjs";
import { CLI_VARIABLE, cmdPath, createTerminal, launchTerminal, logsWords, macScript, removeStaleScripts, SCRIPT_FOLDER_PARTS, STALE_SCRIPT_MS, terminalName, TERMINAL_KINDS, windowsStart } from "../../src/terminal.mjs";

const MAC_CLI = "/Users/you/.busy-emulator/bin/busy-emulator";
const WIN_CLI = "C:\\Users\\you\\Тест Имя\\AppData\\Local\\busy-emulator\\bin\\busy-emulator.exe";
const FOLDER = "/Users/you/Projects/Мой проект/it's one";
const UNTRUSTED = "/Users/you/Downloads/someone else's app";
const PROJECTS = [
  { id: "app.you.one", folder: FOLDER, exists: true, unavailable: false, trusted: true },
  { id: "app.you.away", folder: "/Volumes/Shared/away", exists: false, unavailable: true, trusted: true },
  { id: "app.them.downloaded", folder: UNTRUSTED, exists: true, unavailable: false, trusted: false },
];

function temporary(t) {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "busy-terminal-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function terminalFor({ platform = "darwin", cli = MAC_CLI, exists = () => true, projects = PROJECTS, bar = ["app.from.package"], env = {} } = {}) {
  const plans = [];
  const lines = [];
  const terminal = createTerminal({ platform, cli, env, projects: async () => projects, barApps: async () => bar, launch: (plan) => void plans.push(plan), exists, now: () => 2_000_000_000_000, log: (line) => lines.push(line) });
  return { terminal, plans, lines };
}

// The command line's side, which this package may not import, checks the same words (cli/test/run-logs.test.mjs).
const readBuildFeed = (file) => ({ lines: readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) });

test("the console's filters are the logs command's kinds, and the shell's file of Build lines is the one the command line reads", () => {
  assert.deepEqual(TERMINAL_KINDS, ["console", "lifecycle", "build", "system"]);
  assert.deepEqual(BUILD_FEED_PARTS, ["run", "build-lines.jsonl"]);
  assert.equal(terminalName("darwin"), "Terminal");
  assert.equal(terminalName("win32"), "cmd");
  assert.equal(terminalName("linux"), null);
});

test("the logs command for a state of the window: every app's lines or one app's, the filters that are on, from the last Clear", () => {
  assert.deepEqual(logsWords({ app: null, kinds: ["console", "lifecycle", "build"], since: null }), ["logs", "--follow", "--all", "--kind", "console,lifecycle,build", "--lines", "2000"]);
  // The order of the filters is the logs command's, whatever the window's.
  assert.deepEqual(logsWords({ app: "app.you.one", kinds: ["system", "console"], since: 1_762_870_000_123 }), ["logs", "--follow", "--app", "app.you.one", "--kind", "console,system", "--since", "1762870000123", "--lines", "2000"]);
});

test("macOS: a script for Terminal, to the project's folder, the launcher's folder on PATH, the log, then the person's shell", () => {
  const words = logsWords({ app: null, kinds: ["console", "lifecycle"], since: 42 });
  const script = macScript({ cli: MAC_CLI, words, folder: FOLDER, env: {} });
  assert.equal(
    script,
    [
      "#!/bin/sh",
      "# BUSY Bar Emulator: the window's console in Terminal. This file removes itself.",
      'rm -f "$0"',
      "cd '/Users/you/Projects/Мой проект/it'\\''s one' || cd",
      "PATH='/Users/you/.busy-emulator/bin':\"$PATH\"",
      "export PATH",
      "clear",
      "trap : INT",
      "'/Users/you/.busy-emulator/bin/busy-emulator' 'logs' '--follow' '--all' '--kind' 'console,lifecycle' '--since' '42' '--lines' '2000'",
      "trap - INT",
      'exec "${SHELL:-/bin/zsh}" -l',
      "",
    ].join("\n"),
  );
  // Without a folder: the home. A development run tells the command line its data folder and port.
  const plain = macScript({ cli: MAC_CLI, words, folder: null, env: { BUSY_EMULATOR_DATA: "/tmp/a b", BUSY_EMULATOR_PORT: "9241" } });
  assert.match(plain, /^cd$/m);
  assert.match(plain, /^BUSY_EMULATOR_DATA='\/tmp\/a b'; export BUSY_EMULATOR_DATA$/m);
});

test("macOS: the script runs as written: in a folder with a space, a Cyrillic letter and a quote, the command line gets exactly its words, and the file is gone", { skip: process.platform === "win32" && "macOS only: Terminal and sh" }, (t) => {
  const root = temporary(t);
  const folder = path.join(root, "Мой проект", "it's & one");
  const bin = path.join(root, "bin dir");
  mkdirSync(folder, { recursive: true });
  mkdirSync(bin);
  const cli = path.join(bin, "busy-emulator");
  const said = path.join(root, "said.txt");
  writeFileSync(cli, `#!/bin/sh\n{ pwd; command -v busy-emulator; for word in "$@"; do printf '[%s]\\n' "$word"; done; } > '${said}'\n`);
  chmodSync(cli, 0o755);
  const words = logsWords({ app: null, kinds: ["console", "build"], since: 7 });
  const file = path.join(root, "console.command");
  writeFileSync(file, macScript({ cli, words, folder, env: {} }), { mode: 0o700 });
  // The person's shell at the end is a stand-in that ends at once; `clear` has no terminal to clear.
  const run = spawnSync("/bin/sh", [file], { env: { PATH: "/usr/bin:/bin", SHELL: "/usr/bin/true", TERM: "dumb" }, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(readFileSync(said, "utf8").split("\n").filter(Boolean), [realpathSync(folder), cli, ...words.map((word) => `[${word}]`)]);
  assert.equal(existsSync(file), false, "the script removed itself");
});

test("Windows: cmd starts a cmd window in the folder; the launcher's path goes in the environment, never in the command's text", () => {
  const words = logsWords({ app: null, kinds: ["console", "lifecycle", "build"], since: 1_762_870_000_123 });
  const cmd = "C:\\Windows\\System32\\cmd.exe";
  const start = windowsStart({ cmd, cli: WIN_CLI, words, folder: "D:\\Проекты\\my app", home: "C:\\Users\\you\\Тест Имя", env: {}, baseEnv: { Path: "C:\\Windows\\System32", SystemRoot: "C:\\Windows" } });
  assert.equal(start.file, cmd);
  assert.deepEqual(start.args, [`/d /c start "busy-emulator logs" "C:\\Windows\\System32\\cmd.exe" /d /s /k ""%^${CLI_VARIABLE}%" logs --follow --all --kind console,lifecycle,build --since 1762870000123 --lines 2000"`]);
  assert.equal(start.cwd, "D:\\Проекты\\my app");
  assert.equal(start.env[CLI_VARIABLE], WIN_CLI);
  assert.equal(start.env.NoDefaultCurrentDirectoryInExePath, "1", "cmd does not look in the project's folder for a command");
  assert.equal(start.env.Path, "C:\\Users\\you\\Тест Имя\\AppData\\Local\\busy-emulator\\bin;C:\\Windows\\System32");
  assert.equal(Object.keys(start.env).filter((name) => name.toUpperCase() === "PATH").length, 1);
  // "." and other relative entries of PATH are the project's folder in that window: left out.
  const relative = windowsStart({ cmd, cli: WIN_CLI, words, folder: "D:\\app", home: "C:\\", env: {}, baseEnv: { Path: '.;bin;C:\\Windows\\System32;"C:\\Program Files\\Git\\cmd";C:tools;;D:\\tools' } });
  assert.equal(relative.env.Path, `${path.win32.dirname(WIN_CLI)};C:\\Windows\\System32;C:\\Program Files\\Git\\cmd;D:\\tools`);
  // Without a folder: the home; a development run's data folder and port go in the environment too.
  const home = windowsStart({ cmd, cli: WIN_CLI, words, folder: null, home: "C:\\Users\\user", env: { BUSY_EMULATOR_DATA: "C:\\d", BUSY_EMULATOR_PORT: "9242" }, baseEnv: {} });
  assert.equal(home.cwd, "C:\\Users\\user");
  assert.deepEqual([home.env.BUSY_EMULATOR_DATA, home.env.BUSY_EMULATOR_PORT, home.env.Path], ["C:\\d", "9242", "C:\\Users\\you\\Тест Имя\\AppData\\Local\\busy-emulator\\bin"]);
  // A word that is not one of the fixed set's is never written.
  assert.throws(() => windowsStart({ cmd, cli: WIN_CLI, words: ["logs", "&", "calc"], folder: null, home: "C:\\", baseEnv: {} }));
  // cmd.exe by its full path, from the system's folder.
  assert.equal(cmdPath({ SystemRoot: "D:\\WINDOWS" }), "D:\\WINDOWS\\System32\\cmd.exe");
  assert.equal(cmdPath({ SystemRoot: "evil.exe & x", windir: "relative" }), "C:\\Windows\\System32\\cmd.exe");
});

test("Windows: both cmds read the command as meant: the launcher in a folder with a space, a Cyrillic letter, & and % gets exactly its words", { skip: process.platform !== "win32" && "Windows only: cmd.exe" }, (t) => {
  const root = temporary(t);
  const bin = path.join(root, "Тест dir & 50%");
  mkdirSync(bin);
  // The launcher's stand-in: a batch file that writes the words it got beside itself.
  const cli = path.join(bin, "busy-emulator.cmd");
  writeFileSync(cli, '@echo off\r\n> "%~dp0said.txt" echo [%*]\r\n');
  const words = logsWords({ app: "app.you.one", kinds: ["console", "system"], since: 99 });
  const cmd = cmdPath(process.env);
  const start = windowsStart({ cmd, cli, words, folder: root, home: root, env: {}, baseEnv: process.env });
  // As the shell writes it, less the new window: start runs the second cmd in the first's console and waits (/b /wait),
  // and the second ends (/c) instead of staying (/k).
  const [line] = start.args;
  const here = line.replace('start "busy-emulator logs" ', 'start "busy-emulator logs" /b /wait ').replace(" /d /s /k ", " /d /s /c ");
  assert.notEqual(here, line);
  const run = spawnSync(start.file, [here], { cwd: start.cwd, env: start.env, windowsVerbatimArguments: true, windowsHide: true, encoding: "utf8" });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.equal(readFileSync(path.join(bin, "said.txt"), "utf8").trim(), `[${words.join(" ")}]`);
});

test("Windows: in the cmd window, a command the project's folder holds (npm.cmd, git.bat) does not run for its name", { skip: process.platform !== "win32" && "Windows only: cmd.exe" }, (t) => {
  const root = temporary(t);
  const project = path.join(root, "downloaded app");
  mkdirSync(project);
  for (const name of ["npm.cmd", "git.bat", "busy-emulator.cmd"]) writeFileSync(path.join(project, name), `@echo off\r\n> "%~dp0PLANTED-${name}" echo ran\r\n`);
  const pathKey = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "Path";
  // A PATH with "." first, as some set it: still nothing of the folder runs.
  // The real npm that runs below turns Node's compile cache on: in the test's folder, not the system's temporary one.
  const start = windowsStart({ cmd: cmdPath(process.env), cli: path.join(root, "bin", "busy-emulator.exe"), words: ["logs"], folder: project, home: root, env: {}, baseEnv: { ...process.env, [pathKey]: `.;${process.env[pathKey]}`, NODE_COMPILE_CACHE: path.join(root, "node-compile-cache") } });
  // What the person types in that window, in its folder and with its environment.
  for (const name of ["npm", "git", "busy-emulator"]) spawnSync(start.file, ["/d", "/c", `${name} --version`], { cwd: start.cwd, env: start.env, windowsHide: true, encoding: "utf8" });
  assert.deepEqual(readdirSync(project).filter((name) => name.startsWith("PLANTED")), []);
  // The same without the variable: cmd runs the folder's own.
  const { NoDefaultCurrentDirectoryInExePath: _, ...plain } = start.env;
  spawnSync(start.file, ["/d", "/c", "npm --version"], { cwd: start.cwd, env: plain, windowsHide: true, encoding: "utf8" });
  assert.deepEqual(readdirSync(project).filter((name) => name.startsWith("PLANTED")), ["PLANTED-npm.cmd"]);
});

test("the button's state: available with the launcher there, labelled by the system; without it, not, and says why", async () => {
  assert.deepEqual(terminalFor().terminal.info(), { ok: true, value: { available: true, name: "Terminal", label: "Open in Terminal", why: null } });
  assert.deepEqual(terminalFor({ platform: "win32", cli: WIN_CLI }).terminal.info().value.label, "Open in cmd");
  const none = terminalFor({ cli: null });
  assert.equal(none.terminal.info().value.available, false);
  assert.match(none.terminal.info().value.why, /busy-emulator command/);
  const gone = terminalFor({ exists: () => false });
  assert.equal(gone.terminal.info().value.available, false);
  const refused = await gone.terminal.open({ app: null, folder: null, kinds: ["console"], since: null });
  assert.equal(refused.error.code, "no_cli");
  assert.deepEqual(gone.plans, []);
});

test("open: the window's state becomes a plan of known parts; a folder of the list is where it starts", async () => {
  const { terminal, plans } = terminalFor();
  assert.deepEqual(await terminal.open({ app: null, folder: FOLDER, kinds: ["build", "console"], since: 1_762_870_000_000 }), { ok: true, value: { opened: "Terminal" } });
  assert.equal(plans.length, 1);
  assert.deepEqual([plans[0].cli, plans[0].folder, plans[0].words], [MAC_CLI, FOLDER, ["logs", "--follow", "--all", "--kind", "console,build", "--since", "1762870000000", "--lines", "2000"]]);
  assert.match(plans[0].script, /^cd '\/Users\/you\/Projects\/Мой проект\/it'\\''s one' \|\| cd$/m);
  // An app of a project and an app on the bar without a project are both the emulator's.
  assert.equal((await terminal.open({ app: "app.you.one", kinds: ["console"] })).ok, true);
  assert.equal((await terminal.open({ app: "app.from.package", kinds: ["console"] })).ok, true);
  const win = terminalFor({ platform: "win32", cli: WIN_CLI });
  assert.equal((await win.terminal.open({ app: null, folder: null, kinds: ["console", "system"], since: null })).ok, true);
  assert.deepEqual(win.plans[0], { platform: "win32", cli: WIN_CLI, words: ["logs", "--follow", "--all", "--kind", "console,system", "--lines", "2000"], folder: null, env: {} });
});

test("open refuses what is not the emulator's or not in the fixed set, and opens nothing", async () => {
  const { terminal, plans } = terminalFor();
  const ok = { app: null, folder: null, kinds: ["console"], since: null };
  const cases = [
    [{ ...ok, app: "app.nobody.has" }, "unknown_app"],
    [{ ...ok, app: "app.x; rm -rf ~" }, "unknown_app"],
    [{ ...ok, app: 7 }, "unknown_app"],
    [{ ...ok, folder: "/Users/you/elsewhere" }, "unknown_project"],
    [{ ...ok, folder: `${FOLDER}/..` }, "unknown_project"],
    [{ ...ok, folder: "/Volumes/Shared/away" }, "folder_unavailable"],
    [{ ...ok, folder: UNTRUSTED }, "untrusted_project"],
    [{ ...ok, folder: ["/a"] }, "unknown_project"],
    [{ ...ok, kinds: ["console", "everything"] }, "bad_request"],
    [{ ...ok, kinds: [] }, "bad_request"],
    [{ ...ok, kinds: "console" }, "bad_request"],
    [{ ...ok, kinds: ["console", "console", "console", "console", "console"] }, "bad_request"],
    [{ ...ok, since: "1; calc" }, "bad_request"],
    [{ ...ok, since: 1.5 }, "bad_request"],
    [{ ...ok, since: -1 }, "bad_request"],
    [{ ...ok, since: 9_000_000_000_000 }, "bad_request"],
    [{ ...ok, command: "calc" }, "bad_request"],
    [null, "bad_request"],
    ["logs", "bad_request"],
    [[ok], "bad_request"],
  ];
  for (const [asked, code] of cases) {
    const answer = await terminal.open(asked);
    assert.equal(answer.ok, false, JSON.stringify(asked));
    assert.equal(answer.error.code, code, JSON.stringify(asked));
  }
  assert.deepEqual(plans, []);
});

test("launch on macOS: the script goes to the data folder's run/terminal, readable by the person alone, and Terminal opens it; scripts never run are removed", { skip: process.platform === "win32" && "macOS only: Terminal and sh" }, (t) => {
  const dataDir = temporary(t);
  const folder = path.join(dataDir, ...SCRIPT_FOLDER_PARTS);
  mkdirSync(folder, { recursive: true });
  const stale = path.join(folder, "console-old.command");
  writeFileSync(stale, "#!/bin/sh\n");
  const old = (Date.now() - STALE_SCRIPT_MS - 1000) / 1000;
  utimesSync(stale, old, old);
  const fresh = path.join(folder, "console-fresh.command");
  writeFileSync(fresh, "#!/bin/sh\n");
  const spawned = [];
  const spawn = (file, args, options) => (spawned.push({ file, args, options }), { on() {}, unref() {} });
  launchTerminal({ platform: "darwin", cli: MAC_CLI, words: ["logs"], folder: null, script: "#!/bin/sh\necho hi\n" }, { spawn, dataDir, home: "/Users/you", baseEnv: {} });
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, "a script just written may still be on its way to Terminal");
  assert.equal(spawned.length, 1);
  const [{ file, args, options }] = spawned;
  assert.deepEqual([file, args.slice(0, 2), options.detached, options.stdio], ["/usr/bin/open", ["-a", "Terminal"], true, "ignore"]);
  assert.equal(path.dirname(args[2]), folder);
  assert.match(path.basename(args[2]), /^console-[0-9a-f]{12}\.command$/);
  assert.equal(readFileSync(args[2], "utf8"), "#!/bin/sh\necho hi\n");
  assert.equal(statSync(args[2]).mode & 0o777, 0o700);
  removeStaleScripts(path.join(dataDir, "not there"));
});

test("launch on Windows: cmd.exe by its full path, detached so the window outlives the app, its words as written", () => {
  const spawned = [];
  const spawn = (file, args, options) => (spawned.push({ file, args, options }), { on() {}, unref() {} });
  launchTerminal({ platform: "win32", cli: WIN_CLI, words: ["logs", "--follow"], folder: "D:\\p", env: {} }, { spawn, dataDir: "C:\\data", home: "C:\\Users\\user", baseEnv: { SystemRoot: "C:\\Windows", Path: "C:\\Windows" } });
  const [{ file, args, options }] = spawned;
  assert.equal(file, "C:\\Windows\\System32\\cmd.exe");
  assert.equal(args.length, 1);
  assert.deepEqual([options.cwd, options.detached, options.stdio, options.windowsVerbatimArguments, options.env[CLI_VARIABLE]], ["D:\\p", true, "ignore", true, WIN_CLI]);
});

test("the Build lines: each line of a job goes to the data folder's file, which the app empties when it starts and cuts when it grows long", (t) => {
  const dataDir = temporary(t);
  const file = path.join(dataDir, ...BUILD_FEED_PARTS);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, '{"kind":"build","text":"of the last run","time":1,"at":1}\n');
  let time = 1000;
  const feed = createBuildFeed({ dataDir, log: () => {}, now: () => time++ });
  assert.equal(feed.file, file);
  assert.equal(readFileSync(file, "utf8"), "");
  feed.take({ id: 1, kind: "build", folder: "/p", state: "running", line: "> busy-cli build" });
  feed.take({ id: 1, kind: "build", folder: "/p", state: "done" });
  feed.take({ id: 2, kind: "removed", folder: "/p", state: "done", line: "The project left the list" });
  feed.take({ id: 3, kind: "refresh", folder: "/p", state: "running", line: "Ümlaut and Кириллица" });
  assert.deepEqual(readBuildFeed(file).lines, [
    { kind: "build", text: "> busy-cli build", time: 1000, at: 1000 },
    { kind: "build", text: "Ümlaut and Кириллица", time: 1001, at: 1001 },
  ]);
  for (let i = 0; i < MAX_LINES; i++) feed.take({ id: 4, kind: "build", folder: "/p", state: "running", line: `line ${i}` });
  const kept = readBuildFeed(file).lines;
  assert.ok(kept.length <= MAX_LINES && kept.length >= KEEP, `${kept.length} lines kept`);
  assert.equal(kept.at(-1).text, `line ${MAX_LINES - 1}`);
  assert.deepEqual(readdirSync(path.dirname(file)), ["build-lines.jsonl"]);
});
