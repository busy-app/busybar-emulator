// What the command line does to the system: read the emulator's mirror, look at processes, knock on the bar's address,
// start the app, end it. Commands get these through an object, so that their tests can replace any of them.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { startProgram } from "../../engine/programs.mjs";
import { LOCK_FILE } from "../data-folder.mjs";
import { processInfoSync } from "../process-info.mjs";
import { sameRealPath } from "../same-path.mjs";
import { LOCAL_PORTS_PATH } from "../local-access.mjs";
import { TRUST_PATH } from "../projects/trust.mjs";
import { githubLogin, gitUserName } from "../projects/author.mjs";
import { runNodeTool } from "../projects/node-tools.mjs";
import { authorizationFor, readServerKey, removeServerKey } from "../server-key.mjs";

/** Codes the system gives when a sandbox forbids something; the command line names them (EMU-157). */
export const SANDBOX_CODES = new Set(["EPERM", "EACCES"]);

/**
 * The mirror the app keeps of its state (run/emulator.json).
 * @returns {{ state: object } | { missing: true } | { blocked: string } | { invalid: string }}
 */
export function readRunState(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return { missing: true };
    if (SANDBOX_CODES.has(e?.code)) return { blocked: e.code };
    return { invalid: e?.code ?? String(e) };
  }
  try {
    const state = JSON.parse(text);
    if (!Number.isInteger(state?.pid) || !Number.isInteger(state?.port)) return { invalid: "no pid or port" };
    return { state };
  } catch (e) {
    return { invalid: e.message };
  }
}

export function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Another user's process, or a sandbox that hides processes: it exists.
    return e?.code === "EPERM";
  }
}

/**
 * Asks the emulated bar's address whether it answers.
 * @returns {Promise<{ answering: true } | { answering: false, code: string } | { blocked: string }>}
 */
export function probe(port, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: "/api/status", timeout: timeoutMs, agent: false }, (response) => {
      response.resume();
      resolve({ answering: true });
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ answering: false, code: e?.code ?? String(e) })));
  });
}

/** The most a frame's answer may hold: the back frame is 6400 bytes, 8536 in base64. */
const SCREEN_ANSWER_LIMIT = 64 * 1024;

/**
 * One frame of the emulated bar's display as its API gives it: GET /api/screen?display=0|1, base64 of the frame.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function screen(port, display, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: `/api/screen?display=${display}`, timeout: timeoutMs, agent: false }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= SCREEN_ANSWER_LIMIT) return chunks.push(chunk);
        resolve({ failed: `an answer of more than ${SCREEN_ANSWER_LIMIT / 1024} KiB` });
        request.destroy();
      });
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("latin1") }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
  });
}

/**
 * Where the server that uses a data folder takes commands, and what lets a program in there (ADR-0012 section 3): the
 * port of its management address, from the lock it holds (run/server.lock, written before it answers anybody), and
 * its key, from the file `key`. Both are new at every start of the server, so they are read at every call. `barPort`
 * is the bar's port by the same lock: the caller compares it with the emulator it found.
 * @returns {{ port: number, barPort: number | null, key: string } | { missing: string } | { blocked: string }}
 */
export function readControl(dataDir) {
  const lock = path.join(dataDir, LOCK_FILE);
  let record;
  let key;
  try {
    record = JSON.parse(readFileSync(lock, "utf8"));
    key = readServerKey(dataDir);
  } catch (e) {
    if (SANDBOX_CODES.has(e?.code)) return { blocked: e.code };
    return { missing: e?.code === "ENOENT" || e?.code === "ENOTDIR" ? `there is no ${lock}` : `${lock} cannot be read (${e?.code ?? e?.message ?? e})` };
  }
  const port = record?.control?.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { missing: `${lock} names no management address` };
  if (key === null) return { missing: `there is no server's key in ${dataDir}` };
  return { port, barPort: Number.isInteger(record.port) ? record.port : null, key };
}

