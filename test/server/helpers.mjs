// What the server's tests share: temporary data folders, child processes, ports, plain HTTP requests and a small app
// to run.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { targz } from "../package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const serverDir = resolve(here, "../../packages/server");
export const serverModule = (name) => join(serverDir, name);

// What a test made outside itself, until it has put it away: folders and child processes. A test puts them away in
// its `after`; whatever is left when the file's tests are over or this process ends — a test that failed halfway, a
// server that went on writing after its test, a run that was stopped — is put away then (sweep), so that a red run
// leaves nothing behind either.
const folders = new Set();
const children = new Set();
// The children each test started (node below). A test's folders are removed only once they have ended: node:test runs
// a test's `after` hooks in the order they were added, a test makes a server's data folder before it starts the
// server, and the folder was removed while the server still wrote there (EMU-294, the gate of 13.11 on a loaded
// machine: cli.test.mjs, ENOTEMPTY on bar/1.3.1/ext with an app running).
const childrenOf = new WeakMap(); // test context -> Set of children
// A child that is still writing can make a folder again or keep a file in it open (Windows): try a few times.
const removeFolder = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
/**
 * Puts away what the tests of this process made and have not put away yet: when a file's tests are over (finish),
 * when the process ends by itself and when it is asked to stop.
 */
export function sweep() {
  for (const child of children) child.kill("SIGKILL");
  for (const dir of folders) {
    try {
      removeFolder(dir);
    } catch {
      // Nothing more can be done from here.
    }
  }
}
process.on("exit", sweep);

/**
 * For a test file, when its tests are over: `after(finish)`. Puts everything away, and if the process is then still
 * running a few seconds later — something of a server under test was left alive, and may go on writing to its data
 * folder — says what keeps it running, puts things away once more and ends the process as failed. The test runner
 * would end such a process too, later and with no time to tidy up.
 */
export function finish() {
  sweep();
  setTimeout(() => {
    sweep();
    console.error(`Still running 3 s after the tests of this file: ${JSON.stringify(process.getActiveResourcesInfo())}. A server under test left something behind.`);
    process.exit(1);
  }, 3000).unref();
}
// Stopped from outside: end the usual way, so that the above runs.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(signal, () => process.exit(1));

// A process that the test runner ends outright (a file that ran past its time limit) tidies nothing up. Its folders
// carry its process number, and whoever runs tests next takes away those whose process is gone.
const FOLDER = "busybar-emulator-test-";
const running = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
};
for (const name of readdirSync(tmpdir())) {
  const pid = name.startsWith(FOLDER) ? Number(name.slice(FOLDER.length).split("-")[0]) : NaN;
  if (!Number.isInteger(pid) || running(pid)) continue;
  try {
    removeFolder(join(tmpdir(), name));
  } catch {
    // Somebody else's, or in use: left alone.
  }
}

/** A data folder of its own for a server, gone when the test is over. */
export function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), `${FOLDER}${process.pid}-`));
  // It stays on the list: a child that outlives the test by a moment can make it again, and the end of the process
  // takes it away once more.
  folders.add(dir);
  t.after(async () => {
    for (const child of childrenOf.get(t) ?? []) {
      child.kill("SIGKILL");
      await child.exit;
    }
    removeFolder(dir);
  });
  return dir;
}

/**
 * A child process of a test: `node <args>`. It is ended when the test is over, however the test ends. Returns the
 * child with `exit`, a promise of its exit code (or the signal that ended it), and `exited(ms)`, the same but no
 * longer than `ms`: a child that is still running then is ended, and the wait fails.
 */
export function node(t, args, options = {}) {
  const child = spawn(process.execPath, args, options);
  children.add(child);
  if (!childrenOf.has(t)) childrenOf.set(t, new Set());
  childrenOf.get(t).add(child);
  child.exit = once(child, "exit").then(([code, signal]) => {
    children.delete(child);
    return code ?? signal;
  });
  child.exited = async (ms = 30000) => {
    let timer;
    const late = new Promise((resolve) => (timer = setTimeout(resolve, ms, "late")));
    const outcome = await Promise.race([child.exit, late]);
    clearTimeout(timer);
    if (outcome !== "late") return outcome;
    child.kill("SIGKILL");
    await child.exit;
    throw new Error(`the process was still running after ${ms} ms: node ${args.join(" ")}`);
  };
  t.after(async () => {
    child.kill("SIGKILL");
    await child.exit;
  });
  return child;
}

