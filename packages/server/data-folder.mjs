// The emulator's data folder (architecture.md, section 4): what the server keeps in it and how it makes sure that it
// is the only one using it.
//
//   format              the folder's format number, FORMAT below. The first line is the number; whatever follows is
//                       for later versions and is not read.
//   run/server.lock     taken by the server that uses the folder, for as long as it runs: who it is (process, the
//                       time it started, its executable) and where it listens. The app's mirror for the command line,
//                       run/emulator.json, is the app's (EMU-202) and lies beside it.
//   key                 the server's key (ADR-0012; made by EMU-009 with privateFile below)
//   bar/<firmware>/ext  the emulated bar's storage, one bar for each firmware: installed apps, their data, settings
//
// What the server makes here, it makes for the user alone (0700 folders, 0600 files; on Windows rights come from the
// folder above, and %LOCALAPPDATA% is the user's alone) and never through a link: a link where the server would make
// a folder or a file is an error, not a way somewhere else. The data folder itself may be reached through links (a
// home on another disk, /tmp on macOS): that is the user's choice of where it lies.
//
// A folder that is of a newer format than FORMAT, or whose format record cannot be read, is left exactly as it is: not
// a file is made in it. A folder of an older format is moved to this one (EMU-219) by the steps in MIGRATIONS, one
// format at a time, under the folder's lock and before anything else uses it; the format record is written after each
// step. A folder that cannot be moved (no step for its format, or a step failed) is set aside, not deleted: what the
// emulator keeps there goes to set-aside/format-<n>-<time>/ and the folder starts anew, and the server's notices say
// what was set aside, where and why. The only layout older than the format number, the bar's storage (ext) at the top,
// is refused as before (test/convert-data-folder.mjs moves it).
import { randomBytes } from "node:crypto";
import { accessSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { createServer, connect } from "node:net";
import path, { dirname, join } from "node:path";

import { processInfo } from "./process-info.mjs";

export const FORMAT = 1;
export const LOCK_FILE = join("run", "server.lock");

/**
 * The steps that move a data folder from one format to the next: MIGRATIONS[n] moves format n to n + 1. A step is
 * { what, run({ root, firmware }) }: `what` is one line for the person ("the bar's settings moved to ..."), `run` does
 * it (it may be async) and throws when it cannot. A step must be safe to run again on a folder it already half moved:
 * the record says n until the step has ended. The first format is 1, so there is no step yet; a release that changes
 * what the folder holds adds one here and raises FORMAT (docs/release.md, "Hotfix during the hackathon").
 */
export const MIGRATIONS = Object.freeze({});

/** What a folder that cannot be moved keeps in place when the rest is set aside: the lock, the app's own files, the log. */
const KEPT_WHEN_SET_ASIDE = new Set(["run", "set-aside", "logs", "shell", "install.json", "app-settings.json"]);

const windows = process.platform === "win32";
// Not on Windows, where a file is never opened through a link it did not ask for: O_CREAT | O_EXCL fails on a link
// there too, and links need a privilege to make.
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
// How long a lock that cannot be read yet is taken to be still being written, and a clearing to be under way.
const WRITING_MS = 5000;
// How far the start of a process, as the system tells it, may be from the start the lock records: `ps` gives whole
// seconds, and the two are measured differently.
const STARTED_WITHIN_MS = 2000;

const ownUid = typeof process.getuid === "function" ? process.getuid() : null;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function folderError(root, why, cause) {
  return Object.assign(new Error(`The data folder ${root} cannot be used: ${why}. Name another folder, or put this one right.`, { cause }), { code: "EMU_DATA_FOLDER" });
}
function formatError(message, cause) {
  return Object.assign(new Error(message, { cause }), { code: "EMU_DATA_FORMAT" });
}
function inUseError(message, owner) {
  return Object.assign(new Error(message), { code: "EMU_DATA_IN_USE", owner });
}

const exists = (file) => {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Makes `folder` (whose parent is there) for the user alone, or checks the one that is there: a folder of its own, not
 * a link, this user's. True when it was made now.
 */
function ownFolder(folder, root) {
  let cause;
  try {
    mkdirSync(folder, { mode: 0o700 });
    return true;
  } catch (e) {
    if (e?.code !== "EEXIST") throw systemFolderError(root, e);
    cause = e;
  }
  const stat = lstatSync(folder);
  if (stat.isSymbolicLink()) throw folderError(root, `${folder} is a link, and the emulator makes its folders itself rather than follow one`, cause);
  if (!stat.isDirectory()) throw folderError(root, "a file stands where one of its folders should be", cause);
  if (ownUid !== null && stat.uid !== ownUid) throw folderError(root, `${folder} belongs to another user`, cause);
  return false;
}

function systemFolderError(root, e) {
  if (e?.code === "ENOTDIR" || e?.code === "EEXIST") return folderError(root, "a file stands where one of its folders should be", e);
  if (e?.code === "EACCES" || e?.code === "EPERM" || e?.code === "EROFS") return folderError(root, "this user may not make folders there", e);
  return folderError(root, e?.message ?? String(e), e);
}

/** The data folder itself: made for the user alone if it is not there (the folders above it as the system makes them). */
function makeRoot(root) {
  let cause;
  try {
    mkdirSync(dirname(root), { recursive: true });
  } catch (e) {
    throw systemFolderError(root, e);
  }
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (e) {
    if (e?.code !== "EEXIST") throw systemFolderError(root, e);
    cause = e;
  }
  let stat;
  try {
    // The folder may be reached through a link: the user's choice.
    stat = statSync(root);
  } catch (e) {
    throw systemFolderError(root, e);
  }
  if (!stat.isDirectory()) throw folderError(root, "a file stands where one of its folders should be", cause);
  if (ownUid !== null && stat.uid !== ownUid) throw folderError(root, "it belongs to another user", cause);
  try {
    accessSync(root, constants.W_OK);
  } catch (e) {
    throw folderError(root, `this user may not write to ${root}`, e);
  }
}

/** Reads a small file that must be a file of its own, not a link. Null when it is not there. */
function readOwnFile(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  try {
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error(`${file} is not a file`), { code: "EISDIR" });
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * The folder's format: a number, null when there is no record. A record that is a link, a folder or text that does
 * not begin with a whole number refuses the folder.
 */
function readFormat(root) {
  const file = join(root, "format");
  if (exists(file) && lstatSync(file).isSymbolicLink()) throw formatError(`The data folder ${root} cannot be used: its format record ${file} is a link. It is left as it is. Name another folder, or put this one right.`);
  let text;
  try {
    text = readOwnFile(file);
  } catch (e) {
    throw formatError(`The data folder ${root} cannot be used: its format record ${file} cannot be read (${e?.code ?? e?.message ?? e}). It is left as it is. Name another folder, or put this one right.`, e);
  }
  if (text === null) return null;
  const first = text.split(/\r?\n/, 1)[0].trim();
  if (!/^\d{1,9}$/.test(first) || Number(first) < 1) {
    throw formatError(`The data folder ${root} cannot be used: its format record ${file} does not name a format (${JSON.stringify(first.slice(0, 40))}). It is left as it is. Name another folder, or put this one right.`);
  }
  return Number(first);
}

/**
 * Sets a file just made to 0600 and says whether it is so now. exFAT and FAT on macOS show every file as 0700 whatever
 * is asked (and with "noowners" every user of the computer as its owner); such a volume does not keep the rights.
 * Windows has none of these rights: the folder above gives them.
 */
function keepsRights(fd) {
  if (windows) return true;
  try {
    fchmodSync(fd, 0o600);
  } catch {
    return false;
  }
  return (fstatSync(fd).mode & 0o777) === 0o600;
}

/**
 * Writes a file for the user alone (0600), whole: into a new file of a random name — made anew, never through a link
 * or a file someone left there — then renamed to its name. Returns whether the file system kept the rights (exFAT,
 * FAT and network shares on macOS may not; Windows has no such rights and takes the folder's).
 */
/**
 * Moves a file into its place. On Windows a file in the way that an antivirus, the indexer or OneDrive has open for a
 * moment (a key left by a server that was ended) is waited for, as the rest of the server does (tar.mjs, retrying;
 * not imported here: the command line carries this file with a short list of others). Ten tries over 2.25 s.
 */
export function renameWhole(from, to, rename = renameSync) {
  for (let attempt = 1; ; attempt++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (!(process.platform === "win32" && ["EPERM", "EBUSY", "EACCES"].includes(e?.code)) || attempt === 10) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50 * attempt);
    }
  }
}

export function privateFile(file, content) {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  let fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
  let kept;
  try {
    writeSync(fd, content);
    kept = keepsRights(fd);
    closeSync(fd);
    fd = null;
    renameWhole(temporary, file);
  } catch (e) {
    if (fd !== null) closeSync(fd);
    rmSync(temporary, { force: true });
    throw e;
  }
  return kept;
}

// ------------------------------------------------------------------------------------------------ who holds a lock

// processInfo: when a process started and its command (process-info.mjs, one place for this and the command line).
export { processInfo };

// On Windows the owner of a lock proves that it runs by a named pipe that carries the lock's nonce: the system removes
// a pipe when the process that holds it ends, however it ends, so a pipe that answers is the owner itself and a number
// given again to another program does not matter. (The app ends the server on Windows by terminating it, so there a
// lock is left behind every time.)
const pipeOf = (nonce) => `\\\\.\\pipe\\busy-emulator-server-${nonce}`;

function holdPipe(nonce) {
  return new Promise((resolve, reject) => {
    const pipe = createServer((socket) => socket.destroy());
    pipe.once("error", reject);
    pipe.listen(pipeOf(nonce), () => {
      pipe.off("error", reject);
      pipe.unref();
      resolve(pipe);
    });
  });
}

/** "live" when the owner's pipe answers, "stale" when there is no such pipe, "unknown" otherwise. */
function pipeState(nonce) {
  return new Promise((resolve) => {
    const socket = connect(pipeOf(nonce));
    const timer = setTimeout(() => (socket.destroy(), resolve("unknown")), 5000);
    socket.once("connect", () => (clearTimeout(timer), socket.destroy(), resolve("live")));
    socket.once("error", (e) => (clearTimeout(timer), resolve(e?.code === "ENOENT" ? "stale" : "unknown")));
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Another user's process, or a sandbox that hides processes: it is there.
    return e?.code === "EPERM";
  }
}

const exeName = (file) => path.win32.basename(path.posix.basename(String(file))).replace(/\.exe$/i, "").toLowerCase();

// The locks this process holds, by file → { nonce, pipe }: a second server of the same process asking for one is told
// it is in use, and whatever is still held when the process ends is let go of then.
const held = new Map();
let exitHandler = false;
function letGoAtExit() {
  if (exitHandler) return;
  exitHandler = true;
  process.on("exit", () => {
    for (const [file, { nonce }] of held) {
      try {
        if (JSON.parse(readOwnFile(file) ?? "null")?.nonce === nonce) unlinkSync(file);
      } catch {
        // Nothing more can be done while the process ends; the next server finds the lock stale.
      }
    }
  });
}

/**
 * Whether the lock's owner runs: "live", "stale" (the process is gone, or its number now belongs to another
 * program) or "unknown" (it runs, and it cannot be told whether it is the owner). A process number alone is not
 * trusted: the system gives a number again after the process with it ended. On Windows the owner's pipe must answer.
 * Elsewhere `ps` is compared with `ps`: the lock keeps what `ps` said of the owner when it took the lock, and the
 * process with that number now must have started at that same second. Another start means another process; the same
 * start under another command (process.title set since) is not proof either way, so the folder stays busy. A lock
 * without `ps`'s word (`ps` did not answer then) falls back on the start the owner worked out itself, within a few
 * seconds.
 */
async function ownerState(owner, info) {
  // This process: by the nonce, not the path, which another server may have named through a link.
  if (owner.pid === process.pid) return [...held.values()].some((mine) => mine.nonce === owner.nonce) ? "live" : "stale";
  if (!alive(owner.pid)) return "stale";
  // (A test that describes processes itself is asked on Windows too.)
  if (windows && info === processInfo) return pipeState(owner.nonce);
  const described = await info(owner.pid);
  if (!described) return "unknown";
  if (owner.ps && Number.isFinite(owner.ps.start)) {
    if (described.start !== owner.ps.start) return "stale";
    return described.exe === owner.ps.exe ? "live" : "unknown";
  }
  if (Math.abs(described.start - owner.started) > STARTED_WITHIN_MS) return "stale";
  if (owner.exe && described.exe && exeName(owner.exe) !== exeName(described.exe)) return "unknown";
  return "live";
}

function readLock(file) {
  const text = readOwnFile(file);
  if (text === null) return { missing: true };
  try {
    const owner = JSON.parse(text);
    if (Number.isInteger(owner?.pid) && owner.pid > 0 && Number.isFinite(owner.started) && /^[0-9a-f]{24}$/.test(owner.nonce)) return { owner, text };
  } catch {
    // Not whole: being written, or left half-written by a process that ended.
  }
  return { unreadable: true, text };
}

const ageOf = (file) => {
  try {
    return Date.now() - lstatSync(file).mtimeMs;
  } catch {
    return Infinity;
  }
};
// Being written, or being cleared, right now: made within the last few seconds. A time ahead of the clock by more than
// a moment (the clock was set back since) is not "now": such a file is old, or the folder would stay busy until the
// clock caught up with it.
const recent = (file) => {
  const age = ageOf(file);
  return age > -2000 && age < WRITING_MS;
};

function describeOwner(owner) {
  const where = owner.port ? `, port ${owner.port}` : "";
  const since = owner.since ? `, since ${owner.since}` : "";
  return `process ${owner.pid}${where}${since}`;
}

/** The kind of thing at `file`: "missing", "file" or "other" (a link, a folder). */
function kindAt(file) {
  try {
    const stat = lstatSync(file);
    return stat.isFile() ? "file" : "other";
  } catch (e) {
    if (e?.code === "ENOENT") return "missing";
    throw e;
  }
}

/**
 * Takes the lock for this process, or says who has it. A lock whose owner is gone is cleared — by one server at a time:
 * the one that makes the clearing mark (run/server.lock.clearing) reads the lock again, and only if it is still the
 * same removes it.
 */
async function takeLock(root, record, { notices, signal, processInfo: info }) {
  const file = join(root, LOCK_FILE);
  const clearing = `${file}.clearing`;
  const nonce = randomBytes(12).toString("hex");
  const text = JSON.stringify({ ...record, nonce }, null, 2) + "\n";
  const deadline = Date.now() + 10_000;
  // The proof that this process runs, before the lock names it.
  const pipe = windows ? await holdPipe(nonce) : null;
  try {
    for (;;) {
      signal?.throwIfAborted();
      let fd = null;
      try {
        fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      } catch (e) {
        if (e?.code !== "EEXIST") throw folderError(root, `the lock ${file} cannot be made (${e?.code ?? e?.message ?? e})`, e);
      }
      if (fd !== null) {
        let kept;
        try {
          writeSync(fd, text);
          kept = keepsRights(fd);
        } finally {
          closeSync(fd);
        }
        held.set(file, { nonce, pipe });
        letGoAtExit();
        return { file, nonce, rightsKept: kept };
      }

      const kind = kindAt(file);
      if (kind === "missing") continue; // let go of a moment ago
      if (kind === "other") throw folderError(root, `${file} is not a file the emulator made (a link or a folder stands there); delete it`);
      const read = readLock(file);
      if (read.missing) continue;
      let state;
      if (read.unreadable) state = recent(file) ? "writing" : "stale";
      else state = await ownerState(read.owner, info);
      if (state === "live") {
        throw inUseError(`The data folder ${root} is in use by another emulator (${describeOwner(read.owner)}). Stop that one, or name another data folder.`, read.owner);
      }
      if (state === "unknown") {
        throw inUseError(
          `The data folder ${root} is in use by process ${read.owner.pid}, which may be another emulator: the system would not say what it is. ` +
            `Stop it; if no emulator uses this folder, delete ${file}.`,
          read.owner,
        );
      }
      if (Date.now() > deadline) {
        throw inUseError(`The data folder ${root} is being taken by another emulator that is starting. Wait for it and stop it, or name another data folder.`, read.owner ?? null);
      }
      if (state === "writing") {
        await pause(100);
        continue;
      }

      // Stale: cleared by whoever makes the clearing mark.
      let mark = null;
      try {
        mark = openSync(clearing, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, 0o600);
      } catch (e) {
        if (e?.code !== "EEXIST") throw folderError(root, `the lock ${file} cannot be cleared (${e?.code ?? e?.message ?? e})`, e);
        // Somebody is clearing it, or a server ended while clearing it, long ago.
        if (kindAt(clearing) === "other") throw folderError(root, `${clearing} is not a file the emulator made (a link or a folder stands there); delete it`);
        if (!recent(clearing)) rmSync(clearing, { force: true });
        else await pause(100);
        continue;
      }
      try {
        closeSync(mark);
        mark = null;
        if (readOwnFile(file) === read.text) {
          unlinkSync(file);
          notices.push(
            read.owner
              ? `The data folder's lock was left by an emulator that is no longer running (${describeOwner(read.owner)}); it is cleared.`
              : "The data folder's lock was left half-written by an emulator that is no longer running; it is cleared.",
          );
        }
      } finally {
        if (mark !== null) closeSync(mark);
        rmSync(clearing, { force: true });
      }
    }
  } catch (e) {
    pipe?.close();
    throw e;
  }
}

function releaseLock(lock) {
  const mine = held.get(lock.file);
  if (mine?.nonce !== lock.nonce) return;
  held.delete(lock.file);
  try {
    if (JSON.parse(readOwnFile(lock.file) ?? "null")?.nonce === lock.nonce) unlinkSync(lock.file);
  } catch {
    // Gone already, or cannot be removed: the next server finds it stale.
  }
  // After the file: while the file names this process, the pipe says that it runs.
  mine.pipe?.close();
}

// ------------------------------------------------------------------------------------------------------ the folder

/**
 * The bar's storage for one firmware, bar/<firmware>: its /ext and the folders an empty /ext has, made if they are not
 * there, and writable.
 */
function prepareBar(root, firmware) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(firmware) || firmware.includes("..")) throw new TypeError(`Not a firmware name for a folder: ${firmware}`);
  const bars = join(root, "bar");
  const bar = join(bars, firmware);
  const ext = join(bar, "ext");
  ownFolder(bars, root);
  ownFolder(bar, root);
  ownFolder(ext, root);
  const apps = join(ext, "user_assets");
  try {
    mkdirSync(apps, { recursive: true });
  } catch (e) {
    throw systemFolderError(root, e);
  }
  for (const folder of [ext, apps]) {
    try {
      accessSync(folder, constants.W_OK);
    } catch (e) {
      throw folderError(root, `this user may not write to ${folder}`, e);
    }
  }
  return bar;
}