/**
 * One request to the management address about the ports of this computer apps may reach (server.mjs): GET lists
 * them, POST allows `localPort`, DELETE takes it back. It carries the server's key and no Origin, and goes to
 * 127.0.0.1 only.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function localPorts(port, key, method, localPort = null, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const target = localPort === null ? LOCAL_PORTS_PATH : `${LOCAL_PORTS_PATH}?port=${localPort}`;
    const request = http.request({ host: "127.0.0.1", port, path: target, method, timeout: timeoutMs, agent: false, headers: { Authorization: authorizationFor(key), Connection: "close" } }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
    request.end();
  });
}

/**
 * Asks the running emulator for a clip of its bar (POST /_emu/record on the management address, capture/record.mjs):
 * the request stays open while the take is recorded and encoded. `query` is the request's options as a string.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function recordClip(port, key, query, waitMs) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: `/_emu/record?${query}`, method: "POST", agent: false, headers: { Authorization: authorizationFor(key), Connection: "close", "Content-Length": 0 } }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.setTimeout(waitMs, () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
    request.end();
  });
}

/**
 * Stops the clip of the bar being recorded (POST /_emu/record/stop on the management address): its take ends now.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function stopClip(port, key, waitMs = 10_000) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: "/_emu/record/stop", method: "POST", agent: false, headers: { Authorization: authorizationFor(key), Connection: "close", "Content-Length": 0 } }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.setTimeout(waitMs, () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
    request.end();
  });
}

/**
 * POST /_emu/github: stage 2 of publishing, done by the emulator's app (server.mjs). `query` is the op and its fields.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function askGithub(port, key, query, waitMs) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: `/_emu/github?${new URLSearchParams(query)}`, method: "POST", agent: false, headers: { Authorization: authorizationFor(key), Connection: "close", "Content-Length": 0 } }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => {
        if (body.length < 256 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.setTimeout(waitMs, () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
    request.end();
  });
}

/**
 * POST /_emu/update: the built-in update, done by the emulator's app (server.mjs). `op` is check or install; `pid`, the
 * asking command's process, which the app does not count among what keeps its folder in use on Windows.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function askUpdate(port, key, op, waitMs, pid = null) {
  return new Promise((resolve) => {
    const request = http.request({ host: "127.0.0.1", port, path: `/_emu/update?${new URLSearchParams({ op, ...(Number.isSafeInteger(pid) ? { pid: String(pid) } : {}) })}`, method: "POST", agent: false, headers: { Authorization: authorizationFor(key), Connection: "close", "Content-Length": 0 } }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.setTimeout(waitMs, () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
    request.end();
  });
}

/** The most an answer of the bar's API may hold for the command line: the list of the installed apps. */
const API_ANSWER_LIMIT = 1024 * 1024;

/**
 * One GET of the emulated bar's API, the answer as text.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function barGet(port, pathname, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const request = http.get({ host: "127.0.0.1", port, path: pathname, timeout: timeoutMs, agent: false }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= API_ANSWER_LIMIT) return chunks.push(chunk);
        resolve({ failed: `an answer of more than ${API_ANSWER_LIMIT / 1024} KiB` });
        request.destroy();
      });
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
  });
}

/**
 * One request of the emulated bar's API that changes something (a key, an app's settings, a launch), the answer as
 * text. `body` is sent as it is, as JSON.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function barSend(port, method, pathname, body = null, timeoutMs = 10_000) {
  return new Promise((resolve) => {
    // A package (install <file.tgz>) goes as its bytes; anything else is JSON text.
    const bytes = body !== null && typeof body !== "string";
    const payload = body === null ? null : bytes ? Buffer.from(body) : Buffer.from(body, "utf8");
    const headers = { Connection: "close", ...(payload ? { "Content-Type": bytes ? "application/octet-stream" : "application/json", "Content-Length": payload.length } : {}) };
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method, timeout: timeoutMs, agent: false, headers }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size <= API_ANSWER_LIMIT) return chunks.push(chunk);
        resolve({ failed: `an answer of more than ${API_ANSWER_LIMIT / 1024} KiB` });
        request.destroy();
      });
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    request.on("timeout", () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
    request.end(payload ?? undefined);
  });
}

/**
 * Asks the running emulator to ask the person whether they trust a project folder (server.mjs, POST /_emu/trust on
 * the management address; the app shows the question in a dialog of its own). The request stays open until the person
 * answers or `waitMs` is over; it carries the server's key and goes to 127.0.0.1 only. Ending this process ends the
 * question: the server takes the dialog away.
 * @returns {Promise<{ status: number, body: string } | { failed: string } | { blocked: string }>}
 */
