// The JSON files several processes write at once (audit C4): the list of projects (projects/registry.mjs), the trusted
// folders (projects/trust.mjs). The command line from an agent's MCP, the window, the shell and other agents write
// them side by side, so a change is read, merged and written under a lock, and a file is replaced in one step:
//
// - the lock is `<file>.lock`, made with O_EXCL ("wx"): one process at a time. It holds the owner's PID and when it was
//   taken. A lock is stale, and taken away, when its owner is gone, when it is older than LOCK_STALE_MS (every change
//   is a few milliseconds; a PID given again to another program does not hold it for ever), or when it holds no
//   whole record: empty, not JSON, or a PID of 0 or 1 (process.kill(0, 0) signals the caller's own process group and
//   succeeds, so such a lock would read as live for ever). An empty or broken lock younger than LOCK_GRACE_MS may be
//   one another process has just made and not yet written: it is not stale yet.
// - the file is written to `<file>.<pid>.<n>.tmp` and renamed over the old one: a reader sees the old file or the new
//   one, never part of one.
// - a file that is not JSON, or not of the shape its owner expects, is never written over: it is moved aside to
//   `<file>.corrupt-<time>` and reported, and the change starts from the empty value.
//
// Synchronous, as the callers are: a lock is held for a read and a write of a small file.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import path from "node:path";

/** A lock older than this is stale whatever its PID says. */
export const LOCK_STALE_MS = 30_000;
/** An empty or broken lock younger than this may be one being written. */
export const LOCK_GRACE_MS = 2_000;
/** How long a change waits for the lock before it gives up. */
export const LOCK_WAIT_MS = 15_000;

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Windows refuses to rename over or delete a file another process has open for a moment (a reader, an antivirus). */
const busy = (e) => e?.code === "EPERM" || e?.code === "EBUSY" || e?.code === "EACCES";
function retrying(action) {
  for (let attempt = 1; ; attempt++) {
    try {
      return action();
    } catch (e) {
      if (!busy(e) || attempt === 20) throw e;
      sleep(10 * attempt);
    }
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM"; // there, and another user's
  }
}

/**
 * Whether a lock is stale: its text (what the owner wrote), its age, and `isAlive(pid)`. Exported for the tests.
 */
export function lockIsStale(text, { ageMs, isAlive = alive, graceMs = LOCK_GRACE_MS, staleMs = LOCK_STALE_MS }) {
  if (ageMs >= staleMs) return true;
  let pid = NaN;
  try {
    pid = JSON.parse(text)?.pid;
  } catch {
    // broken, or not written yet
  }
  if (!Number.isSafeInteger(pid) || pid <= 1) return ageMs >= graceMs;
  return pid !== process.pid && !isAlive(pid);
}

let count = 0;

/** Takes `<file>.lock`; returns the function that gives it back. Throws (code ELOCKED) after `waitMs`. */
export function lockFile(file, { waitMs = LOCK_WAIT_MS } = {}) {
  const lock = `${file}.lock`;
  const nonce = `${process.pid}-${Date.now()}-${++count}-${Math.random().toString(36).slice(2)}`;
  const record = JSON.stringify({ pid: process.pid, at: new Date().toISOString(), nonce });
  const deadline = Date.now() + waitMs;
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 1; ; attempt++) {
    let fd = null;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (e) {
      if (e?.code !== "EEXIST" && !busy(e)) throw e;
    }
    if (fd !== null) {
      try {
        writeSync(fd, record);
      } finally {
        closeSync(fd);
      }
      return () => {
        // Only our own lock is removed: one taken away from us as stale is another's now.
        try {
          if (readFileSync(lock, "utf8") === record) retrying(() => rmSync(lock, { force: true }));
        } catch {
          // gone already
        }
      };
    }
    try {
      const text = readFileSync(lock, "utf8");
      const ageMs = Date.now() - statSync(lock).mtimeMs;
      // Read again just before: the lock is removed only when it is still the stale one that was looked at.
      if (lockIsStale(text, { ageMs }) && readFileSync(lock, "utf8") === text) retrying(() => rmSync(lock, { force: true }));
    } catch {
      // the owner has just given it back: try again at once
    }
    if (Date.now() > deadline) throw Object.assign(new Error(`${lock} is held by another process for more than ${Math.round(waitMs / 1000)} s`), { code: "ELOCKED", lock });
    sleep(Math.min(50, 2 + attempt * 3 + Math.random() * 5));
  }
}