/**
 * Moves a folder of format `from` to `to`, one step at a time, writing the record after each. A format without a step,
 * or a step that fails, sets the folder aside (setAside) and writes `to` on the empty folder.
 * @returns {{ from: number, to: number, setAside: string | null }}
 */
async function migrate(root, { from, to, migrations, firmware, notices }) {
  const done = [];
  for (let n = from; n < to; n++) {
    const step = migrations[n];
    let why = null;
    if (!step || typeof step.run !== "function") why = `this emulator has no way to move format ${n}`;
    else {
      try {
        await step.run({ root, firmware });
      } catch (e) {
        why = `moving format ${n} to ${n + 1} failed: ${e?.message ?? e}`;
      }
    }
    if (why) {
      const aside = setAside(root, n);
      privateFile(join(root, "format"), `${to}\n`);
      notices.push(
        `The data folder ${root} was of format ${from}, made by an earlier emulator, and could not be moved to format ${to} (${why}). ` +
          `What it held is set aside, untouched, in ${aside}; the emulator starts with an empty BUSY Bar and no projects.`,
      );
      return { from, to, setAside: aside };
    }
    privateFile(join(root, "format"), `${n + 1}\n`);
    if (step.what) done.push(step.what);
  }
  notices.push(`The data folder, made by an earlier emulator, is moved from format ${from} to ${to}${done.length ? `: ${done.join("; ")}` : ""}.`);
  return { from, to, setAside: null };
}