export function askTrust(port, key, folder, waitMs) {
  return new Promise((resolve) => {
    const target = `${TRUST_PATH}?folder=${encodeURIComponent(folder)}&wait=${waitMs}`;
    const request = http.request({ host: "127.0.0.1", port, path: target, method: "POST", agent: false, headers: { Authorization: authorizationFor(key), Connection: "close", "Content-Length": 0 } }, (response) => {
      let body = "";
      response.setEncoding("utf8").on("data", (chunk) => {
        if (body.length < 64 * 1024) body += chunk;
      });
      response.on("end", () => resolve({ status: response.statusCode, body }));
      response.on("error", (e) => resolve({ failed: e?.code ?? String(e) }));
    });
    // The server ends the wait itself; this is for a server that went silent.
    request.setTimeout(waitMs + 15_000, () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => (SANDBOX_CODES.has(e?.code) ? resolve({ blocked: e.code }) : resolve({ failed: e?.code ?? String(e) })));
    request.end();
  });
}

/**
 * The emulated bar's log: what its apps print with console.log, the runtime's errors, and what the bar itself says
 * (an app installed, started, ended). The server keeps the latest lines and sends them to whoever opens its stream of
 * events (GET /_emu/events, device-window.mjs: "log" events { kind, text, time }, the kept ones first, then "state").
 * Without `follow` the answer is the kept lines. With it the stream stays open: `onKept` gets the kept lines once,
 * `onLine` every line that comes after them, and the answer comes when the emulator closes the stream (it quits, or
 * its server restarts).
 * @param {number} port
 * @param {{ follow?: boolean, onKept?: (lines: object[]) => void, onLine?: (line: { kind: string, text: string, time: number }) => void, timeoutMs?: number }} [o]
 * @returns {Promise<{ lines: { kind: string, text: string, time: number }[] } | { failed: string } | { blocked: string }>}
 *   `lines`: the kept ones.
 */
export function barLog(port, { follow = false, onKept = null, onLine = null, timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const lines = [];
    let done = false;
    let opened = false; // the stream answered: from then on its end is the emulator's, not a failure
    let kept = false;   // the kept lines are all here: the first "state" came
    const settle = (answer) => {
      if (done) return;
      done = true;
      request.destroy();
      resolve(answer);
    };
    const request = http.get({ host: "127.0.0.1", port, path: "/_emu/events", agent: false, headers: { Accept: "text/event-stream" } }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return settle({ failed: `HTTP ${response.statusCode}` });
      }
      opened = true;
      request.setTimeout(0);
      let rest = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        const events = (rest + chunk).split("\n\n");
        rest = events.pop();
        for (const event of events) {
          const name = /^event: (.*)$/m.exec(event)?.[1];
          if (name === "log") {
            let line = null;
            try {
              line = JSON.parse(/^data: (.*)$/m.exec(event)?.[1] ?? "");
            } catch {
              // A line that is no JSON is not the log's.
            }
            if (!line || typeof line.text !== "string") continue;
            if (kept) onLine?.(line);
            else lines.push(line);
          } else if (name === "state" && !kept) {
            // The kept lines come before the first "state".
            kept = true;
            if (!follow) return settle({ lines });
            onKept?.(lines);
          }
        }
      });
      response.on("end", () => settle({ lines }));
    });
    // Until the answer's head: a server that takes the connection and says nothing is not the emulator's.
    request.setTimeout(timeoutMs, () => request.destroy(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })));
    request.on("error", (e) => settle(SANDBOX_CODES.has(e?.code) ? { blocked: e.code } : opened && follow ? { lines } : { failed: e?.code ?? String(e) }));
  });
}

/** The name of the account this process runs under, or null when the system gives none. */
export function userName() {
  try {
    return os.userInfo().username || null;
  } catch {
    return null;
  }
}

/** The catalog's screenshot check (capture/catalog-png.mjs). Null in a copy that lacks the file. */
export async function loadCatalogCheck(file = fileURLToPath(new URL("../capture/catalog-png.mjs", import.meta.url))) {
  if (!existsSync(file)) return null;
  const { checkCatalogPng, CATALOG_PNG_RULES } = await import(pathToFileURL(file).href);
  return { check: checkCatalogPng, rules: CATALOG_PNG_RULES };
}

/** A process as the system describes it (process-info.mjs, one place for this and the data folder's lock). */
export const processInfo = processInfoSync;

/** True when two paths name the same file: by real path where it can be told, letter case aside on Windows (same-path.mjs). */
export const samePath = sameRealPath;

