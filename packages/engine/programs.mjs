// Starting other programs (git, tar, Python, Emscripten) without the current folder choosing which one runs.
//
// Windows looks a bare program name up in the folder the child starts in before PATH: `git` started from a folder
// that holds a git.exe runs that file (checked on Windows 10, EMU-237). So on Windows a program is found here on PATH
// alone — its absolute folders, with the extensions PATHEXT lists — and started by its full path. Elsewhere the system
// looks on PATH only, and the name is passed on as it is: on macOS nothing changes.
//
// The children started here on Windows get NoDefaultCurrentDirectoryInExePath=1, so what they start by name in turn is
// not taken from the current folder either: cmd.exe running a batch file honours it, and so does CreateProcess, which
// Emscripten's launcher (emcc.exe) starts python.exe with.
//
// Batch files (.bat, .cmd: emcc.bat of older Emscripten, for one) cannot be started without cmd.exe: Node refuses
// them since CVE-2024-27980. They are started the way Node documents, through cmd.exe, with every argument quoted and
// its special characters escaped twice — once for the command line cmd.exe reads, once more for the line the batch
// file passes them on in (%*) — so that an argument reaches the program as given, spaces, quotes, &, % and all, and
// nothing in it is run as a command. A ^ does not stop cmd.exe from expanding %name% or %name:a=b% on its command
// line, so a % goes as %%cd:~,%: cmd.exe keeps the first % and expands %cd:~,% to nothing, and no pair of % is left
// (the way Rust's standard library passes % to batch files). What cmd.exe cannot carry (line breaks, NUL, a line over
// 8191 characters) is refused rather than mangled.
//
// A batch file that turns delayed expansion on itself (setlocal enabledelayedexpansion) expands !name! in what it is
// given, after /v:off has done its part: there a ! in an argument is lost, and nothing outside the batch file can
// prevent it. The same holds for % in a batch file that passes %* on through call, which expands it once more.

import { execFile, execFileSync, spawn } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** A program that is not on PATH. `code` is "ENOENT", as when the system does not find it. */
export class ProgramNotFound extends Error {
  constructor(name) {
    super(`${name} is not on PATH; install it or add its folder to PATH`);
    this.name = "ProgramNotFound";
    this.code = "ENOENT";
    this.program = name;
  }
}

// What can be started at all: a program, or a batch file through cmd.exe. Other PATHEXT entries (.js, .vbs, ...) open
// in a script host and are skipped.
const STARTABLE = [".com", ".exe", ".bat", ".cmd"];
const isBatch = (file) => /\.(bat|cmd)$/i.test(file);

/**
 * A variable of `env` by name, ignoring case as Windows does: of { ...process.env, PATH } — "Path" and "PATH" — the
 * child gets the first in sorted order, as Node passes it (the documented rule for options.env on Windows).
 */
function variable(env, name) {
  const key = Object.keys(env).filter((k) => k.toUpperCase() === name.toUpperCase()).sort()[0];
  return key === undefined ? undefined : env[key];
}

/**
 * Whether `file` is something to start: a file, or a link to one. The store's app aliases (WindowsApps\python.exe) are
 * links that stat refuses (EACCES) and Windows starts all the same; a dangling link or a link to a folder is not one.
 */