/** Moves what the emulator keeps in the folder, but for KEPT_WHEN_SET_ASIDE, to set-aside/format-<n>-<time>/. */
function setAside(root, n) {
  const parent = join(root, "set-aside");
  ownFolder(parent, root);
  const aside = join(parent, `format-${n}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(aside, { mode: 0o700 });
  for (const name of readdirSync(root)) {
    if (KEPT_WHEN_SET_ASIDE.has(name)) continue;
    try {
      renameSync(join(root, name), join(aside, name));
    } catch (e) {
      throw formatError(`The data folder ${root} could not be set aside: ${join(root, name)} cannot be moved to ${aside} (${e?.code ?? e?.message ?? e}). Quit what uses it and start the emulator again.`, e);
    }
  }
  return aside;
}

/**
 * Opens a data folder for a server: checks its format (and leaves it exactly as it is if it cannot be used), takes its
 * lock, records the format in a new folder or moves an older one to it, and makes the bar's storage for the firmware
 * ready.
 *
 * @param {string} root the data folder, resolved
 * @param {object} o
 * @param {string} o.firmware the firmware's name: the bar is bar/<firmware>
 * @param {object} o.record what the lock says about the server besides the process: { port, url, firmware, apiVersion }
 * @param {AbortSignal} [o.signal]
 * @param {(pid: number) => Promise<{ start: number, exe: string } | null>} [o.processInfo] for tests: how the system
 *   describes a process. By default `ps` on macOS and Linux; on Windows the owner's pipe is asked instead, unless a
 *   test gives its own.
 * @param {number} [o.format] for tests: the format this emulator makes (FORMAT)
 * @param {object} [o.migrations] for tests: the steps between formats (MIGRATIONS)
 * @returns {Promise<{ root: string, barDir: string, format: number, created: boolean, migrated: object | null,
 *   lockFile: string, rightsKept: boolean, notices: string[], release: () => void }>} `created`: the folder had no
 *   format record and has one now — a new folder. `migrated`: { from, to, setAside } when it was of an older format;
 *   setAside names where its contents went when they could not be moved, null when they were. `rightsKept`: false where the file system does not keep the user-alone rights the files
 *   were made with. `notices`: what a person should hear about the folder (a lock cleared, rights not kept), a line
 *   each. release() lets go of the lock; calling it again does nothing.
 */
export async function openDataFolder(root, { firmware, record = {}, signal, processInfo: info = processInfo, format: target = FORMAT, migrations = MIGRATIONS }) {
  makeRoot(root);
  const format = readFormat(root);
  if (format === null) {
    const ext = join(root, "ext");
    if (exists(ext) && lstatSync(ext).isDirectory()) {
      throw formatError(
        `The data folder ${root} has the layout of an earlier emulator, without a format record: the BUSY Bar's storage, ext, is at its top. ` +
          `This emulator does not move it, and leaves it as it is. Move ${ext} to ${join(root, "bar", firmware, "ext")}, or name another folder.`,
      );
    }
  } else if (format > target) {
    throw formatError(
      `The data folder ${root} is of format ${format}: a newer emulator made it, and this one knows format ${target} at most. ` +
        "It is left as it is. Use the newer emulator with it, or name another data folder.",
    );
  }
  // Format `target`, an older one (moved below, under the lock), or a new folder.

  ownFolder(join(root, "run"), root);
  const notices = [];
  const started = Math.round(Date.now() - process.uptime() * 1000);
  // What `ps` says of this process now is what the next server compares `ps` with (ownerState). Not on Windows, where
  // the pipe is the proof.
  const self = windows && info === processInfo ? null : await info(process.pid);
  const owner = { pid: process.pid, started, exe: process.execPath, ...(self ? { ps: { start: self.start, exe: self.exe } } : {}) };
  const lock = await takeLock(root, { ...owner, since: new Date().toISOString(), ...record }, { notices, signal, processInfo: info });
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    releaseLock(lock);
  };
  try {
    let rightsKept = lock.rightsKept;
    let migrated = null;
    if (format === null) rightsKept = privateFile(join(root, "format"), `${target}\n`) && rightsKept;
    else if (format < target) migrated = await migrate(root, { from: format, to: target, migrations, firmware, notices });
    const barDir = prepareBar(root, firmware);
    if (!rightsKept) {
      notices.push(`The file system of ${root} does not keep file rights: other users of this computer may read the emulator's files there. Keep the data folder on the system disk.`);
    }
    return { root, barDir, format: target, created: format === null, migrated, lockFile: lock.file, rightsKept, notices, release };
  } catch (e) {
    release();
    throw e;
  }
}
