import { gzipSync } from "node:zlib";
// What the tests of the shell share: paths, ports, temporary folders, and the checks that nothing is left behind.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const SUPERVISOR = path.join(APP_DIR, "src", "supervisor.mjs");
export const FAKE_SERVER = path.join(APP_DIR, "test", "fixtures", "fake-server.mjs");
export const REAL_SERVER = path.join(APP_DIR, "..", "server", "server.mjs");
/**
 * True when the real server and the engine it runs on lie beside this package, as they do in the repository. In a
 * copy of this package alone the tests with the real server are skipped and the rest run on the stand-in.
 */
export const HAS_REAL_SERVER = existsSync(REAL_SERVER) && existsSync(path.join(APP_DIR, "..", "engine", "build"));
/** The Node the servers of the tests run on: the one that runs the tests. */
export const NODE = process.execPath;

/**
 * The ports the tests may use, all on 127.0.0.1. Tests run one file at a time. BUSY_APP_TEST_PORTS=<first>-<last>
 * moves them to another range of nine (for a machine where port ranges are shared out).
 */
export const PORTS = testPorts(process.env.BUSY_APP_TEST_PORTS);

function testPorts(range) {
  const [first, last] = (range || "8831-8839").split("-").map(Number);
  if (!Number.isInteger(first) || last !== first + 8) throw new Error(`BUSY_APP_TEST_PORTS must name nine ports, like 8831-8839: ${range}`);
  return Object.freeze({ app: first, second: first + 1, witness: first + 2, cli: first + 3, other: first + 4, unit: first + 5, udp: first + 8 });
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// What a test file started and made is ended and removed when its process ends, however it ends: a file that hangs is
// cut off by the time limit of the scripts (--test-timeout: the runner ends the file's process with SIGTERM) and must
// not leave an app, a server or a folder behind. The processes are the ones this process started itself, known by
// their ChildProcess, so a number given to another process since is never touched. A supervisor needs no entry: it
// ends by itself when the process that holds its standard input is gone. Windows ends a process without a signal it
// could answer; there the processes go with it (the job object Node keeps its children in), and the folders of a
// test process that is gone are removed by the next one that loads this file.
//
// The folders go only once what was ended has ended, it and every process below it (Chromium's helpers, the
// supervisor, the server): an app that quits writes into its data folder on its way out (Chromium's profile, the
// network service's cookies and cache), and a folder removed under a writer is left half there — rmSync meets a
// file that was not there when it looked (ENOTEMPTY), more often the busier the machine. The wait is on this
// process's way out, so it blocks; it ends when they have, or after CHROMIUM_GONE_WITHIN_MS.
const childrenToEnd = new Set();
const foldersToRemove = new Set();
let ending = false;
function endWhatWasStarted() {
  if (ending) return;
  ending = true;
  const ended = [];
  for (const child of childrenToEnd) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        // A terminate signal: the app quits as from its menu (its Chromium helpers with it, which a killed main
        // process can leave behind); on Windows it is the end of the process.
        const below = process.platform === "win32" ? [] : descendantsOf(child.pid);
        child.kill("SIGTERM");
        ended.push(child.pid, ...below);
      } catch {
        // Gone meanwhile.
      }
    }
  }
  if (ended.length) waitUntilGone(ended, CHROMIUM_GONE_WITHIN_MS);
  for (const folder of foldersToRemove) {
    try {
      rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A file still held (Windows); nothing more can be done on the way out.
    }
  }
}