export function isProgramFile(file) {
  try {
    const entry = lstatSync(file);
    if (entry.isDirectory()) return false;
    if (!entry.isSymbolicLink()) return true;
  } catch {
    return false;
  }
  try {
    return !statSync(file).isDirectory();
  } catch (error) {
    return !["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code);
  }
}

/**
 * The program to start for `name`. On Windows: the full path of the first `name` + extension (PATHEXT order, or `name`
 * itself when it has one) in the absolute folders of PATH — "." and other relative entries are the current folder
 * again and are skipped. Throws ProgramNotFound when there is none. A name with a folder in it is a path, not looked up.
 * Elsewhere: `name` itself, which the system looks up on PATH. `exists` is for tests: whether a file is there.
 */
export function findProgram(name, { env = process.env, platform = process.platform, exists = isProgramFile } = {}) {
  if (platform !== "win32" || /[\\/]/.test(name)) return name;
  const own = path.win32.extname(name).toLowerCase();
  const listed = (variable(env, "PATHEXT") ?? "").split(";").map((e) => e.trim().toLowerCase()).filter((e) => STARTABLE.includes(e));
  const order = listed.length ? listed : STARTABLE; // no PATHEXT, or nothing startable in it: Windows' own list
  const names = STARTABLE.includes(own) ? [name] : order.map((ext) => name + ext);
  for (const entry of (variable(env, "PATH") ?? "").split(";")) {
    const dir = entry.trim().replace(/^"(.*)"$/, "$1");
    if (!path.win32.isAbsolute(dir)) continue;
    for (const candidate of names) if (exists(path.win32.join(dir, candidate))) return path.win32.join(dir, candidate);
  }
  throw new ProgramNotFound(name);
}

// cmd.exe's special characters; each is escaped with ^ (so is ", which keeps cmd.exe from seeing quoted stretches).
const CMD_SPECIAL = /([()\][%!^"`<>&|;, *?])/g;
const CMD_LINE_MAX = 8191;

/** One argument as a C runtime reads it back: quoted, quotes escaped, backslashes before a quote or the end doubled. */
const quoted = (arg) => `"${arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;

/**
 * The command line for cmd.exe /d /s /c that runs batch file `file` with `args` (see the top of the file). The file's
 * path is escaped once — cmd.exe reads it once —, the arguments twice; a % in either goes as %%cd:~,%.
 */
export function batchCommandLine(file, args) {
  for (const arg of args) {
    if (/[\r\n\0]/.test(arg)) throw new Error(`cannot pass an argument with a line break or NUL to ${path.win32.basename(file)}: cmd.exe would cut it`);
  }
  const line = [file.replace(CMD_SPECIAL, "^$1").replaceAll("^%", "%%cd:~,%"), ...args.map((arg) => quoted(String(arg)).replace(CMD_SPECIAL, "^$1").replace(CMD_SPECIAL, "^$1").replaceAll("^^^%", "%%cd:~,%"))].join(" ");
  if (line.length + 2 > CMD_LINE_MAX) throw new Error(`the command line for ${path.win32.basename(file)} is ${line.length + 2} characters, cmd.exe takes ${CMD_LINE_MAX}: use a response file`);
  return `"${line}"`;
}

/**
 * How to start `name` with `args`: { file, args, options } for execFileSync or spawn, `options` to be merged over the
 * caller's (it carries their env with the variable above, and for a batch file windowsVerbatimArguments). `lookup`
 * is for tests: findProgram's platform and exists.
 */
export function programCommand(name, args = [], options = {}, lookup = {}) {
  const platform = lookup.platform ?? process.platform;
  const env = options.env ?? process.env;
  const file = findProgram(name, { env, ...lookup });
  if (platform !== "win32") return { file, args, options };
  const safer = { ...options, env: { ...env, NoDefaultCurrentDirectoryInExePath: "1" } };
  if (!isBatch(file)) return { file, args, options: safer };
  const comspec = variable(env, "ComSpec");
  const cmd = comspec && path.win32.isAbsolute(comspec) ? comspec : path.win32.join(variable(env, "SystemRoot") ?? "C:\\Windows", "System32", "cmd.exe");
  return { file: cmd, args: ["/d", "/s", "/v:off", "/c", batchCommandLine(file, args)], options: { ...safer, windowsVerbatimArguments: true } };
}

/** execFileSync for `name`, found as findProgram finds it. */
export function execProgram(name, args = [], options = {}) {
  const c = programCommand(name, args, options);
  return execFileSync(c.file, c.args, c.options);
}

/** spawn for `name`, found as findProgram finds it. */
export function spawnProgram(name, args = [], options = {}) {
  const c = programCommand(name, args, options);
  return spawn(c.file, c.args, c.options);
}

// ---------------------------------------------------------------- what the emulator starts while it runs

/**
 * The programs the server and the command line start (ADR-0012 §6, EMU-010): this list and nothing else. They are
 * started through startProgram and runProgram, which refuse any other; execProgram and spawnProgram above are for the
 * maintainers' tools (the engine's build, the packaging, the tests), which start what they need. A test keeps every
 * module the app ships off node:child_process and off execProgram and spawnProgram
 * (packages/engine/test/started-programs.test.mjs). The desktop app's own short list is packages/app/src/processes.mjs.
 *
 * Each entry: the programs, by full path on macOS and Linux; on Windows by the path inside the Windows folder (the
 * one the system names, or SystemRoot of this process), letter case aside; or by name for one found on PATH. Node is
 * the Node this process runs on or the one inside the app, by its exact path; gh, by name or inside the app's
 * resources. `why` is what it is started for.
 */
export const ALLOWED_PROGRAMS = Object.freeze([
  { id: "node", why: "the Node that runs the emulator (bundled in the app): npm as npm-cli.js, npx, the app template's generator, the project's busy-cli, the catalog check's import probe", node: true },
  { id: "git", why: "the state of a project's repository; a commit or a push only on the person's word", names: ["git"] },
  { id: "gh", why: "the GitHub command line bundled in the app (EMU-010 keeps the place; the publish flow takes it when it ships)", names: ["gh"], bundled: ["gh", "gh.exe"] },
  { id: "opener", why: "start the app the way the system starts one (busy-emulator start)", darwin: ["/usr/bin/open"], windows: ["explorer.exe"] },
  { id: "trash", why: "move a project's folder to the Trash (busy-emulator uninstall --delete-files)", darwin: ["/usr/bin/trash", "/usr/bin/osascript"], linux: ["gio"] },
  { id: "powershell", why: "Windows: the Recycle Bin, and when a process started", windows: ["System32\\WindowsPowerShell\\v1.0\\powershell.exe"] },
  { id: "taskkill", why: "Windows: end a project tool and what it started, by the tool's process id, never by a name (projects/node-tools.mjs killTree)", windows: ["System32\\taskkill.exe"] },
  { id: "ps", why: "macOS and Linux: when a process started (the data folder's lock, a running emulator)", darwin: ["/bin/ps"], linux: ["/bin/ps"] },
  { id: "xattr", why: "macOS: whether the data folder's disk makes ._ files (exFAT, FAT)", darwin: ["/usr/bin/xattr"] },
]);

// In an app, this file lies at <resources>/emulator/packages/engine/programs.mjs; the bundled Node at
// <resources>/node/bin/node (node.exe on Windows). In the source tree the path names nothing, and only the Node this
// runs on is allowed.
const RESOURCES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUNDLED_NODE = path.join(RESOURCES, "node", process.platform === "win32" ? "node.exe" : path.join("bin", "node"));

/** A program that is not in ALLOWED_PROGRAMS. `code` is "program_not_allowed". */
export class ProgramNotAllowed extends Error {
  constructor(file) {
    super(`${file} is not among the programs the emulator starts (ALLOWED_PROGRAMS in programs.mjs)`);
    this.name = "ProgramNotAllowed";
    this.code = "program_not_allowed";
    this.program = file;
  }
}

/**
 * The entry of ALLOWED_PROGRAMS that `file` is, or null.
 * @param {string} file
 * @param {object} [o]
 * @param {string} [o.platform]
 * @param {string[]} [o.nodes]       the Nodes that may start: the one this runs on and the one inside the app
 * @param {string[]} [o.windowsDirs] the Windows folders the system programs are taken from
 * @param {string} [o.resources]     the app's resources folder, where a bundled gh lies
 */
export function allowedProgram(file, { platform = process.platform, nodes = [process.execPath, BUNDLED_NODE], windowsDirs = windowsFolders(), resources = RESOURCES } = {}) {
  if (typeof file !== "string" || !file) return null;
  const p = platform === "win32" ? path.win32 : path.posix;
  const fold = (text) => (platform === "win32" ? p.normalize(text).toLowerCase() : text);
  const named = !/[\\/]/.test(file);
  const absolute = !named && p.isAbsolute(file);
  for (const entry of ALLOWED_PROGRAMS) {
    if (entry.node && absolute && nodes.some((one) => one && fold(one) === fold(file))) return entry;
    if (named && entry.names?.includes(fold(file))) return entry;
    if (absolute && entry.bundled?.includes(fold(p.basename(file))) && fold(file).startsWith(fold(resources) + p.sep)) return entry;
    if (absolute && (entry[platform] ?? []).some((one) => fold(file) === fold(one))) return entry;
    if (absolute && platform === "win32" && (entry.windows ?? []).some((one) => windowsDirs.some((dir) => fold(file) === fold(p.join(dir, one))))) return entry;
  }
  return null;
}

/** The Windows folders system programs may come from: the one the caller names (the system's), SystemRoot, windir. */
function windowsFolders(given = null) {
  return [given, process.env.SystemRoot, process.env.windir].filter((one) => typeof one === "string" && path.win32.isAbsolute(one));
}

function allowed(file, args, options, { unlisted = null, windowsDir = null, bundledNode = null } = {}) {
  if (options?.shell) throw new Error(`${file} would be started through a shell; the emulator passes arguments as a list`);
  const nodes = [process.execPath, BUNDLED_NODE, bundledNode];
  if (!unlisted && !allowedProgram(file, { nodes, windowsDirs: windowsFolders(windowsDir) })) throw new ProgramNotAllowed(file);
  return programCommand(file, args, options);
}

/**
 * spawn for a program of ALLOWED_PROGRAMS (see the list), found as findProgram finds it. `unlisted` names why a
 * program that is not in the list is started all the same: only the test variant's own launch of the app
 * (BUSY_EMULATOR_TEST_LAUNCH, which a release does not read) does so. `windowsDir`: the Windows folder the system
 * names. `bundledNode`: the Node inside the app as the project tools find it from the app's resources folder
 * (projects/node-tools.mjs, nodeToolsAt), for a command line that does not run on that Node itself.
 */
export function startProgram(file, args = [], options = {}, { unlisted = null, windowsDir = null, bundledNode = null } = {}) {
  const c = allowed(file, args, options, { unlisted, windowsDir, bundledNode });
  return spawn(c.file, c.args, c.options);
}

/** execFileSync for a program of ALLOWED_PROGRAMS; `windowsDir`: the Windows folder the system names. */
export function runProgram(file, args = [], options = {}, { windowsDir = null } = {}) {
  const c = allowed(file, args, options, { windowsDir });
  return execFileSync(c.file, c.args, c.options);
}

/** execFile for a program of ALLOWED_PROGRAMS: `done(error, stdout, stderr)`. */
export function runProgramLater(file, args, options, done) {
  let c;
  try {
    c = allowed(file, args, options);
  } catch (e) {
    queueMicrotask(() => done(e, "", ""));
    return null;
  }
  return execFile(c.file, c.args, c.options, done);
}