/** Removes the mirror if it still names this process: on Windows the app ends without removing it. */
export function removeRunStateOf(file, pid) {
  const read = readRunState(file);
  if (read.state?.pid === pid) rmSync(file, { force: true });
}

/**
 * The mark of a start under way (run/starting.json in the data folder): { pid, at } — the process of the `start`
 * command that waits for the app, and when it began. `quit` reads it: an app that was just started has not written
 * its mirror yet, and without the mark a quit in that moment would find nothing to quit and leave the app coming up.
 * A quit that ended the app during a start says so in the mark (quitStartMark), and the start, which looks at it as
 * it waits, ends at once instead of waiting its time out. It is a note between two runs of this command line, not a command to the
 * app; like the mirror it is only data (lifecycle.mjs checks that its process is alive and that it is not old). Written as well as it can be: where the
 * folder cannot be written (a sandbox) there is no mark, and start goes on without it.
 */
export function writeStartMark(file, mark) {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(mark)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** @returns {{ pid: number, at: number, quit: boolean } | null} `quit`: a quit ended the app this start waited for. */
export function readStartMark(file) {
  try {
    const mark = JSON.parse(readFileSync(file, "utf8"));
    return Number.isInteger(mark?.pid) && mark.pid > 1 && Number.isFinite(mark?.at) ? { pid: mark.pid, at: mark.at, quit: mark.quit === true } : null;
  } catch {
    return null;
  }
}

/** Removes the mark if it is still this process's: a later start may have written its own. */
export function removeStartMark(file, pid) {
  try {
    if (readStartMark(file)?.pid === pid) rmSync(file, { force: true });
  } catch {
    // Left behind, it names a process that is gone, and is ignored.
  }
}

/**
 * Writes into the mark that a quit has ended the app its start was waiting for. The start, which looks at its mark as
 * it waits, ends at once; it removes the mark itself. (Not by removing the mark: another start that ended would
 * remove its own, and the first one must not take that for a quit.)
 */
export function quitStartMark(file) {
  try {
    const mark = readStartMark(file);
    if (mark) writeFileSync(file, `${JSON.stringify({ ...mark, quit: true })}\n`, { mode: 0o600 });
  } catch {
    // The start then learns of it from its app being gone, or waits its time out.
  }
}

/**
 * The note of a quit that found nothing to quit (run/quit-asked.json in the data folder): { at }, when it was asked.
 * A `start` whose process began before that moment was already on its way — its app not there yet, and its mark
 * perhaps not either (Node takes a moment to start) — and ends the app it started when it sees the note
 * (lifecycle.mjs). A start that begins later takes no notice of it.
 */
export function writeQuitNote(file, note) {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, `${JSON.stringify(note)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** @returns {{ at: number } | null} */
export function readQuitNote(file) {
  try {
    const note = JSON.parse(readFileSync(file, "utf8"));
    return Number.isFinite(note?.at) ? { at: note.at } : null;
  } catch {
    return null;
  }
}

/**
 * The two files a server removes from its data folder when it stops, as they are now: its lock (run/server.lock) and
 * its key. Read before the app is ended, for removeServerFilesOf below.
 * @returns {{ lock: string | null, key: string | null }}
 */
export function serverFilesOf(dataDir) {
  let lock = null;
  let key = null;
  try {
    lock = readFileSync(path.join(dataDir, LOCK_FILE), "utf8");
  } catch {
    // No lock, or not readable: nothing to clear later.
  }
  try {
    key = readServerKey(dataDir);
  } catch {
    // Not readable: left where it is.
  }
  return { lock, key };
}

/**
 * Removes what the server of an app that was ended without its clean-up left in the data folder: on Windows `quit`
 * ends the app's process, and the server, a process the app started, goes with it before it can let go of its lock and
 * remove its key. Only the files read before the app was ended go, and only once the process the lock names is gone:
 * a lock or a key another server has written since is another text and stays; a server that is still running (not
 * the app's own) keeps both.
 * @param {string} dataDir
 * @param {{ lock: string | null, key: string | null }} before  serverFilesOf(), read before the app was ended
 * @param {{ sleep: (ms: number) => Promise<void>, now: () => number, isAlive?: (pid: number) => boolean, waitMs?: number }} o
 * @returns {Promise<{ lock: boolean, key: boolean }>} what was removed
 */
export async function removeServerFilesOf(dataDir, before, { sleep, now, isAlive = alive, waitMs = 5000 }) {
  const removed = { lock: false, key: false };
  if (!before?.lock) return removed;
  let owner = null;
  try {
    owner = JSON.parse(before.lock)?.pid;
  } catch {
    // Half-written: the next server clears it.
  }
  if (!Number.isInteger(owner) || owner <= 1) return removed;
  const deadline = now() + waitMs;
  while (isAlive(owner)) {
    if (now() >= deadline) return removed;
    await sleep(100);
  }
  const file = path.join(dataDir, LOCK_FILE);
  try {
    if (readFileSync(file, "utf8") === before.lock) {
      rmSync(file);
      removed.lock = true;
    }
  } catch {
    // Gone already, or cannot be removed: the next server finds it stale.
  }
  if (before.key && readServerKey(dataDir) === before.key) {
    removeServerKey(dataDir, before.key);
    removed.key = readServerKey(dataDir) === null;
  }
  return removed;
}

/**
 * Starts the app the way the system starts an app a person opens, so that it belongs to nobody who called this
 * command (ADR-0010, EMU-157): on macOS through Launch Services (`open`), on Windows through Explorer — a process
 * started from Node stays in the caller's job object and dies with it. No argument goes to the app: a release takes
 * none (ADR-0016). A second launch of a running app brings its window to the front.
 * Explorer is taken from the Windows folder the system names (ctx.windowsDir), not from SystemRoot of the caller.
 * @param {object} ctx
 * @param {typeof startProgram} [run]   for the tests: what starts the program
 * @returns {Promise<void>}
 */
export function launchApp(ctx, run = startProgram) {
  return new Promise((resolve, reject) => {
    let program;
    let args;
    if (ctx.testLaunch) {
      [program, ...args] = ctx.testLaunch;
    } else if (!ctx.appPath) {
      return reject(Object.assign(new Error("no app"), { code: "no_app" }));
    } else if (!existsSync(ctx.appPath)) {
      return reject(Object.assign(new Error(`${ctx.appPath} does not exist`), { code: "ENOENT" }));
    } else if (ctx.platform === "win32") {
      program = path.win32.join(ctx.windowsDir ?? "C:\\Windows", "explorer.exe");
      args = [ctx.appPath];
    } else {
      program = "/usr/bin/open";
      args = [ctx.appPath];
    }
    const child = run(program, args, { detached: true, stdio: ["ignore", "ignore", "pipe"], windowsHide: true }, { unlisted: ctx.testLaunch ? "the test variant's own launch of the app (BUSY_EMULATOR_TEST_LAUNCH)" : null, windowsDir: ctx.windowsDir ?? null });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    if (ctx.testLaunch || ctx.platform === "win32") {
      // Explorer answers 1 whatever happens, and a test's launch is the app itself: neither is waited for.
      child.stderr.destroy();
      child.unref();
      child.once("spawn", resolve);
    } else {
      child.on("exit", (code) => (code === 0 ? resolve() : reject(Object.assign(new Error(stderr.trim() || `open exited with ${code}`), { code: "open_failed" }))));
    }
  });
}

/**
 * Windows moves a folder to the Recycle Bin only where there is one: the session of a person (not a service's, which
 * an SSH login is: there the same call deletes for good, checked on Windows 10) and a fixed disk (a USB stick or a
 * network share has none, and the call deletes there too). Anywhere else nothing is done and the answer says why.
 */
const WINDOWS_RECYCLE = [
  "$ErrorActionPreference = 'Stop'",
  "$folder = $env:BUSY_EMULATOR_TRASH",
  "if ((Get-Process -Id $PID).SessionId -eq 0) { [Console]::Error.WriteLine('This session has no Recycle Bin (a service or an SSH login), so the folder was not moved. Move it yourself.'); exit 3 }",
  "if ($folder.StartsWith('\\\\') -or ([System.IO.DriveInfo]::new([System.IO.Path]::GetPathRoot($folder))).DriveType -ne 'Fixed') { [Console]::Error.WriteLine('The folder is not on a fixed disk of this computer, which has no Recycle Bin, so it was not moved. Move it yourself.'); exit 3 }",
  "Add-Type -AssemblyName Microsoft.VisualBasic",
  "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($folder, 'OnlyErrorDialogs', 'SendToRecycleBin')",
].join("; ");

/**
 * Moves a folder to the Trash (the Recycle Bin on Windows), the way the system's file manager does, so that it can be
 * put back: never a deletion. macOS: its own `trash` (macOS 15 and later), else the Finder; Windows: the Recycle Bin
 * through PowerShell (WINDOWS_RECYCLE), the folder's path in the environment so that no character of it is read as
 * code; Linux: `gio trash`. Resolves when it is there; rejects with the system's words.
 * @param {string} folder  a real path that `trashableFolder` (../path-boundary.mjs) has let through
 * `env` is the command line's environment (ctx.env), `windowsDir` the Windows folder (ctx.windowsDir).
 */
export function trashFolder(folder, { platform = process.platform, windowsDir = null, env: callerEnv = {}, run = startProgram } = {}) {
  let program;
  let args;
  let env = callerEnv;
  if (platform === "darwin") {
    if (existsSync("/usr/bin/trash")) [program, args] = ["/usr/bin/trash", [folder]];
    else [program, args] = ["/usr/bin/osascript", ["-e", "on run argv", "-e", 'tell application "Finder" to delete (POSIX file (item 1 of argv) as alias)', "-e", "end run", folder]];
  } else if (platform === "win32") {
    program = path.win32.join(windowsDir ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    args = ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_RECYCLE];
    env = { ...callerEnv, BUSY_EMULATOR_TRASH: folder };
  } else {
    [program, args] = ["gio", ["trash", "--", folder]];
  }
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = run(program, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true, env }, { windowsDir });
    } catch (e) {
      return reject(e);
    }
    let said = "";
    child.stderr?.setEncoding("utf8").on("data", (chunk) => (said += chunk));
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 && !existsSync(folder) ? resolve() : reject(new Error(said.trim().split(/\r?\n/).slice(-3).join(" ") || `the folder is still there (exit code ${code})`))));
  });
}

/**
 * Ends the emulator. macOS: a terminate signal, which the app takes as Quit. Windows has no such signal; the process
 * is ended, and the server goes with it (its supervisor sees the app gone, as it does on every quit on Windows).
 */
export function terminate(pid) {
  process.kill(pid, "SIGTERM");
}

export const system = Object.freeze({
  readRunState,
  alive,
  probe,
  processInfo: (pid, platform, windowsDir) => processInfo(pid, platform, windowsDir),
  samePath: (a, b, platform) => samePath(a, b, platform),
  removeRunStateOf,
  writeStartMark,
  readStartMark,
  removeStartMark,
  quitStartMark,
  writeQuitNote,
  readQuitNote,
  pid: () => process.pid,
  // When this process began (ms since the epoch): a quit asked after that came while this command was on its way.
  startedAt: () => Math.floor(Date.now() - process.uptime() * 1000),
  serverFilesOf,
  removeServerFilesOf: (dataDir, before) => removeServerFilesOf(dataDir, before, { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)), now: () => Date.now() }),
  launchApp: (ctx) => launchApp(ctx),
  terminate,
  screen: (port, display) => screen(port, display),
  barGet: (port, pathname) => barGet(port, pathname),
  barLog: (port, options) => barLog(port, options),
  barSend: (port, method, pathname, body, timeoutMs) => barSend(port, method, pathname, body, timeoutMs),
  trashFolder: (folder, options) => trashFolder(folder, options),
  home: () => os.homedir(),
  askTrust: (port, key, folder, waitMs) => askTrust(port, key, folder, waitMs),
  recordClip: (port, key, query, waitMs) => recordClip(port, key, query, waitMs),
  stopClip: (port, key) => stopClip(port, key),
  askGithub: (port, key, query, waitMs) => askGithub(port, key, query, waitMs),
  askUpdate: (port, key, op, waitMs, pid) => askUpdate(port, key, op, waitMs, pid),
  userName,
  // A new app's author (projects/author.mjs): read from files, no gh or git started.
  githubLogin: (dataDir, env = {}) => githubLogin({ dataDir, env, platform: process.platform, home: os.homedir() }),
  gitUserName: (env = {}) => gitUserName({ env, home: os.homedir() }),
  readControl: (dataDir) => readControl(dataDir),
  localPorts: (port, key, method, localPort, timeoutMs) => localPorts(port, key, method, localPort, timeoutMs),
  loadCatalogCheck: () => loadCatalogCheck(),
  // The project commands' one way to start a tool: the bundled Node, npm or npx (projects/node-tools.mjs).
  runTool: (setup, request) => runNodeTool(setup, request),
  cwd: () => process.cwd(),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