/** The file's name for a broken copy: the time without characters Windows refuses in a name. */
const asideName = (file, now) => `${file}.corrupt-${new Date(now).toISOString().replace(/[:.]/g, "-")}`;

/**
 * Reads a JSON file. `{ value, missing: true }` when there is none, `{ value, corrupt: "why" }` when it is not JSON or
 * `check(value)` refuses its shape (value is then `fallback()`), `{ value }` otherwise. Changes nothing on the disk.
 */
export function readJsonFile(file, { fallback = () => null, check = () => true } = {}) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT") return { value: fallback(), missing: true };
    throw e;
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { value: fallback(), corrupt: `it is not JSON (${String(e?.message ?? e).split("\n")[0]})` };
  }
  if (!check(value)) return { value: fallback(), corrupt: "it is JSON, but not of the shape the emulator writes" };
  return { value };
}

/** Moves a broken file aside, so that nothing writes over it. Returns where it went. */
export function setAside(file, now = Date.now()) {
  let aside = asideName(file, now);
  for (let n = 2; ; n++) {
    try {
      statSync(aside);
      aside = `${asideName(file, now)}-${n}`;
    } catch {
      break;
    }
  }
  retrying(() => renameSync(file, aside));
  return aside;
}

/** Writes `text` to `file` in one step: a temporary file beside it, then a rename over the old one. */
export function writeFileAtomic(file, text, { mode = 0o600 } = {}) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${++count}.tmp`;
  try {
    const fd = openSync(temporary, "wx", mode);
    try {
      writeSync(fd, text);
    } finally {
      closeSync(fd);
    }
    retrying(() => renameSync(temporary, file));
  } catch (e) {
    rmSync(temporary, { force: true });
    throw e;
  }
}

/**
 * Where a broken file is told about by default: one line on stderr (stdout carries the command line's answers). The
 * command line names its own writer of stderr (cli/console.mjs) with reportBrokenFilesTo, so that the line is written
 * as everything else it prints.
 */
let brokenFileLine = (line) => process.stderr.write(`${line}\n`);

/** Tells broken files, from now on, through `writeLine` (a line, without its new line); gives the writer before. */
export function reportBrokenFilesTo(writeLine) {
  const before = brokenFileLine;
  brokenFileLine = writeLine;
  return before;
}

const reportOnStderr = ({ file, aside, why }) => brokenFileLine(`busy-emulator: ${file} could not be read: ${why}. It is kept as ${aside}, and a new one is started.`);

/**
 * Changes a JSON file under its lock: reads it (a broken one is set aside and reported, and `fallback()` stands for
 * it), passes the value to `change`, writes what `change` returns (nothing when it returns undefined), and gives the
 * lock back. Returns what was written, or the value read when nothing was.
 * @param {string} file
 * @param {(value: any) => any} change
 * @param {{ fallback?: () => any, check?: (value: any) => boolean, print?: (value: any) => string, mode?: number,
 *   report?: (o: { file: string, aside: string, why: string }) => void, waitMs?: number }} [o]
 */
export function updateJsonFile(file, change, { fallback = () => null, check = () => true, print = (value) => `${JSON.stringify(value, null, 2)}\n`, mode = 0o600, report = reportOnStderr, waitMs } = {}) {
  const unlock = lockFile(file, { waitMs });
  try {
    const read = readJsonFile(file, { fallback, check });
    if (read.corrupt) report({ file, aside: setAside(file), why: read.corrupt });
    const next = change(read.value);
    if (next === undefined) return read.value;
    writeFileAtomic(file, print(next), { mode });
    return next;
  } finally {
    unlock();
  }
}