/** macOS, Linux: every process below `pid`, by the system's list of parents (ps), read now. */
function descendantsOf(pid) {
  let table;
  try {
    table = execFileSync("/bin/ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const children = new Map();
  for (const line of table.trim().split("\n")) {
    const [one, parent] = line.trim().split(/\s+/).map(Number);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(one);
  }
  const found = [];
  for (let i = 0, next = [pid]; i < next.length; i++) for (const one of children.get(next[i]) ?? []) found.push(one), next.push(one);
  return found;
}

/**
 * Blocks until none of the processes runs any more, or `limitMs` passed. A process of this one's that has ended but
 * that nobody has reaped yet (its parent is on its way out, its event loop no longer runs) is a zombie: ended.
 */
function waitUntilGone(pids, limitMs) {
  const pause = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + limitMs;
  let left = pids;
  for (;;) {
    if (process.platform === "win32") left = left.filter(alive);
    else {
      let states = "";
      try {
        states = execFileSync("/bin/ps", ["-o", "pid=,stat=", "-p", left.join(",")], { encoding: "utf8" });
      } catch {
        // ps ends with 1 when none of them is there.
      }
      const running = new Set(states.trim().split("\n").filter((line) => line.trim() && !/^\s*\d+\s+Z/.test(line)).map((line) => Number(line.trim().split(/\s+/)[0])));
      left = left.filter((pid) => running.has(pid));
    }
    if (!left.length || Date.now() > deadline) return;
    Atomics.wait(pause, 0, 0, 100);
  }
}
process.on("exit", endWhatWasStarted);
for (const [signal, number] of [["SIGTERM", 15], ["SIGINT", 2], ["SIGHUP", 1]]) {
  process.on(signal, () => {
    endWhatWasStarted();
    process.exit(128 + number);
  });
}
const FOLDER_PREFIX = "busy-app-";
for (const name of readdirSync(os.tmpdir())) {
  const owner = Number(name.startsWith(FOLDER_PREFIX) && /^(\d+)-/.exec(name.slice(FOLDER_PREFIX.length))?.[1]);
  if (!owner || owner === process.pid || alive(owner)) continue;
  try {
    rmSync(path.join(os.tmpdir(), name), { recursive: true, force: true });
  } catch {
    // Still held; the next run tries again.
  }
}

/** Ends the child, if it still runs, when this process ends (a terminate signal). Returns the child. */
export function endOnExit(child) {
  childrenToEnd.add(child);
  child.once("exit", () => childrenToEnd.delete(child));
  return child;
}

/** A temporary folder, by the path the system gives (on macOS that path goes through a symbolic link). */
export function temporaryFolder() {
  // The name says which process made it, for the sweep above.
  const folder = mkdtempSync(path.join(os.tmpdir(), `${FOLDER_PREFIX}${process.pid}-`));
  foldersToRemove.add(folder);
  return folder;
}

/** Removes a folder; Windows may hold a file a moment after its process ended. */
export async function removeFolder(folder) {
  for (let i = 0; ; i++) {
    try {
      rmSync(folder, { recursive: true, force: true });
      foldersToRemove.delete(folder);
      return;
    } catch (e) {
      if (i >= 20) throw e;
      await sleep(250);
    }
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

/** Waits until fn() is truthy and returns that value; throws the description after the timeout. */
export async function until(fn, what, timeoutMs = 15_000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(stepMs);
  }
}

/**
 * How long a process may take to end before it counts as left behind. The wait stops as soon as all are gone, so the
 * limits cost nothing on a quiet machine.
 *
 * The shell's own processes — the supervisor, the server and what the server started — are stopped by the shell:
 * the gentle way takes milliseconds, the forced one comes after 5 s, so 7 s is already a failure of the stop.
 * Chromium's processes (the app's main process and its helpers) end by themselves; on a very busy machine a helper
 * has taken longer than 8 s, for a reason that was not found.
 */
export const OWN_GONE_WITHIN_MS = 7_000;
export const CHROMIUM_GONE_WITHIN_MS = 30_000;

/** Waits until none of the processes is alive; returns the ones that still are after the limit. */
export async function survivors(pids, timeoutMs = OWN_GONE_WITHIN_MS) {
  const deadline = Date.now() + timeoutMs;
  let left = pids.filter(alive);
  while (left.length && Date.now() < deadline) {
    await sleep(100);
    left = left.filter(alive);
  }
  return left;
}

/** True when something accepts connections on the port. */
export function listening(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

/** Takes a port the way another program would; close() gives it back. */
export function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.destroy());
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ close: () => new Promise((done) => server.close(done)) }));
  });
}

export const realPath = (target) => realpathSync(target);

/**
 * macOS: makes a read-only disk image with one empty app folder in it and mounts it inside `folder`.
 * Returns the mounted app's path and detach(), or null with the reason in `why` when the system would not make the
 * image there (it refuses on some volumes).
 */
export function mountReadOnlyImage(folder, appName) {
  const hdiutil = "/usr/bin/hdiutil";
  const image = path.join(folder, "image.dmg");
  const mount = path.join(folder, "mount");
  mkdirSync(path.join(folder, "content", appName), { recursive: true });
  try {
    execFileSync(hdiutil, ["create", "-quiet", "-srcfolder", path.join(folder, "content"), "-format", "UDRO", "-volname", "busy-app-test", image], { stdio: "pipe" });
    execFileSync(hdiutil, ["attach", "-quiet", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, image], { stdio: "pipe" });
  } catch (e) {
    return { app: null, why: `hdiutil could not make or mount a disk image in ${folder}: ${String(e.stderr ?? e.message).trim()}`, detach() {} };
  }
  return { app: path.join(mount, appName), why: null, detach: () => execFileSync(hdiutil, ["detach", "-quiet", "-force", mount]) };
}

/** What a process is, for the message of a failed check: its program and, for Chromium's helpers, its type. */
export function describeProcess(pid) {
  if (process.platform === "win32") return String(pid);
  try {
    const command = execFileSync("/bin/ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const type = [...command.matchAll(/--(?:type|utility-sub-type)=\S+/g)].map((m) => m[0]).join(" ");
    return `${pid} (${path.basename(command.split(" --")[0])}${type ? ` ${type}` : ""})`;
  } catch {
    return String(pid);
  }
}

// The same as test/package.mjs of the emulator: packages/app imports nothing from outside itself.
// A .tgz the way busy-cli packs an app: ustar entries for the directories and files.
export function targz(files) {
  const blocks = [];
  const header = (name, size, type) => {
    const h = Buffer.alloc(512);
    h.write(name, 0, 100);
    h.write(type === "5" ? "0000755\0" : "0000644\0", 100);
    h.write("0000000\0", 108);
    h.write("0000000\0", 116);
    h.write(size.toString(8).padStart(11, "0") + "\0", 124);
    h.write(Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0", 136);
    h.write("        ", 148);
    h.write(type, 156);
    h.write("ustar\0", 257);
    h.write("00", 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
    return h;
  };
  const dirs = new Set();
  for (const name of Object.keys(files)) {
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
  }
  for (const dir of [...dirs].sort()) blocks.push(header(dir, 0, "5"));
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text);
    blocks.push(header(name, data.length, "0"), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
