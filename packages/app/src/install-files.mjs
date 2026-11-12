// The files the app writes outside itself so that a person or an agent finds its command line (ADR-0002, sections 7
// and 7a), and the mirror of its state the command line reads:
//
//   launcher   ~/.busy-emulator/bin/busy-emulator                  (macOS: a sh script with this copy's paths)
//              %LOCALAPPDATA%\busy-emulator\bin\busy-emulator.exe  (Windows: a copy of the app's own .exe, with
//              busy-emulator.launch beside it naming this copy's Node and command line)
//   pointer    <data folder>/install.json   { "app", "cli", "version" } — "cli" is the launcher
//   run state  <data folder>/run/emulator.json   { pid, exe, port, url, state, detail, since }
//
// The app rewrites the launcher and the pointer at every start, so both name the copy that started last. Every file is
// written whole or not at all: to a temporary name, then renamed over the old one. Nothing here knows about Electron.
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, constants, copyFileSync, fchmodSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";

/**
 * What the bundled Node must not get from the caller: the list of packages/server/cli/node-environment.mjs (the shell
 * imports nothing from other packages; a test keeps the two equal).
 */
export const NODE_ENVIRONMENT_UNSET = Object.freeze([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "NODE_USE_SYSTEM_CA",
  "NODE_USE_ENV_PROXY",
  "NODE_REPL_EXTERNAL_MODULE",
  "NODE_REPL_HISTORY",
  "NODE_ICU_DATA",
  "NODE_V8_COVERAGE",
  "NODE_DEBUG",
  "NODE_DEBUG_NATIVE",
  "NODE_PRESERVE_SYMLINKS",
  "NODE_PENDING_DEPRECATION",
  "NODE_REDIRECT_WARNINGS",
  "NODE_COMPILE_CACHE",
  "NODE_TEST_CONTEXT",
  "NODE_CHANNEL_FD",
  "NODE_CHANNEL_SERIALIZATION_MODE",
  "NODE_UNIQUE_ID",
  "NODE_SKIP_PLATFORM_CHECK",
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/** The name of the file beside the Windows launcher that says what it runs. */
export const WINDOWS_LAUNCH_FILE = "busy-emulator.launch";

/** A string as one word of a POSIX shell, whatever it holds. */
export function shellQuote(text) {
  return `'${String(text).replace(/'/g, `'\\''`)}'`;
}

/** The pointer file: exactly the three fields of ADR-0002, section 7. Readers skip fields they do not know. */
export function pointerContent({ appPath, launcher, version }) {
  return `${JSON.stringify({ app: appPath, cli: launcher, version }, null, 2)}\n`;
}

/** The macOS launcher: runs this copy's command line on this copy's Node, with no other program. */
export function macLauncherScript({ node, cli, launcher, appPath }) {
  return [
    "#!/bin/sh -p",
    "# The command line of BUSY Bar Emulator. The emulator writes this file every time it starts, so it runs the",
    "# copy that started last. Do not edit it: the next start writes it again. -p: no functions or ENV file from the",
    "# environment; Node starts without the variables that would change how it starts.",
    `node=${shellQuote(node)}`,
    `cli=${shellQuote(cli)}`,
    'if [ ! -x "$node" ] || [ ! -f "$cli" ]; then',
    `  echo ${shellQuote(`busy-emulator: BUSY Bar Emulator is no longer at ${appPath}. Open the emulator once and this command will find it again.`)} >&2`,
    "  exit 1",
    "fi",
    `exec /usr/bin/env ${NODE_ENVIRONMENT_UNSET.map((name) => `-u ${name}`).join(" ")} BUSY_EMULATOR_CLI_PATH=${shellQuote(launcher)} "$node" "$cli" "$@"`,
    "",
  ].join("\n");
}

/** What the Windows launcher reads beside itself: the Node to run and the script to give it, one per line. */
export function windowsLaunchContent({ node, cli }) {
  return `${node}\r\n${cli}\r\n`;
}

/**
 * Writes a file whole: to a temporary file of a random name, created anew (never through a link or a file someone
 * left there), then renamed over the old one; a link where the file was is replaced, not followed.
 */
function writeWhole(file, content, mode = 0o644) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  let fd = null;
  try {
    fd = openSync(temporary, "wx", mode);
    writeSync(fd, content);
    if (process.platform !== "win32") fchmodSync(fd, mode);
    closeSync(fd);
    fd = null;
    renameWithRetry(temporary, file);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
    throw e;
  }
}

/**
 * The launcher's folders (~/.busy-emulator and its bin) are the user's alone: made with 0700 and set to it if they
 * were there already, and refused if one is a link or belongs to someone else, since whoever can write there decides
 * what the command runs. On Windows %LOCALAPPDATA% is already the user's alone.
 */
function ownFolder(folder) {
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (process.platform === "win32") return;
  const stat = lstatSync(folder);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${folder} is not a folder of its own (a link or a file); the command line's launcher is not written there`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`${folder} belongs to another user; the command line's launcher is not written there`);
  chmodSync(folder, 0o700);
}

/**
 * The app's data folder is the user's alone (EMU-242): made with 0700, and one an older version made with the umask's
 * mode (775 under umask 002) set to 0700. Electron, the log and the server make folders inside it, each with the
 * umask's mode; this one above them is what keeps the trusted projects, the server's key and the logs from the other
 * accounts of the computer. A link or a folder of another user is left as it is (the server's data-folder.mjs refuses
 * to run there). Nothing to do on Windows: %LOCALAPPDATA% is the user's alone. Answers what it did: "made", "tightened",
 * "kept" or "not_own".
 */
export function ownDataFolder(folder, { platform = process.platform } = {}) {
  let made = false;
  try {
    lstatSync(folder);
  } catch {
    made = true;
  }
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  if (platform === "win32") return made ? "made" : "kept";
  const stat = lstatSync(folder);
  if (stat.isSymbolicLink() || !stat.isDirectory() || (typeof process.getuid === "function" && stat.uid !== process.getuid())) return "not_own";
  if ((stat.mode & 0o077) === 0) return made ? "made" : "kept";
  chmodSync(folder, stat.mode & 0o700);
  return made ? "made" : "tightened";
}

function launcherFolders(launcher) {
  const bin = path.dirname(launcher);
  ownFolder(path.dirname(bin));
  ownFolder(bin);
}

// Windows refuses to rename over a file that another process has open for a moment (the launcher reading its
// .launch file); a few tries are enough.
function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      if (i >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
}

function sameBytes(a, b) {
  try {
    if (statSync(a).size !== statSync(b).size) return false;
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

// The Windows launcher is an executable, and a running executable cannot be overwritten. It changes only with the
// app, so it is copied only when it differs; a copy that is running at that moment is moved aside first (Windows lets
// a running executable be renamed) and removed on a later start.
function placeWindowsLauncher(source, target) {
  mkdirSync(path.dirname(target), { recursive: true });
  const folder = path.dirname(target);
  for (const name of safeList(folder)) {
    if (!name.startsWith(`${path.basename(target)}.old-`)) continue;
    try {
      rmSync(path.join(folder, name), { force: true });
    } catch {
      // Still running; the next start removes it.
    }
  }
  if (sameBytes(source, target)) return;
  const temporary = `${target}.${randomBytes(8).toString("hex")}.tmp`;
  copyFileSync(source, temporary, constants.COPYFILE_EXCL);
  try {
    renameSync(temporary, target);
  } catch (e) {
    if (!["EPERM", "EACCES", "EBUSY"].includes(e?.code)) throw e;
    renameSync(target, `${target}.old-${process.pid}`);
    renameSync(temporary, target);
  }
}

function safeList(folder) {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/**
 * Writes the launcher, then the pointer that names it.
 * @param {object} files    config.installFiles
 * @param {object} o
 * @param {string} o.platform
 * @param {string} o.version  the app's version
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function writeInstallFiles(files, { platform, version }) {
  try {
    launcherFolders(files.launcher);
    if (platform === "win32") {
      placeWindowsLauncher(files.inAppLauncher, files.launcher);
      writeWhole(path.join(path.dirname(files.launcher), WINDOWS_LAUNCH_FILE), windowsLaunchContent(files));
    } else {
      writeWhole(files.launcher, macLauncherScript(files), 0o755);
    }
    writeWhole(files.pointer, pointerContent({ appPath: files.appPath, launcher: files.launcher, version }));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  }
}

/** The mirror of the app's state for the command line. Errors are the caller's to log; the app goes on without it. */
export function writeRunState(file, state) {
  writeWhole(file, `${JSON.stringify(state)}\n`);
}

export function removeRunState(file) {
  rmSync(file, { force: true });
}