// By default a server under test takes a free port (port 0). Where only some ports may be used, EMU_TEST_PORTS names
// them, "8761-8769" or "8761,8763": the tests then take theirs from these, and must be run one file at a time
// (node --test --test-concurrency=1).
const allowed = (() => {
  const spec = process.env.EMU_TEST_PORTS;
  if (!spec) return null;
  return spec.split(",").flatMap((part) => {
    const [first, last = first] = part.split("-").map(Number);
    return Array.from({ length: last - first + 1 }, (_, i) => first + i);
  });
})();

/** The n-th port a test may use: 0 (any free one) unless EMU_TEST_PORTS limits the choice. */
export function port(n = 0) {
  if (!allowed) return 0;
  if (n >= allowed.length) throw new Error(`EMU_TEST_PORTS names ${allowed.length} ports, the test needs ${n + 1}`);
  return allowed[n];
}

/** A port to name before a server has it: port(n), or with a free choice one that was free a moment ago. */
export async function knownPort(n = 0) {
  if (allowed) return port(n);
  const probe = http.createServer();
  await new Promise((resolve, reject) => probe.once("error", reject).listen(0, "127.0.0.1", resolve));
  const taken = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  return taken;
}

/**
 * One HTTP request on a connection of its own, closed after the answer: nothing of the client is left to keep the
 * process or the server busy. Returns { status, headers, body: Buffer, text, json() }.
 */
export function request(method, url, body = null) {
  return new Promise((done, fail) => {
    const req = http.request(url, { method, agent: false, headers: { Connection: "close", ...(body ? { "Content-Length": body.length } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", fail);
      res.on("end", () => {
        const bytes = Buffer.concat(chunks);
        done({ status: res.statusCode, headers: res.headers, body: bytes, text: bytes.toString(), json: () => JSON.parse(bytes.toString()) });
      });
    });
    req.on("error", fail);
    req.end(body ?? undefined);
  });
}

export const get = (url) => request("GET", url);

/** Installs an app made of one script on the server at `base` and returns its id. */
export async function installApp(base, id, script, manifest = {}) {
  const files = {
    [`${id}/appmeta/manifest.json`]: JSON.stringify({ format_version: 1, id, name: id, version: "0.1.0", api_version: "27.0.0", ...manifest }),
    [`${id}/scripts/main.js`]: script,
  };
  const staged = await request("POST", `${base}/api/apps/stage`, targz(files));
  if (staged.status !== 200) throw new Error(`stage ${id}: ${staged.status} ${staged.text}`);
  const installed = await request("POST", `${base}/api/apps/install?install_key=${staged.json().install_key}`);
  if (installed.status !== 200) throw new Error(`install ${id}: ${installed.status} ${installed.text}`);
  return id;
}

/** Waits until check() gives something, at most `ms`. */
export async function until(what, check, ms = 10000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * What keeps, or could keep, this process's event loop busy, by kind: sockets, servers, timers and the rest, as
 * process.getActiveResourcesInfo() names them. Two readings that are equal mean nothing was left behind in between.
 */
export function activeResources() {
  const counts = {};
  for (const kind of process.getActiveResourcesInfo()) counts[kind] = (counts[kind] ?? 0) + 1;
  return counts;
}

/**
 * activeResources() once it equals `expected`, or what it is after `ms` if it never does. Node lets go of a closed
 * socket a turn of the event loop after it was closed, so a reading right after a stop can still count it.
 */
export async function activeResourcesSettled(expected, ms = 2000) {
  const same = (counts) => JSON.stringify(Object.entries(counts).sort()) === JSON.stringify(Object.entries(expected).sort());
  const end = Date.now() + ms;
  while (!same(activeResources()) && Date.now() < end) await new Promise((resolve) => setImmediate(resolve));
  return activeResources();
}

/**
 * activeResources() after what was closed just before has been let go of: a reading that has stayed the same for a
 * while. Node goes on naming a closed listening socket for a few turns of the event loop, longer on Windows.
 */
export async function activeResourcesAtRest(ms = 2000) {
  const text = () => JSON.stringify(Object.entries(activeResources()).sort());
  const end = Date.now() + ms;
  let last = text();
  for (let same = 0; same < 5 && Date.now() < end; ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const now = text();
    same = now === last ? same + 1 : 0;
    last = now;
  }
  return activeResources();
}
